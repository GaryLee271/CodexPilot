  function uniqueValues(values) {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0)));
  }

  let codexModelCatalog = { status: "loading", model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
  let codexModelCatalogLoadedAt = 0;
  let codexModelCatalogPromise = null;
  if (window.__CODEX_PLUS_TEST_SERVICE_TIER__) {
    window.__codexPlusServiceTierTest = {
      diagnostics: () => [...(window.__codexPlusServiceTierTestDiagnostics || [])],
      currentModelName: () => codexServiceTierCurrentModelName(),
      fastAvailability: (modelName = codexServiceTierCurrentModelName()) => codexServiceTierFastAvailability(modelName),
      setModelCatalog: (catalog = {}) => {
        codexModelCatalog = {
          status: "ok",
          model: "",
          default_model: "",
          model_provider: "",
          codex_model_provider: "",
          provider_name: "",
          models: [],
          sources: [],
          responses_api: { status: "unknown", message: "" },
          ...catalog,
        };
        codexModelCatalogLoadedAt = Date.now();
        codexModelCatalogPromise = null;
      },
      loadModelCatalog: (force = false) => loadCodexModelCatalog(force),
      setBackendSettings: (settings = {}) => {
        codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
        codexPlusBackendSettingsLoaded = true;
      },
      patchAppServerClient: patchAppServerModelRequestClient,
      locateAppServerClientBreakpoint: locateCodexAppServerClientBreakpoint,
      installAppServerClientPrototypePatch: installCodexAppServerClientPrototypePatch,
      appServerClientPrototypeState: () => ({
        hasClass: typeof window.__codexPlusAppServerClientClass === "function",
        installed: window.__codexPlusAppServerClientPrototypePatchInstalled || null,
      }),
    };
    return;
  }
  function codexPlusModelNames() {
    return uniqueValues([
      codexModelCatalog.default_model,
      codexModelCatalog.model,
      ...(Array.isArray(codexModelCatalog.models) ? codexModelCatalog.models : []),
    ]);
  }

  async function loadCodexModelCatalog(force = false) {
    if (!force && codexModelCatalogPromise) return codexModelCatalogPromise;
    if (!force && codexModelCatalogLoadedAt && Date.now() - codexModelCatalogLoadedAt < 10000) return codexModelCatalog;
    codexModelCatalogPromise = readCodexAppServerPreparation("/codex-model-catalog", {})
      .then(async (result) => {
        codexModelCatalog = result && typeof result === "object" ? result : { status: "failed", model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
        codexModelCatalogLoadedAt = Date.now();
        renderCodexPlusMenu();
        return codexModelCatalog;
      })
      .catch((error) => {
        codexModelCatalog = { status: "failed", message: String(error?.message || error), model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
        codexModelCatalogLoadedAt = Date.now();
        return codexModelCatalog;
      })
      .finally(() => {
        codexModelCatalogPromise = null;
      });
    return codexModelCatalogPromise;
  }

  function codexPlusModelMetadata(modelName) {
    const metadata = codexModelCatalog.modelMetadata || codexModelCatalog.model_metadata;
    const normalizedName = codexServiceTierModelFromValue(modelName);
    const exact = metadata && typeof metadata === "object" ? metadata[normalizedName] : null;
    const matchedKey = !exact && metadata && typeof metadata === "object"
      ? Object.keys(metadata).find((key) => key.toLowerCase() === normalizedName.toLowerCase())
      : null;
    const value = exact || (matchedKey ? metadata[matchedKey] : null);
    return value && typeof value === "object" ? value : null;
  }

  function patchAppServerModelRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    try {
      if (!Object.isExtensible(client)) return false;
      for (const key of ["__codexPlusModelRequestPatch", "__codexPlusModelOriginalSendRequest", "sendRequest"]) {
        const descriptor = Object.getOwnPropertyDescriptor(client, key);
        if (descriptor && descriptor.writable === false && typeof descriptor.set !== "function") return false;
      }
    } catch {
      return false;
    }
    if (client.__codexPlusModelRequestPatch === codexAppServerModelRequestPatchVersion) return true;
    const originalSendRequest = (client.__codexPlusModelOriginalSendRequest || client.sendRequest).bind(client);
    client.__codexPlusModelOriginalSendRequest = originalSendRequest;
    // 保留会话操作的交换中间件；原生模型列表、默认模型和请求参数原样传递。
    client.sendRequest = async function codexPlusModelPatchedSendRequest(method, params, options) {
      return sendAppServerRequestThroughExchange(client, method, params,
        () => originalSendRequest(method, params, options));
    };
    client.__codexPlusModelRequestPatch = codexAppServerModelRequestPatchVersion;
    return true;
  }

  /**
   * `codex/exchange` 中间件链：包住一次发往 app-server 的请求。值是 `{ method, params, hostId, send }`，
   * 中间件用 `next({ ...exchange, send: 新的 send })` 在原请求前后做事（内置拓展「侧聊保存」就挂在这里），
   * 链尾调用最终的 send。没有中间件时直接发，不多一层 Promise。
   * 内核分片还没初始化（页面早期、只抽前面分片的测试）时读中间件表会落进暂时性死区，按没有中间件处理。
   */
  async function sendAppServerRequestThroughExchange(client, method, params, send) {
    let wanted = false;
    try {
      wanted = codexPlusExtensionInterceptors.has("codex/exchange");
    } catch {}
    if (!wanted) return send();
    const exchange = await codexPlusRunWaterfall("codex/exchange", { method, params, hostId: client.hostId, send });
    return typeof exchange?.send === "function" ? exchange.send() : send();
  }

  // issue #2177：Codex 26.908 把 AppServerRequestClient 类藏进模块闭包且不再导出，
  // 渲染层扫描在新版上永远 not_found，直接改写 dispatcher 又会撞上不可写的 RPC stub。
  // 改为两段式接管：这里先用纯文本定位算出 sendRequest 的断点坐标（按 UTF-16 计数，
  // 与 V8 断点坐标语义一致），launcher 侧 bridge.rs 再用 CDP Debugger 按坐标下条件断点，
  // 命中时把类构造器挂到 window.__codexPlusAppServerClientClass，随后对原型套用与
  // 实例版完全一致的请求补丁。断点条件 `!window.__codexPlusAppServerClientClass`
  // 保证页面重载后自动重新捕获，且每次页面生命周期内只暂停一次。
  function locateCodexAppServerClientBreakpoint(text) {
    if (typeof text !== "string" || !text) return null;
    const markerIdx = text.indexOf(codexAppServerClientCaptureMarker);
    if (markerIdx < 0) return null;
    const anchorIdx = text.lastIndexOf(codexAppServerClientCaptureAnchor, markerIdx);
    if (anchorIdx < 0 || markerIdx - anchorIdx > 220) return null;
    const braceIdx = text.indexOf("{", anchorIdx);
    if (braceIdx < 0) return null;
    let lineNumber = 0;
    let lastNewline = -1;
    for (let i = 0; i < braceIdx; i++) {
      if (text.charCodeAt(i) === 10) {
        lineNumber += 1;
        lastNewline = i;
      }
    }
    return { lineNumber, columnNumber: braceIdx - lastNewline - 1 };
  }

  // issue #2399：抓取目标不能再按 asset 文件名前缀写死。Codex 26.930 把
  // AppServerRequestClient 从 `app-initial-*.js` 搬到了 `app-shared-*.js`，
  // 按前缀找资产必然 anchor_missing，依赖客户端采集的会话操作无法接入。
  // 加一项前缀只治当前这一版，下次改名又会失灵，所以改成**按内容找类定义**：
  // 遍历已加载的 app asset，谁包含 marker 文本谁就是目标，两代产物都能覆盖。
  // 排序只做「可能的更靠前」的启发式，不影响正确性；命中全靠文本匹配。
  const codexAppServerClientBundleHints = ["app-shared-", "app-initial-", "app-main-", "chatg"];
  const codexAppServerClientAssetFetchLimit = 24;

  // 已经拉过全文、确认不含类定义的资产。重试时只看新出现的候选，
  // 不会因为多试几轮就把同一批大文件反复 fetch（#1960 / #2330 的教训）。
  const codexAppServerClientCheckedUrls = new Set();

  function codexAppServerClientAssetCandidateUrls() {
    const urls = codexAppAssetCandidateUrls().filter((url) => !codexAppServerClientCheckedUrls.has(url));
    const rank = (url) => {
      const name = (url.split("/").pop() || "").toLowerCase();
      const hint = codexAppServerClientBundleHints.findIndex((part) => name.includes(part));
      return hint < 0 ? codexAppServerClientBundleHints.length : hint;
    };
    // 按「像主 bundle」在前、体积（URL 长度做代理）大的在前排序，再截断。
    // 全量 fetch 所有 app asset 会重蹈 #1960 的覆辙，所以限制尝试数量。
    return urls
      .slice()
      .sort((left, right) => rank(left) - rank(right) || right.length - left.length)
      .slice(0, codexAppServerClientAssetFetchLimit);
  }

  // 返回 { url, location }；找不到返回 null。diagnostics 由调用方按命中/未命中归类。
  async function locateCodexAppServerClientInAssets() {
    const urls = codexAppServerClientAssetCandidateUrls();
    if (urls.length === 0) return { urls, hit: null };
    // 先走廉价的 asset loader（有 30s 失败冷却与重试上限），脚本里已经内联了
    // asset 名时能直接命中，省掉整轮 fetch；不可用就退回到全量文本匹配。
    const hinted = resolveCodexAppServerClientHintedUrl();
    const ordered = hinted && !codexAppServerClientCheckedUrls.has(hinted)
      ? [hinted, ...urls.filter((url) => url !== hinted)]
      : urls;
    for (const url of ordered) {
      try {
        const text = await fetch(url).then((response) => response.ok ? response.text() : "");
        if (!text) continue;
        const location = locateCodexAppServerClientBreakpoint(text);
        if (location) return { urls, hit: { url, location } };
        codexAppServerClientCheckedUrls.add(url);
      } catch {
        // 单个 asset 拉取失败不影响其余候选，继续下一个；没记成已检查，下一轮还会再试。
      }
    }
    return { urls, hit: null };
  }

  // 兼容旧路径：asset 名确实内联在入口脚本里时，用 loader 的缓存直接拿到 URL，
  // 不必为了它把所有 asset 拉一遍。找不到就返回空串，交给内容匹配兜底。
  function resolveCodexAppServerClientHintedUrl() {
    for (const prefix of codexAppServerClientBundleHints) {
      const url = codexAppAssetUrl(prefix);
      if (url) return url;
    }
    return "";
  }

  // 定位常常跑在类所在的资产「可见」之前：Codex 26.10xx 由 app-main 静态 import app-initial，
  // 开了 Fast 时 import map 又把它指向 Blob，资源记录里没有原 URL（缓冲区 250 条也早就满了），
  // 要等 Fast 模块执行完置上 __codexPlusNativeFastCompiled 才能拿到。之前首轮只看到 5 个候选、
  // 报 anchor_missing 后本页再也不试，launcher 等不到坐标就放弃捕获，依赖原型补丁的功能全部失效。
  // 所以未命中时按退避重试；总时长控制在 launcher 90s 的坐标等待窗口之内。
  const codexAppServerClientCaptureRetryDelaysMs = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
  let codexAppServerClientCaptureStarted = false;
  let codexAppServerClientCaptureAttempts = 0;
  async function installCodexAppServerClientCapture() {
    if (codexAppServerClientCaptureStarted || window.__codexPlusAppServerClientCapture) return;
    codexAppServerClientCaptureStarted = true;
    codexAppServerClientCaptureAttempts += 1;
    try {
      if (typeof fetch !== "function") return;
      const { urls, hit } = await locateCodexAppServerClientInAssets();
      if (!hit) {
        const retryDelay = codexAppServerClientCaptureRetryDelaysMs[codexAppServerClientCaptureAttempts - 1];
        if (retryDelay !== undefined) {
          window.setTimeout(() => {
            codexAppServerClientCaptureStarted = false;
            void installCodexAppServerClientCapture().catch(() => {});
          }, retryDelay);
          return;
        }
        // 区分「一个候选资产都没有」和「有资产但没有类定义」：
        // 前者是页面还没加载完，后者才是 Codex 真的改了产物形状。
        sendCodexPlusDiagnostic("app_server_client_capture_locate_failed", {
          reason: urls.length === 0 && codexAppServerClientCheckedUrls.size === 0 ? "asset_url_missing" : "anchor_missing",
          candidateCount: urls.length,
          checkedCount: codexAppServerClientCheckedUrls.size,
          attempts: codexAppServerClientCaptureAttempts,
        });
        return;
      }
      const urlRegex = hit.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      window.__codexPlusAppServerClientCapture = { urlRegex, ...hit.location };
      sendCodexPlusDiagnostic("app_server_client_capture_located", {
        lineNumber: hit.location.lineNumber,
        columnNumber: hit.location.columnNumber,
        asset: (hit.url.split("/").pop() || "").split("?")[0],
        attempts: codexAppServerClientCaptureAttempts,
      });
    } catch (error) {
      codexAppServerClientCaptureStarted = false;
      sendCodexPlusDiagnostic("app_server_client_capture_locate_failed", {
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
    }
  }

  function installCodexAppServerClientPrototypePatch() {
    if (window.__codexPlusAppServerClientPrototypePatchInstalled === codexAppServerModelRequestPatchVersion) return true;
    const wanted = typeof codexPlusExtensionWantsRequestMiddleware === "function" && codexPlusExtensionWantsRequestMiddleware();
    if (!wanted) return false;
    const klass = window.__codexPlusAppServerClientClass;
    if (!klass || typeof klass !== "function" || !klass.prototype) return false;
    const proto = klass.prototype;
    if (proto.__codexPlusModelRequestPatch === codexAppServerModelRequestPatchVersion) {
      window.__codexPlusAppServerClientPrototypePatchInstalled = codexAppServerModelRequestPatchVersion;
      return true;
    }
    try {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "sendRequest");
      if (!descriptor || descriptor.writable === false) {
        sendCodexPlusDiagnostic("app_server_client_prototype_patch_skipped", {});
        window.__codexPlusAppServerClientPrototypePatchInstalled = codexAppServerModelRequestPatchVersion;
        return false;
      }
    } catch {
      window.__codexPlusAppServerClientPrototypePatchInstalled = codexAppServerModelRequestPatchVersion;
      return false;
    }
    const originalSendRequest = proto.__codexPlusModelOriginalSendRequest || proto.sendRequest;
    proto.__codexPlusModelOriginalSendRequest = originalSendRequest;
    proto.sendRequest = async function codexPlusModelPatchedSendRequest(method, params, options) {
      // 与实例补丁共用交换链，返回原生结果，不再追加模型或插入 thread/resume。
      return sendAppServerRequestThroughExchange(this, method, params,
        () => originalSendRequest.call(this, method, params, options));
    };
    // 所有请求最终都经 createRequest(method, params, options) 组装：拓展的 codex/request 中间件挂在这里。
    // createRequest 是同步的，与 codex/request 的契约一致（中间件同步返回，返回 Promise 视为出错并放行）。
    if (typeof proto.createRequest === "function") {
      const originalCreateRequest = proto.__codexPlusOriginalCreateRequest || proto.createRequest;
      proto.__codexPlusOriginalCreateRequest = originalCreateRequest;
      proto.createRequest = function codexPlusPatchedCreateRequest(method, params, ...rest) {
        let nextParams = params;
        if (typeof codexPlusExtensionWantsRequestMiddleware === "function" && codexPlusExtensionWantsRequestMiddleware()
            && typeof codexPlusApplyExtensionRequestMiddleware === "function") {
          nextParams = codexPlusApplyExtensionRequestMiddleware(String(method || ""), params);
        }
        return originalCreateRequest.call(this, method, nextParams, ...rest);
      };
    }
    proto.__codexPlusModelRequestPatch = codexAppServerModelRequestPatchVersion;
    window.__codexPlusAppServerClientPrototypePatchInstalled = codexAppServerModelRequestPatchVersion;
    sendCodexPlusDiagnostic("app_server_client_prototype_patch_installed", {});
    return true;
  }

  const appServerModelRequestPatchMaxMisses = 8;
  const appServerModelRequestPatchMaxRetryDelayMs = 30000;
  let appServerModelRequestPatchMissCount = 0;
  let appServerModelRequestPatchDisabled = false;
  let appServerModelRequestPatchPromise = null;
  let appServerModelRequestPatchRetryTimer = 0;
  let appServerModelRequestPatchRetryDelayMs = 250;

  function scheduleAppServerModelRequestPatchRetry() {
    if (appServerModelRequestPatchRetryTimer) return;
    // issue #2256/#2255：固定 250ms 重试在 Codex 改 asset 命名后变成每秒 4 轮的全量
    // rescan（每轮 fetch 全部 app asset）。改为指数退避， miss 计满后由熔断停掉。
    appServerModelRequestPatchRetryTimer = window.setTimeout(() => {
      appServerModelRequestPatchRetryTimer = 0;
      installAppServerModelRequestPatch();
    }, appServerModelRequestPatchRetryDelayMs);
    appServerModelRequestPatchRetryDelayMs = Math.min(appServerModelRequestPatchRetryDelayMs * 4, appServerModelRequestPatchMaxRetryDelayMs);
  }

  function noteAppServerModelRequestPatchMiss(event, detail) {
    appServerModelRequestPatchMissCount += 1;
    // 原生模块迟到或改名时只记录首个失败，随后按退避重试和次数上限停止采集。
    // 会话操作继续使用可用的原生桥接，不为恢复模型列表而反复扫描资产。
    if (appServerModelRequestPatchMissCount === 1) {
      sendCodexPlusDiagnostic(event, detail);
    }
    // issue #2256：provider 重试路径以前在这里提前 return，绕过下面的 maxMisses
    // 熔断，失败变成 250ms 无限重试（每轮全量 rescan 全部 app assets）。
    // 现在两个路径统一计数：先按 maxMisses 熔断，未熔断时再走指数退避重试。
    if (appServerModelRequestPatchMissCount >= appServerModelRequestPatchMaxMisses && !appServerModelRequestPatchDisabled) {
      appServerModelRequestPatchDisabled = true;
      clearTimeout(appServerModelRequestPatchRetryTimer);
      appServerModelRequestPatchRetryTimer = 0;
      sendCodexPlusDiagnostic("model_app_server_request_patch_skipped", {
        misses: appServerModelRequestPatchMissCount,
        lastEvent: event,
      });
      return;
    }
    if (!appServerModelRequestPatchDisabled) {
      scheduleAppServerModelRequestPatchRetry();
    }
  }

  function installAppServerModelRequestPatch() {
    if (window.__codexPlusAppServerModelRequestPatchInstalled === codexAppServerModelRequestPatchVersion) return;
    if (appServerModelRequestPatchDisabled) return;
    if (appServerModelRequestPatchPromise) return;
    const patch = async () => {
      try {
        const { modules, candidates, sources, discovery } = await loadAppServerRequestCandidates();
        if (modules.length === 0) {
          noteAppServerModelRequestPatchMiss("model_app_server_request_patch_skipped", {
            reason: "app_server_request_assets_missing",
          });
          return;
        }
        let patchedCount = 0;
        for (const candidate of candidates) {
          if (patchAppServerModelRequestClient(candidate)) patchedCount += 1;
        }
        if (patchedCount > 0) {
          clearTimeout(appServerModelRequestPatchRetryTimer);
          appServerModelRequestPatchRetryTimer = 0;
          appServerModelRequestPatchMissCount = 0;
          appServerModelRequestPatchRetryDelayMs = 250;
          window.__codexPlusAppServerModelRequestPatchInstalled = codexAppServerModelRequestPatchVersion;
          sendCodexPlusDiagnostic("model_app_server_request_patch_installed", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            patchedCount,
            sources,
            discovery,
          });
        } else {
          noteAppServerModelRequestPatchMiss("model_app_server_request_patch_not_found", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            sources,
            discovery,
          });
        }
      } catch (error) {
        noteAppServerModelRequestPatchMiss("model_app_server_request_patch_failed", {
          errorName: error?.name || "",
          errorMessage: error?.message || String(error),
        });
      }
    };
    appServerModelRequestPatchPromise = patch().finally(() => {
      appServerModelRequestPatchPromise = null;
    });
    void appServerModelRequestPatchPromise;
  }

  function ensureCodexAppServerClient() {
    const extensionWantsRequests = typeof codexPlusExtensionWantsRequestMiddleware === "function"
      && codexPlusExtensionWantsRequestMiddleware();
    // 模型目录仅供读取；客户端采集只由拓展请求中间件按需启用。
    if (extensionWantsRequests) {
      installAppServerModelRequestPatch();
      void installCodexAppServerClientCapture().catch(() => {});
    }
    if (extensionWantsRequests && !window.__codexPlusAppServerClientClass && !window.__codexPlusExtensionRequestCaptureAsked) {
      window.__codexPlusExtensionRequestCaptureAsked = true;
      void postJson("/extensions/request-capture", {}).catch(() => {});
    }
  }

  function threadIdVariants(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) return [];
    const id = sessionId.trim();
    const bareId = id.startsWith("local:") ? id.slice("local:".length) : id;
    return uniqueValues([id, bareId, `local:${bareId}`]);
  }
