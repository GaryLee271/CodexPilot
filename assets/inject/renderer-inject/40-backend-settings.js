  async function loadBackendSettings() {
    const loaded = await loadBackendSettingsState();
    if (loaded) {
      void loadCodexModelCatalog();
      void loadCodexPlusBuiltinInventory();
    }
    refreshCodexPlusBackendToggles();
    // 后端可用后预取设置项清单，首次打开设置页时不必再等一次请求。
    if (loaded && typeof loadCodexPlusSettingsCatalog === "function") void loadCodexPlusSettingsCatalog();
    // 设置事件继续提供给保留功能及第三方拓展。
    if (loaded) emitCodexPlusSettingsLoaded("startup");
    return loaded;
  }

  /**
   * 读到后端设置（启动或心跳）后发公开事件 `settings/loaded`，参数 `{ reason: "startup" | "heartbeat", changedKeys? }`。
   * 内置拓展与第三方拓展都经 ctx.on 订阅，拓展卸下时订阅跟着撤掉。
   * typeof 守卫：本分片会被切片到不带拓展内核的沙箱里执行。
   */
  function emitCodexPlusSettingsLoaded(reason, changedKeys) {
    if (typeof codexPlusEmitExtensionEvent !== "function") return;
    // 心跳带上这次变了的字段名（管理器里改的设置靠它识别）；启动时第一次读到设置不带。
    const detail = Array.isArray(changedKeys) ? { reason, changedKeys } : { reason };
    codexPlusEmitExtensionEvent("settings/loaded", [detail]);
  }

  /** 两份设置之间值变了的顶层字段名。只给名字不给值，免得经事件把设置内容交给拓展。 */
  function codexPlusChangedBackendSettingKeys(previous, next) {
    const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
    const changed = [];
    for (const key of keys) {
      let before;
      let after;
      try {
        before = JSON.stringify(previous?.[key]);
        after = JSON.stringify(next?.[key]);
      } catch {
        continue;
      }
      if (before !== after) changed.push(key);
    }
    return changed;
  }

  /**
   * 供应商相关的公开事件，比较前后两份设置里 Codex Pilot 下发的 activeRelayProfilePublic / modelCatalogFingerprint：
   *   - `relayProfile/switched`：({ previous, profile })，当前供应商换了
   *   - `modelCatalog/changed`：({ profile })，决定模型目录的字段变了（模型列表、每模型窗口 / 压缩 / 元数据、换供应商……），
   *     新目录用 /model-catalog/public 取
   * profile 形状同 /settings/public 的 activeProfile。页面里改的立即发，管理器里改的经心跳发；第一次读到设置时不发。
   */
  function emitCodexPlusRelaySettingsEvents(previous, next) {
    if (typeof codexPlusEmitExtensionEvent !== "function") return;
    const before = previous?.activeRelayProfilePublic;
    const after = next?.activeRelayProfilePublic;
    if (!before || !after) return;
    if (before.id !== after.id) {
      codexPlusEmitExtensionEvent("relayProfile/switched", [{ previous: { ...before }, profile: { ...after } }]);
    }
    const beforeFingerprint = previous?.modelCatalogFingerprint;
    const afterFingerprint = next?.modelCatalogFingerprint;
    if (beforeFingerprint && afterFingerprint && beforeFingerprint !== afterFingerprint) {
      codexPlusEmitExtensionEvent("modelCatalog/changed", [{ profile: { ...after } }]);
    }
  }

  /**
   * 在 Codex 页面里改了一项设置后发公开事件 `settings/changed`，参数 `{ key, value, persisted }`：
   * key 是改动的设置字段（存在 Codex Pilot 后端的用后端字段名，如 codexAppCapacityAutoRetry；只存页面本地的用页面键名）；
   * 先按新值发一次 persisted: false（这时读设置已是新值），写进后端后再发一次 persisted: true。
   * 跟着设置走的内置拓展订阅它，内核不再逐个点名功能。
   */
  function emitCodexPlusSettingsChanged(key, value, persisted) {
    if (typeof codexPlusEmitExtensionEvent === "function") codexPlusEmitExtensionEvent("settings/changed", [{ key, value, persisted: persisted === true }]);
  }

  /**
   * 启动期读取后端设置的重试间隔；返回 -1 表示停止。
   * 前 60 次每 250ms 一次（约 15 秒，覆盖常规启动）；之后按指数退避到 5 秒封顶再试 30 次，
   * 重启 Codex 后首次桥接超时、页面被启动壳自救重载这类慢启动也能补上设置（#2680）。
   */
  function backendSettingsStartupRetryDelay(attempt) {
    if (attempt < 60) return 250;
    if (attempt >= 90) return -1;
    return Math.min(5000, 250 * 2 ** (attempt - 59));
  }

  function loadBackendSettingsForStartup(attempt = 0) {
    loadBackendSettings().then((loaded) => {
      if (loaded) {
        scan();
        return;
      }
      const delay = backendSettingsStartupRetryDelay(attempt);
      if (delay >= 0) {
        setTimeout(() => loadBackendSettingsForStartup(attempt + 1), delay);
      }
    });
  }

  let syncBackendSettingsInFlight = false;
  /** 已读到过的后端设置（对象引用，之后的写入都换新对象，不会改到它）；还没读到过时为 null。 */
  function codexPlusBackendSettingsSnapshot() {
    if (typeof codexPlusBackendSettingsLoaded === "undefined" || codexPlusBackendSettingsLoaded !== true) return null;
    return typeof codexPlusBackendSettings === "object" && codexPlusBackendSettings ? codexPlusBackendSettings : null;
  }

  async function syncBackendSettingsFromHeartbeat() {
    if (syncBackendSettingsInFlight) return;
    syncBackendSettingsInFlight = true;
    try {
      // 记下读之前的设置：loadBackendSettingsState 换成新对象，旧引用里还是上一次的值。
      // 下面的 typeof 守卫：本段会被切片到只给了少量依赖的沙箱里测。
      const previous = codexPlusBackendSettingsSnapshot();
      const loaded = await loadBackendSettingsState();
      if (loaded) {
        const next = previous ? codexPlusBackendSettingsSnapshot() : null;
        // 启动期读取全部失败时，心跳是之后唯一的设置来源；跟着设置走的功能由内置拓展订阅。
        emitCodexPlusSettingsLoaded("heartbeat", previous && next && typeof codexPlusChangedBackendSettingKeys === "function"
          ? codexPlusChangedBackendSettingKeys(previous, next)
          : undefined);
        if (previous && next && typeof emitCodexPlusRelaySettingsEvents === "function") emitCodexPlusRelaySettingsEvents(previous, next);
        // 管理器里改的设置：设置页开着时，开关与随总开关切换的说明也跟着变。
        syncCodexPlusBackendToggleButtons();
        renderCodexPlusMenu();
      }
    } finally {
      syncBackendSettingsInFlight = false;
    }
  }

  async function setBackendSetting(key, value) {
    const seq = ++codexPlusBackendSettingsSeq;
    const previous = typeof codexPlusBackendSettingsSnapshot === "function" ? codexPlusBackendSettingsSnapshot() : null;
    codexPlusBackendSettings = { ...codexPlusBackendSettings, [key]: value };
    codexPlusBackendSettingsLoaded = true;
    if (typeof emitCodexPlusSettingsChanged === "function") emitCodexPlusSettingsChanged(key, value, false);
    refreshCodexPlusBackendToggles();
    try {
      const settings = await postJson("/settings/set", { [key]: value });
      if (seq === codexPlusBackendSettingsSeq) {
        codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
        globalThis.window?.__codexPlusNativeFastUnlock?.runtime?.update?.({
          enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
          codexAppNativeFastUnlock: codexPlusBackendSettings.codexAppNativeFastUnlock === true,
          nativeFastLocalApiConfigured: codexPlusBackendSettings.nativeFastLocalApiConfigured === true,
        });
        // 仅发布本地分区策略，不读取或传递账号分区数据。
        globalThis.window?.__codexPlusNativeProjectSections?.runtime?.update?.({
          enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
          codexAppNativeProjectSections: codexPlusBackendSettings.codexAppNativeProjectSections === true,
          nativeProjectSectionsLocalApiConfigured: codexPlusBackendSettings.nativeProjectSectionsLocalApiConfigured === true,
        });
        globalThis.window?.__codexPlusNativePredictions?.runtime?.update?.({
          enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
          codexAppNativePredictions: codexPlusBackendSettings.codexAppNativePredictions === true,
          nativePredictionsLocalApiConfigured: codexPlusBackendSettings.nativePredictionsLocalApiConfigured === true,
          codexAppNativePredictionsModel: String(codexPlusBackendSettings.codexAppNativePredictionsModel || "").trim(),
        });
        if (typeof emitCodexPlusSettingsChanged === "function") emitCodexPlusSettingsChanged(key, value, true);
        if (previous && typeof emitCodexPlusRelaySettingsEvents === "function") emitCodexPlusRelaySettingsEvents(previous, codexPlusBackendSettings);
      }
    } finally {
      refreshCodexPlusBackendToggles();
    }
  }

  /**
   * 把直接写后端字段的开关同步成当前值。心跳每 5 秒也会调用，
   * 值没变就不写属性，避免无谓的 DOM 变更触发扫描。
   */
  function syncCodexPlusBackendToggleButtons() {
    document.querySelectorAll(".codex-plus-toggle[data-codex-backend-setting]").forEach((button) => {
      const key = button.getAttribute("data-codex-backend-setting");
      const enabled = String(!!codexPlusBackendSettings[key]);
      if (button.dataset.enabled === enabled) return;
      button.dataset.enabled = enabled;
      button.setAttribute("aria-checked", enabled);
    });
    if (typeof syncCodexPlusSettingsModelInputs === "function") syncCodexPlusSettingsModelInputs();
    syncCodexPlusSettingsCatalogDescriptions();
  }

  /** 刷新设置页的开关与菜单。跟着设置走的功能由内置拓展订阅 settings/loaded、settings/changed 自己对齐，这里不点名。 */
  function refreshCodexPlusBackendToggles() {
    syncCodexPlusBackendToggleButtons();
    renderCodexPlusMenu();
    scan();
  }

  let codexPlusBuiltinInventory = { builtins: [], scripts: [] };
  let codexPlusBuiltinInventoryLoaded = false;

  let codexPlusBackendStatus = window.__codexPlusBackendStatus || { status: "checking", message: "正在检查后端…" };
  let codexPlusBackendCheckSeq = 0;
  let codexPlusBackendCheckInFlight = false;
  let codexPlusBackendFailureCount = 0;
  const CODEX_PLUS_BACKEND_FAILURE_THRESHOLD = 3;
  // 桥接通道（binding）与后端可用性分开统计：HTTP 回落成功会让后端状态保持绿色，
  // 但桥接持续失败时必须把降级呈现出来，否则启动器侧的重注入修复循环对用户完全不可见（issue #2169）。
  let codexPlusBridgeFailureCount = 0;
  const CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD = 3;
  const codexPlusBackendGeneration = (Number(window.__codexPlusBackendGeneration) || 0) + 1;
  window.__codexPlusBackendGeneration = codexPlusBackendGeneration;

  function recordCodexPlusBridgeHealth(field) {
    if (codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
    const health = window.__codexPlusBridgeHealth || (window.__codexPlusBridgeHealth = {});
    health[field] = Date.now();
  }

  function recordCodexPlusBridgeSuccess() {
    recordCodexPlusBridgeHealth("lastSuccessAt");
    if (codexPlusBackendGeneration === window.__codexPlusBackendGeneration) {
      const health = window.__codexPlusBridgeHealth || (window.__codexPlusBridgeHealth = {});
      health.failures = 0;
    }
    codexPlusBridgeFailureCount = 0;
  }

  function recordCodexPlusBridgeAttempt() {
    recordCodexPlusBridgeHealth("lastAttemptAt");
  }

  function recordCodexPlusBridgeFailure() {
    codexPlusBridgeFailureCount += 1;
    if (codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
    // 看门狗只能读到 window 上的 health 快照：不落 failures/lastFailureAt，
    // CDP 连接断掉后它会一直把“还在尝试”当成桥接存活，永久不重注入。
    const health = window.__codexPlusBridgeHealth || (window.__codexPlusBridgeHealth = {});
    health.lastFailureAt = Date.now();
    health.failures = codexPlusBridgeFailureCount;
  }

  function renderBackendStatus() {
    const bridgeDegraded = codexPlusBridgeFailureCount >= CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD;
    const rawStatus = codexPlusBackendStatus.status || "failed";
    const status = bridgeDegraded && rawStatus === "ok" ? "degraded" : rawStatus;
    if (codexPlusBackendStatus.version) {
      codexPlusVersion = codexPlusBackendStatus.version;
      document.querySelectorAll("[data-codex-plus-version]").forEach((node) => {
        node.textContent = `Codex Pilot ${codexPlusVersion}`;
      });
    }
    const labelFallback = status === "ok" ? "后端已连接" : status === "degraded" ? "桥接降级，自动修复中" : status === "checking" ? "正在检查后端…" : "未连接";
    const label = document.querySelector("[data-codex-backend-status]");
    if (label) {
      label.dataset.status = status;
      label.textContent = status === "degraded" ? labelFallback : (codexPlusBackendStatus.message || labelFallback);
    }
    document.querySelectorAll("[data-codex-backend-indicator]").forEach((indicator) => {
      indicator.dataset.status = status;
      indicator.title = status === "ok" ? "后端已连接" : status === "degraded" ? "后端可达，桥接降级，正在自动修复" : status === "checking" ? "正在检查后端" : "未连接";
    });
  }

  function withBackendTimeout(request) {
    return Promise.race([
      request,
      new Promise((resolve) => setTimeout(() => resolve({ status: "failed", message: "后端检查超时", timeout: true }), 2000)),
    ]);
  }

  async function checkBackendStatus() {
    if (codexPlusBackendCheckInFlight) return;
    codexPlusBackendCheckInFlight = true;
    const seq = ++codexPlusBackendCheckSeq;
    try {
      const nextStatus = await postJson("/backend/status", {});
      if (seq !== codexPlusBackendCheckSeq || codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
      if (nextStatus?.status === "ok") {
        codexPlusBackendFailureCount = 0;
        codexPlusBackendStatus = window.__codexPlusBackendStatus = nextStatus;
        void syncBackendSettingsFromHeartbeat();
      } else {
        codexPlusBackendFailureCount += 1;
        sendCodexPlusDiagnostic("backend_check_failed", {
          status: nextStatus?.status || "unknown",
          message: nextStatus?.message || "",
          timeout: !!nextStatus?.timeout,
          consecutiveFailures: codexPlusBackendFailureCount,
        });
        if (codexPlusBackendFailureCount >= CODEX_PLUS_BACKEND_FAILURE_THRESHOLD) {
          codexPlusBackendStatus = window.__codexPlusBackendStatus = nextStatus;
        }
      }
      renderBackendStatus();
    } finally {
      codexPlusBackendCheckInFlight = false;
    }
  }

  async function openManagerFromCodex() {
    const result = await postJson("/manager/open", {});
    if (result.status === "ok") {
      showToast("管理工具已打开", null);
    } else {
      showToast(result.message || "打开管理工具失败", null);
    }
  }

  function scheduleBackendHeartbeat() {
    if (codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
    if (window.__codexPlusBackendHeartbeat &&
        window.__codexPlusBackendHeartbeatGeneration === codexPlusBackendGeneration) return;
    if (window.__codexPlusBackendHeartbeat) clearInterval(window.__codexPlusBackendHeartbeat);
    window.__codexPlusBackendHeartbeatGeneration = codexPlusBackendGeneration;
    window.__codexPlusBackendHeartbeat = setInterval(checkBackendStatus, 5000);
    checkBackendStatus();
  }

  async function loadCodexPlusBuiltinInventory(path = "/user-scripts/list", payload = {}) {
    const requestPayload = path === "/user-scripts/list"
      ? { ...payload, runtime_status: window.__codexPlusUserScripts?.scripts || {} }
      : payload;
    const result = await postJson(path, requestPayload);
    if (Array.isArray(result?.builtins)) {
      codexPlusBuiltinInventory = result;
      codexPlusBuiltinInventoryLoaded = true;
      syncCodexPlusBuiltinExtensionToggles();
    }
  }

  /**
   * 我们的页面是叠加在 Codex 上的，Codex 不知道，所以它自己那个 destination
   * 的选中态会一直留着，表现为 rail 上同时亮两个。页面打开时给根节点打标记，
   * 由 CSS 把原生选中项压成未选中；关掉即移除标记，原生状态自动恢复。
   *
   * 未选中的颜色取自当前主题下真实的未选中项，避免把深浅色写死。
   */
  function syncCodexPlusRailNativeSelection() {
    const root = document.documentElement;
    if (!root) return;
    if (!document.querySelector(`.${codexPlusPageClass}`)) {
      root.removeAttribute("data-codex-plus-page-open");
      root.style.removeProperty("--codex-plus-rail-dim");
      return;
    }
    const rail = document.querySelector(codexPlusRailSelector);
    const unselected = rail?.querySelector(`${codexPlusRailDestinationSelector}:not([aria-current="page"])`);
    const dim = unselected ? getComputedStyle(unselected).color : "";
    if (dim) root.style.setProperty("--codex-plus-rail-dim", dim);
    root.setAttribute("data-codex-plus-page-open", "");
  }

  function positionCodexPlusPage(overlay) {
    if (!overlay?.classList?.contains(codexPlusPageClass)) return;
    const sidebar = document.querySelector("aside.app-shell-left-panel");
    const rect = sidebar?.getBoundingClientRect?.();
    const main = document.querySelector("main");
    const rail = document.querySelector(codexPlusRailSelector);
    const railRect = rail?.getBoundingClientRect?.();
    // 新版：页面要顶替原生侧边栏——从图标栏右边界起铺满，把宽面板整个盖住，
    // 而不是并排在其右侧多出一列（那样会变成「图标栏 + 会话列表 + 我们的面板」三段）。
    // 旧版没有图标栏，我们的入口就在 aside 内部，此时退回 aside 右边界。
    const left = railRect && railRect.width > 0
      ? Math.max(0, railRect.right)
      : (rect && rect.width > 0 ? Math.max(0, rect.right) : 0);
    // 量出来的是视觉坐标，而 overlay 在缩放空间里布局，所以统一折算成布局坐标。
    // CSS 的 calc(100vw / zoom - left) 用的也是这个空间的量，两边才配得上。
    const zoom = codexPlusWindowZoom();
    const layoutLeft = zoom === 1 ? left : left / zoom;
    overlay.style.setProperty("--codex-plus-page-left", `${layoutLeft}px`);
    overlay.style.left = `${layoutLeft}px`;
    // 官方顶部有一条 header（返回/前进/隐藏侧边栏），图标栏与侧边栏都从它的下沿开始。
    // 我们的 overlay 若从 y=0 铺满就会把整条 header 盖住——用户反馈「比官方少了一条顶部栏」
    // 就是这个原因。这里同样量图标栏的顶边（而非硬编码高度），让 overlay 从 header 下沿开始。
    const top = railRect && railRect.height > 0
      ? Math.max(0, railRect.top)
      : (rect && rect.height > 0 ? Math.max(0, rect.top) : 0);
    const layoutTop = zoom === 1 ? top : top / zoom;
    overlay.style.setProperty("--codex-plus-page-top", `${layoutTop}px`);
    overlay.style.top = `${layoutTop}px`;
    // 右侧与下方官方各留了一圈槽：整行的 [data-app-shell-workspace-row] 比视口小
    // （真机 1715x984 / 视口 1719x988，即右、下各 4px），官方内容面板正好收在行的右下角。
    // 我们原先 right/bottom 都贴 0，于是比官方多占这 4px。这里量取而不是硬编码 4。
    const row = document.querySelector("[data-app-shell-workspace-row]");
    const rowRect = row?.getBoundingClientRect?.();
    const rightGutter = rowRect && rowRect.width > 0 ? Math.max(0, window.innerWidth - rowRect.right) : 0;
    const bottomGutter = rowRect && rowRect.height > 0 ? Math.max(0, window.innerHeight - rowRect.bottom) : 0;
    const layoutRight = zoom === 1 ? rightGutter : rightGutter / zoom;
    const layoutBottom = zoom === 1 ? bottomGutter : bottomGutter / zoom;
    overlay.style.setProperty("--codex-plus-page-right", `${layoutRight}px`);
    overlay.style.setProperty("--codex-plus-page-bottom", `${layoutBottom}px`);
    overlay.style.right = `${layoutRight}px`;
    overlay.style.bottom = `${layoutBottom}px`;
    // 圆角同样量取官方面板自身的值，不写死 12px。
    // 这里量的是 _PageSurface_：官方那个与我们 overlay 同格子的页面面板（rect 都是
    // [52, 44, 1663, 940]），它四角同为 12px，左侧那一角也真实可见——真机像素扫描确认
    // 官方左边缘从 y=44 的 x=62 收到 y=54 的 x=52，是一条完整的弧。
    // 别改用 main[data-app-shell-main-surface] 的 --app-shell-main-surface-clip-start-radius：
    // 那个元素左边缘在 362（缩在侧边栏后面），左侧还用 inset 负内缩把圆角裁掉，start 恒为 0，
    // 会让人误判左侧不该圆——第一版就是这么写错的，用户反馈「少一个圆角」正是缺了左边两个角。
    // 类名是 CSS Modules 的哈希名，但 _PageSurface_ 这个片段稳定，且不会命中 _PageSurfaceLayout_
    //（其后紧跟 L 而非 _）。量到的是视觉值，同样折算成布局坐标。读不到就保持 0，不做猜测。
    const pageSurface = document.querySelector('[class*="_PageSurface_"]');
    const pageSurfaceStyle = pageSurface ? getComputedStyle(pageSurface) : null;
    const mainSurfaceStyle = (() => {
      const main = document.querySelector("main[data-app-shell-main-surface]");
      return main ? getComputedStyle(main) : null;
    })();
    const radius =
      parseFloat(pageSurfaceStyle?.borderTopLeftRadius || "") ||
      parseFloat(mainSurfaceStyle?.getPropertyValue("--app-shell-main-surface-clip-end-radius") || "") ||
      0;
    const layoutRadius = zoom === 1 ? radius : radius / zoom;
    overlay.style.setProperty("--codex-plus-page-radius", `${layoutRadius}px`);
    if (window.__codexPlusPageLayoutObserver &&
        (window.__codexPlusPageLayoutTargets?.main !== main ||
         window.__codexPlusPageLayoutTargets?.sidebar !== sidebar ||
         window.__codexPlusPageLayoutTargets?.rail !== rail)) {
      window.__codexPlusPageLayoutObserver.disconnect();
      for (const target of new Set([main, sidebar, rail])) {
        if (target) window.__codexPlusPageLayoutObserver.observe(target);
      }
      window.__codexPlusPageLayoutTargets = { main, sidebar, rail };
    }
  }

  function observeCodexPlusPageLayout(overlay) {
    window.__codexPlusPageLayoutObserver?.disconnect();
    window.removeEventListener("resize", window.__codexPlusPageResizeHandler);
    const reposition = () => {
      if (overlay.isConnected) positionCodexPlusPage(overlay);
    };
    window.__codexPlusPageLayoutObserver = new ResizeObserver(reposition);
    window.__codexPlusPageLayoutTargets = {};
    window.__codexPlusPageResizeHandler = reposition;
    window.addEventListener("resize", reposition);
    positionCodexPlusPage(overlay);
    syncCodexPlusPageBackButton();
  }

  function codexPlusHostUsesLightTheme() {
    const root = document.documentElement;
    const body = document.body;
    const explicitTheme = [
      root?.getAttribute("data-theme"),
      body?.getAttribute("data-theme"),
      root?.getAttribute("data-color-scheme"),
      body?.getAttribute("data-color-scheme"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/\b(light|light-mode|theme-light)\b/.test(explicitTheme)) return true;
    if (/\b(dark|dark-mode|theme-dark)\b/.test(explicitTheme)) return false;

    const themeClasses = [root?.className, body?.className]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (/(^|\s)(light|light-mode|theme-light)(\s|$)/.test(themeClasses)) return true;
    if (/(^|\s)(dark|dark-mode|theme-dark)(\s|$)/.test(themeClasses)) return false;

    return !window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  }

  /**
   * 取 Codex 当前的界面缩放系数。
   *
   * Codex 的界面缩放的实现是给内层布局节点设 CSS `zoom`（例如 1.2），而不是改
   * documentElement，所以固定在 body 下的 overlay 不会自动跟随。这里把它读出来，
   * 由 applyCodexPlusZoom 自己套上。
   */
  function codexPlusWindowZoom() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(codexPlusWindowZoomVar);
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  /**
   * 让 overlay 跟随 Codex 的界面缩放，并保持满屏。
   *
   * 直接给 fixed 元素设 zoom 的话，它自身的 `inset: 0` / `100vw` 都还是按未缩放的
   * 视口算，再乘 zoom 就溢出（实测 zoom=1.2 时 100vw 得到 2072px，视口只有 1727）。
   * 所以 overlay 自身的尺寸改用 `calc(100vw / var(--codex-plus-zoom))` 抵消，
   * 内部子元素则用百分比——它们在缩放空间里，百分比本来就对。
   *
   * 字号不在这里动：由 CSS 跟随 zoom 自然放大，与原生行为一致。
   */
  function applyCodexPlusZoom(overlay) {
    if (!overlay?.style) return 1;
    const zoom = codexPlusWindowZoom();
    overlay.style.setProperty("--codex-plus-zoom", String(zoom));
    if (zoom === 1) {
      overlay.style.removeProperty("zoom");
      return 1;
    }
    overlay.style.setProperty("zoom", String(zoom));
    return zoom;
  }

  /**
   * 用 Codex 自己的语义令牌刷新 overlay 的变量。
   *
   * 早先这里内联写死了一套 zinc 调色板（深色正文 #f3f4f6、次要 #a1a1aa），
   * 内联优先级最高，把样式表里本来正确的令牌链整个盖掉了，表现为我们的文字
   * 比原生偏白偏冷。现在改成读宿主算好的值——取不到才回落到兜底色，
   * 这样浅色/深色主题都跟原生同源，也不会在 Codex 调色板变动后失配。
   */
  function applyCodexPlusTheme(overlay) {
    if (!overlay?.style) return;
    const light = codexPlusHostUsesLightTheme();
    const host = getComputedStyle(document.documentElement);
    const read = (names, fallback) => {
      for (const name of names) {
        const value = host.getPropertyValue(name).trim();
        if (value) return value;
      }
      return fallback;
    };
    const variables = {
      "--codex-plus-bg-primary": read(
        ["--color-token-bg-primary", "--token-bg-primary", "--app-color-background-surface"],
        light ? "#ffffff" : "#141414",
      ),
      "--codex-plus-bg-secondary": read(
        ["--color-token-bg-secondary", "--token-bg-secondary", "--color-surface-secondary"],
        light ? "#f7f7f7" : "#2f2f2f",
      ),
      "--codex-plus-bg-elevated": read(
        ["--color-token-dropdown-background", "--color-surface-elevated-secondary", "--color-token-bg-elevated-secondary"],
        light ? "#ffffff" : "#2f2f2f",
      ),
      // 设置页使用独立 surface，正文背景令牌在部分版本中比原生设置页更深。
      "--codex-plus-settings-page-bg": read(
        ["--color-background-surface", "--app-color-background-surface"],
        light ? "#ffffff" : "#181818",
      ),
      "--codex-plus-nav-bg": read(
        ["--color-token-sidebar-background", "--color-background-sidebar"],
        light ? "#f7f7f7" : "#1e1e1e",
      ),
      "--codex-plus-nav-selected-bg": read(
        ["--color-token-interactive-bg-secondary-selected", "--color-background-primary-soft-active"],
        light ? "#e9e9e9" : "#2f2f2f",
      ),
      "--codex-plus-settings-card-bg": read(
        ["--color-background-surface-secondary", "--color-background-surface-raised"],
        light ? "#f7f7f7" : "#232323",
      ),
      "--codex-plus-switch-on": read(
        ["--color-background-accent-solid", "--color-token-bg-accent"],
        "#3485ff",
      ),
      "--codex-plus-switch-off": read(
        ["--color-background-switch-off", "--color-background-secondary-solid"],
        light ? "#dedede" : "#3a3a3a",
      ),
      "--codex-plus-switch-thumb": read(
        ["--color-background-switch-thumb"],
        "#ffffff",
      ),
      "--codex-plus-bg-hover": read(
        ["--color-token-interactive-bg-secondary-hover", "--color-background-primary-soft-hover", "--token-list-hover-background"],
        light ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.08)",
      ),
      "--codex-plus-bg-selected": read(
        ["--color-token-interactive-bg-secondary-selected", "--color-background-primary-soft-active"],
        light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.12)",
      ),
      "--codex-plus-text": read(
        ["--color-token-text-primary", "--color-text-primary", "--token-text-primary"],
        light ? "#171717" : "#dfdfdf",
      ),
      "--codex-plus-text-secondary": read(
        ["--color-token-text-secondary", "--color-text-secondary-solid", "--color-text-secondary"],
        light ? "#5d5d5d" : "rgba(255,255,255,.71)",
      ),
      "--codex-plus-text-tertiary": read(
        ["--color-token-text-tertiary", "--color-text-tertiary"],
        light ? "#8a8a8a" : "rgba(255,255,255,.498)",
      ),
      "--codex-plus-border": read(
        ["--color-token-border-default", "--color-token-border", "--color-border-primary-outline"],
        light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.084)",
      ),
      "--codex-plus-border-subtle": read(
        ["--color-token-border-subtle", "--color-border-disabled"],
        light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.06)",
      ),
      "--codex-plus-danger": read(
        ["--color-text-danger", "--color-token-text-error"],
        light ? "#dc2626" : "#ff6764",
      ),
      "--codex-plus-success": read(
        ["--color-text-success", "--app-color-text-success"],
        light ? "#15803d" : "#40c977",
      ),
      "--codex-plus-warning": read(
        ["--color-text-warning", "--color-text-caution-surface"],
        light ? "#a16207" : "#ffc300",
      ),
    };
    Object.entries(variables).forEach(([name, value]) => overlay.style.setProperty(name, value));
    overlay.dataset.codexPlusTheme = light ? "light" : "dark";
  }

  // ── 设置项清单 ──────────────────────────────────────────────────────────────
  // 设置页里每个开关的标题、说明、分组都来自后端 /settings/catalog，
  // 与管理器「Codex → 内置拓展」页 import 的是同一份 JSON（crates/codex-plus-core/assets/enhancement-settings.json）。
  // 每个功能是一个内置拓展：开关就是它对应的设置项，子选项（清单里 parent 指向它）缩进排在它下面；
  // 没有设置项的内置拓展（清单顶层 builtins）经 /user-scripts/set-script-enabled 启停。
  // 这里不写任何一份设置文案：拿不到清单时只显示原因与重试，绝不退回写死的副本。
  let codexPlusSettingsCatalog = null;
  // idle / loading / failed / ok。idle 与 loading 渲染相同的“正在读取”。
  let codexPlusSettingsCatalogStatus = { status: "idle", message: "" };
  let codexPlusSettingsCatalogRequest = null;

  function normalizeCodexPlusSettingsCatalog(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.groups) || !Array.isArray(value.items)) return null;
    const groups = value.groups.filter((group) => group && typeof group.id === "string" && typeof group.title === "string");
    const items = value.items.filter((item) => item && typeof item.key === "string" && typeof item.group === "string"
      && typeof item.title === "string" && Array.isArray(item.surfaces));
    const builtins = (Array.isArray(value.builtins) ? value.builtins : []).filter((entry) => entry && typeof entry.id === "string"
      && typeof entry.group === "string" && typeof entry.title === "string");
    return groups.length && items.length ? { groups, items, builtins } : null;
  }

  function codexPlusSettingsCatalogItemVisible(item) {
    const platform = codexPlusIsWindowsPlatform ? "windows" : codexPlusIsMacPlatform ? "macos" : "linux";
    return item.surfaces.includes("codex") && (!Array.isArray(item.platforms) || item.platforms.includes(platform));
  }

  /** 读一次清单并缓存；失败后由设置页上的「重试」再次触发。 */
  function loadCodexPlusSettingsCatalog() {
    if (codexPlusSettingsCatalog) return Promise.resolve(codexPlusSettingsCatalog);
    if (codexPlusSettingsCatalogRequest) return codexPlusSettingsCatalogRequest;
    const retrying = codexPlusSettingsCatalogStatus.status === "failed";
    codexPlusSettingsCatalogStatus = { status: "loading", message: "" };
    if (retrying) refreshCodexPlusSettingsCatalogView();
    codexPlusSettingsCatalogRequest = Promise.resolve()
      .then(() => postJson("/settings/catalog", {}))
      .then((result) => {
        const catalog = normalizeCodexPlusSettingsCatalog(result);
        if (catalog) {
          codexPlusSettingsCatalog = catalog;
          codexPlusSettingsCatalogStatus = { status: "ok", message: "" };
          return;
        }
        const message = result?.status === "failed" && result.message ? String(result.message) : "后端返回的设置项清单格式不正确";
        codexPlusSettingsCatalogStatus = { status: "failed", message };
      }, (error) => {
        codexPlusSettingsCatalogStatus = { status: "failed", message: error?.message || String(error) };
      })
      .then(() => {
        codexPlusSettingsCatalogRequest = null;
        if (codexPlusSettingsCatalogStatus.status === "failed") {
          sendCodexPlusDiagnostic("settings_catalog_load_failed", { message: codexPlusSettingsCatalogStatus.message });
        }
        refreshCodexPlusSettingsCatalogView();
        return codexPlusSettingsCatalog;
      });
    return codexPlusSettingsCatalogRequest;
  }

  function renderCodexPlusSettingsSection(title, rows) {
    const label = escapeHtml(title);
    return `
            <section class="codex-plus-settings-section" aria-label="${label}" data-codex-plus-settings-catalog="section">
              <h2 class="codex-plus-settings-section-title">${label}</h2>
              <div class="codex-plus-settings-card">${rows}</div>
            </section>`;
  }

  /** 后端连接状态不是设置项，固定放在第一组的最前面（清单读取失败时也要能看到它）。 */
  function renderCodexPlusBackendStatusRow() {
    return `
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">后端连接</div><div class="codex-plus-row-description">每 5 秒检查一次 launcher 后端状态。</div></div>
                  <div class="codex-plus-backend-status">
                    <div class="codex-plus-backend-label" data-codex-backend-status="true" data-status="checking">正在检查后端…</div>
                  </div>
                </div>`;
  }

  /**
   * 只在 Codex 设置页出现的行内输入框（值存在本页 localStorage，管理器读不到）。
   * 清单只给读屏标签与悬停提示；取值范围、当前值仍由运行时常量和读写函数决定。
   */

  /** 清单 key 是 BackendSettings 字段；能映射到本页设置 key 的走 setCodexPlusSetting（带即时副作用）。 */
  function codexPlusLocalSettingKey(backendKey) {
    return Object.keys(codexPlusBackendSettingMap).find((key) => codexPlusBackendSettingMap[key] === backendKey) || "";
  }

  function codexPlusSettingsCatalogDescription(item) {
    return item.description || "";
  }

  /** 清单刷新时同步行文案和原生 Fast 自检状态。 */
  function syncCodexPlusSettingsCatalogDescriptions() {
    if (!codexPlusSettingsCatalog) return;
    document.querySelectorAll("[data-codex-plus-setting-description]").forEach((node) => {
      const key = node.getAttribute("data-codex-plus-setting-description");
      const item = codexPlusSettingsCatalog.items.find((candidate) => candidate.key === key);
      const description = item ? codexPlusSettingsCatalogDescription(item) : "";
      if (item && node.textContent !== description) node.textContent = description;
    });
    syncCodexPlusNativeFastStatus();
  }

  // 原生 Fast 的自检结果：补丁是否真的打进了当前 Codex。Codex 更新后结构变了时，
  // 用户在这里就能看到「暂未适配」和原因，不用再猜按钮为什么不见了。
  function codexPlusNativeFastStatusText() {
    if (codexPlusBackendSettings.enhancementsEnabled === false || codexPlusBackendSettings.codexAppNativeFastUnlock !== true) return "";
    const state = window.__codexPlusNativeFastPatchState;
    if (window.__codexPlusNativeFastCompiled === "v1" || state === "patched") return "已生效：当前 Codex 版本已适配。";
    if (state === "failed" || state === "unsupported") {
      const reason = String(window.__codexPlusNativeFastFailureReason || window.__codexPlusNativeFastModuleDiagnostics?.reason || "").slice(0, 120);
      return `当前 Codex 版本暂未适配，Fast 开关不会出现${reason ? `（${reason}）` : ""}。请把 codex-plus.log 里 bridge.native_module_patch_prepared 那一行反馈给我们。`;
    }
    return "";
  }

  function syncCodexPlusNativeFastStatus() {
    document.querySelectorAll("[data-codex-plus-native-fast-status]").forEach((node) => {
      const text = codexPlusNativeFastStatusText();
      const failed = String(!!text && !text.startsWith("已生效"));
      if (node.textContent !== text) node.textContent = text;
      if (node.hidden !== !text) node.hidden = !text;
      if (node.dataset.failed !== failed) node.dataset.failed = failed;
    });
  }

  // 与管理器增强页一致：「（实验）」从标题里拿出来做成小标签；说明里写了要重启 Codex 的，标题旁加「需重启」。
  const codexPlusExperimentalTitle = /\s*(?:（实验性?）|\(experimental\))$/i;
  const codexPlusRestartHint = /重启 ?Codex|重新启动 ?Codex|下次启动 ?Codex|restart(?:ing)? Codex|relaunch/i;

  function renderCodexPlusSettingsCatalogTitle(item, description) {
    const experimental = codexPlusExperimentalTitle.test(item.title);
    const tags = [
      experimental ? '<em class="codex-plus-feature-tag" data-tone="experimental">实验</em>' : "",
      item.restart === true || codexPlusRestartHint.test(description) ? '<em class="codex-plus-feature-tag">需重启</em>' : "",
    ].join("");
    return escapeHtml(experimental ? item.title.replace(codexPlusExperimentalTitle, "") : item.title) + tags;
  }

  /** 优先使用已加载模型目录；目录不可用时回退当前供应商配置。 */
  function codexPlusSettingsModelNames() {
    const catalogNames = typeof codexPlusModelNames === "function" ? codexPlusModelNames() : [];
    const profiles = Array.isArray(codexPlusBackendSettings.relayProfiles) ? codexPlusBackendSettings.relayProfiles : [];
    const profile = profiles.find((entry) => entry.id === codexPlusBackendSettings.activeRelayId);
    const names = Array.isArray(catalogNames) && catalogNames.length ? catalogNames : [
      codexPlusBackendSettings.activeRelayProfilePublic?.model,
      profile?.model,
      ...(typeof profile?.modelList === "string" ? profile.modelList.split(/[\r\n,]+/) : []),
    ];
    return [...new Set(names.filter((name) => typeof name === "string").map((name) => {
      const trimmed = name.trim();
      // 与管理器 modelSlugFromRowName 一致，只去掉合法的正整数窗口后缀。
      const match = /^(.*?)\[(\d+)([KkMm])?\]$/.exec(trimmed);
      const tokens = match ? Number(match[2]) * (match[3]?.toLowerCase() === "m" ? 1000000 : match[3] ? 1000 : 1) : 0;
      return match && Number.isSafeInteger(tokens) && tokens > 0 ? match[1].trim() : trimmed;
    }).filter(Boolean))];
  }

  function codexPlusSettingsModelDisabled(item) {
    return (item.masterGated !== false && codexPlusBackendSettings.enhancementsEnabled === false)
      || (item.parent === "native-predictions" && codexPlusBackendSettings.codexAppNativePredictions !== true);
  }

  function renderCodexPlusSettingsModelOptions() {
    return codexPlusSettingsModelNames().map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
  }

  /** 心跳与本页保存后同步输入框；聚焦中的草稿由用户继续编辑。 */
  function syncCodexPlusSettingsModelInputs() {
    document.querySelectorAll("input[data-codex-backend-model-setting]").forEach((input) => {
      const key = input.getAttribute("data-codex-backend-model-setting");
      const item = codexPlusSettingsCatalog?.items.find((entry) => entry.key === key && entry.control === "model");
      if (!item) return;
      const disabled = codexPlusSettingsModelDisabled(item);
      if (input.disabled !== disabled) input.disabled = disabled;
      if (document.activeElement === input) return;
      const value = String(codexPlusBackendSettings[key] ?? "");
      if (input.value !== value) input.value = value;
      const list = input.list;
      const options = renderCodexPlusSettingsModelOptions();
      if (list && list.innerHTML !== options) list.innerHTML = options;
    });
  }

  function renderCodexPlusSettingsCatalogRow(item, options = {}) {
    const title = escapeHtml(item.title);
    let control = "";
    if (item.control === "bool") {
      const localKey = codexPlusLocalSettingKey(item.key);
      const binding = localKey ? `data-codex-plus-setting="${escapeHtml(localKey)}"` : `data-codex-backend-setting="${escapeHtml(item.key)}"`;
      const toggle = `<button type="button" class="codex-plus-toggle" ${binding} role="switch" aria-checked="false" aria-label="${title}"><span></span></button>`;
      control = toggle;
    } else if (item.control === "model") {
      const key = escapeHtml(item.key);
      const listId = `codex-plus-setting-models-${key}`;
      const value = escapeHtml(String(codexPlusBackendSettings[item.key] ?? ""));
      const placeholder = escapeHtml(item.placeholder || "跟随当前对话");
      control = `<input type="text" class="codex-plus-width-input codex-plus-model-input" data-codex-backend-model-setting="${key}" aria-label="${title}" placeholder="${placeholder}" value="${value}" list="${listId}" spellcheck="false"${codexPlusSettingsModelDisabled(item) ? " disabled" : ""} /><datalist id="${listId}">${renderCodexPlusSettingsModelOptions()}</datalist>`;
    }
    // 不认识的控件类型宁可不显示，也不显示一个点了不生效的行。
    if (!control) return "";
    // 设置页文案统一从共享清单读取。
    const rawDescription = codexPlusSettingsCatalogDescription(item);
    const description = escapeHtml(rawDescription);
    const descriptionData = ` data-codex-plus-setting-description="${escapeHtml(item.key)}"`;
    const builtin = item.builtin ? ` data-codex-plus-builtin="${escapeHtml(item.builtin)}"` : "";
    const param = options.param ? " data-codex-plus-builtin-param=\"true\"" : "";
    return `
                <div class="codex-plus-row" data-codex-plus-setting-row="${escapeHtml(item.key)}"${builtin}${param}>
                  <div><div class="codex-plus-row-title">${renderCodexPlusSettingsCatalogTitle(item, rawDescription)}</div><div class="codex-plus-row-description"${descriptionData}>${description}</div>${item.key === "codexAppNativeFastUnlock" ? '<div class="codex-plus-row-description" data-codex-plus-native-fast-status="true" role="status" hidden></div>' : ""}</div>
                  ${control}
                </div>`;
  }

  /**
   * 清单顶层的内置拓展（桌宠等）：设置字段是本页认识的顶层字段就照常绑定设置；
   * 嵌套字段或没有设置字段的，开关走 /user-scripts/set-script-enabled（后台按清单写设置或记在用户脚本配置里）。
   */
  function renderCodexPlusBuiltinEntryRow(entry) {
    const title = escapeHtml(entry.title);
    const setting = typeof entry.setting === "string" && !entry.setting.includes(".") ? entry.setting : "";
    const localKey = setting ? codexPlusLocalSettingKey(setting) : "";
    const binding = localKey ? `data-codex-plus-setting="${escapeHtml(localKey)}"`
      : setting ? `data-codex-backend-setting="${escapeHtml(setting)}"`
        : `data-codex-builtin-extension="${escapeHtml(entry.id)}"`;
    return `
                <div class="codex-plus-row" data-codex-plus-builtin="${escapeHtml(entry.id)}">
                  <div><div class="codex-plus-row-title">${renderCodexPlusSettingsCatalogTitle(entry, entry.description || "")}</div><div class="codex-plus-row-description">${escapeHtml(entry.description || "")}</div></div>
                  <button type="button" class="codex-plus-toggle" ${binding} role="switch" aria-checked="false" aria-label="${title}"><span></span></button>
                </div>`;
  }

  /** 一组里的行：不属于任何内置拓展的设置（总开关等）在前，然后每个内置拓展一行、子选项紧跟其后。 */
  function renderCodexPlusSettingsGroupRows(catalog, group) {
    const visible = (item) => item.group === group.id && codexPlusSettingsCatalogItemVisible(item);
    const params = (id) => catalog.items.filter((item) => item.parent === id && codexPlusSettingsCatalogItemVisible(item))
      .map((item) => renderCodexPlusSettingsCatalogRow(item, { param: true }));
    return [
      ...catalog.items.filter((item) => visible(item) && !item.builtin && !item.parent).map((item) => renderCodexPlusSettingsCatalogRow(item)),
      ...catalog.items.filter((item) => visible(item) && item.builtin)
        .flatMap((item) => [renderCodexPlusSettingsCatalogRow(item), ...params(item.builtin)]),
      ...(catalog.builtins || []).filter((entry) => entry.group === group.id)
        .flatMap((entry) => [renderCodexPlusBuiltinEntryRow(entry), ...params(entry.id)]),
    ].filter(Boolean);
  }

  /**
   * 内置拓展开关（走用户脚本配置的那几个）与「已被顶替」提示，按后台给的内置拓展现状同步。
   * 提示写在说明元素的 data-codex-builtin-replaced 上，由样式接在说明后面显示。
   */
  function syncCodexPlusBuiltinExtensionToggles() {
    const builtins = new Map((codexPlusBuiltinInventory.builtins || []).map((builtin) => [builtin.id, builtin]));
    document.querySelectorAll(".codex-plus-toggle[data-codex-builtin-extension]").forEach((button) => {
      const builtin = builtins.get(button.getAttribute("data-codex-builtin-extension"));
      const enabled = String(builtin ? !!builtin.enabled : true);
      button.dataset.pending = String(!codexPlusBuiltinInventoryLoaded);
      if (button.dataset.enabled === enabled) return;
      button.dataset.enabled = enabled;
      button.setAttribute("aria-checked", enabled);
    });
    document.querySelectorAll(".codex-plus-row[data-codex-plus-builtin]").forEach((row) => {
      const replacedBy = builtins.get(row.getAttribute("data-codex-plus-builtin"))?.replacedBy;
      const text = replacedBy ? `已被 ${String(replacedBy).replace(/^user:/, "")} 顶替` : "";
      const description = row.querySelector(".codex-plus-row-description");
      if (!description) return;
      if (text) description.setAttribute("data-codex-builtin-replaced", text);
      else description.removeAttribute("data-codex-builtin-replaced");
    });
  }

  /** 页面里切换一个内置拓展：后台写设置或内置拓展状态，回来后同步开关与功能状态。 */
  async function setCodexPlusBuiltinExtensionEnabled(id, enabled) {
    await loadCodexPlusBuiltinInventory("/user-scripts/set-script-enabled", { key: `builtin:${id}`, enabled });
    const builtins = codexPlusBuiltinInventory.builtins || [];
    if (builtins.length) {
      window.__codexPlusBuiltinExtensionState = {
        disabled: builtins.filter((builtin) => !builtin.setting && !builtin.enabled).map((builtin) => builtin.id),
        replacedBy: Object.fromEntries(builtins.filter((builtin) => builtin.replacedBy).map((builtin) => [builtin.id, builtin.replacedBy])),
      };
      try { window.__codexPlusSyncBuiltinExtensions?.(); } catch {}
    }
    // 有设置字段的（桌宠等）后台改的是设置，重新读一次让功能跟上。
    await loadBackendSettings();
    syncCodexPlusBuiltinExtensionToggles();
  }

  /** 设置页主体：清单就绪时按分组生成，否则显示读取中 / 读取失败与重试。 */
  function renderCodexPlusSettingsCatalogSections() {
    const catalog = codexPlusSettingsCatalog;
    if (!catalog) {
      const failed = codexPlusSettingsCatalogStatus.status === "failed";
      const message = codexPlusSettingsCatalogStatus.message;
      const state = failed
        ? `
                <div class="codex-plus-row" data-codex-plus-settings-catalog-state="failed" role="alert">
                  <div><div class="codex-plus-row-title">设置项读取失败</div><div class="codex-plus-row-description">无法从 Codex Pilot 后端读取设置项清单${message ? `：${escapeHtml(message)}` : ""}。确认后端已连接后重试。</div></div>
                  <button type="button" class="codex-plus-action-button" data-codex-plus-settings-catalog-retry="true">重试</button>
                </div>`
        : `
                <div class="codex-plus-row" data-codex-plus-settings-catalog-state="loading" role="status">
                  <div><div class="codex-plus-row-title">正在读取设置项…</div><div class="codex-plus-row-description">设置项清单由 Codex Pilot 后端提供，读取完成后显示。</div></div>
                </div>`;
      return renderCodexPlusSettingsSection("设置", renderCodexPlusBackendStatusRow() + state);
    }
    if (!codexPlusBuiltinInventoryLoaded) void loadCodexPlusBuiltinInventory();
    return catalog.groups.map((group, index) => {
      const rows = renderCodexPlusSettingsGroupRows(catalog, group);
      if (index === 0) rows.unshift(renderCodexPlusBackendStatusRow());
      return rows.length ? renderCodexPlusSettingsSection(group.title, rows.join("")) : "";
    }).join("");
  }

  /** 清单状态变化后重建设置页里由清单生成的部分，并把开关状态同步回来。 */
  function refreshCodexPlusSettingsCatalogView() {
    let rendered = false;
    document.querySelectorAll('[data-codex-plus-panel="home"]').forEach((panel) => {
      const anchor = panel.querySelector("[data-codex-plus-settings-tools]");
      if (!anchor) return;
      const retryFocused = !!document.activeElement?.closest?.("[data-codex-plus-settings-catalog-retry]");
      panel.querySelectorAll("[data-codex-plus-settings-catalog]").forEach((node) => node.remove());
      anchor.insertAdjacentHTML("beforebegin", renderCodexPlusSettingsCatalogSections());
      if (retryFocused) {
        panel.querySelector("[data-codex-plus-settings-catalog-retry], [data-codex-plus-settings-catalog] .codex-plus-toggle")?.focus({ preventScroll: true });
      }
      rendered = true;
    });
    if (!rendered) return;
    renderBackendStatus();
    refreshCodexPlusBackendToggles();
    syncCodexPlusBuiltinExtensionToggles();
  }

  function openCodexPlusModal(options = {}) {
    closeCodexPlusPage();
    document.querySelectorAll(".codex-plus-modal-overlay").forEach((node) => node.remove());
    document.querySelectorAll(`.${codexPlusPageClass}, [data-codex-plus-dialog="true"]`).forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = "codex-plus-modal-overlay";
    overlay.dataset.codexPlusPage = "false";
    applyCodexPlusTheme(overlay);
    // 跟随 Codex 的界面缩放。必须在写 innerHTML 之前设好，否则内部那些
    // calc(100% / var(--codex-plus-zoom-inverse)) 会先按 1 算一遍再被 zoom 放大。
    applyCodexPlusZoom(overlay);
    // 下拉箭头与勾选图标使用已安装的 Lucide ChevronDown / Check（ISC）路径。
    overlay.innerHTML = `
      <div class="codex-plus-modal-content" role="dialog" aria-modal="true" aria-label="Codex Pilot">
        <div class="codex-plus-modal-header">
          <div class="codex-plus-modal-title"><span class="codex-plus-backend-indicator" data-codex-backend-indicator="true" data-status="checking"></span><span data-codex-plus-version="true">Codex Pilot ${codexPlusVersion}</span></div>
          <button type="button" class="codex-plus-modal-close" aria-label="关闭">×</button>
        </div>
        <div class="codex-plus-modal-body">
          <div class="codex-plus-panel codex-plus-settings" data-codex-plus-panel="home">
            ${renderCodexPlusSettingsCatalogSections()}
            <section class="codex-plus-settings-section" aria-label="工具与关于" data-codex-plus-settings-tools="true">
              <h2 class="codex-plus-settings-section-title">工具与关于</h2>
              <div class="codex-plus-settings-card">
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">管理工具</div><div class="codex-plus-row-description">配置增强功能和模型。</div></div>
                  <button type="button" class="codex-plus-action-button" data-codex-open-manager="true">打开管理工具</button>
                </div>
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">刷新 UI 配置</div><div class="codex-plus-row-description">手动请求当前 Statsig 客户端重新评估远程配置，并显示 enable_i18n 的结果。</div></div>
                  <button type="button" class="codex-plus-action-button" data-codex-refresh-statsig="true">刷新 UI 配置</button>
                </div>
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">打开 DevTools</div><div class="codex-plus-row-description">打开当前 Codex 页面开发者工具，方便排查增强功能。</div></div>
                  <button type="button" class="codex-plus-action-button" data-codex-open-devtools="true">打开 DevTools</button>
                </div>
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">关于 Codex Pilot</div><div class="codex-plus-about">Codex Pilot 是通过外部 launcher 注入的增强菜单，不修改 Codex App 原始安装文件。<br>Build: <span data-codex-plus-build="true">${codexPlusBuild}</span><br>GitHub: <a href="${codexPilotRepoUrl}" target="_blank" rel="noreferrer">${codexPilotRepoUrl}</a></div></div>
                </div>
                <div class="codex-plus-row">
                  <div><div class="codex-plus-row-title">提出问题</div><div class="codex-plus-row-description">打开 GitHub Issues 反馈问题或建议。</div></div>
                  <button type="button" class="codex-plus-issue-button" data-codex-plus-issue="true">提出问题</button>
                </div>
              </div>
            </section>
            ${renderCodexPlusExtensionMenuRows()}
          </div>
        </div>
      </div>
    `;
    overlay.querySelectorAll(".codex-plus-toggle[data-codex-plus-setting], .codex-plus-toggle[data-codex-backend-setting]").forEach((button) => {
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", "false");
      button.setAttribute("aria-label", button.closest(".codex-plus-row")?.querySelector(".codex-plus-row-title")?.textContent || "设置");
    });
    const closeButton = overlay.querySelector(".codex-plus-modal-close");
    closeButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      overlay.remove();
    }, true);
    overlay.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const modelInput = target?.closest("input[data-codex-backend-model-setting]");
      if (modelInput) {
        if (!modelInput.disabled) void setBackendSetting(modelInput.getAttribute("data-codex-backend-model-setting"), modelInput.value);
        return;
      }
    }, true);
    overlay.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      // 拓展注册的菜单项。放在最前面是因为它的判定完全基于自己的 data 属性，
      // 与下面那些内置分支不会重叠；万一将来重叠，也应当由拓展优先拿到。
      if (handleCodexPlusExtensionMenuClick(target)) return;
      if (target?.closest("[data-codex-plus-settings-catalog-retry]")) {
        void loadCodexPlusSettingsCatalog();
        return;
      }
      if (target?.closest("[data-codex-open-devtools]")) {
        postJson("/devtools/open", {});
        return;
      }
      if (target?.closest("[data-codex-open-manager]")) {
        openManagerFromCodex();
        return;
      }
      const refreshStatsigButton = target?.closest("[data-codex-refresh-statsig]");
      if (refreshStatsigButton) {
        const button = refreshStatsigButton;
        if (button.dataset.pending === "true") return;
        button.dataset.pending = "true";
        const originalLabel = button.textContent;
        button.textContent = "刷新中…";
        Promise.resolve(window.__codexPlusRefreshStatsigUiConfig?.())
          .then((result) => {
            if (!result || result.status === "unsupported") {
              showToast("当前 Codex 构建没有可用的 Statsig 刷新接口", null);
            } else if (result.status === "ok" && result.enable_i18n === true) {
              showToast("UI 配置已刷新，enable_i18n=true", null);
              // 只有用户主动点击且远端明确返回 true 时刷新页面，让 Codex
              // 重新走语言包加载 gate；不在启动/网络恢复路径自动触发。
              window.setTimeout(() => window.location.reload(), 150);
            } else if (result.status === "ok" && result.enable_i18n === false) {
              showToast("UI 配置已刷新，enable_i18n=false", null);
            } else {
              // showToast 的第二个参数若是字符串会被当成撤销 token（旧签名），
              // 错误详情必须拼进正文并以对象参数标明类型。
              const detail = result.errors?.join("；");
              showToast(`UI 配置刷新${result.status === "partial" ? "部分完成" : "失败"}${detail ? `：${detail}` : ""}`, { type: result.status === "partial" ? "warn" : "error" });
            }
          })
          .catch((error) => showToast(`UI 配置刷新失败：${error?.message || String(error)}`, { type: "error" }))
          .finally(() => {
            button.dataset.pending = "false";
            button.textContent = originalLabel || "刷新 UI 配置";
          });
        return;
      }
      const issueButton = target?.closest("[data-codex-plus-issue]");
      if (issueButton) {
        window.open(`${codexPilotRepoUrl}/issues`, "_blank");
        return;
      }
      const builtinToggle = target?.closest("[data-codex-builtin-extension]");
      if (builtinToggle) {
        if (builtinToggle.dataset.pending === "true") return;
        void setCodexPlusBuiltinExtensionEnabled(builtinToggle.getAttribute("data-codex-builtin-extension"), builtinToggle.dataset.enabled !== "true");
        return;
      }
      const toggle = target?.closest("[data-codex-plus-setting]");
      if (toggle) {
        if (toggle.disabled || toggle.dataset.pending === "true") return;
        const key = toggle.getAttribute("data-codex-plus-setting");
        setCodexPlusSetting(key, !codexPlusSettings({ ignoreBuiltins: true })[key]);
        return;
      }
      const backendToggle = target?.closest("[data-codex-backend-setting]");
      if (backendToggle) {
        const key = backendToggle.getAttribute("data-codex-backend-setting");
        setBackendSetting(key, !codexPlusBackendSettings[key]);
        return;
      }
    }, true);
    document.body.appendChild(overlay);
    renderCodexPlusMenu();
    refreshCodexPlusBackendToggles();
    renderBackendStatus();
    void loadCodexPlusBuiltinInventory();
    // 每次打开都重读一次：用户可能在 Codex 设置页（官方登录时可见）改过。
    // 清单已缓存时上面的模板已经按清单渲染；否则读完后再替换“正在读取”占位。
    if (!codexPlusSettingsCatalog) void loadCodexPlusSettingsCatalog();
  }

  function closeCodexPlusPage() {
    clearTimeout(window.__codexPlusPageNavigationCloseTimer);
    window.__codexPlusPageNavigationCloseTimer = null;
    window.removeEventListener("resize", window.__codexPlusPageResizeHandler);
    window.__codexPlusPageResizeHandler = null;
    window.__codexPlusPageLayoutObserver?.disconnect();
    window.__codexPlusPageLayoutObserver = null;
    window.__codexPlusPageLayoutTargets = null;
    document.querySelectorAll(`.${codexPlusPageClass}`).forEach((node) => node.remove());
    syncCodexPlusRailNativeSelection();
    restoreCodexPlusPageBackButton();
  }

  function codexPlusNativeBackButton() {
    const labels = new Set(["back", "go back", "返回", "后退"]);
    const selector = selectors.appHeader.split(",").map((header) => `${header.trim()} button`).join(", ");
    const buttons = Array.from(document.querySelectorAll(selector))
      .filter((button) => !button.closest(`.${codexPlusPageClass}, [data-codex-plus-ext]`));
    // 宿主的前进按钮复用返回箭头并水平翻转；路径识别不依赖界面语言。
    const backIcon = 'svg:not([class~="-scale-x-100"]) path[d^="M6.96231 2.96214C7.16727 2.7574"]';
    return buttons.find((button) => button.querySelector(backIcon)) || buttons.find((button) =>
      labels.has(String(button.getAttribute("aria-label") || button.title || "").trim().toLowerCase())) || null;
  }

  function restoreCodexPlusPageBackButton() {
    const state = window.__codexPlusPageBackButtonState;
    window.__codexPlusPageBackButtonState = null;
    if (!state) return;
    for (const [name, value] of state.attributes) {
      if (value === null) state.button.removeAttribute(name);
      else state.button.setAttribute(name, value);
    }
  }

  function syncCodexPlusPageBackButton() {
    if (window.__codexPlusPageNavigationCloseTimer != null) return;
    if (!document.querySelector(`.${codexPlusPageClass}`)) {
      restoreCodexPlusPageBackButton();
      return;
    }
    const button = codexPlusNativeBackButton();
    if (!button) return;
    if (window.__codexPlusPageBackButtonState?.button !== button) {
      restoreCodexPlusPageBackButton();
      window.__codexPlusPageBackButtonState = {
        button,
        attributes: ["disabled", "aria-disabled", "tabindex", "data-disabled"]
          .map((name) => [name, button.getAttribute(name)]),
      };
    }
    // 覆盖页自身可返回，即使原生历史尚无上一页也必须能点击。
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    button.removeAttribute("data-disabled");
    if (button.getAttribute("tabindex") === "-1") button.removeAttribute("tabindex");
  }

  function closeCodexPlusPageAfterNativeNavigation() {
    const page = document.querySelector(`.${codexPlusPageClass}`);
    if (!page) return;
    clearTimeout(window.__codexPlusPageNavigationCloseTimer);
    // 原生导航前撤销临时属性，避免延迟关闭覆盖导航提交后的返回状态。
    restoreCodexPlusPageBackButton();
    const timer = setTimeout(() => {
      if (window.__codexPlusPageNavigationCloseTimer !== timer) return;
      window.__codexPlusPageNavigationCloseTimer = null;
      if (document.querySelector(`.${codexPlusPageClass}`) === page) closeCodexPlusPage();
    }, 0);
    window.__codexPlusPageNavigationCloseTimer = timer;
  }

  function installCodexPlusPageNavigationCloseHandler() {
    syncCodexPlusPageBackButton();
    document.removeEventListener("click", window.__codexPlusPageNavigationCloseHandler, true);
    window.removeEventListener("click", window.__codexPlusPageNavigationCloseHandler, true);
    window.__codexPlusPageNavigationCloseHandler = (event) => {
      if (!document.querySelector(`.${codexPlusPageClass}`)) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const backButton = codexPlusNativeBackButton();
      if (backButton && target?.closest("button") === backButton) {
        // 原生界面仍在覆盖页下方，关闭即可；继续后退会跳过进入前的界面。
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCodexPlusPage();
        return;
      }
      if (!target?.closest(selectors.sidebarThread)) return;
      // Let Codex's own click handler update its route before removing our page.
      closeCodexPlusPageAfterNativeNavigation();
    };
    window.addEventListener("click", window.__codexPlusPageNavigationCloseHandler, true);
  }

  /**
   * 挑一个原生 rail 按钮当模板。
   *
   * 优先 builtin:projects——它在 primary 区，且不像 builtin:library 那样会走
   * tooltip/triggerRef 的特殊分支。找不到就退回第一个可见 destination。
   */
  function codexPlusRailTemplateButton(rail) {
    const preferred = rail.querySelector(`${codexPlusRailDestinationSelector}[data-sidebar-destination="builtin:projects"]`);
    if (preferred) return preferred;
    const candidates = Array.from(rail.querySelectorAll(codexPlusRailDestinationSelector))
      .filter((node) => node.closest("nav") === rail);
    // 优先挑未选中的：clone 会把选中态的属性和配色一起带过来，
    // 表现为入口在没有任何页面打开时也显示成选中。
    const isSelected = (node) => node.getAttribute("aria-current") === "page" || node.hasAttribute("data-selected");
    return candidates.find((node) => !isSelected(node)) || candidates[0] || null;
  }

  function codexPlusRailPrimaryAnchor(rail) {
    const fixedIds = [
      'builtin:home',
      'builtin:customize',
    ];
    const buttons = Array.from(rail.querySelectorAll(codexPlusRailDestinationSelector));
    return buttons.find((node) => {
      const id = node.getAttribute("data-sidebar-destination") || "";
      return id && !fixedIds.includes(id);
    }) || null;
  }

  /**
   * 入口按钮能否沿用。
   *
   * 同页重复注入（Codex Pilot 重启 / 升级而 Codex 没重启）时，上一次注入建的拓展按钮还在，
   * 按钮上绑的是旧闭包，需要在重建时换成当前拓展的回调。
   * 按钮记下建它的注入代次；最新一代遇到别代的按钮就重建。旧代即便还在跑也不重建，
   * 免得两代来回抢同一个 id。
   */
  function codexPlusNavEntryReusable(node) {
    return node.__codexPlusGeneration === codexPlusBackendGeneration
      || codexPlusBackendGeneration !== window.__codexPlusBackendGeneration;
  }

  function createCodexPlusRailButton({ id, template, label, iconMarkup, onActivate }) {
    const wrapper = document.createElement("div");
    wrapper.id = id;
    wrapper.__codexPlusGeneration = codexPlusBackendGeneration;
    wrapper.dataset.codexPlusRail = "extension";
    // 模板拿不到时不回退到旧模式，而是自建一个按钮：rail 上 destination 可能在
    // 登录态/接口就绪前还是空的，那只是暂时状态，不该让入口整个消失。
    const button = template
      ? template.cloneNode(true)
      : document.createElement("button");
    if (!(button instanceof HTMLElement)) return null;
    button.type = "button";
    // 留着 data-sidebar-destination 会被 Codex 的自定义/排序逻辑当成真的 destination。
    button.removeAttribute("data-sidebar-destination");
    button.removeAttribute("data-state");
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    // 选中态由 data-selected 驱动，但它只在没有 data-suppress-active-style 时生效。
    // 模板若是未选中的按钮，会带着 suppress 过来，压制掉我们的选中样式——
    // 必须移除，否则按钮永远停在未选中的暗色。
    button.removeAttribute("data-suppress-active-style");
    // 起始为未选中；激活态由 setCodexPlusExtensionNavActive 切换 data-selected。
    button.removeAttribute("data-selected");
    button.removeAttribute("aria-current");
    button.setAttribute("aria-label", label);
    // 不用 title：那会弹出系统自带的提示框，样式和位置都和原生按钮不一样。
    button.removeAttribute("title");
    attachCodexPlusRailTooltip(button, label);
    button.textContent = "";
    // 原生 rail 按钮是纯图标，没有文字标签。
    button.innerHTML = `<span class="codex-plus-rail-icon" aria-hidden="true">${iconMarkup}</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    }, true);
    wrapper.appendChild(button);
    return wrapper;
  }

  /**
   * 图标栏按钮的悬浮提示，外观与行为对齐原生按钮。
   *
   * 原生按钮的提示由 React（Radix Tooltip）渲染，我们复制出来的按钮接不上它，
   * 所以自己画：直接复用原生提示的样式类（深浅主题、版本更新都跟着走），找不到时
   * 用量出来的数值兜底。位置与时机照原生：按钮右侧 2px、垂直居中；悬停约 150ms
   * 出现，在相邻按钮间移动时（300ms 内）立即出现；按下、移出、失焦即消失。
   */
  const codexPlusRailTooltipDelayMs = 150;
  const codexPlusRailTooltipSkipDelayMs = 300;
  const codexPlusRailTooltipSideOffset = 2;
  const codexPlusComposerTooltipSideOffset = 6;
  let codexPlusRailTooltipTimer = null;
  let codexPlusRailTooltipHiddenAt = 0;
  let codexPlusRailTooltipOwner = null;
  let codexPlusNativeTooltipClassCache;

  /**
   * 原生提示的样式类名带构建哈希（如 _Tooltip_11i4f_2），每个版本都可能变，只能运行时找。
   * 它独有一条 `[data-side="bottom"][data-default-side-offset="true"]` 变体，用来和
   * 其它同名前缀的组件区分开。规则可能嵌在 @layer / @supports 里，要递归找。
   */
  function codexPlusNativeTooltipClass(sheets = document.styleSheets) {
    if (codexPlusNativeTooltipClassCache !== undefined) return codexPlusNativeTooltipClassCache;
    const signature = /^\.(_Tooltip_[\w-]+)\[data-side="bottom"\]\[data-default-side-offset="true"\]$/;
    let found = "";
    const walk = (rules) => {
      for (const rule of rules || []) {
        if (found) return;
        const match = signature.exec(rule.selectorText || "");
        if (match) found = match[1];
        else if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of sheets || []) {
      try {
        walk(sheet.cssRules);
      } catch {}
      if (found) break;
    }
    // 只缓存找到的结果：样式表可能晚于第一次悬停才加载完。
    if (found) codexPlusNativeTooltipClassCache = found;
    return found;
  }

  function hideCodexPlusRailTooltip() {
    clearTimeout(codexPlusRailTooltipTimer);
    codexPlusRailTooltipTimer = null;
    const node = document.getElementById("codex-plus-rail-tooltip");
    if (node) {
      node.remove();
      codexPlusRailTooltipHiddenAt = Date.now();
    }
    codexPlusRailTooltipOwner = null;
  }

  function showCodexPlusRailTooltip(button, label, side = "right") {
    if (!button.isConnected || codexPlusRailTooltipOwner !== button) return;
    document.getElementById("codex-plus-rail-tooltip")?.remove();
    const nativeClass = codexPlusNativeTooltipClass();
    const zoom = codexPlusWindowZoom();
    const wrapper = document.createElement("div");
    wrapper.id = "codex-plus-rail-tooltip";
    markCodexPlusExtensionNode(wrapper, "builtin-rail-tooltip");
    // 挂在 body 下、不在 Codex 的缩放容器里，所以自己套上界面缩放，坐标相应除回去。
    wrapper.style.cssText = `position:fixed;left:0;top:0;z-index:2147483645;pointer-events:none;zoom:${zoom};`;
    const tip = document.createElement("div");
    tip.setAttribute("role", "tooltip");
    tip.className = nativeClass || "codex-plus-rail-tooltip-fallback";
    Object.assign(tip.dataset, { side, align: "center", state: "delayed-open", gutterSize: "md", defaultSideOffset: "true", clickable: "false" });
    tip.textContent = label;
    wrapper.appendChild(tip);
    document.body.appendChild(wrapper);
    const anchor = button.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    // 图标栏的提示在右侧，输入区按钮的提示在上方，标题栏与消息操作行的在下方（与原生对应位置的按钮一致）。
    // 上下方向的提示按窗口宽度收进来：贴着窗口右边的按钮不能把提示挤出窗外。
    const vertical = side === "top" || side === "bottom";
    const left = vertical
      ? Math.min(Math.max(4, anchor.left + (anchor.width - box.width) / 2), window.innerWidth - box.width - 4) / zoom
      : (anchor.right + codexPlusRailTooltipSideOffset) / zoom;
    const top = side === "top"
      ? (anchor.top - box.height - codexPlusComposerTooltipSideOffset) / zoom
      : side === "bottom"
        ? (anchor.bottom + codexPlusComposerTooltipSideOffset) / zoom
        : (anchor.top + (anchor.height - box.height) / 2) / zoom;
    wrapper.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    button.setAttribute("aria-describedby", wrapper.id);
  }

  /**
   * 窗口失焦、滚动时收起提示。按钮所在的 rail 被 Codex 重建时不会再收到 pointerleave，
   * 这两个全局时机兜底。同页重复注入时先摘掉旧监听。
   */
  function installCodexPlusRailTooltipDismiss() {
    if (window.__codexPlusRailTooltipDismiss === hideCodexPlusRailTooltip) return;
    window.removeEventListener("blur", window.__codexPlusRailTooltipDismiss);
    document.removeEventListener("scroll", window.__codexPlusRailTooltipDismiss, true);
    window.__codexPlusRailTooltipDismiss = hideCodexPlusRailTooltip;
    window.addEventListener("blur", hideCodexPlusRailTooltip);
    document.addEventListener("scroll", hideCodexPlusRailTooltip, true);
  }

  function attachCodexPlusRailTooltip(button, label, side = "right") {
    installCodexPlusRailTooltipDismiss();
    const open = () => {
      clearTimeout(codexPlusRailTooltipTimer);
      codexPlusRailTooltipOwner = button;
      const instant = Date.now() - codexPlusRailTooltipHiddenAt < codexPlusRailTooltipSkipDelayMs
        || !!document.getElementById("codex-plus-rail-tooltip");
      if (instant) showCodexPlusRailTooltip(button, label, side);
      else codexPlusRailTooltipTimer = setTimeout(() => showCodexPlusRailTooltip(button, label, side), codexPlusRailTooltipDelayMs);
    };
    const close = () => {
      if (codexPlusRailTooltipOwner !== button) return;
      button.removeAttribute("aria-describedby");
      hideCodexPlusRailTooltip();
    };
    button.addEventListener("pointerenter", open);
    button.addEventListener("pointerleave", close);
    button.addEventListener("focus", () => {
      if (button.matches?.(":focus-visible")) open();
    });
    button.addEventListener("blur", close);
    // 按下就收起，和原生一致；点击后页面切换，提示不该留在原处。
    button.addEventListener("pointerdown", close);
  }
