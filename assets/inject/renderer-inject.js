(() => {
  // The launcher targets the Codex app page, but keep a renderer-side guard
  // so this bundle cannot create UI in embedded browser documents.
  const codexPlusIsNodeTestHarness = typeof process === "object" && !!process.versions?.node;
  if (!codexPlusIsNodeTestHarness && (window.top !== window || window.self !== window || !window.electronBridge || !/^app:\/\/\-\//i.test(window.location.href))) return;
  const codexPlusIsWindowsPlatform = /\bWindows\b/i.test(navigator.userAgent || "");
  const codexPlusIsMacPlatform = /\bMacintosh\b/i.test(navigator.userAgent || "");

  function codexPlusStatsigClients() {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
    if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
  }

  /**
   * User-triggered Statsig refresh. SDK versions expose different refresh
   * methods, so only invoke methods proven to exist on the live client and
   * report unsupported when none is available.
   */
  window.__codexPlusRefreshStatsigUiConfig = async () => {
    const clients = codexPlusStatsigClients();
    const methods = [];
    const errors = [];
    for (const client of clients) {
      try {
        if (typeof client.updateUserAsync === "function") {
          const user = typeof client.getUser === "function" ? client.getUser() : client.user;
          await client.updateUserAsync(user);
          methods.push("updateUserAsync");
        } else if (typeof client.initializeAsync === "function") {
          await client.initializeAsync();
          methods.push("initializeAsync");
        } else if (typeof client.fetchValues === "function") {
          await client.fetchValues();
          methods.push("fetchValues");
        }
      } catch (error) {
        errors.push(String(error?.message || error));
      }
    }
    const current = clients[0];
    let enableI18n = null;
    try {
      const layer = typeof current?.getLayer === "function" ? current.getLayer("72216192") : null;
      if (layer && typeof layer.get === "function") enableI18n = layer.get("enable_i18n", null);
      if (enableI18n === null && typeof current?.getDynamicConfig === "function") {
        enableI18n = current.getDynamicConfig("72216192", { disableExposureLog: true })?.get?.("enable_i18n", null) ?? null;
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
    const result = {
      status: methods.length ? (errors.length ? "partial" : "ok") : "unsupported",
      methods: Array.from(new Set(methods)),
      clientCount: clients.length,
      enable_i18n: typeof enableI18n === "boolean" ? enableI18n : null,
      errors,
    };
    window.dispatchEvent(new CustomEvent("codex-plus-statsig-refreshed", { detail: result }));
    return result;
  };

  const buttonClass = "codex-delete-button";
  const exportButtonClass = "codex-export-button";
  const actionButtonClass = "codex-session-action-button";
  const actionGroupClass = "codex-session-actions";
  const moreButtonClass = "codex-session-more-button";
  const moreMenuClass = "codex-session-more-menu";
  const actionTooltipClass = "codex-session-action-tooltip";
  // 已发布的旧类名保留兼容；对应功能不再安装。
  const zedRemoteButtonClass = "codex-zed-remote-button";
  const zedRemoteOpenInMenuItemClass = "codex-zed-open-in-menu-item";
  const sessionShareButtonClass = "codex-session-share-button";
  const zedRemoteToastClass = "codex-zed-remote-toast";
  const upstreamWorktreeDialogClass = "codex-upstream-worktree-dialog";
  const upstreamBranchOptionAttribute = "data-codex-upstream-branch-option";
  const styleId = "codex-delete-style";
  // 改 10-style.js 里的任何 CSS 都要把它 +1：installStyle 靠这个版本号判断
  // 页面里已有的 <style> 是否过期，不升的话新样式在旧标签存在时会被直接跳过。
  const codexDeleteStyleVersion = "41";
  const codexPlusMenuId = "codex-plus-menu";
  const codexPlusMenuFloatingClass = "codex-plus-menu-floating";
  const codexPlusPageClass = "codex-plus-page-overlay";
  const codexPlusRailSelector = "nav[data-app-navigation-rail]";
  const codexPlusRailDestinationSelector = "[data-sidebar-destination]";
  // Codex 的界面缩放是给内层布局节点设 CSS zoom，不是改 documentElement。
  // 我们的 overlay 挂在 body 下、落在那棵缩放子树之外，只能自己读这个变量跟随。
  const codexPlusWindowZoomVar = "--codex-window-zoom";
  const codexActionGroupVersion = "8";
  const codexArchiveRowActionsVersion = "1";
  const codexServiceTierBadgeClass = "codex-service-tier-badge";
  const codexServiceTierBadgeVersion = "3";
  let codexPlusVersion = window.__CODEX_PLUS_VERSION__ || "unknown";
  const codexPlusBuild = window.__CODEX_PLUS_BUILD__ || "unknown";
  // 项目仓库地址，界面上需要外链的地方统一取这里，避免散落多处硬编码。
  const codexPilotRepoUrl = "https://github.com/GaryLee271/CodexPilot";
  const codexPlusSettingsKey = "codexPlusSettings";
  const codexAppServerModelRequestPatchVersion = "30";
  const codexAppServerClientCaptureMarker = "AppServerRequestClient is missing a message dispatcher";
  const codexAppServerClientCaptureAnchor = "async sendRequest(";
  const selectors = {
    sidebarThread: "[data-app-action-sidebar-thread-id]",
    threadTitle: "[data-thread-title]",
    appHeader: '[class*="ApplicationMenuTopBar"], .app-header-tint',
    archiveNav: 'button[aria-label="已归档对话"], button[aria-label="Archived conversations"]',
    pluginNavButton: 'nav[role="navigation"] button.h-token-nav-row.w-full',
    pluginSvgPath: 'svg path[d^="M7.94562 14.0277"]',
  };
  /**
   * 拓展注册中心。
   *
   * 第三方用户脚本通过挂到 window 上的 `codexPlus` 对象注册 UI 项，注册结果
   * 落在这里。注册中心只存数据与回调，不做任何渲染——渲染由各消费方在合适的
   * 时机读表完成。这样「内置项」和「第三方项」不会产生两条代码路径。
   *
   * 生命周期约定（很重要）：
   *   注册表持久，DOM 瞬态。
   *
   * Codex Pilot 的 UI 宿主会被反复重建（overlay 每次打开都清空重建、会话行按钮在
   * 版本号变化时整组重建），所以任何消费方都不能缓存 DOM 引用，必须每次从注册
   * 表读数据全量重建。反过来说，第三方脚本不需要关心 DOM 何时被销毁。
   *
   * 注意：注册中心本身不持有 DOM，也不在模块顶层读 DOM，因此可以安全地放在
   * prelude 之后的最前面——此时常量已声明，而所有顶层启动语句都还没执行。
   */
  const codexPlusRegistry = {
    rowActions: new Map(),
    navEntries: new Map(),
    pages: new Map(),
    menuItems: new Map(),
    composerActions: new Map(),
    commands: new Map(),
    messageActions: new Map(),
    messageDecorations: new Map(),
    sidePanels: new Map(),
    slots: new Map(),
    inputTriggers: new Map(),
    shortcuts: new Map(),
    themes: new Map(),
    floatingTabs: new Map(),
  };

  /** 每个脚本最多注册多少项、全局最多多少项，防止劣质拓展把扫描拖慢。 */
  const codexPlusExtensionPerScriptLimit = 16;
  const codexPlusExtensionGlobalLimit = 64;

  /**
   * 必须被扫描调度忽略的选择器。
   *
   * 这些节点由 Codex Pilot 自己（或拓展）插入到 Codex 的容器里，而容器本身是
   * scan-relevant 的。如果不排除，就会形成「写入 → 观察到自己的写入 → 200ms
   * 后再 scan → 再写入」的自喂循环：空闲时也每秒全量扫描五次，macOS 上足以
   * 吃满一个核（issue #1960）。
   *
   * 内置项在这里，拓展项通过 registerCodexPlusExtensionSelector 动态加入。
   * 拓展自带的选择器一律是 `[data-codex-plus-ext="<脚本 key>"]`，由接口层在
   * 注册时自动加上，拓展作者不需要也不应该自己维护这个列表。
   */
  const codexPlusExtensionSelectors = new Set();
  let codexPlusExtensionSelectorCache = null;

  function registerCodexPlusExtensionSelector(selector) {
    if (typeof selector !== "string" || !selector.trim()) return false;
    if (codexPlusExtensionSelectors.has(selector)) return true;
    if (codexPlusExtensionSelectors.size >= codexPlusExtensionGlobalLimit) {
      return false;
    }
    // 提前验证选择器语法：非法选择器会在 closest() 里抛错，而 closest() 跑在
    // 每次 mutation 上，一个坏选择器能把整个页面卡死。
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      return false;
    }
    codexPlusExtensionSelectors.add(selector);
    codexPlusExtensionSelectorCache = null;
    return true;
  }

  /**
   * 拼给 closest() 用的选择器串。Set 变化时重建、否则复用——closest() 传一个
   * 逗号串比逐个调用快得多，而这里每次 DOM 变更都会走一遍。
   */
  function codexPlusExtensionSelector() {
    if (codexPlusExtensionSelectorCache !== null) return codexPlusExtensionSelectorCache;
    codexPlusExtensionSelectorCache = [...codexPlusExtensionSelectors].join(", ");
    return codexPlusExtensionSelectorCache;
  }

  function isCodexPlusExtensionNode(node) {
    const selector = codexPlusExtensionSelector();
    if (!selector) return false;
    return !!node?.closest?.(selector);
  }

  /**
   * 注册一项通用扩展数据。返回 dispose 函数。
   *
   * 所有类别共用同一套校验与配额，免得每个 register* 各写一遍。`kind` 只用于
   * 诊断与配额统计，不参与渲染。
   */
  function registerCodexPlusExtension(kind, registry, id, definition, scriptKey) {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("拓展项 id 不能为空");
    }
    if (registry.has(id)) {
      throw new Error(`拓展项 id 已被占用：${id}`);
    }
    const owned = [...registry.values()].filter((item) => item.scriptKey === scriptKey).length;
    if (owned >= codexPlusExtensionPerScriptLimit) {
      throw new Error(`每个脚本最多注册 ${codexPlusExtensionPerScriptLimit} 项`);
    }
    if (registry.size >= codexPlusExtensionGlobalLimit) {
      throw new Error(`拓展项总数已达上限 ${codexPlusExtensionGlobalLimit}`);
    }
    // 每个类别至少要有一个可调用的钩子，否则注册进来也渲染不出东西。
    // 菜单项的开关形态是 onChange，页面/入口是 render，斜杠命令与快捷键是 run，输入触发是 items，其余是 onActivate。
    // 主题是纯样式，没有回调。
    const callbacks = ["render", "onActivate", "onChange", "onCleanup", "run", "items"];
    if (definition && kind !== "theme" && !callbacks.some((name) => typeof definition[name] === "function")) {
      throw new Error(`拓展项 ${id} 必须提供 ${callbacks.join(" / ")} 之一`);
    }
    const order = Number.isFinite(definition?.order) ? Number(definition.order) : 0;
    // 内置项（内置拓展，scriptKey 为 builtin:*）占用 0~999，第三方从 1000 起，避免插到内置项前面破坏既有布局。
    const minOrder = String(scriptKey || "").startsWith("builtin:") ? 0 : 1000;
    const normalized = { ...definition, kind, id, order: Math.max(minOrder, order), scriptKey };
    registry.set(id, normalized);
    codexPlusRegistryDiagnostics(kind, "register", id, scriptKey);
    return () => {
      if (registry.get(id) === normalized) {
        registry.delete(id);
        codexPlusRegistryDiagnostics(kind, "dispose", id, scriptKey);
      }
    };
  }

  /** 按 order 排序的注册项快照。消费方每次渲染时取，不要缓存结果。 */
  function codexPlusExtensionItems(registry) {
    return [...registry.values()].sort((left, right) => left.order - right.order);
  }

  function codexPlusRegistryDiagnostics(kind, action, id, scriptKey) {
    const entry = {
      kind,
      action,
      id,
      script_key: scriptKey || "",
      at: Date.now(),
      // 不抛错：诊断通道本身出问题时不该影响注册。
    };
    window.__codexPlusRegistryLog = window.__codexPlusRegistryLog || [];
    window.__codexPlusRegistryLog.push(entry);
    if (window.__codexPlusRegistryLog.length > 200) window.__codexPlusRegistryLog.shift();
    try {
      window.__codexSessionDeleteBridge?.("/diagnostics/log", {
        event: "extension_registry",
        detail: entry,
      })?.catch?.(() => {});
    } catch {}
  }

  /**
   * 带着归属信息执行拓展提供的回调。
   *
   * 拓展代码可能抛错、也可能返回坏数据。这里统一兜住：错误记进该脚本的状态
   * 通道（和用户脚本自身的失败上报同一个字段），并由调用方决定如何降级展示。
   * 返回值约定：成功返回 { ok: true, value }，失败返回 { ok: false, error }。
   */
  function runCodexPlusExtensionCallback(scriptKey, label, callback) {
    try {
      return { ok: true, value: callback() };
    } catch (error) {
      const message = String(error?.stack || error?.message || error);
      codexPlusMarkExtensionFailure(scriptKey, `${label}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * 把拓展的失败写进用户脚本运行时状态。
   *
   * 复用 wrap_script 已经建立的上报通道：管理页读的就是
   * window.__codexPlusUserScripts.scripts[key].error。这样拓展的 UI 错误和
   * 脚本本身抛错在用户看来是同一件事，不需要第二套排查入口。
   */
  function codexPlusMarkExtensionFailure(scriptKey, message) {
    if (!scriptKey) return;
    const record = window.__codexPlusUserScripts?.scripts?.[scriptKey];
    if (record) {
      record.error = message;
      // 不覆盖 status：脚本本身可能已成功加载，失败的只是它注册的某一项 UI。
      record.extensionError = message;
    }
    window.__codexPlusExtensionFailures = window.__codexPlusExtensionFailures || [];
    window.__codexPlusExtensionFailures.push({ script_key: scriptKey, message, at: Date.now() });
    if (window.__codexPlusExtensionFailures.length > 100) window.__codexPlusExtensionFailures.shift();
  }
  function installStyle() {
    const existingStyle = document.getElementById(styleId);
    if (existingStyle?.dataset.codexDeleteStyleVersion === codexDeleteStyleVersion) return;
    existingStyle?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.dataset.codexDeleteStyleVersion = codexDeleteStyleVersion;
    style.textContent = `
      .${actionGroupClass} {
        position: absolute;
        right: var(--codex-session-actions-right, 28px);
        top: 50%;
        transform: translateY(-50%);
        z-index: 20;
        opacity: 0;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: transparent;
      }
      .${actionButtonClass} {
        flex: 0 0 auto;
        -webkit-app-region: no-drag;
      }
      /* 外观优先套用同一行原生「置顶 / 归档」按钮的类名与 data-* 属性（见
         90-action-groups.js 的 syncNativeSessionActionStyle），套上后带
         data-codex-native-style，下面这组兜底规则就不再生效。兜底按 Codex 原生
         secondary / transparent / 3xs 图标按钮复刻：20px 方形、14px 图标、
         默认三级文字色，悬停只提亮颜色、不铺底色。 */
      .${actionButtonClass}:not([data-codex-native-style]) {
        position: relative;
        width: var(--control-size-4xs, 20px);
        height: var(--control-size-4xs, 20px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: var(--control-radius-sm, var(--radius-sm, 6px));
        background: transparent;
        color: var(--color-text-secondary-ghost, var(--color-text-tertiary, var(--color-token-text-tertiary, var(--codex-plus-text-tertiary, rgba(255,255,255,.5)))));
        font: inherit;
        padding: 0;
        cursor: default;
        text-align: center;
        transition: color var(--transition-duration-basic, .15s) var(--transition-ease-basic, ease);
      }
      .${actionButtonClass}:not([data-codex-native-style]) svg {
        display: block;
        width: var(--control-icon-size-xs, 14px);
        height: var(--control-icon-size-xs, 14px);
      }
      .codex-session-action-inner {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .${actionButtonClass}:not([data-codex-native-style]):hover,
      .${actionButtonClass}:not([data-codex-native-style]):focus-visible,
      .${actionButtonClass}:not([data-codex-native-style])[aria-expanded="true"] {
        background: transparent;
        color: var(--color-text-secondary-ghost-hover, var(--color-text, var(--color-token-text-primary, #f4f4f5)));
        outline: none;
      }
      .${moreMenuClass} {
        position: fixed;
        z-index: 2147483201;
        min-width: 104px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        padding: 4px;
      }
      .${moreMenuClass}[hidden] { display: none !important; }
      .${moreMenuClass}.codex-session-more-menu-open-up {
        transform: translateY(calc(-100% - 34px));
      }
      .codex-session-more-menu-item {
        width: 100%;
        border: 0;
        border-radius: var(--border-radius-sm, 6px);
        background: transparent;
        color: inherit;
        cursor: default;
        display: flex;
        align-items: center;
        gap: 8px;
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 6px 8px;
        text-align: left;
      }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible {
        background: var(--codex-plus-bg-hover);
        outline: none;
      }
      .codex-session-more-menu-icon {
        width: 16px;
        text-align: center;
      }
      .codex-archive-row-button {
        border: 1px solid var(--color-token-border-light, var(--color-token-border-default, rgba(0,0,0,.12)));
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-token-bg-secondary, transparent);
        color: var(--color-token-text-secondary, inherit);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      [data-codex-delete-row="true"]:hover .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
      }
      [data-codex-delete-row="true"]:hover ${selectors.threadTitle},
      [data-codex-delete-row="true"]:focus-within ${selectors.threadTitle},
      [data-codex-delete-row="true"].codex-session-more-open ${selectors.threadTitle} {
        flex: 0 1 auto;
        width: var(--codex-session-title-max-width, auto);
        max-width: var(--codex-session-title-max-width, 100%);
        overflow: hidden;
      }
      [data-codex-delete-row="true"].codex-session-more-open .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
        z-index: 2147483201;
      }
      [data-codex-delete-row="true"].codex-archive-confirm-visible .${actionGroupClass} {
        right: max(66px, var(--codex-session-actions-right, 28px));
      }
      .${actionTooltipClass} {
        position: fixed;
        z-index: 2147483201;
        max-width: min(220px, calc(100vw - 32px));
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
        pointer-events: none;
        white-space: nowrap;
      }
      .codex-archive-delete-all {
        border: 1px solid var(--color-border-danger, #dc2626);
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-background-danger-soft, rgba(220,38,38,.1));
        color: var(--color-text-danger, #dc2626);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      .codex-archive-action-bar {
        position: fixed;
        right: 28px;
        top: 86px;
        z-index: 2147482999;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
      }
      .codex-delete-toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        padding: 10px 12px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        pointer-events: none;
      }
      .codex-delete-toast button { margin-left: 10px; pointer-events: auto; }
      /* 拓展与内置提示共用的类型配色。不传 type 时保持上面的默认外观。 */
      .codex-delete-toast[data-toast-type="success"] { border-color: var(--codex-plus-success, #2f9e63); }
      .codex-delete-toast[data-toast-type="warn"] { border-color: var(--codex-plus-warn, #b7791f); }
      .codex-delete-toast[data-toast-type="error"] { border-color: var(--codex-plus-error, #c53030); }
      .codex-plus-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        /*
         * overlay 自身带 zoom（见 applyCodexPlusZoom），而它的 inset: 0 与 100vw
         * 都按未缩放的视口算，再乘 zoom 就溢出（实测 zoom=1.2 时 100vw 得到 2072px，
         * 视口只有 1727px）。用 calc(100vw / var(--codex-plus-zoom)) 抵消；zoom 缺失
         * 时分母回落到 1，行为与改造前一致。
         * 内部子元素用百分比即可——它们在缩放空间里，百分比本来就对。
         * 注意：本段在 JS 模板字符串里，注释中不能出现反引号，否则会提前闭合。
         */
        width: calc(100vw / var(--codex-plus-zoom, 1));
        height: calc(100vh / var(--codex-plus-zoom, 1));
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--modal-backdrop-dim-shadow, rgba(0,0,0,.32));
        backdrop-filter: blur(1px);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-content {
        width: min(520px, calc(100% - 48px));
        max-height: min(680px, calc(100% - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 14px;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px 8px;
        flex: 0 0 auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; }
      .codex-plus-backend-indicator { width: 8px; height: 8px; border-radius: 999px; background: var(--codex-plus-text-tertiary); display: inline-block; }
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      .codex-plus-backend-indicator[data-status="degraded"] { background: var(--codex-plus-warning); }
      /*
       * 用户拓展添加的导航图标栏入口：原生按钮只放图标，
       * 这里对齐它的尺寸。
       *
       * 用 [data-codex-plus-rail] 而不是逐个列 id——早先按 id 写，加第三个入口时
       * 漏掉了对应的选择器，那个图标容器就没有 20px 约束、撑成整个按钮宽，
       * 表现为图标偏左不居中。
       */
      [data-codex-plus-rail] {
        position: relative;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      [data-codex-plus-rail] > button {
        position: relative;
      }
      [data-codex-plus-rail] .codex-plus-rail-icon {
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      [data-codex-plus-rail] .codex-plus-rail-icon svg {
        width: 19px;
        height: 19px;
        display: block;
      }
      /*
       * 我们的页面是叠加在 Codex 之上的，Codex 并不知道，所以它自己那个
       * destination 的选中态会一直留着，看起来像 rail 上同时亮两个。
       * 页面打开时给根节点打标记，用 CSS 把原生选中项压成未选中；
       * 关掉页面即移除标记，原生状态自动恢复——比改它的按钮属性稳，
       * 不会和 React 的重渲染打架。
       * 颜色取自当前主题下真实未选中项（见 syncCodexPlusRailNativeSelection），
       * 主题切换时下次同步会重算。
       */
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"] {
        color: var(--codex-plus-rail-dim, var(--codex-plus-text-tertiary, currentColor)) !important;
      }
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"]::before {
        opacity: 0 !important;
      }
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"] * {
        color: var(--codex-plus-rail-dim, var(--codex-plus-text-tertiary, currentColor)) !important;
      }
      /*
       * 页面 overlay 的 left 由 positionCodexPlusPage 按图标栏右边界算好写进来。
       *
       * 关键：写进来的必须是**布局坐标**（视觉值 / zoom），因为 overlay 自己在缩放
       * 空间里布局，宽度也要用同一个空间的量。width 的 calc(100vw / zoom - left - right)
       * 把右边贴到原生内容区的右边缘；三个量都除过 zoom，缩放后才正好补齐。
       * 注意：本段在 JS 模板字符串里，注释里不能出现反引号，否则会提前闭合。
       *
       * 右/下各留一圈槽（原生是 4px）并给四角加圆角，对齐官方面板的观感：
       * 官方页面面板 [_PageSurface_] 的 rect 与我们这块 overlay 完全相同（都是
       * [52, 44, 1663, 940]），四角 12px；它外面套了一个 padding: 0 4px 4px 0 的槽，
       * 右、下能看到底色。我们原先 right/bottom 贴 0 且无圆角，于是方角并且比官方
       * 多占 4px，用户反馈「少一个圆角」就是这个。
       * 圆角值由 positionCodexPlusPage 量官方面板写入，四个角一起用，不做左右区分。
       * overflow: hidden 让圆角真正裁到内容；内容都在 .codex-plus-modal-content 内，
       * 没有依赖溢出显示的全屏浮层，切掉是安全的。
       */
      .${codexPlusPageClass} {
        position: fixed;
        top: var(--codex-plus-page-top, 0px);
        right: var(--codex-plus-page-right, 0px);
        bottom: var(--codex-plus-page-bottom, 0px);
        left: var(--codex-plus-page-left, 0px);
        width: calc(100vw / var(--codex-plus-zoom, 1) - var(--codex-plus-page-left, 0px) - var(--codex-plus-page-right, 0px));
        height: calc(100vh / var(--codex-plus-zoom, 1) - var(--codex-plus-page-top, 0px) - var(--codex-plus-page-bottom, 0px));
        border-radius: var(--codex-plus-page-radius, 0px);
        overflow: hidden;
        /*
         * 功能页是覆盖在 Codex 内容区上的基础层，不能压过原生侧栏/顶部栏
         * 的 tooltip 和 menu；原生弹出层在页面打开时由下方规则提升。
         */
        z-index: 2147482000;
        display: block;
        background: var(--codex-plus-bg-primary, #fff);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      /* 图标栏按钮提示的兜底外观：找不到原生提示样式类时使用，数值量自原生提示。 */
      .codex-plus-rail-tooltip-fallback {
        max-width: 320px;
        padding: 5px 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 20px;
        background: rgb(45, 45, 45);
        box-shadow: rgba(15, 23, 42, 0.2) 0 8px 18px 0;
        color: #fff;
        font-size: 13px;
        font-weight: 430;
        line-height: 18px;
        letter-spacing: -0.15px;
        white-space: nowrap;
      }
      /*
       * 提升定位包装层，避免只改 tooltip/menu 子节点仍被父级堆叠上下文困住。
       * 新版 Codex 还把弹出层挂在一个 z-60 的固定视口容器里（zoom-adjusted-viewport），
       * 只提升里面的节点逃不出这个堆叠上下文，所以直接父容器也一起提升。
       */
      html[data-codex-plus-page-open] div:has(> [data-radix-popper-content-wrapper], > [role="tooltip"], > [role="menu"]):not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [data-radix-popper-content-wrapper]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [role="tooltip"]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [role="menu"]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [class*="ApplicationMenuTopBar"],
      html[data-codex-plus-page-open] .app-header-tint {
        z-index: 2147483645 !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content {
        width: auto;
        height: 100%;
        max-height: none;
        border: 0;
        border-radius: 0;
        background: var(--codex-plus-bg-primary, #fff);
        box-shadow: none;
      }
      .${codexPlusPageClass} .codex-plus-modal-header {
        width: 100%;
        margin: 0;
        padding: 16px 24px 10px;
      }
      .${codexPlusPageClass} .codex-plus-modal-body {
        width: 100%;
        margin: 0;
        padding: 4px 32px 32px;
      }
      .codex-plus-modal-close {
        border: 0;
        background: transparent;
        color: #d1d5db;
        font-size: 20px;
        cursor: pointer;
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 4px 20px 16px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,.28) transparent;
      }
      .codex-plus-modal-body::-webkit-scrollbar { width: 10px; }
      .codex-plus-modal-body::-webkit-scrollbar-track { background: transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255,255,255,.28);
        background-clip: padding-box;
      }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.38); background-clip: padding-box; }
      .codex-plus-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid rgba(255,255,255,.1);
      }
      .codex-plus-row:first-child { border-top: 0; }
      .codex-plus-row-title { font-weight: 550; line-height: 1.35; }
      .codex-plus-row-description { margin-top: 2px; color: #a1a1aa; font-size: 13px; line-height: 1.4; }
      .codex-plus-row-description[data-codex-plus-native-fast-status][data-failed="true"] { color: #f59e0b; }
      .codex-plus-model-compat-warning { margin-top: 6px; color: #fbbf24; font-size: 13px; line-height: 1.45; }
      .codex-plus-toggle {
        width: 42px;
        height: 24px;
        border: 0;
        border-radius: 999px;
        background: #52525b;
        padding: 2px;
      }
      .codex-plus-toggle span {
        display: block;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: white;
        transition: transform .12s ease;
      }
      .codex-plus-toggle,
      .codex-plus-action-button,
      .codex-plus-issue-button,
      .codex-plus-backend-status {
        flex-shrink: 0;
        align-self: center;
      }
      .codex-plus-toggle[data-enabled="true"] { background: #10a37f; }
      .codex-plus-toggle[data-enabled="true"] span { transform: translateX(18px); }
      .codex-plus-toggle[data-pending="true"],
      .codex-plus-toggle:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-width-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 176px; align-self: center; }
      .codex-plus-width-input {
        width: 78px;
        height: 26px;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.08);
        color: #f3f4f6;
        font-size: 13px;
        font-family: inherit;
        padding: 0 8px;
      }
      .codex-plus-width-input:disabled { opacity: .55; cursor: not-allowed; }
      .codex-plus-about { color: #a1a1aa; line-height: 1.5; }
      .codex-plus-panel[hidden] { display: none; }
      .codex-plus-action-button,
      .codex-plus-issue-button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #3f3f46; color: #f3f4f6; font-size: 13px;
        font-family: inherit; padding: 6px 8px; }
      .codex-plus-form-field {
        display: grid;
        gap: 4px;
        margin-top: 10px;
        /* issue #2359：原来是写死的 #d4d4d8，浅色主题下对比度只有 1.38:1（≈看不见）。
           标签文字改跟主题走。 */
        color: var(--codex-plus-text-secondary);
        font-size: 13px;
        font-family: inherit;
        text-align: left;
      }
      .codex-plus-form-field input {
        width: min(520px, 72vw);
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        background: #18181b;
        color: #f4f4f5;
        padding: 8px 10px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .codex-plus-form-message {
        min-height: 18px;
        margin-top: 10px;
        color: #a1a1aa;
        font-size: 13px;
        font-family: inherit;
        text-align: left;
      }
      .codex-plus-form-message[data-status="ok"] { color: #34d399; }
      .codex-plus-form-message[data-status="failed"] { color: #f87171; }
      .codex-plus-form-message[data-status="loading"] { color: #fbbf24; }
      .codex-plus-backend-status { display: grid; gap: 4px; min-width: 132px; justify-items: end; }
      .codex-plus-backend-label { color: #a1a1aa; font-size: 13px; }
      .codex-plus-backend-label[data-status="ok"] { color: #34d399; }
      .codex-plus-backend-label[data-status="failed"] { color: #f87171; }
      .codex-plus-backend-label[data-status="degraded"] { color: #fbbf24; }
      /*
       * 注入面板的语义色板：前景/背景必须取自同一套 token，且都要能被主题切换带走。
       *
       * issue #2359（Windows 浅色主题下黑底黑字）：旧写法在中间塞了一整层
       * --token-* 回退名（--token-bg-primary / --token-text-primary /
       * --token-border / --token-list-hover-background / --token-text-default /
       * --token-bg-fog / --token-text-tertiary …）。实测 Codex 客户端（26.9xx）
       * 的产物里这些名字**一个都不存在**——真正在用的一套是 --color-token-*。
       * 于是三级回退链的中间那级永远落空，浅色主题下只靠最后一级写死的深色值
       * 兜底，前景与背景各自独立兜底时明度撞在一起，就成了黑底黑字。
       * 这里把死名删掉，直接接到确实存在、且**由 Codex 自己按主题重算**的
       * --color-token-* 上；末级兜底仅作最后保险，不再承担主题判断。
       */
      :root {
        --codex-plus-bg-primary: var(--color-token-bg-primary, var(--color-token-main-surface-primary, #fff));
        --codex-plus-bg-secondary: var(--color-token-bg-secondary, var(--codex-plus-bg-primary));
        --codex-plus-bg-elevated: var(--color-token-dropdown-background, var(--color-token-bg-secondary, var(--codex-plus-bg-primary)));
        --codex-plus-bg-hover: var(--color-token-interactive-bg-secondary-hover, var(--color-token-list-hover-background, rgba(0,0,0,.06)));
        --codex-plus-bg-selected: var(--color-token-interactive-bg-secondary-selected, var(--codex-plus-bg-hover));
        --codex-plus-text: var(--color-token-text-primary, var(--color-token-foreground, #171717));
        --codex-plus-text-secondary: var(--color-token-text-secondary, var(--codex-plus-text));
        --codex-plus-text-tertiary: var(--color-token-text-tertiary, var(--codex-plus-text-secondary));
        --codex-plus-border: var(--color-token-border-light, var(--color-token-border, var(--color-token-border-default, rgba(0,0,0,.12))));
        --codex-plus-border-subtle: var(--codex-plus-border);
        --codex-plus-focus: var(--color-token-focus-border, var(--color-border-focus, currentColor));
        --codex-plus-danger: var(--color-text-danger, #dc2626);
        --codex-plus-danger-bg: var(--color-background-danger-soft, rgba(220,38,38,.1));
        --codex-plus-success: var(--color-text-success, #15803d);
        --codex-plus-warning: var(--color-text-warning, #a16207);
      }
      :where(.${moreMenuClass}, .${actionTooltipClass}, .codex-delete-toast, .codex-plus-modal-overlay, .${codexPlusPageClass}) {
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .${moreMenuClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
      }
      .codex-session-more-menu-item { border-radius: var(--border-radius-sm, 6px); font-family: inherit; }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible { background: var(--codex-plus-bg-hover); }
      .${actionTooltipClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font-family: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
      }
      .codex-plus-modal-overlay { background: var(--color-background-surface-under, rgba(0,0,0,.32)); backdrop-filter: blur(1px); }
      .codex-plus-modal-content {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font-family: inherit;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
      }
      .codex-plus-row-description,
      .codex-plus-about,
      .codex-plus-backend-label,
      .codex-plus-form-message,
      .codex-plus-action-button,
      .codex-plus-issue-button {
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 5px 10px;
      }
      .codex-plus-action-button:hover,
      .codex-plus-action-button:focus-visible,
      .codex-plus-issue-button:hover,
      .codex-plus-issue-button:focus-visible {
        border-color: var(--color-border-danger, #dc2626);
        background: var(--color-background-danger-solid, #dc2626);
        color: var(--color-text-danger-solid, #fff);
      }
      .codex-plus-modal-close { border-color: var(--codex-plus-border); color: var(--codex-plus-text-secondary); border-radius: var(--border-radius-lg, 8px); }
      .codex-plus-modal-close:hover,
      .codex-plus-modal-close:focus-visible { background: var(--codex-plus-bg-hover); color: var(--codex-plus-text); outline: none; }
      .${codexPlusPageClass},
      .${codexPlusPageClass} .codex-plus-modal-content {
        background: var(--codex-plus-bg-primary) !important;
        color: var(--codex-plus-text) !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content { border-color: transparent; }
      .codex-plus-modal-body { scrollbar-color: var(--codex-plus-text-tertiary) transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--codex-plus-text-tertiary) 45%, transparent); background-clip: padding-box; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: var(--codex-plus-text-tertiary); background-clip: padding-box; }
      .codex-plus-row { border-top-color: var(--codex-plus-border-subtle); }
      .codex-plus-toggle { background: var(--color-background-secondary-solid, var(--codex-plus-text-tertiary)); }
      .codex-plus-toggle span { background: var(--color-token-bg-primary, #fff); box-shadow: var(--switch-thumb-shadow, 0 1px 2px rgba(0,0,0,.16)); }
      .codex-plus-toggle[data-enabled="true"] { background: var(--color-background-primary-solid, var(--color-background-success-solid, #10a37f)); }
      .codex-plus-width-input,
      .codex-plus-form-field input {
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .codex-plus-width-input:focus,
      .codex-plus-form-field input:focus { border-color: var(--codex-plus-focus); outline: 2px solid color-mix(in srgb, var(--codex-plus-focus) 25%, transparent); outline-offset: 0; }
      .codex-plus-backend-indicator { box-shadow: none; }
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      .codex-plus-backend-indicator[data-status="degraded"] { background: var(--codex-plus-warning); }
      .codex-plus-form-message[data-status="ok"], .codex-plus-backend-label[data-status="ok"] { color: var(--codex-plus-success); }
      .codex-plus-form-message[data-status="failed"], .codex-plus-backend-label[data-status="failed"] { color: var(--codex-plus-danger); }
      .codex-plus-backend-label[data-status="degraded"] { color: var(--codex-plus-warning); }
      .codex-plus-form-message[data-status="loading"], .codex-plus-model-compat-warning { color: var(--codex-plus-warning); }
      /* Codex Pilot 设置主页：对齐原生设置页，保持其它页面与弹窗的布局独立。 */
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] {
        background: var(--codex-plus-settings-page-bg, var(--codex-plus-bg-primary)) !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body {
        box-sizing: border-box;
        padding: 72px 32px 64px;
      }
      .codex-plus-settings {
        width: 100%;
        max-width: 740px;
        min-width: 0;
        margin: 0 auto;
        container: codex-plus-settings / inline-size;
      }
      .codex-plus-settings > .codex-plus-modal-header {
        width: 100%;
        box-sizing: border-box;
        padding: 0;
        margin: 0 0 48px;
        gap: 16px;
      }
      .codex-plus-settings .codex-plus-modal-title {
        min-width: 0;
        font-size: 28px;
        font-weight: 600;
        line-height: 36px;
        letter-spacing: -.02em;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings-section { margin: 0 0 48px; }
      .codex-plus-settings-section:last-child { margin-bottom: 0; }
      .codex-plus-settings-section-title {
        margin: 0 0 16px;
        color: var(--codex-plus-text);
        font-size: 14px;
        font-weight: 550;
        line-height: 20px;
      }
      .codex-plus-settings-card,
      .codex-plus-settings > [data-codex-plus-ext-menu] {
        box-sizing: border-box;
        min-width: 0;
        padding: 0 16px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 16px;
        background: var(--codex-plus-settings-card-bg, var(--codex-plus-bg-secondary));
      }
      .codex-plus-settings > [data-codex-plus-ext-menu] { margin-top: 48px; }
      .codex-plus-settings .codex-plus-row {
        box-sizing: border-box;
        min-height: 60px;
        align-items: center;
        gap: 24px;
        padding: 10px 0;
        font-size: 14px;
        line-height: 20px;
      }
      .codex-plus-settings .codex-plus-row[hidden] { display: none; }
      /* 内置拓展的子选项缩进挂在所属拓展下面；被顶替时的小字用警示色。 */
      .codex-plus-settings .codex-plus-row[data-codex-plus-builtin-param] { padding-left: 20px; }
      .codex-plus-settings .codex-plus-row-description[data-codex-builtin-replaced]::after {
        content: " · " attr(data-codex-builtin-replaced);
        color: var(--color-token-text-warning, #d97706);
      }
      .codex-plus-settings .codex-plus-row > :first-child {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings .codex-plus-row > :not(:first-child) { max-width: 48%; }
      .codex-plus-settings .codex-plus-row-title { font-weight: 500; line-height: 20px; }
      /* 设置项标题旁的小标签：实验 / 需重启，与管理器增强页一致。 */
      .codex-plus-settings .codex-plus-feature-tag {
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        padding: 0 5px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 4px;
        color: var(--codex-plus-text-secondary);
        font-size: 10.5px;
        font-style: normal;
        font-weight: 500;
        line-height: 16px;
        vertical-align: 1px;
      }
      .codex-plus-settings .codex-plus-feature-tag[data-tone="experimental"] {
        border-color: color-mix(in srgb, var(--codex-plus-warning) 40%, transparent);
        color: var(--codex-plus-warning);
      }
      .codex-plus-settings .codex-plus-row-description,
      .codex-plus-settings .codex-plus-about {
        margin-top: 2px;
        color: var(--codex-plus-text-secondary);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings .codex-plus-toggle {
        flex: 0 0 32px;
        width: 32px;
        height: 20px;
        min-height: 20px;
        box-sizing: border-box;
        padding: 2px;
        background: var(--codex-plus-switch-off, #3a3a3a);
        cursor: pointer;
      }
      .codex-plus-settings .codex-plus-toggle span {
        width: 16px;
        height: 16px;
        background: var(--codex-plus-switch-thumb, #fff);
      }
      .codex-plus-settings .codex-plus-toggle[data-enabled="true"] { background: var(--codex-plus-switch-on, #3485ff); }
      .codex-plus-settings .codex-plus-toggle[data-enabled="true"] span { transform: translateX(12px); }
      .codex-plus-settings .codex-plus-toggle[data-pending="true"],
      .codex-plus-settings .codex-plus-toggle:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-settings .codex-plus-width-control {
        flex: 0 1 auto;
        min-width: 0;
        flex-wrap: wrap;
        gap: 8px;
      }
      .codex-plus-settings .codex-plus-backend-status { overflow-wrap: anywhere; text-align: right; }
      .codex-plus-settings .codex-plus-action-button,
      .codex-plus-settings .codex-plus-issue-button,
      .codex-plus-settings .codex-plus-width-input {
        box-sizing: border-box;
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 8px;
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font-family: inherit;
        font-size: 13px;
        line-height: 18px;
      }
      .codex-plus-settings .codex-plus-width-input { height: 32px; width: 72px; min-width: 48px; }
      .codex-plus-settings .codex-plus-width-input.codex-plus-model-input { width: 220px; min-width: 0; padding: 0 10px; }
      .codex-plus-settings .codex-plus-model-input:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-settings .codex-plus-action-button,
      .codex-plus-settings .codex-plus-issue-button { white-space: normal; overflow-wrap: anywhere; }
      .codex-plus-settings .codex-plus-action-button:hover,
      .codex-plus-settings .codex-plus-action-button:focus-visible,
      .codex-plus-settings .codex-plus-issue-button:hover,
      .codex-plus-settings .codex-plus-issue-button:focus-visible {
        border-color: var(--codex-plus-border);
        background: var(--codex-plus-bg-hover);
        color: var(--codex-plus-text);
      }
      .codex-plus-settings button:focus-visible,
      .codex-plus-settings input:focus-visible,
      .codex-plus-settings select:focus-visible {
        outline: 2px solid var(--codex-plus-switch-on, #3485ff);
        outline-offset: 3px;
      }
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] { container: codex-plus-settings-page / inline-size; }
      @container codex-plus-settings-page (max-width: 800px) {
        .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body { padding: 48px 24px; }
      }
      @container codex-plus-settings-page (max-width: 480px) {
        .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body { padding: 32px 16px; }
      }
      @container codex-plus-settings (max-width: 560px) {
        .codex-plus-settings .codex-plus-row { gap: 16px; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function defaultCodexPlusSettings() {
    return { nativeMenuPlacement: true, nativeFastUnlock: false };
  }

  const codexPlusBackendSettingMap = {
    nativeMenuPlacement: "codexAppNativeMenuPlacement",
    nativeFastUnlock: "codexAppNativeFastUnlock",
  };
  const codexPlusBackendMappedSettings = new Set(Object.keys(codexPlusBackendSettingMap));

  function backendCodexPlusSettings() {
    const settings = {};
    Object.entries(codexPlusBackendSettingMap).forEach(([localKey, backendKey]) => {
      const value = codexPlusBackendSettings[backendKey];
      if (typeof value === "boolean" || typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value))) {
        settings[localKey] = value;
      }
    });
    return settings;
  }

  /**
   * 功能侧读到的设置：设置项开着、且对应的内置拓展在用（没停用、没被顶替）才算开。
   * 设置页的开关要显示 / 切换用户自己存的值，传 { ignoreBuiltins: true }。
   * 映射写在函数里：多个测试把本函数单独切片到沙箱里执行。
   */
  function codexPlusSettings(options) {
    const withBuiltins = (settings) => {
      const inactive = globalThis.__codexPlusBuiltinInactive;
      if (options?.ignoreBuiltins || !inactive?.size) return settings;
      const builtinSettings = { nativeFastUnlock: "native-fast-unlock" };
      Object.entries(builtinSettings).forEach(([key, id]) => {
        if (inactive.has(id)) settings[key] = false;
      });
      return settings;
    };
    if (codexPlusBackendSettings.enhancementsEnabled === false) {
      return {
        nativeMenuPlacement: false,
        nativeFastUnlock: false,
      };
    }
    try {
      const defaults = defaultCodexPlusSettings();
      const stored = JSON.parse(localStorage.getItem(codexPlusSettingsKey) || "{}");
      // 只读取当前支持的选项，旧缓存中的退役开关与参数不能重新激活功能。
      const settings = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter((key) => typeof stored?.[key] === "boolean").map((key) => [key, stored[key]])), ...backendCodexPlusSettings() };
      return withBuiltins(settings);
    } catch {
      const settings = { ...defaultCodexPlusSettings(), ...backendCodexPlusSettings() };
      return withBuiltins(settings);
    }
  }

  function setCodexPlusSetting(key, value) {
    const backendKey = codexPlusBackendSettingMap[key];
    if (backendKey) {
      // 跟着开关走的功能由各自的内置拓展订阅 setBackendSetting 发的 settings/changed，这里不点名。
      void setBackendSetting(backendKey, value).catch(() => {
        void loadBackendSettings();
      });
      return;
    }
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(codexPlusSettingsKey) || "{}");
    } catch {
      stored = {};
    }
    const next = { ...stored, [key]: value };
    localStorage.setItem(codexPlusSettingsKey, JSON.stringify(next));
    if (typeof emitCodexPlusSettingsChanged === "function") emitCodexPlusSettingsChanged(key, value, true);
    renderCodexPlusMenu();
    scan();
  }
  function renderCodexPlusMenu() {
    const settings = codexPlusSettings({ ignoreBuiltins: true });
    document.querySelectorAll(".codex-plus-toggle[data-codex-plus-setting]").forEach((button) => {
      const key = button.getAttribute("data-codex-plus-setting");
      const waitsForBackend = codexPlusBackendMappedSettings.has(key) && !codexPlusBackendSettingsLoaded;
      button.dataset.enabled = String(!!settings[key]);
      button.setAttribute("aria-checked", button.dataset.enabled);
      button.dataset.pending = String(waitsForBackend);
      button.disabled = waitsForBackend || button.dataset.relayUnneeded === "true";
    });
  }

  let codexPlusBackendSettings = { enhancementsEnabled: true, codexAppVersion: "" };
  let codexPlusBackendSettingsSeq = 0;
  let codexPlusBackendSettingsLoaded = false;
  const codexServiceTierModulePromises = new Map();
  // namePart -> { at, attempts, error }，见 loadCodexAppModule 里的说明。
  // 挂在 window 上跨重注入保留：否则每次重注入都会清空失败记录，重新全量 fetch asset
  // （issue #2330 / #2169：桥接看门狗重注入后 asset rescan 被重新跑满）。
  const codexAppModuleFailures = window.__codexPlusAppModuleFailures || (window.__codexPlusAppModuleFailures = new Map());
  // namePart -> { at, url }：codexAppAssetUrlFromScriptText 的查找结果，未命中也缓存，
  // 同样跨重注入保留（有调用方会绕过 asset loader 直接调它）。
  const codexAppAssetUrlLookups = window.__codexPlusAssetUrlLookups || (window.__codexPlusAssetUrlLookups = new Map());
  const codexAppModuleRetryCooldownMs = 30000;
  const codexAppModuleMaxAttempts = 8;
  const codexServiceTierSupportedFastModels = new Set(["gpt-5.4", "gpt-5.5"]);
  // 这里只放确认支持 priority service tier 的官方模型——这个集合同时用于生成
  // 「Fast 仅支持 …」的提示文案，塞进没验证过的模型等于对用户做出错误承诺。
  // 第三方模型（deepseek 等）走下面 codexServiceTierFastSupportedForModel 里的
  // 模型元数据判定：上游自己声明了 priority 才认。
  ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].forEach((model) => codexServiceTierSupportedFastModels.add(model));

  function uniqueCodexAppAssetUrls(urls) {
    return Array.from(new Set((urls || []).filter((url) => typeof url === "string" && url.includes("/assets/") && url.split("?")[0].endsWith(".js"))));
  }

  function codexAppAssetCandidateUrls() {
    return uniqueCodexAppAssetUrls([
      // Fast 的 import map 让实际加载记录指向 Blob；定位原生类仍需要原资产 URL。
      window.__codexPlusNativeFastCompiled === "v1" ? window.__codexPlusNativeFastModuleDiagnostics?.url : null,
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ]);
  }

  function codexAppAssetUrl(namePart) {
    if (!namePart) return "";
    return codexAppAssetCandidateUrls().find((url) => url.includes(namePart)) || "";
  }

  async function codexAppAssetUrlFromScriptText(namePart) {
    if (!namePart) return "";
    // 有调用方会绕过 asset loader 直接调这里，
    // 没有缓存时每次注入都要把全部 app asset fetch 一遍（issue #2330）。
    // 未命中同样缓存：冷却期内不重复扫描。
    const cached = codexAppAssetUrlLookups.get(namePart);
    if (cached && (cached.url || Date.now() - cached.at < codexAppModuleRetryCooldownMs)) {
      return cached.url;
    }
    const url = await scanCodexAppAssetUrlFromScriptText(namePart);
    codexAppAssetUrlLookups.set(namePart, { at: Date.now(), url });
    return url;
  }

  async function scanCodexAppAssetUrlFromScriptText(namePart) {
    const scripts = codexAppAssetCandidateUrls();
    const escaped = String(namePart).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`["'](\\./(?:assets/)?${escaped}[^"']+\\.js)["']`),
      new RegExp(`["'](\\.?/assets/${escaped}[^"']+\\.js)["']`),
      new RegExp(`["']([^"']*/assets/${escaped}[^"']+\\.js)["']`),
    ];
    for (const src of scripts) {
      try {
        const text = await fetch(src).then((response) => response.ok ? response.text() : "");
        if (!text) continue;
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (!match) continue;
          return new URL(match[1], src).href;
        }
      } catch {
      }
    }
    return "";
  }

  // issue #1960：失败必须被记住。之前失败只是把 promise 从 map 里删掉，
  // 于是任何调用方下一次重试都会重新走 codexAppAssetUrlFromScriptText()，
  // 把全部 app asset（实测 121 个）重新 fetch 一遍再跑三条正则。
  // 这个 loader 有四个调用方，其中 installCodexServiceTierDispatcherPatch()
  // 挂在 scanLightweight() 里、每轮 scan 都试三个前缀，Codex 侧改名后就成了永不停止的重扫：
  // 实测空闲时 301 次请求/秒，主线程 TaskOtherDuration 占满一半 CPU，JS 堆每秒涨约 1MB，
  // Sentry 又给每个请求记一条 breadcrumb 并回同步一次 scope，把量再翻一倍推给 browser 进程。
  // 记住失败 + 冷却重试，让下游即便还在轮询也只会周期性地试一次。
  // 「这个 asset 找不到」是可预期的、会随 Codex 版本变化的情形，
  // 不是异常。用结构化标记而不是靠 message 字符串比对来区分：字符串比对让
  // loadOptionalCodexAppModule 的「可选」语义只对精确复刻了那段 message 的调用方生效，
  // 任何一个自己抛错或包了一层的调用方都会漏判，把可选依赖的缺失当成硬失败中断整条流程
  // （issue #1316 的「未找到 Codex App asset: vscode-api-」就是这么冒到用户面前的）。
  function codexAppAssetMissingError(namePart) {
    const error = new Error(`未找到 Codex App asset: ${namePart}`);
    error.code = "CODEX_PLUS_ASSET_MISSING";
    error.assetNamePart = namePart;
    return error;
  }

  function isCodexAppAssetMissingError(error) {
    return !!error && (error.code === "CODEX_PLUS_ASSET_MISSING" || error.name === "CodexPlusAssetMissingError");
  }

  async function loadCodexAppModule(namePart) {
    if (!codexServiceTierModulePromises.has(namePart)) {
      const failure = codexAppModuleFailures.get(namePart);
      if (failure
          && (failure.attempts >= codexAppModuleMaxAttempts
            || Date.now() - failure.at < codexAppModuleRetryCooldownMs)) {
        throw failure.error;
      }
      const promise = Promise.resolve().then(async () => {
        const url = codexAppAssetUrl(namePart) || await codexAppAssetUrlFromScriptText(namePart);
        if (!url) throw codexAppAssetMissingError(namePart);
        return await import(url);
      }).then((module) => {
        // Codex 更新后 asset 可能又出现，成功时把失败记录清掉，冷却计数重新开始。
        codexAppModuleFailures.delete(namePart);
        return module;
      }).catch((error) => {
        codexServiceTierModulePromises.delete(namePart);
        codexAppModuleFailures.set(namePart, {
          at: Date.now(),
          attempts: (codexAppModuleFailures.get(namePart)?.attempts || 0) + 1,
          error,
        });
        throw error;
      });
      codexServiceTierModulePromises.set(namePart, promise);
    }
    return await codexServiceTierModulePromises.get(namePart);
  }

  async function loadOptionalCodexAppModule(namePart) {
    try {
      return await loadCodexAppModule(namePart);
    } catch (error) {
      // 结构化标记优先；保留字符串兜底以便老缓存里的 Error 也能被认出来。
      if (isCodexAppAssetMissingError(error)) return null;
      if (String(error?.message || error).includes(`未找到 Codex App asset: ${namePart}`)) return null;
      throw error;
    }
  }

  function appServerFallbackAssetUrls() {
    const urls = codexAppAssetCandidateUrls();
    const preferred = urls.filter((url) => {
      const name = (url.split("/").pop() || "").toLowerCase();
      return /use-host-config|app-server-manager-signals|app-initial|app-main|page-|chatg|signals|server-manager/.test(name);
    });
    // Prefer known request-client modules, then the larger application bundles.
    preferred.sort((left, right) => {
      const score = (url) => {
        const name = (url.split("/").pop() || "").toLowerCase();
        if (name.includes("use-host-config")) return 0;
        if (name.includes("app-server-manager-signals")) return 1;
        if (name.includes("app-initial") && name.includes("app-main")) return 3;
        if (name.includes("app-main")) return 4;
        return 5;
      };
      return score(left) - score(right) || right.length - left.length;
    });
    return preferred.slice(0, 16);
  }

  function collectAppServerRequestCandidatesFromModule(module) {
    const candidates = [];
    const seen = new Set();
    const push = (value) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      candidates.push(value);
    };
    for (const value of Object.values(module || {})) {
      push(value);
      if (!value || typeof value !== "object") continue;
      if (typeof value.get === "function") {
        try { push(value.get()); } catch {}
        try { push(value.get("local")); } catch {}
      }
      try {
        for (const nested of Object.values(value).slice(0, 100)) push(nested);
      } catch {}
    }
    return candidates;
  }

  async function loadAppServerRequestModules() {
    const modules = [];
    const sources = [];
    const seenModules = new Set();
    const seenUrls = new Set();
    const pushModule = (module, source) => {
      if (!module || typeof module !== "object" || seenModules.has(module)) return;
      seenModules.add(module);
      modules.push(module);
      sources.push(source);
    };
    for (const assetPrefix of ["use-host-config-", "app-server-manager-signals-"]) {
      try {
        const module = await loadOptionalCodexAppModule(assetPrefix);
        if (module) pushModule(module, assetPrefix);
      } catch {
      }
    }
    for (const url of appServerFallbackAssetUrls()) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      try {
        pushModule(await import(url), url);
      } catch {
      }
    }
    return { modules, sources };
  }

  async function loadAppServerRequestCandidates() {
    const { modules, sources } = await loadAppServerRequestModules();
    const candidates = [];
    const seen = new Set();
    for (const module of modules) {
      for (const candidate of collectAppServerRequestCandidatesFromModule(module)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
    const usedFallback = sources.some((source) => !source.endsWith("-"));
    return { modules, candidates, sources, discovery: usedFallback ? "fallback" : "named-assets" };
  }

  function normalizeCodexServiceTierModelName(model) {
    return String(model || "").trim().toLowerCase();
  }

  function codexServiceTierModelFromValue(value, visited = new WeakSet(), depth = 0) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || visited.has(value) || depth > 3) return "";
    visited.add(value);
    for (const key of ["model", "modelId", "model_id", "selectedModel", "selected_model", "defaultModel", "default_model"]) {
      const model = codexServiceTierModelFromValue(value[key], visited, depth + 1);
      if (model) return model;
    }
    for (const key of ["params", "request", "payload", "body", "config", "options"]) {
      const model = codexServiceTierModelFromValue(value[key], visited, depth + 1);
      if (model) return model;
    }
    return "";
  }

  function codexServiceTierCurrentModelName() {
    return codexServiceTierModelFromValue(codexModelCatalog.model) || codexServiceTierModelFromValue(codexModelCatalog.default_model);
  }

  // threadId -> 模型名。挂在 window 上跨重注入保留（重注入不该丢掉已知的线程模型）。
  // 只在请求路径观测到模型时写入，用于让界面判定跟上线程当前模型（issue #1463）。
  const codexServiceTierThreadModels = window.__codexPlusServiceTierThreadModels
    || (window.__codexPlusServiceTierThreadModels = new Map());

  // 线程中途换模型后，全局 catalog 的 model 字段往往还没更新，直接拿它判 Fast 可用性
  // 会落后一拍。因此界面优先读「当前线程最近一次实际请求用的模型」，读不到才回落全局。
  function codexServiceTierUiModelName(threadId = "") {
    const key = typeof threadId === "string" ? threadId.trim().replace(/^local:/, "") : "";
    if (key) {
      const cached = codexServiceTierThreadModels.get(key);
      if (cached) return cached;
    }
    return codexServiceTierCurrentModelName();
  }

  function codexServiceTierRememberThreadModel(threadId, modelName) {
    const key = typeof threadId === "string" ? threadId.trim().replace(/^local:/, "") : "";
    const model = codexServiceTierModelFromValue(modelName);
    if (!key || !model) return;
    codexServiceTierThreadModels.set(key, model);
    // 简易上界，避免长会话里 Map 无限增长；Map 的插入序即写入序，删最旧的即可。
    while (codexServiceTierThreadModels.size > 64) {
      const oldest = codexServiceTierThreadModels.keys().next().value;
      if (oldest === undefined) break;
      codexServiceTierThreadModels.delete(oldest);
    }
  }

  function codexServiceTierModelForRequest(params, modelHint = "") {
    return codexServiceTierModelFromValue(params) || codexServiceTierModelFromValue(modelHint) || codexServiceTierCurrentModelName();
  }

  function codexServiceTierFastSupportedForModel(modelName) {
    const normalized = normalizeCodexServiceTierModelName(modelName);
    if (!normalized) return false;
    // 不按名字猜：模型叫 deepseek 不代表它的中转站支持 priority tier。
    // 只认上游模型元数据里明确声明的 priority。
    try {
      const metadata = typeof codexPlusModelMetadata === "function" ? codexPlusModelMetadata(modelName) : null;
      if (typeof metadata?.prioritySupportOverride === "boolean") return metadata.prioritySupportOverride;
      const tierIs = (tier, expected) => String(typeof tier === "string" ? tier : tier?.id || "").trim().toLowerCase() === expected;
      if (Array.isArray(metadata?.serviceTiers) && metadata.serviceTiers.some((tier) => tierIs(tier, "priority"))) return true;
      if (Array.isArray(metadata?.additionalSpeedTiers) && metadata.additionalSpeedTiers.some((tier) => tierIs(tier, "fast"))) return true;
    } catch {}
    // 未声明仍沿用已验证的内置模型；第三方模型不能因名字含 fast 就自动放行。
    return codexServiceTierSupportedFastModels.has(normalized);
  }

  // UI 侧「Fast 是否可用」的唯一判据。这里必须复用 codexServiceTierFastSupportedForModel，
  // 不能再自己对照 codexServiceTierSupportedFastModels：那套只认内置名单，中转场景下
  // 模型名带前缀（或仅靠上游元数据声明 priority）时，界面会判「不支持/未读取」，而真正
  // 发请求的路径却按同一模型放了 service_tier=priority——两条判据不一致就会自相矛盾
  // （issue #772）。
  //
  // 默认模型名优先取最近一次在线程里观测到的模型（见 codexServiceTierRememberThreadModel），
  // 只有完全没观测过时才回落到全局 catalog——否则线程中途换模型后 UI 会落后一拍
  // （issue #1463）。
  function codexServiceTierFastAvailability(modelName = codexServiceTierUiModelName()) {
    const normalizedModel = normalizeCodexServiceTierModelName(modelName);
    return {
      modelName: modelName || "",
      supported: !!normalizedModel && codexServiceTierFastSupportedForModel(modelName),
    };
  }
  async function readCodexAppServerPreparation(path, payload, timeoutMs = codexAppServerPreparationTimeoutMs) {
    let timeoutId;
    try {
      return await Promise.race([
        postJson(path, payload),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            sendCodexPlusDiagnostic("app_server_preparation_read_timeout", { path, timeoutMs });
            reject(new Error(`Codex Pilot preparation read timed out: ${path}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function loadBackendSettingsState(timeoutMs = 0) {
    const seq = codexPlusBackendSettingsSeq;
    try {
      const settings = await (timeoutMs > 0
        ? readCodexAppServerPreparation("/settings/get", {}, timeoutMs)
        : postJson("/settings/get", {}));
      if (!settings || typeof settings !== "object" || !("enhancementsEnabled" in settings)) {
        throw new Error("invalid backend settings response");
      }
      if (seq !== codexPlusBackendSettingsSeq) {
        return false;
      }
      codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
      codexPlusBackendSettingsLoaded = true;
      globalThis.window?.__codexPlusNativeFastUnlock?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativeFastUnlock: codexPlusBackendSettings.codexAppNativeFastUnlock === true,
        nativeFastLocalApiConfigured: codexPlusBackendSettings.nativeFastLocalApiConfigured === true,
      });
      // 分区只接收策略和已核验的本机账号标识，不接收认证或供应商凭据。
      globalThis.window?.__codexPlusNativeProjectSections?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativeProjectSections: codexPlusBackendSettings.codexAppNativeProjectSections === true,
        nativeProjectSectionsLocalApiConfigured: codexPlusBackendSettings.nativeProjectSectionsLocalApiConfigured === true,
      });
      // 原生输入预测只接收开关、本机 API 布尔投影和预测模型 ID。
      globalThis.window?.__codexPlusNativePredictions?.runtime?.update?.({
        enhancementsEnabled: codexPlusBackendSettings.enhancementsEnabled !== false,
        codexAppNativePredictions: codexPlusBackendSettings.codexAppNativePredictions === true,
        nativePredictionsLocalApiConfigured: codexPlusBackendSettings.nativePredictionsLocalApiConfigured === true,
        codexAppNativePredictionsModel: String(codexPlusBackendSettings.codexAppNativePredictionsModel || "").trim(),
      });
    } catch (_) {
      return false;
    }
    return true;
  }
  // 原生准备会话时会读取本地配置；该 fetch 没有默认超时，丢失响应会同时
  // 挂住恢复和发送队列。只约束这一个只读接口，不接管原生恢复/提交生命周期。
  function installCodexConfigReadDeadline() {
    if (window.__codexPlusConfigReadDeadline) return;
    const pending = new Map();
    const deadlineMs = 15_000;
    const runtime = { pending, deadlineMs };

    const clear = (requestId) => {
      const timer = pending.get(requestId);
      if (timer === undefined) return;
      pending.delete(requestId);
      window.clearTimeout(timer);
    };
    const outgoing = (event) => {
      if (event?.__codexForwardedViaBridge !== true) return;
      const message = event?.detail;
      if (message?.type === "cancel-fetch") {
        clear(message.requestId);
        return;
      }
      if (message?.type !== "fetch" || message.method !== "POST"
          || message.url !== "vscode://codex/mcp-codex-config"
          || typeof message.requestId !== "string" || !message.requestId
          || pending.has(message.requestId)) return;
      const requestId = message.requestId;
      const timer = window.setTimeout(() => {
        if (pending.get(requestId) !== timer) return;
        pending.delete(requestId);
        // 取消宿主读取，同时让原生 fetch 自己清理 pending、reject 等待者。
        // 不吞掉配置错误，也不自动重发任何用户消息。
        try {
          const cancel = { type: "cancel-fetch", requestId };
          const bridge = window.electronBridge;
          if (typeof bridge?.sendMessageFromView === "function") {
            Promise.resolve(bridge.sendMessageFromView(cancel)).catch(() => {});
          } else {
            window.dispatchEvent(new CustomEvent("codex-message-from-view", { detail: cancel }));
          }
        } catch {
          // 宿主取消失败时仍需释放 renderer 的等待；迟到响应由原生按 ID 忽略。
        }
        window.dispatchEvent(new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            type: "fetch-response",
            requestId,
            responseType: "error",
            status: 408,
            error: "Timed out reading Codex configuration. Please try again.",
          },
        }));
        sendCodexPlusDiagnostic("config_read_deadline_exceeded", { deadlineMs });
      }, deadlineMs);
      pending.set(requestId, timer);
    };
    const incoming = (event) => {
      if (event?.source != null && event.source !== window) return;
      const origin = String(event?.origin || "");
      if (origin && origin !== "null" && origin !== window.location.origin) return;
      if (event?.data?.type === "fetch-response") clear(event.data.requestId);
    };
    window.addEventListener("codex-message-from-view", outgoing, true);
    window.addEventListener("message", incoming, true);
    window.__codexPlusConfigReadDeadline = runtime;
  }
  // 原生 Fork 的放置检查（#2826）：getForkCapabilities().readPlacement 要先读两个门控
  // sidebarCustomSectionsEnabled / useAppServerCustomSections，任一为 undefined 就返回
  // not-ready / execution-config-loading。后者来自 Statsig，Windows 上不登录账号（纯 API Key）
  // 时 Statsig 客户端一直不就绪，Fork 就永远失败：弹窗关闭、不产生新会话、没有任何提示。
  //
  // 这两个门控只决定「新会话放进哪个自定义侧栏分组」，而自定义分组需要账号；
  // 所以只在没有账号时把读不到的值按原生缺省 false 处理，登录用户保持原生行为。
  const codexForkPlacementGateKeys = new Set(["sidebarCustomSectionsEnabled", "useAppServerCustomSections"]);
  const codexForkReadinessState = window.__codexPlusForkReadinessState
    || (window.__codexPlusForkReadinessState = { installing: null, patched: false, reported: false });

  function codexForkPlacementSettings(settings) {
    return new Proxy(settings, {
      get(target, property) {
        if (property === "read") {
          return (key, ...rest) => {
            const value = target.read(key, ...rest);
            if (value !== undefined || !codexForkPlacementGateKeys.has(key)) return value;
            if (!codexForkReadinessState.reported) {
              codexForkReadinessState.reported = true;
              try { sendCodexPlusDiagnostic("fork_placement_gate_fallback", { key }); } catch {}
            }
            return false;
          };
        }
        // 方法绑回原对象：私有状态、getter 都按原对象读取。
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function codexForkReadinessFallbackActive(manager) {
    if (typeof codexPlusBackendSettings !== "undefined" && codexPlusBackendSettings?.enhancementsEnabled === false) return false;
    try {
      if (typeof manager?.settings?.read !== "function") return false;
      return manager.runtime?.accountId?.() == null;
    } catch {
      return false;
    }
  }

  function patchCodexForkCapabilities(prototype) {
    const original = prototype?.getForkCapabilities;
    if (typeof original !== "function") return false;
    if (original.__codexPlusForkReadiness === true) return true;
    const patched = function getForkCapabilities(...args) {
      if (!codexForkReadinessFallbackActive(this)) return original.apply(this, args);
      // 不改实例字段：以原实例为原型，只把 settings 换成兜底视图，其余字段照常读取。
      const receiver = Object.create(this, { settings: { value: codexForkPlacementSettings(this.settings) } });
      return original.apply(receiver, args);
    };
    Object.defineProperty(patched, "__codexPlusForkReadiness", { value: true });
    Object.defineProperty(patched, "__codexPlusOriginal", { value: original });
    prototype.getForkCapabilities = patched;
    return true;
  }

  function installCodexForkReadinessFallback(attempt = 0) {
    if (codexForkReadinessState.patched || codexForkReadinessState.installing) return codexForkReadinessState.installing;
    codexForkReadinessState.installing = (async () => {
      const module = await loadOptionalCodexAppModule("app-initial-");
      let patched = false;
      for (const value of Object.values(module || {})) {
        if (typeof value !== "function" || typeof value.prototype?.getForkCapabilities !== "function") continue;
        patched = patchCodexForkCapabilities(value.prototype) || patched;
      }
      return patched;
    })().catch(() => false).then((patched) => {
      codexForkReadinessState.installing = null;
      codexForkReadinessState.patched = patched;
      // 模块可能还没加载完；有限次退避重试，找不到就静默放弃（原生行为不变）。
      if (!patched && attempt < 5) window.setTimeout(() => void installCodexForkReadinessFallback(attempt + 1), 2000 * (attempt + 1));
      return patched;
    });
    return codexForkReadinessState.installing;
  }
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
  function installCodexPlusNavigationEntries() {
    // 清理旧版固定入口；拓展入口由注册中心单独管理。
    for (const id of [
      "codex-plus-sidebar-nav",
      "codex-plus-rail-nav",
      "codex-plus-rail-extensions",
      "codex-plus-rail-sponsor",
      "codex-plus-rail-plugin-market",
      "codex-plus-sidebar-plugin-market",
    ]) document.getElementById(id)?.remove();
    document.querySelectorAll(`#${codexPlusMenuId}, [data-codex-plus-menu="true"]`).forEach((node) => node.remove());
    refreshCodexPlusRailNavigation();
  }
  // 会话引用、桥接和诊断供第三方拓展及保留的增强功能共用。
  let cachedSessionRows = [];
  let cachedSessionRowsAt = 0;

  function sessionRows(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now - cachedSessionRowsAt < 150) {
      cachedSessionRows = cachedSessionRows.filter((row) => row.isConnected);
      if (cachedSessionRows.length > 0) return cachedSessionRows;
    }

    cachedSessionRows = Array.from(document.querySelectorAll(selectors.sidebarThread));
    cachedSessionRowsAt = now;
    return cachedSessionRows;
  }

  function archivePageHintVisible() {
    if (window.location.href.includes("archive")) return true;
    if (document.querySelector('[data-codex-archive-page-row="true"], [data-codex-archive-delete-all]')) return true;
    const archiveNav = document.querySelector(selectors.archiveNav);
    if (archiveNav?.className?.includes?.("bg-token-list-hover-background")) return true;
    return !!Array.from(document.querySelectorAll("h1, h2, h3")).find((element) => (element.textContent || "").trim() === "已归档对话");
  }

  function archiveRowFromUnarchiveButton(button) {
    return button.closest('[data-codex-archive-page-row="true"]')
      || button.closest('[role="listitem"], [role="row"]')
      || button.closest(".flex.w-full.items-center.justify-between")
      || button.parentElement;
  }

  function archivedPageRows() {
    if (!archivePageHintVisible()) return [];
    const rows = Array.from(document.querySelectorAll("button")).filter((button) => (button.textContent || "").trim() === "取消归档").map(archiveRowFromUnarchiveButton).filter(Boolean);
    rows.forEach((row) => {
      row.dataset.codexArchivePageRow = "true";
      row.setAttribute("data-codex-archive-page-row", "true");
    });
    return rows;
  }

  function archivedSessionRows() {
    if (!archivePageHintVisible()) return [];
    return sessionRows().filter((row) => row.querySelector('button[aria-label="取消归档对话"]') || row.outerHTML.includes("取消归档") || row.outerHTML.includes("unarchive"));
  }

  function archivedRows() {
    if (!archivePageHintVisible()) return [];
    return [...archivedSessionRows(), ...archivedPageRows()];
  }

  function archivedPageVisible() {
    return archivePageHintVisible() && archivedRows().length > 0;
  }

  function isClientNewThreadId(value) {
    return /^(?:local:)?client-new-thread:/i.test(String(value || "").trim());
  }

  function normalizedCodexThreadUuid(value) {
    const id = String(value || "").trim().replace(/^local:/i, "");
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
  }

  function reactConversationIdFromRow(row) {
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let fiberDepth = 0; fiber && fiberDepth < 16; fiberDepth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
        const directId = normalizedCodexThreadUuid(props?.conversationId);
        if (directId) return directId;
        const childId = normalizedCodexThreadUuid(
          props?.children?.props?.conversationId,
        );
        if (childId) return childId;
      }
    }
    return "";
  }

  function sessionRefFromRow(row) {
    const href = row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
    const idMatch = href.match(/(?:session|conversation|thread)[=/:-]([A-Za-z0-9_.-]+)/i) || href.match(/([A-Za-z0-9_-]{8,})$/);
    const codexThreadId = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const scopedThread = codexThreadId.match(/^(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const fallbackId = row.getAttribute("data-session-id") || row.getAttribute("data-testid") || "";
    const placeholderThreadId = isClientNewThreadId(codexThreadId);
    const hrefId = idMatch && idMatch[1];
    const canonicalHrefId = normalizedCodexThreadUuid(hrefId);
    const hrefIsTemporary = isClientNewThreadId(href)
      || isClientNewThreadId(hrefId)
      || /(?:^|[=/])(?:local:)?client-new-thread:/i.test(href);
    const sessionId = placeholderThreadId
      ? canonicalHrefId || (!hrefIsTemporary ? reactConversationIdFromRow(row) : "")
      : normalizedCodexThreadUuid(codexThreadId)
        || (scopedThread ? scopedThread[2] : "")
        || canonicalHrefId
        || codexThreadId
        || hrefId
        || fallbackId;
    const titleNode = row.querySelector(`${selectors.threadTitle}, .truncate.select-none, .truncate.text-base`);
    const rawTitle = (titleNode?.textContent || (titleNode ? "" : (row.textContent || "Untitled session")));
    const title = (titleNode ? rawTitle : rawTitle.replace(/\s*(导出|删除|移动|移出项目)(\s*(导出|删除|移动|移出项目))*$/g, "")).trim().slice(0, 160);
    return { session_id: sessionId, title, host_id: sessionHostIdFromRow(row, sessionId, scopedThread?.[1]) };
  }

  function sessionHostIdFromRow(row, sessionId, scopedHost) {
    return sessionHostEvidenceFromRow(row, sessionId, scopedHost).hostId;
  }

  function sessionHostEvidenceFromRow(row, sessionId, scopedHost) {
    const hosts = new Set();
    let matchingMetadata = 0;
    let identityConflict = false;
    const add = (value) => {
      if (typeof value === "string" && value.trim()) hosts.add(value.trim());
    };
    const identity = (value) => {
      if (typeof value !== "string" || !value.trim()) return null;
      const raw = value.trim();
      const scoped = raw.match(/^(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const id = normalizedCodexThreadUuid(raw) || scoped?.[2];
      return id ? { id: id.toLowerCase(), host: scoped?.[1] } : raw === sessionId ? { id: raw, host: null } : null;
    };
    const canonicalWanted = normalizedCodexThreadUuid(sessionId);
    const wanted = canonicalWanted ? canonicalWanted.toLowerCase() : sessionId || "";
    const identities = (record) => [record?.conversationId, record?.threadId, record?.id].map(identity).filter(Boolean);
    const collect = (record) => {
      if (!record || typeof record !== "object") return;
      const ownIds = identities(record);
      const matched = ownIds.some((candidate) => candidate.id === wanted);
      const nested = [record.threadSummary, record.thread, record.target].filter((value) => value && typeof value === "object");
      const allIds = [...ownIds, ...nested.flatMap(identities)];
      if (allIds.some((candidate) => candidate.id === wanted) && allIds.some((candidate) => candidate.id !== wanted)) {
        identityConflict = true;
        return;
      }
      if (matched) {
        matchingMetadata += 1;
        add(record.hostId);
        ownIds.forEach((candidate) => add(candidate.host));
        // 26.930 原生 sidebar 行的 {conversationId,hostId,threadSummary}：
        // hostId ?? threadSummary?.hostId。summary 没有自己的 id 时仍属于这条会话。
        if (record.threadSummary && !["conversationId", "threadId", "id"].some((key) => typeof record.threadSummary[key] === "string" && record.threadSummary[key].trim())) add(record.threadSummary.hostId);
      }
      for (const child of nested) {
        const childIds = identities(child);
        if (!childIds.some((candidate) => candidate.id === wanted)) continue;
        matchingMetadata += 1;
        add(child.hostId);
        childIds.forEach((candidate) => add(candidate.host));
      }
    };
    add(row.getAttribute("data-app-action-sidebar-thread-host-id"));
    const rowIdentity = identity(row.getAttribute("data-app-action-sidebar-thread-id"));
    if (rowIdentity?.id === wanted) add(scopedHost || rowIdentity.host);
    // 只接受同一条会话的成对身份。原生 locator 为 {hostId,threadId}，
    // sidebarThreadRow 为 {hostId,id}；bare UUID 或不相关祖先的 hostId 都不说明归属。
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 16; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps, fiber.pendingProps?.children?.props, fiber.memoizedProps?.children?.props]) {
        collect(props);
      }
    }
    const conflict = identityConflict || hosts.size > 1;
    return {
      hostId: !conflict && hosts.size === 1 ? [...hosts][0] : null,
      reason: conflict ? "conflicting" : hosts.size === 1 ? "resolved" : "unknown",
      hostCount: hosts.size,
      matchingMetadata,
    };
  }

  if (window.__CODEX_PLUS_TEST_SESSION_REF__) {
    window.__codexPlusSessionRefTest = {
      fromRow: sessionRefFromRow,
    };
  }

  function codexPlusDiagnosticPayload(event, detail) {
    return {
      event,
      detail: detail || {},
      hasBridge: !!window.__codexSessionDeleteBridge,
      location: window.location?.href || "",
      userAgent: navigator.userAgent || "",
      timestamp: new Date().toISOString(),
    };
  }

  async function sendCodexPlusDiagnostic(event, detail) {
    const payload = codexPlusDiagnosticPayload(event, detail);
    if (window.__CODEX_PLUS_TEST_SERVICE_TIER__) {
      window.__codexPlusServiceTierTestDiagnostics = window.__codexPlusServiceTierTestDiagnostics || [];
      window.__codexPlusServiceTierTestDiagnostics.push(payload);
      return;
    }
    if (window.__codexSessionDeleteBridge) {
      try {
        const response = await window.__codexSessionDeleteBridge("/diagnostics/log", payload);
        if (response?.status === "ok") return;
      } catch (_) {}
    }
    // 诊断只复用 CDP 桥接；桥接尚未就绪时放弃本条日志，不再请求本机 HTTP 端口。
  }

  sendCodexPlusDiagnostic("script_loaded", {
    version: codexPlusVersion,
    build: codexPlusBuild,
  });

  function locationThreadId() {
    const source = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function currentSessionRef() {
    const rows = sessionRows();
    for (const row of rows) {
      const ref = sessionRefFromRow(row);
      if (ref.session_id && isCurrentSessionRow(row, ref)) return ref;
    }
    return { session_id: locationThreadId(), title: "" };
  }

  async function postJson(path, payload) {
    const bridge = window.__codexSessionDeleteBridge;
    if (typeof bridge !== "function") {
      recordCodexPlusBridgeFailure();
      return { status: "failed", message: "桥接不可用，请重启启动器" };
    }
    try {
      // 状态心跳仍有超时与尝试时间记录，供看门狗区分页面忙碌和真正断连。
      const request = bridge(path, payload);
      const result = path === "/backend/status" ? await withBackendTimeout(request) : await request;
      if (path === "/backend/status" && result?.status !== "ok") {
        recordCodexPlusBridgeFailure();
        if (result?.timeout) {
          recordCodexPlusBridgeAttempt();
          sendCodexPlusDiagnostic("backend_bridge_timeout", { path });
        }
        return result;
      }
      recordCodexPlusBridgeSuccess();
      return result;
    } catch (error) {
      recordCodexPlusBridgeFailure();
      sendCodexPlusDiagnostic("bridge_call_failed", {
        path,
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
      if (path === "/backend/status") {
        return { status: "failed", message: error?.message || "未连接" };
      }
      throw error;
    }
  }
  // 标签栏读取原生状态、项目和图标；用户打开对话选项时复用原生菜单，不另建会话操作逻辑。
  // Rspack 的模块 ID、导出短名随版本变化，因此按已核验的职责特征定位并要求唯一命中。
  function codexPlusConversationTabStatusApi(require) {
    if (typeof require !== 'function' || !require.m || !require.c) return null;
    const factories = Object.entries(require.m).map(([id, factory]) => [id, String(factory)]);
    function uniqueFactory(matches) {
      const entries = factories.filter(([, source]) => matches(source));
      if (entries.length !== 1) return null;
      // 原生启动尚未完成时，require 会执行工厂并永久缓存异常；识别阶段只能读取已初始化导出。
      // 即使捕获异常也无法撤销原生缓存，因此绝不能靠试执行来探测模块是否就绪。
      const cached = require.c[entries[0][0]];
      if (!cached || cached.error || !cached.exports || typeof cached.exports.then === 'function') return null;
      return { source: entries[0][1], module: cached.exports };
    }
    function uniqueModule(matches) { return uniqueFactory(matches)?.module || null; }
    function uniqueValue(module, matches) {
      const values = Object.values(module || {}).filter(matches);
      return values.length === 1 ? values[0] : null;
    }
    const states = uniqueModule(source => ['questionKey', 'pendingThreadStart', 'summaryHostId', 'hasUnreadTurn'].every(part => source.includes(part)));
    const attention = uniqueValue(states, value => typeof value === 'function'
      && ['"idle"===', '"unread"===', '?"active":'].every(part => String(value).includes(part)));
    const rows = uniqueValue(states, value => typeof value === 'function'
      && ['.flatMap(', 'gitBranch:', 'workspaceKind:', 'summary:'].every(part => String(value).includes(part)));
    // 原生完整条目保留新会话的临时 key；规范化 rows 只给正式 UUID，不能拿它直接查项目分组。
    const nativeEntry = uniqueValue(states, value => typeof value === 'function'
      && ['.byKey.get(', 'summary:', 'hasUnreadTurn:'].every(part => String(value).includes(part)));
    const scopes = new Set(Object.values(states || {}).map(value => value?.scope).filter(Boolean));
    const Indicator = uniqueValue(uniqueModule(source => source.length < 3000
      && ['statusState:', 'unreadCount', 'attention', 'working:'].every(part => source.includes(part))), value => typeof value === 'function');
    const react = uniqueModule(source => source.includes('.createElement=function') && source.includes('.useState=function'));
    const dom = uniqueModule(source => source.includes('.createRoot=function'));
    if (!attention || !rows || scopes.size !== 1 || !Indicator || !react?.createElement || !dom?.createRoot) return null;
    const [scopeToken] = scopes;
    const known = new Set(['idle', 'active', 'unread', 'input', 'approval', 'error']);
    const metadata = uniqueFactory(source => ['sidebar_workspace_task_groups_task_dirs', 'projectlessThreadIds', 'gitRepositoryName'].every(part => source.includes(part)));
    let projectSignal = null;
    if (metadata) {
      // 原生侧栏按 threadKey 从项目索引取完整归属；从绑定关系追到导出，避免写死 T8 等混淆名。
      const id = '[A-Za-z_$][\\w$]*';
      const bindings = [...metadata.source.matchAll(new RegExp(`(?:let |,)(?<binding>${id})=\\(0,${id}\\.${id}\\)\\(${id}\\.${id},\\((?<key>${id}),\\{get:(?<get>${id})\\}\\)=>\\k<get>\\(${id}\\)\\.get\\(\\k<key>\\)\\?\\?null\\)`, 'g'))];
      if (bindings.length === 1) {
        const binding = bindings[0].groups.binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exports = [...metadata.source.slice(metadata.source.lastIndexOf('.d(')).matchAll(new RegExp(`(?:\\{|,)(?<name>${id}):(?:\\(\\)=>)?${binding}(?=[,}])`, 'g'))];
        if (exports.length === 1 && metadata.module[exports[0].groups.name]?.scope === scopeToken) projectSignal = metadata.module[exports[0].groups.name];
      }
    }
    const ProjectIcon = uniqueValue(uniqueModule(source => ['gizmo.display.theme', 'gizmo.display.emoji', 'markerClassName:'].every(part => source.includes(part))), value => typeof value === 'function');
    // 复用完整的原生行组件生成菜单，保留项目移动、重命名和归档确认等原生行为。
    const threadRowFactories = factories.filter(([, source]) => ['entryFallback:', 'sidebarThreadRow', 'onArchivePendingWorktree:', 'threadKey:'].every(part => source.includes(part)));
    function threadRow() {
      if (threadRowFactories.length !== 1) return null;
      // 只有用户明确打开菜单后才允许加载原生行组件，此时主界面和上下文都已完成初始化。
      try {
        return uniqueValue(require(threadRowFactories[0][0]), value => typeof value === 'function' || value?.$$typeof === Symbol.for('react.memo'));
      } catch { return null; }
    }
    const threadMenus = new Map();
    function threadKey(get, id) {
      const key = 'local:' + id, entry = nativeEntry?.(get, key);
      // 仅接受原生确认属于同一 UUID、同一本地主机的映射；临时 key 不参与持久化或页面导航。
      return entry?.kind === 'local' && entry.summary?.conversationId === id && entry.summary.hostId === 'local'
        && typeof entry.key === 'string' && entry.key.startsWith('local:') ? entry.key : key;
    }
    function localRow(context, id) {
      if (!context?.scope || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
      try {
        const row = rows((...args) => context.scope.get(...args), ['local:' + id])[0];
        return row?.kind === 'local' && row.hostId === 'local' ? row : null;
      } catch { return null; }
    }
    function releaseThreadMenu(id) {
      const menu = threadMenus.get(id); if (!menu) return;
      menu.cancel?.(); menu.root.unmount(); menu.host.remove(); threadMenus.delete(id);
    }

    // 图标在独立小根中渲染；原生组件升级后即使失配，也不能影响 Codex 主 React 树。
    class StatusBoundary extends react.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? this.props.fallback || null : this.props.children; }
    }
    return {
      // 每轮从当前 shell 查找 scope；不缓存侧栏 DOM 或依赖项目是否展开。
      context() {
        const anchor = document.querySelector('[data-app-shell-active-page="true"]')
          || document.querySelector('[data-app-shell-main-surface]');
        const key = anchor && Object.getOwnPropertyNames(anchor).find(name => name.startsWith('__reactFiber$'));
        let current = anchor?.[key], root = current;
        for (let depth = 0; root?.return && depth < 200; depth++) root = root.return;
        if (current?.alternate && root?.stateNode?.current && root.stateNode.current !== root) current = current.alternate;
        let scope = null, intl = null, appScope = null;
        const providers = [], seen = new Set();
        for (let fiber = current, depth = 0; fiber && depth < 180; fiber = fiber.return, depth++) {
          // 只读已提交的 hook ref，不调用原生 hook，也不复制其内部 store 实现。
          for (let hook = fiber.memoizedState, i = 0; !scope && hook && i < 80; hook = hook.next, i++) {
            const value = hook.memoizedState?.current;
            if (value?.scope === scopeToken && typeof value.get === 'function' && typeof value.watch === 'function') scope = value;
          }
          const value = fiber.memoizedProps?.value;
          // 菜单组件还依赖导航、弹窗等上下文，沿当前已提交的主树复用最近一层 provider。
          const provider = fiber.type, token = provider?._context || provider;
          if ([Symbol.for('react.context'), Symbol.for('react.provider')].includes(provider?.$$typeof)
            && fiber.memoizedProps && Object.hasOwn(fiber.memoizedProps, 'value') && !seen.has(token)) {
            seen.add(token); providers.push({ Provider: provider, value });
          }
          if (!intl && typeof value?.formatMessage === 'function' && typeof value.locale === 'string') intl = { Provider: fiber.type, value };
          // 原生项目图标自身订阅图标/颜色设置，需要与主树共用 AppScope，而非复制其配置。
          if (!appScope && fiber.type?.displayName === scopeToken.__scopeBrand && value instanceof Map && value.has(scopeToken.id)) appScope = { Provider: fiber.type, value };
        }
        return scope && intl ? { scope, intl, appScope, providers } : null;
      },
      canOpenThreadMenu(context, id) {
        return threadRowFactories.length === 1 && !!context?.providers?.length && !!localRow(context, id);
      },
      openThreadMenu(context, id, x, y) {
        if (!context?.providers?.length || !localRow(context, id)) return false;
        const ThreadRow = threadRow(); if (!ThreadRow) return false;
        let key;
        try { key = threadKey((...args) => context.scope.get(...args), id); }
        catch { return false; }
        let menu = threadMenus.get(id);
        if (menu && menu.scope !== context.scope) { releaseThreadMenu(id); menu = null; }
        if (!menu) {
          // 宿主只在用户打开菜单时创建；隐藏行不参与标签扫描，原生弹窗仍由其 portal 正常呈现。
          const host = document.createElement('div'); host.hidden = true;
          host.setAttribute('data-codex-plus-ext', 'conversation-tabs'); document.body.append(host);
          menu = { host, root: dom.createRoot(host), scope: context.scope, cancel: null }; threadMenus.set(id, menu);
        }
        menu.cancel?.();
        return new Promise(resolve => {
          let done = false, timeout;
          const finish = opened => {
            if (done) return; done = true; observer.disconnect(); clearTimeout(timeout); menu.cancel = null; resolve(opened);
          };
          const open = () => {
            if (done || !menu.host.isConnected) return;
            // 创建期间映射可能刚好完成切换，接受已核验的临时 key 或同一正式 UUID。
            const row = menu.host.querySelector('[data-app-action-sidebar-thread-id="' + key + '"]')
              || menu.host.querySelector('[data-app-action-sidebar-thread-id="local:' + id + '"]');
            if (!row) return;
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y, button: 2, buttons: 2 }));
            finish(true);
          };
          // 等 React 提交真实菜单处理器；不用后台窗口可能暂停的 requestAnimationFrame。
          const observer = new MutationObserver(open); observer.observe(menu.host, { childList: true, subtree: true });
          menu.cancel = () => finish(false); timeout = setTimeout(() => finish(false), 2000);
          let content = react.createElement(ThreadRow, { threadKey: key,
            onArchiveStart() {}, onArchiveSuccess() {}, onArchiveError() {} });
          for (const provider of context.providers) content = react.createElement(provider.Provider, { value: provider.value }, content);
          try { menu.root.render(react.createElement(StatusBoundary, null, content)); }
          catch { finish(false); }
          Promise.resolve().then(open);
        });
      },
      cancelThreadMenu(id) { threadMenus.get(id)?.cancel?.(); },
      // 不在原生菜单关闭时卸载：归档等操作可能随后打开确认弹窗，需要继续保留原生组件状态。
      releaseThreadMenu,
      watch(context, ids, changed, projectsChanged) {
        // rows 与 attention 都来自原生侧栏模块；host 验证避免同 UUID 的远端会话串入本地标签。
        return context.scope.watch(({ get }) => {
          const snapshot = new Map(), projects = new Map();
          for (const id of ids) {
            const key = 'local:' + id;
            const row = rows(get, [key])[0];
            if (row?.kind !== 'local' || row.hostId !== 'local') continue;
            const state = attention(get, key);
            if (known.has(state)) snapshot.set(id, state);
            if (projectSignal) try {
              const resolvedKey = threadKey(get, id);
              let group = get(projectSignal, resolvedKey);
              if (group == null && resolvedKey !== key) group = get(projectSignal, key);
              // 名称来自原生项目索引，工作目录只作悬停说明；不按目录 basename 猜项目名。
              projects.set(id, group && typeof group.projectId === 'string' && typeof group.label === 'string' ? {
                id: group.projectId, name: group.label,
                path: typeof group.path === 'string' ? group.path : '',
                kind: group.projectKind === 'remote' ? 'remote' : 'local',
                hostId: typeof group.hostId === 'string' ? group.hostId : '',
              } : null);
            } catch { /* 项目索引短暂不可读时保留已有归属，状态订阅继续生效。 */ }
          }
          changed(snapshot);
          projectsChanged?.(projects);
        });
      },
      mountProject(element, fallbackMarkup) {
        const root = dom.createRoot(element);
        const fallbackIcon = react.createElement('span', { className: 'cpt-project-fallback', dangerouslySetInnerHTML: { __html: fallbackMarkup } });
        return {
          render(project, context) {
            let icon = project?.id && ProjectIcon && context.appScope ? react.createElement(ProjectIcon, {
              projectId: project.id, size: 12, className: 'cpt-project-native-icon', markerClassName: 'cpt-project-native-icon',
              isRemoteProject: project.kind === 'remote', remoteHostId: project.hostId || undefined, fallbackIcon,
            }) : fallbackIcon;
            if (context.appScope) icon = react.createElement(context.appScope.Provider, { value: context.appScope.value }, icon);
            // 原生图标升级或缺少上下文时仍显示文件夹，不能让固定的项目行变成空图标。
            root.render(react.createElement(StatusBoundary, { fallback: fallbackIcon },
              react.createElement(context.intl.Provider, { value: context.intl.value }, icon)));
          },
          dispose() { root.unmount(); },
        };
      },
      mount(element) {
        const root = dom.createRoot(element);
        return {
          render(state, context) {
            const statusState = {
              type: state === 'active' ? 'loading' : state === 'error' ? 'error' : 'idle',
              attention: state === 'input' || state === 'approval' ? state : undefined,
              unread: state === 'unread',
            };
            // Intl 使用当前主树的同一个 provider，状态名称随原生语言设置切换。
            root.render(react.createElement(StatusBoundary, null,
              react.createElement(context.intl.Provider, { value: context.intl.value },
                react.createElement(Indicator, { statusState, size: 'compact' }))));
          },
          dispose() { root.unmount(); },
        };
      },
      description(state, context) {
        const messages = {
          active: ['taskRow.working', 'Working'], unread: ['sidebar.navItem.unread', 'Unread updates'],
          input: ['sidebar.aggregate.needsInput', 'Needs input'], approval: ['sidebar.aggregate.awaitingApproval', 'Needs approval'],
          error: ['taskRow.failed', 'Task failed'],
        };
        const message = messages[state];
        return message ? context.intl.value.formatMessage({ id: message[0], defaultMessage: message[1] }) : '';
      },
    };
  }

  async function loadCodexPlusConversationTabStatusApi() {
    // 冷启动的 loading 壳还没有原生应用上下文；此时不导入启动脚本，也不抢跑其模块初始化。
    if (!document.querySelector('[data-app-shell-main-surface]')) return null;
    // 只检查页面的启动脚本且每次启用最多探测一次，不把全部资源扫描放进刷新循环。
    for (const script of Array.from(document.scripts || [])) {
      if (!script.src?.startsWith(location.origin + '/assets/')) continue;
      try {
        const response = await fetch(script.src);
        if (!response.ok || !(await response.text()).includes('as __webpack_require__')) continue;
        const module = await import(script.src);
        return codexPlusConversationTabStatusApi(module.__webpack_require__);
      } catch { /* 原生模块未就绪或版本不兼容时，标签导航继续工作。 */ }
    }
    return null;
  }
  /*
   * 改编自 chatgpt-codex-tabs 的独立 renderer（不包含 CodexHost 或独立启动器）。
   * 来源：https://github.com/yuanruoyu515/chatgpt-codex-tabs
   * MIT License
   *
   * Copyright (c) 2026 yuanruoyu515
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */

  // 热注入先释放旧监听、观察器、计时器和布局；开关关闭后持久化标签继续保留。
  window.__codexPlusConversationTabs?.dispose?.();

  function syncCodexPlusConversationTabs() {
    const enabled = codexPlusBackendSettings.enhancementsEnabled === true
      && codexPlusBackendSettings.codexAppConversationTabs === true;
    const eligible = document.body && !new URL(window.location.href).searchParams.has('initialRoute');
    if (!enabled || !eligible) {
      window.__codexPlusConversationTabs?.dispose?.();
      return;
    }
    if (!window.__codexPlusConversationTabs) createCodexPlusConversationTabs();
  }

  function createCodexPlusConversationTabs() {
    const navigate = (path) => window.electronBridge?.sendMessageFromView?.({ type: 'open-in-main-window', path });



    let store;
    try { store = window.localStorage; } catch { /* 系统禁用本地存储时仍允许临时使用标签。 */ }
    const key = 'codex-plus:conversation-tabs:v1';
    const attr = 'data-app-action-sidebar-thread-';
    const MAX_TABS = 30;
    const STRINGS = {
      en: ['Open threads', 'New chat', 'Close tab (the thread is kept)', 'Close tab: ', 'Untitled thread', 'Close tab', 'Close other tabs', 'Close tabs to the right', 'Thread options…', 'Not in the sidebar'],
      'zh-CN': ['打开的对话', '新建对话', '关闭标签（不会删除对话）', '关闭标签：', '未命名对话', '关闭标签', '关闭其他标签', '关闭右侧标签', '对话选项…', '侧栏里没有这个对话'],
      'zh-TW': ['已開啟的對話', '新增對話', '關閉分頁（不會刪除對話）', '關閉分頁：', '未命名對話', '關閉分頁', '關閉其他分頁', '關閉右側分頁', '對話選項…', '側邊欄裡沒有這個對話'],
      ja: ['開いているスレッド', '新しいチャット', 'タブを閉じる（スレッドは削除されません）', 'タブを閉じる：', '無題のスレッド', 'タブを閉じる', '他のタブを閉じる', '右側のタブを閉じる', 'スレッドのオプション…', 'サイドバーにありません'],
      ko: ['열린 스레드', '새 채팅', '탭 닫기(스레드는 삭제되지 않음)', '탭 닫기: ', '제목 없는 스레드', '탭 닫기', '다른 탭 닫기', '오른쪽 탭 닫기', '스레드 옵션…', '사이드바에 없음'],
      es: ['Conversaciones abiertas', 'Nuevo chat', 'Cerrar pestaña (la conversación no se elimina)', 'Cerrar pestaña: ', 'Conversación sin título', 'Cerrar pestaña', 'Cerrar las demás pestañas', 'Cerrar pestañas a la derecha', 'Opciones de la conversación…', 'No está en la barra lateral'],
      fr: ['Conversations ouvertes', 'Nouveau chat', 'Fermer l’onglet (la conversation est conservée)', 'Fermer l’onglet : ', 'Conversation sans titre', 'Fermer l’onglet', 'Fermer les autres onglets', 'Fermer les onglets à droite', 'Options de la conversation…', 'Absente de la barre latérale'],
      de: ['Geöffnete Threads', 'Neuer Chat', 'Tab schließen (Thread bleibt erhalten)', 'Tab schließen: ', 'Unbenannter Thread', 'Tab schließen', 'Andere Tabs schließen', 'Tabs rechts schließen', 'Thread-Optionen…', 'Nicht in der Seitenleiste'],
      it: ['Conversazioni aperte', 'Nuova chat', 'Chiudi scheda (la conversazione resta)', 'Chiudi scheda: ', 'Conversazione senza titolo', 'Chiudi scheda', 'Chiudi le altre schede', 'Chiudi le schede a destra', 'Opzioni conversazione…', 'Non presente nella barra laterale'],
      pt: ['Conversas abertas', 'Novo chat', 'Fechar aba (a conversa não é excluída)', 'Fechar aba: ', 'Conversa sem título', 'Fechar aba', 'Fechar outras abas', 'Fechar abas à direita', 'Opções da conversa…', 'Não está na barra lateral'],
      'pt-PT': ['Conversas abertas', 'Novo chat', 'Fechar separador (a conversa não é eliminada)', 'Fechar separador: ', 'Conversa sem título', 'Fechar separador', 'Fechar os outros separadores', 'Fechar separadores à direita', 'Opções da conversa…', 'Não está na barra lateral'],
      nl: ['Geopende gesprekken', 'Nieuwe chat', 'Tabblad sluiten (gesprek blijft bewaard)', 'Tabblad sluiten: ', 'Naamloos gesprek', 'Tabblad sluiten', 'Andere tabbladen sluiten', 'Tabbladen rechts sluiten', 'Gespreksopties…', 'Niet in de zijbalk'],
      pl: ['Otwarte wątki', 'Nowy czat', 'Zamknij kartę (wątek pozostaje)', 'Zamknij kartę: ', 'Wątek bez tytułu', 'Zamknij kartę', 'Zamknij pozostałe karty', 'Zamknij karty po prawej', 'Opcje wątku…', 'Brak na pasku bocznym'],
      ru: ['Открытые чаты', 'Новый чат', 'Закрыть вкладку (чат не удаляется)', 'Закрыть вкладку: ', 'Чат без названия', 'Закрыть вкладку', 'Закрыть другие вкладки', 'Закрыть вкладки справа', 'Параметры чата…', 'Нет на боковой панели'],
      uk: ['Відкриті чати', 'Новий чат', 'Закрити вкладку (чат не видаляється)', 'Закрити вкладку: ', 'Чат без назви', 'Закрити вкладку', 'Закрити інші вкладки', 'Закрити вкладки праворуч', 'Параметри чату…', 'Немає на бічній панелі'],
      tr: ['Açık sohbetler', 'Yeni sohbet', 'Sekmeyi kapat (sohbet silinmez)', 'Sekmeyi kapat: ', 'Adsız sohbet', 'Sekmeyi kapat', 'Diğer sekmeleri kapat', 'Sağdaki sekmeleri kapat', 'Sohbet seçenekleri…', 'Kenar çubuğunda yok'],
      vi: ['Cuộc trò chuyện đang mở', 'Cuộc trò chuyện mới', 'Đóng thẻ (không xóa cuộc trò chuyện)', 'Đóng thẻ: ', 'Cuộc trò chuyện chưa đặt tên', 'Đóng thẻ', 'Đóng các thẻ khác', 'Đóng các thẻ bên phải', 'Tùy chọn cuộc trò chuyện…', 'Không có trong thanh bên'],
      id: ['Percakapan terbuka', 'Chat baru', 'Tutup tab (percakapan tidak dihapus)', 'Tutup tab: ', 'Percakapan tanpa judul', 'Tutup tab', 'Tutup tab lain', 'Tutup tab di sebelah kanan', 'Opsi percakapan…', 'Tidak ada di bilah samping'],
      th: ['แชทที่เปิดอยู่', 'แชทใหม่', 'ปิดแท็บ (แชทจะไม่ถูกลบ)', 'ปิดแท็บ: ', 'แชทที่ไม่มีชื่อ', 'ปิดแท็บ', 'ปิดแท็บอื่น', 'ปิดแท็บทางขวา', 'ตัวเลือกแชท…', 'ไม่อยู่ในแถบด้านข้าง'],
    };
    const KEYS = ['bar', 'add', 'closeTip', 'closeLabel', 'untitled', 'close', 'closeOthers', 'closeRight', 'options', 'noRow'];
    const PROJECT_STRINGS = {
      en: ['No project', 'Project unavailable'], 'zh-CN': ['未关联项目', '项目未识别'], 'zh-TW': ['未關聯專案', '無法識別專案'],
      ja: ['プロジェクトなし', 'プロジェクト不明'], ko: ['프로젝트 없음', '프로젝트 확인 불가'],
      es: ['Sin proyecto', 'Proyecto no disponible'], fr: ['Aucun projet', 'Projet indisponible'], de: ['Kein Projekt', 'Projekt nicht verfügbar'],
      it: ['Nessun progetto', 'Progetto non disponibile'], pt: ['Sem projeto', 'Projeto indisponível'], 'pt-PT': ['Sem projeto', 'Projeto indisponível'],
      nl: ['Geen project', 'Project niet beschikbaar'], pl: ['Brak projektu', 'Projekt niedostępny'], ru: ['Без проекта', 'Проект недоступен'],
      uk: ['Без проєкту', 'Проєкт недоступний'], tr: ['Proje yok', 'Proje kullanılamıyor'], vi: ['Không có dự án', 'Không xác định dự án'],
      id: ['Tanpa proyek', 'Proyek tidak tersedia'], th: ['ไม่มีโปรเจกต์', 'ไม่พบโปรเจกต์'],
    };
    const OLD_UNTITLED = new Set(['未命名对话']);
    let str = {}, lang = '';
    function localize() {
      const tag = document.documentElement.lang || navigator.language || 'en';
      if (tag === lang) return false;
      lang = tag;
      const [base, region = ''] = tag.split('-'), r = region.toUpperCase();
      const pick = base === 'zh' ? (/^(TW|HK|MO|HANT)$/.test(r) || /hant/i.test(tag) ? 'zh-TW' : 'zh-CN')
        : base === 'pt' && r === 'PT' ? 'pt-PT' : Object.hasOwn(STRINGS, base) ? base : 'en';
      str = Object.fromEntries(KEYS.map((k, i) => [k, STRINGS[pick][i]]));
      [str.noProject, str.unknownProject] = PROJECT_STRINGS[pick];
      return true;
    }
    localize();
    const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const abort = new AbortController();
    const opts = { signal: abort.signal };
    // active 是乐观选中项；appActive 来自已确认的原生路由/侧栏，pending 等待导航完成。
    let tabs = [], active = '', appActive = '', pending = null, scrolledTo = '';
    let disposed = false, timer = 0, suppressed = '', saved = '';
    let statusApi = null, statusContext = null, statusWatch = null, statusIds = '';
    let statusLoading = false, statusLoadAttempts = 0, statusNextLoadAt = 0;
    let nativeStates = new Map(), nativeProjects = new Map(), statusGeneration = 0;
    // 悬停子菜单和拖动动画的延迟也归运行时所有，关闭开关不能遗留异步回调。
    const delays = new Set();
    function later(callback, ms) {
      const id = setTimeout(() => { delays.delete(id); if (!disposed) callback(); }, ms);
      delays.add(id);
      return id;
    }
    function cancelLater(id) { clearTimeout(id); delays.delete(id); }
    // 只保存本机持久 UUID；损坏缓存、重复项和临时客户端 ID 都不能变成导航目标。
    try {
      const parsed = JSON.parse(store?.getItem(key) || '[]');
      if (Array.isArray(parsed)) tabs = [...new Map(parsed.filter(valid).map(tab => [tab.id.toLowerCase(), stored(tab)])).values()].slice(-MAX_TABS);
    } catch {}
    for (const tab of tabs) if (OLD_UNTITLED.has(tab.title)) tab.title = '';
    function valid(t) { return t && typeof t.id === 'string' && ID.test(t.id) && typeof t.title === 'string'; }
    function stored({ id, title }) { return { id: id.toLowerCase(), title: title.slice(0, 240) }; }
    function visible(el) { return el && !el.closest('[data-app-shell-active-page="false"], [inert]') && el.getBoundingClientRect().width > 0; }
    function isLocal(r) { return r.getAttribute(attr + 'host-id') === 'local' && ['', 'local'].includes(r.getAttribute(attr + 'kind') || ''); }
    function rowId(r) {
      const raw = (r.getAttribute(attr + 'id') || '').replace(/^local:/, '');
      if (ID.test(raw)) return raw.toLowerCase();
      // 新建对话行可能保留 client-new-thread；复用已核验的会话引用，不按重名标题猜 UUID。
      const ref = typeof sessionRefFromRow === 'function' ? sessionRefFromRow(r) : null;
      return ref?.host_id === 'local' && ID.test(ref.session_id) ? ref.session_id.toLowerCase() : '';
    }
    function sidebarRows() { return [...document.querySelectorAll(`[${attr}row]`)].filter(row => !row.closest('[data-codex-plus-ext]')); }
    function rowFor(id, anyRow = false) {
      let fallback = null;
      for (const r of sidebarRows()) {
        if (rowId(r) !== id || !isLocal(r)) continue;
        if (visible(r)) return r;
        fallback ??= r;
      }
      return anyRow ? fallback : null;
    }
    function routeId() {
      const url = new URL(location.href);
      const path = url.searchParams.get('initialRoute') || url.pathname;
      const value = /^\/local\/([\w-]+)(?:[/?#]|$)/.exec(path)?.[1] || '';
      return ID.test(value) ? value.toLowerCase() : '';
    }
    function currentRoute() {
      // 原生地址栏通常停在 index.html；当前页面的路由 context 才是会话身份的稳定来源。
      // retained 页面可能仍在 DOM 中，必须排除隐藏页面及其后代。
      const anchor = [...document.querySelectorAll('[data-app-shell-active-page="true"]')]
        .find(element => !element.closest('[data-app-shell-active-page="false"], [inert]'));
      const key = anchor && Object.getOwnPropertyNames(anchor).find(name => name.startsWith('__reactFiber$'));
      let fiber = anchor?.[key], root = fiber;
      for (let depth = 0; root?.return && depth < 200; depth++) root = root.return;
      // React 会交替提交两棵 fiber；DOM 上的引用可能仍指向旧树，不能拿旧路由覆盖新选中项。
      if (fiber?.alternate && root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber.alternate;
      for (let depth = 0; fiber && depth < 180; fiber = fiber.return, depth++) {
        const route = fiber.memoizedProps?.value;
        if (typeof route?.routeKind !== 'string' || typeof route.pathname !== 'string') continue;
        // 新会话的临时路由仍可由侧栏提供正式 UUID，不能直接当作离开对话页。
        if (route.routeKind === 'client-local-thread' && (route.hostId == null || route.hostId === 'local')) return { known: false, id: '' };
        if (route.routeKind !== 'local-thread' || route.hostId != null && route.hostId !== 'local') return { known: true, id: '' };
        const id = typeof route.conversationId === 'string' && ID.test(route.conversationId)
          ? route.conversationId : /^\/local\/([\w-]+)(?:[/?#]|$)/.exec(route.pathname)?.[1] || '';
        // 临时新会话路由尚未取得正式 UUID 时不判作首页，继续等侧栏的可信引用。
        return { known: ID.test(id), id: ID.test(id) ? id.toLowerCase() : '' };
      }
      return { known: false, id: '' };
    }
    // 仅持久化标签 UUID / 标题 / 顺序；项目归属、图标和状态每次从原生重读，避免移动/改名后残留旧信息。
    function persist() { try { const value = JSON.stringify(tabs.map(stored)); if (value !== saved) { store?.setItem(key, value); saved = value; } } catch {} }
    const icon = {
      close: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
      plus: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      folder: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    };
    const style = document.createElement('style');
    style.textContent = `
      #codex-plus-conversation-tabs,#codex-plus-conversation-tabs-menu{--cpt-fg:var(--color-text-primary-ghost,#1f2328);--cpt-muted:var(--color-text-secondary-ghost,#1f23287e);--cpt-hover:var(--color-background-primary-ghost-hover,#1f23280e);--cpt-line:var(--color-border,#1f232814);--cpt-ring:var(--color-ring,#0969da);--cpt-ease:var(--ease-enter-snappy,cubic-bezier(.23,1,.32,1))}
      #codex-plus-conversation-tabs{position:fixed;z-index:45;display:flex;align-items:center;gap:6px;height:54px;padding:0 10px 0 12px;box-sizing:border-box;border-bottom:1px solid var(--cpt-line);color:var(--cpt-fg);font:430 13px/18px var(--font-sans,-apple-system,BlinkMacSystemFont,sans-serif);-webkit-app-region:no-drag;overflow:hidden;user-select:none;-webkit-user-select:none}
      #codex-plus-conversation-tabs *{-webkit-user-drag:none}
      #codex-plus-conversation-tabs[hidden]{display:none!important}
      #codex-plus-conversation-tabs .cpt-list{position:relative;display:flex;align-items:center;gap:2px;min-width:0;flex:1;height:100%;overflow-x:auto;scrollbar-width:none}
      #codex-plus-conversation-tabs .cpt-list::-webkit-scrollbar{display:none}
      #codex-plus-conversation-tabs .cpt-item{position:relative;display:flex;align-items:center;flex:0 1 200px;min-width:104px;height:44px;padding:0 3px 0 10px;border-radius:var(--radius-md,10px);color:var(--cpt-muted);cursor:default;transition:background-color .15s var(--cpt-ease),color .15s var(--cpt-ease),opacity .15s}
      #codex-plus-conversation-tabs .cpt-item:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-item.cpt-active{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-item:not(.cpt-lifted),#codex-plus-conversation-tabs .cpt-item.cpt-settle{transition:transform .2s var(--cpt-ease),background-color .15s var(--cpt-ease),color .15s var(--cpt-ease)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-item:not(.cpt-lifted):not(.cpt-active){background:transparent}
      #codex-plus-conversation-tabs .cpt-item.cpt-lifted{z-index:1;color:var(--cpt-fg);background:linear-gradient(var(--cpt-hover),var(--cpt-hover)),var(--cpt-bg,Canvas);box-shadow:0 1px 2px rgb(0 0 0/.1),0 4px 14px rgb(0 0 0/.1)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-close{opacity:0!important}
      #codex-plus-conversation-tabs button{font:inherit;color:inherit;background:transparent;border:0;padding:0;margin:0;cursor:default;-webkit-app-region:no-drag}
      #codex-plus-conversation-tabs button:focus-visible{outline:2px solid var(--cpt-ring);outline-offset:-2px;border-radius:var(--radius-sm,7px)}
      #codex-plus-conversation-tabs .cpt-open{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:1px;overflow:hidden;white-space:nowrap;text-align:start}
      #codex-plus-conversation-tabs .cpt-title-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:20px}
      #codex-plus-conversation-tabs .cpt-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      #codex-plus-conversation-tabs .cpt-project{display:flex;align-items:center;gap:3px;min-width:0;height:12px;font-size:9px;line-height:12px;font-weight:400;color:var(--cpt-muted)}
      #codex-plus-conversation-tabs .cpt-project-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
      /* 保留原生图标的内部规格，在项目行统一缩小文件夹、SVG 和表情图标。 */
      #codex-plus-conversation-tabs .cpt-project-icon,#codex-plus-conversation-tabs .cpt-project-fallback,#codex-plus-conversation-tabs .cpt-project-native-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:10px;height:10px;font-size:10px;line-height:10px}
      #codex-plus-conversation-tabs .cpt-project-icon svg,#codex-plus-conversation-tabs .cpt-project-icon img{max-width:10px;max-height:10px}
      #codex-plus-conversation-tabs .cpt-status{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-status[hidden]{display:none}
      #codex-plus-conversation-tabs .cpt-item:has(.cpt-status[data-state="input"]),#codex-plus-conversation-tabs .cpt-item:has(.cpt-status[data-state="approval"]){min-width:156px}
      #codex-plus-conversation-tabs .cpt-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--color-text-info-ghost-hover,#0169cc)}
      #codex-plus-conversation-tabs .cpt-dot[hidden]{display:none}
      #codex-plus-conversation-tabs .cpt-close{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:6px;color:var(--cpt-muted);opacity:0;transition:opacity .15s,background-color .15s}
      #codex-plus-conversation-tabs .cpt-item:hover .cpt-close,#codex-plus-conversation-tabs .cpt-active .cpt-close,#codex-plus-conversation-tabs .cpt-close:focus-visible{opacity:1}
      #codex-plus-conversation-tabs .cpt-close:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-add{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-md,10px);color:var(--cpt-muted);transition:background-color .15s,color .15s}
      #codex-plus-conversation-tabs .cpt-add:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs-menu{position:fixed;z-index:1000;min-width:180px;padding:5px;box-sizing:border-box;border-radius:12px;border:1px solid var(--cpt-line);background:var(--cpt-bg,Canvas);color:var(--cpt-fg);box-shadow:0 8px 28px rgb(0 0 0/.16);font:430 13px/18px var(--font-sans,-apple-system,BlinkMacSystemFont,sans-serif);user-select:none;-webkit-app-region:no-drag}
      #codex-plus-conversation-tabs-menu[hidden]{display:none}
      #codex-plus-conversation-tabs-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:5px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:start;cursor:default}
      #codex-plus-conversation-tabs-menu .cpt-chevron{color:var(--cpt-muted)}
      #codex-plus-conversation-tabs-menu button:is(:hover,:focus-visible,.cpt-expanded):not(:disabled){background:var(--cpt-hover);outline:none}
      #codex-plus-conversation-tabs-menu button:disabled{color:var(--cpt-muted)}
      #codex-plus-conversation-tabs-menu hr{height:1px;margin:4px 6px;border:0;background:var(--cpt-line)}
      html.cpt-dragging,html.cpt-dragging *{-webkit-app-region:no-drag!important}
      [data-codex-plus-tabs-space]{padding-top:54px!important;box-sizing:border-box!important}
      @media(prefers-reduced-motion:reduce){#codex-plus-conversation-tabs *{transition:none!important}}
      @media(forced-colors:active){#codex-plus-conversation-tabs .cpt-active{outline:1px solid Highlight}}
    `;
    const bar = document.createElement('nav');
    bar.id = 'codex-plus-conversation-tabs';
    for (const element of [style, bar]) element.setAttribute('data-codex-plus-ext', 'conversation-tabs');
    const list = document.createElement('div'); list.className = 'cpt-list'; list.setAttribute('role','tablist'); bar.append(list);
    const add = document.createElement('button'); add.className = 'cpt-add'; add.innerHTML = icon.plus;
    add.addEventListener('click', () => navigate('/'), opts); bar.append(add);
    const menu = document.createElement('div'); menu.setAttribute('data-codex-plus-ext', 'conversation-tabs'); menu.id = 'codex-plus-conversation-tabs-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    document.head.append(style); document.body.append(bar, menu);
    function labels() {
      bar.setAttribute('aria-label', str.bar); add.title = str.add; add.setAttribute('aria-label', str.add);
    }
    labels();
    const langWatch = new MutationObserver(() => { if (localize()) { labels(); hideMenu(); render(); } });
    langWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    let spaced, background = '';
    const resized = new ResizeObserver(() => layout());
    // 只占用已识别的 Codex 主内容区；切页、收起侧栏和关闭功能时归还原有留白。
    function layout() {
      if (disposed) return;
      const main = Array.from(document.querySelectorAll('[data-app-shell-main-surface]')).find(visible);
      const titlebar = Array.from(document.querySelectorAll('[data-app-shell-main-titlebar], [data-app-shell-titlebar]')).find(visible);
      const body = main?.querySelector('[data-app-shell-main-content-layout]');
      const rect = (body || main)?.getBoundingClientRect();
      const hide = !rect || main.getAttribute('data-app-shell-main-surface') !== 'default' || /(?:\/|^)settings(?:\/|$)/.test(location.href) || !tabs.length;
      if (bar.hidden !== hide) bar.hidden = hide;
      if (hide) { spaced?.removeAttribute('data-codex-plus-tabs-space'); spaced = null; resized.disconnect(); return; }
      const target = body || main;
      if (spaced !== target) { spaced?.removeAttribute('data-codex-plus-tabs-space'); spaced = target; resized.disconnect(); resized.observe(target); }
      if (!spaced.hasAttribute('data-codex-plus-tabs-space')) spaced.setAttribute('data-codex-plus-tabs-space','');
      const top = Math.max(rect.top, titlebar?.getBoundingClientRect().bottom || 0);
      bar.style.left = `${Math.max(0, rect.left)}px`; bar.style.top = `${top}px`;
      bar.style.width = `${rect.width}px`;
      const bg = getComputedStyle(main).backgroundColor;
      if (bg !== background) { background = bg; bar.style.background = bg; bar.style.setProperty('--cpt-bg', bg); menu.style.setProperty('--cpt-bg', bg); }
    }
    // 有侧栏行时走原生点击；项目折叠后改用官方页面消息，不伪造路由状态。
    function go(id) {
      if (!ID.test(id)) return;
      if (id === appActive && id === active && !pending) return;
      if (id !== active) { pending = { id, at: performance.now() }; active = id; render(); }
      const row = rowFor(id);
      if (row) row.click(); else navigate('/local/' + id);
    }
    // 关闭只影响本地标签；抑制迟到的原生选中态，避免刚关闭的标签立即复活。
    function close(id) {
      const at = tabs.findIndex(t => t.id === id); if (at < 0) return;
      suppressed = id; tabs.splice(at, 1); persist();
      if (id === active) { active = ''; pending = null; if (tabs.length) go(tabs[Math.min(at, tabs.length - 1)].id); else navigate('/'); }
      render(); layout();
    }
    function closeOthers(keep, gone) {
      const ids = new Set(gone.map(t => t.id)); if (!ids.size) return;
      tabs = tabs.filter(t => !ids.has(t.id)); persist();
      if (ids.has(active)) { suppressed = active; active = ''; pending = null; go(keep); }
      render(); layout();
    }
    // DOM 节点只在当前运行时复用；卸载会全部释放，重注入从持久化数据重建。
    const nodes = new Map();
    function node(id) {
      let n = nodes.get(id); if (n) return n;
      const item = document.createElement('div'); item.className = 'cpt-item'; item.dataset.id = id;
      const open = document.createElement('button'); open.className = 'cpt-open'; open.setAttribute('role','tab'); open.dataset.id = id;
      const status = document.createElement('span'); status.className = 'cpt-status'; status.hidden = true;
      const dot = document.createElement('span'); dot.className = 'cpt-dot'; dot.hidden = true;
      const label = document.createElement('span'); label.className = 'cpt-label';
      // 上行只放会话状态/标题，下行固定放项目归属；长名称在各自行内截断。
      const titleRow = document.createElement('span'); titleRow.className = 'cpt-title-row'; titleRow.append(status, dot, label);
      const project = document.createElement('span'); project.className = 'cpt-project';
      const projectIcon = document.createElement('span'); projectIcon.className = 'cpt-project-icon'; projectIcon.setAttribute('aria-hidden', 'true'); projectIcon.innerHTML = icon.folder;
      const projectLabel = document.createElement('span'); projectLabel.className = 'cpt-project-name'; project.append(projectIcon, projectLabel);
      open.append(titleRow, project);
      const x = document.createElement('button'); x.className = 'cpt-close'; x.innerHTML = icon.close;
      item.append(open, x);
      n = { item, open, status, dot, label, projectIcon, projectLabel, x, title: null, lang: '', statusRoot: null, state: null, intl: null,
        projectRoot: null, projectKey: null, projectScope: null, projectIntl: null, projectName: null }; nodes.set(id, n);
      return n;
    }
    const mac = /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    function shortcut(i) { return i < 8 ? `${mac ? '⌘' : 'Ctrl+'}${i + 1}` : i === tabs.length - 1 ? `${mac ? '⌘' : 'Ctrl+'}9` : ''; }
    function render() {
      const ids = new Set(tabs.map(t => t.id));
      const hasActive = ids.has(active);
      for (const [id, n] of nodes) if (!ids.has(id)) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); statusApi?.releaseThreadMenu?.(id); n.item.remove(); nodes.delete(id); }
      tabs.forEach((tab, i) => {
        const n = node(tab.id), title = tab.title || str.untitled, on = tab.id === active;
        if (n.title !== title || n.lang !== lang) {
          n.title = title; n.lang = lang; n.label.textContent = title; n.x.title = str.closeTip;
          n.open.setAttribute('aria-label', title); n.x.setAttribute('aria-label', str.closeLabel + title);
        }
        const state = nativeStates.get(tab.id);
        const native = !!statusContext && state != null;
        n.status.hidden = !native || state === 'idle';
        if (native && (n.state !== state || n.intl !== statusContext.intl.value)) {
          n.statusRoot ??= statusApi.mount(n.status);
          n.statusRoot.render(state, statusContext);
          n.state = state; n.intl = statusContext.intl.value;
        }
        if (n.state != null && !native) { n.statusRoot?.dispose(); n.statusRoot = null; n.state = null; }
        n.status.setAttribute('data-state', native ? state : 'unknown');
        n.dot.hidden = native || !tab.running;
        n.open.setAttribute('aria-busy', String(native ? state === 'active' : !!tab.running));
        const project = nativeProjects.get(tab.id);
        const projectName = project?.name || (project === null ? str.noProject : str.unknownProject);
        if (n.projectName !== projectName) { n.projectName = projectName; n.projectLabel.textContent = projectName; }
        const projectKey = project ? JSON.stringify([project.id, project.kind, project.hostId]) : '';
        if (statusContext && statusApi.mountProject) {
          if (!n.projectRoot || n.projectKey !== projectKey || n.projectScope !== statusContext.appScope?.value || n.projectIntl !== statusContext.intl.value) {
            n.projectRoot ??= statusApi.mountProject(n.projectIcon, icon.folder);
            n.projectRoot.render(project, statusContext);
            n.projectKey = projectKey; n.projectScope = statusContext.appScope?.value; n.projectIntl = statusContext.intl.value;
          }
        } else if (n.projectRoot) { n.projectRoot.dispose(); n.projectRoot = null; n.projectIcon.innerHTML = icon.folder; }
        const description = [native ? statusApi.description(state, statusContext) : '', projectName].filter(Boolean).join(' · ');
        if (description) n.open.setAttribute('aria-description', description); else n.open.removeAttribute('aria-description');
        if (n.item.classList.contains('cpt-active') !== on) {
          n.item.classList.toggle('cpt-active', on);
          n.open.setAttribute('aria-selected', String(on));
          if (on) n.open.setAttribute('aria-current', 'page'); else n.open.removeAttribute('aria-current');
        }
        n.open.tabIndex = on || !hasActive && i === 0 ? 0 : -1;
        n.open.setAttribute('aria-selected', String(on));
        const tip = [title, projectName, project?.path, shortcut(i)].filter(Boolean).join('\n');
        if (n.item.title !== tip) n.item.title = tip;
      });
      let ref = list.firstElementChild;
      for (const tab of tabs) {
        const item = nodes.get(tab.id).item;
        if (item === ref) ref = ref.nextElementSibling; else list.insertBefore(item, ref);
      }
      if (active !== scrolledTo) { scrolledTo = active; reveal(nodes.get(active)?.item); }
    }
    function reveal(item) {
      if (!item) return;
      const left = item.offsetLeft, right = left + item.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left - 4;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 4;
    }
    // 侧栏补充标题和选中项；路由和状态不依赖行是否挂载。
    function discoverStatusApi() {
      if (statusApi || statusLoading || statusLoadAttempts >= 20 || performance.now() < statusNextLoadAt
        || !document.querySelector('[data-app-shell-main-surface]')) return;
      statusLoading = true; statusLoadAttempts++; statusNextLoadAt = performance.now() + 1500;
      // 等原生主界面出现后再读取模块缓存；未就绪时有界重试，不能通过执行工厂来催促启动。
      loadCodexPlusConversationTabStatusApi().then(api => {
        statusLoading = false;
        if (disposed || !api) return;
        statusApi = api; refresh();
      }).catch(() => { statusLoading = false; });
    }
    function syncStatusWatch() {
      if (!statusApi) return;
      const context = statusApi.context();
      const ids = tabs.map(tab => tab.id).sort().join(',');
      if (context?.scope.node === statusContext?.scope.node && context?.scope === statusContext?.scope && ids === statusIds) {
        statusContext = context; return;
      }
      const generation = ++statusGeneration;
      statusWatch?.(); statusWatch = null; statusIds = ids; statusContext = context;
      if (!context) return; // shell 暂时切换时保留最后一次可信快照，不猜测会话已经完成。
      const wanted = new Set(tabs.map(tab => tab.id));
      nativeStates = new Map([...nativeStates].filter(([id]) => wanted.has(id)));
      nativeProjects = new Map([...nativeProjects].filter(([id]) => wanted.has(id)));
      try {
        statusWatch = statusApi.watch(context, [...wanted], snapshot => {
          // 解绑后迟到的旧订阅不能覆盖新 shell 或新标签集合的快照。
          if (disposed || generation !== statusGeneration) return;
          let changed = false;
          for (const [id, state] of snapshot) {
            if (wanted.has(id) && nativeStates.get(id) !== state) { nativeStates.set(id, state); changed = true; }
          }
          if (changed) schedule();
        }, projects => {
          if (disposed || generation !== statusGeneration) return;
          let changed = false;
          for (const [id, project] of projects) {
            if (wanted.has(id) && JSON.stringify(nativeProjects.get(id)) !== JSON.stringify(project)) {
              nativeProjects.set(id, project && { ...project }); changed = true;
            }
          }
          if (changed) schedule();
        });
      } catch { statusContext = null; } // 原生升级失配时降级，不影响标签的切换和关闭。
    }
    // 禁止用标题猜测两个会话是同一条。
    function refresh() {
      clearTimeout(timer); timer = 0;
      if (disposed || document.hidden) return;
      if (drag?.moved) return; // 拖动结束后统一刷新，流式输出不能打乱拖动中的 DOM 顺序。
      const byId = new Map(); let selected = null;
      for (const r of sidebarRows()) {
        if (!isLocal(r)) continue;
        const id = rowId(r);
        if (!id) continue;
        // 侧栏收起后原生行仍可能挂载但宽度为零；身份以当前页面的 active 属性为准。
        if (!selected && r.getAttribute(attr + 'active') === 'true' && !r.closest('[data-app-shell-active-page="false"]')) { selected = r; byId.set(id, r); }
        else if (!byId.has(id)) byId.set(id, r);
      }
      const route = currentRoute();
      const observed = route.known ? route.id : (selected && rowId(selected)) || routeId();
      const confirmed = route.known || !!observed;
      if (confirmed) appActive = observed;
      if (pending && ((confirmed && pending.id === appActive) || performance.now() - pending.at > 1500)) pending = null;
      // “读不到”不等于“没有会话”：只有确认路由离开对话页，才清除当前标签。
      const id = pending ? pending.id : confirmed ? appActive : active;
      active = id; if (confirmed && appActive !== suppressed) suppressed = '';
      for (const t of tabs) {
        let row = byId.get(t.id);
        if (row) t.title = (row.getAttribute(attr+'title') || t.title).slice(0, 240);
        // 原生适配尚未就绪时保留原有加载提示；行不在 DOM 中不能被当作已结束。
        if (row) t.running = !!row.querySelector('[data-loading-indicator]');
      }
      if (id && id !== suppressed && ID.test(id) && !tabs.some(t => t.id === id)) {
        const title = (byId.get(id)?.getAttribute(attr+'title') || '').slice(0, 240);
        tabs.push({ id, title });
        if (tabs.length > MAX_TABS) tabs.shift();
      }
      discoverStatusApi(); syncStatusWatch(); render(); persist(); layout();
    }
    function schedule() { if (!timer) timer = setTimeout(refresh, 80); }
    // 忽略增强自身和聊天正文的高频写入；只节流处理侧栏与原生布局变化。
    const observer = new MutationObserver(ms => {
      for (const m of ms) {
        if (m.target.closest?.('[data-codex-plus-ext]')) continue;
        const changed = [...m.addedNodes || [], ...m.removedNodes || []].filter(node => node.nodeType === 1);
        if (changed.length && changed.every(node => node.matches('[data-codex-plus-ext]'))) continue;
        if (m.type === 'childList' && spaced?.contains(m.target)) continue;
        schedule(); return;
      }
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:[attr+'active',attr+'title',attr+'id',attr+'host-id',attr+'kind','data-app-shell-active-page']});
    window.addEventListener('resize',layout,opts);
    window.addEventListener('popstate',schedule,opts);
    document.addEventListener('visibilitychange',schedule,opts);
    list.addEventListener('click', e => {
      const item = e.target.closest('.cpt-item'); if (!item) return;
      if (e.target.closest('.cpt-close')) { e.stopPropagation(); close(item.dataset.id); }
      else if (e.detail === 0 && e.target.closest('.cpt-open')) go(item.dataset.id);
    }, opts);
    let drag = null;
    // 使用指针捕获拖动，避免 HTML 拖放把会话标题误放进输入框；丢失释放事件也会结束。
    list.addEventListener('pointerdown', e => {
      if (drag) endDrag(true); // 上一次释放事件缺失时，先结束旧拖动。
      if (e.button !== 0 || e.ctrlKey || e.target.closest('.cpt-close')) return;
      const item = e.target.closest('.cpt-item'); if (!item) return;
      go(item.dataset.id);
      drag = { id: item.dataset.id, item, pointerId: e.pointerId, startX: e.clientX, x: e.clientX, moved: false };
      try { list.setPointerCapture(e.pointerId); } catch {}
    }, opts);
    list.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!(e.buttons & 1)) return endDrag(true);
      drag.x = e.clientX;
      if (!drag.moved) { if (Math.abs(drag.x - drag.startX) < 5) return; startDrag(); }
      dragUpdate();
    }, opts);
    list.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, opts);
    list.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) endDrag(false); }, opts);
    list.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, opts);
    window.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, { capture: true, signal: abort.signal });
    document.addEventListener('keydown', e => {
      if (drag?.moved && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); endDrag(false); }
    }, { capture: true, signal: abort.signal });
    window.addEventListener('blur', () => drag && endDrag(false), opts);
    // 优先转发给现有原生行；侧栏收起后改用原生组件生成菜单，不把 DOM 卸载当作会话不存在。
    function threadMenu(id, x, y) {
      const row = rowFor(id, true);
      if (!row) return statusApi?.openThreadMenu?.(statusApi.context() || statusContext, id, x, y) || false;
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y, button: 2, buttons: 2 }));
      return true;
    }
    let menuFrom = null;
    // 菜单动作执行时重新读取位置，防止菜单打开期间排序变化后关错标签。
    function tabMenu(id, x, y) {
      if (!tabs.some(t => t.id === id)) return;
      const from = menu.hidden ? document.activeElement : menuFrom?.el;
      menuFrom = { id, el: from };
      const at = tabs.findIndex(t => t.id === id);
      const available = !!rowFor(id, true) || !!statusApi?.canOpenThreadMenu?.(statusContext, id);
      const closeRight = () => { const i = tabs.findIndex(t => t.id === id); if (i >= 0) closeOthers(id, tabs.slice(i + 1)); };
      const closeOther = () => { if (tabs.some(t => t.id === id)) closeOthers(id, tabs.filter(t => t.id !== id)); };
      const entries = [
        [str.close, () => close(id), true],
        [str.closeOthers, closeOther, tabs.length > 1],
        [str.closeRight, closeRight, at < tabs.length - 1],
        null,
        [str.options, available ? b => openThreadMenu(id, b) : null, available, 'sub'],
      ];
      menu.replaceChildren(...entries.map(entry => {
        if (!entry) { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); return hr; }
        const [label, run, enabled, kind] = entry;
        const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; b.disabled = !enabled; b.tabIndex = -1;
        if (kind === 'sub') { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.append(Object.assign(document.createElement('span'), { className: 'cpt-chevron', textContent: '›' })); }
        if (run && kind === 'sub') {
          let hover = 0;
          b.addEventListener('pointermove', () => { if (!hover) hover = later(() => { hover = 0; if (!nativeAt && b.isConnected) run(b); }, 120); });
          b.addEventListener('pointerleave', () => { cancelLater(hover); hover = 0; });
          b.addEventListener('pointerdown', () => { cancelLater(hover); hover = 0; });
          b.addEventListener('click', e => { if (e.detail === 0 && !nativeAt) run(b); });
          b.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { e.preventDefault(); if (!nativeAt) run(b); } });
        }
        else if (run) b.addEventListener('click', () => {
          const back = menu.contains(document.activeElement), from = menuFrom;
          hideMenu(); run(); if (back) { menuFrom = from; restoreFocus(); }
        });
        return b;
      }));
      menu.hidden = false;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    }
    let nativeAt = 0;
    // macOS 在点击后弹原生菜单会强制定位到指针下，因此按子菜单方式悬停打开。
    async function openThreadMenu(id, b) {
      const m = menu.getBoundingClientRect(), r = b.getBoundingClientRect();
      b.setAttribute('aria-expanded', 'true'); b.classList.add('cpt-expanded');
      nativeAt = performance.now();
      // 临时宿主异步挂载失败时收回展开态，避免菜单卡在“已打开”。
      try {
        const opened = await threadMenu(id, m.right + 2, r.top - 5);
        if (!opened && b.isConnected && menuFrom?.id === id) nativeClosed();
      } catch { if (b.isConnected && menuFrom?.id === id) nativeClosed(); }
    }
    function nativeClosed() {
      nativeAt = 0;
      menu.querySelector('.cpt-expanded')?.classList.remove('cpt-expanded');
      menu.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
    }
    document.addEventListener('pointermove', e => {
      if (!nativeAt || performance.now() - nativeAt < 200) return;
      nativeClosed();
      if (!menu.contains(e.target)) hideMenu();
    }, { capture: true, signal: abort.signal });
    // 菜单关闭后优先还焦点到原输入框或标签，键盘用户不会被留在已卸载的菜单内。
    function restoreFocus() {
      const from = menuFrom; menuFrom = null;
      const el = [from?.el, nodes.get(from?.id)?.open, list.querySelector('.cpt-active .cpt-open')]
        .find(e => e?.isConnected && e !== document.body && !menu.contains(e));
      el?.focus({ preventScroll: true });
    }
    function hideMenu(refocus = false) {
      if (menu.hidden) return;
      const back = refocus && menu.contains(document.activeElement);
      // 用户关闭菜单后取消尚未完成的宿主挂载，避免稍后突然弹出原生菜单。
      statusApi?.cancelThreadMenu?.(menuFrom?.id);
      menu.hidden = true; menu.replaceChildren(); nativeAt = 0;
      if (back) restoreFocus(); else menuFrom = null;
    }
    document.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) hideMenu(); }, { capture: true, signal: abort.signal });
    window.addEventListener('blur', () => { if (!nativeAt) hideMenu(); }, opts);
    window.addEventListener('resize', () => hideMenu(), opts);
    menu.addEventListener('mousedown', e => e.preventDefault(), opts);
    menu.addEventListener('focusout', e => { if (!menu.hidden && !nativeAt && !menu.contains(e.relatedTarget)) hideMenu(); }, opts);
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); hideMenu(true); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
      if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items.at(e.key === 'Home' ? 0 : -1)?.focus(); }
    }, opts);
    list.addEventListener('contextmenu', e => {
      const item = e.target.closest('.cpt-item'); if (!item) return;
      e.preventDefault(); e.stopPropagation();
      if (!drag?.moved) tabMenu(item.dataset.id, e.clientX, e.clientY);
    }, opts);
    // 拖动期间临时关闭系统窗口拖动区，保证跨过标题栏时仍能收到 pointerup。
    function startDrag() {
      const d = drag, items = [...list.children];
      d.moved = true; d.items = items; d.from = d.to = items.indexOf(d.item);
      d.lefts = items.map(it => it.offsetLeft); d.widths = items.map(it => it.offsetWidth);
      d.width = d.widths[d.from]; d.end = d.lefts.at(-1) + d.widths.at(-1);
      d.gap = items.length > 1 ? d.lefts[1] - d.lefts[0] - d.widths[0] : 0;
      d.scroll0 = list.scrollLeft;
      document.documentElement.classList.add('cpt-dragging');
      bar.classList.add('cpt-reordering'); d.item.classList.remove('cpt-settle'); d.item.classList.add('cpt-lifted');
      const edge = 36, step = () => {
        if (drag !== d) return;
        const r = list.getBoundingClientRect();
        const v = d.x < r.left + edge ? -(r.left + edge - d.x) : d.x > r.right - edge ? d.x - (r.right - edge) : 0;
        if (v && list.scrollWidth > list.clientWidth) { list.scrollLeft += Math.max(-14, Math.min(14, v / 2.5)); dragUpdate(); }
        d.raf = requestAnimationFrame(step);
      };
      d.raf = requestAnimationFrame(step);
    }
    // 跨过相邻标签中点才换位；边缘自动滚动支持横向溢出的标签。
    function dragUpdate() {
      const d = drag, start = d.lefts[d.from];
      const left = Math.min(Math.max(start + d.x - d.startX + list.scrollLeft - d.scroll0, 0), d.end - d.width);
      d.item.style.transform = `translateX(${left - start}px)`;
      let to = 0;
      d.items.forEach((it, k) => {
        const mid = d.lefts[k] + d.widths[k] / 2;
        if (k < d.from ? left >= mid : k > d.from && left + d.width > mid) to++;
      });
      if (to === d.to) return;
      d.to = to;
      const shift = d.width + d.gap;
      d.items.forEach((it, k) => {
        if (k === d.from) return;
        const s = d.from < k && k <= to ? -shift : to <= k && k < d.from ? shift : 0;
        it.style.transform = s ? `translateX(${s}px)` : '';
      });
    }
    // Escape / 失焦撤销排序；先清状态再释放捕获，避免 lostpointercapture 重入。
    function endDrag(commit) {
      const d = drag; drag = null;
      if (!d) return;
      try { list.releasePointerCapture(d.pointerId); } catch {}
      if (!d.moved) return;
      cancelAnimationFrame(d.raf);
      document.documentElement.classList.remove('cpt-dragging');
      const moved = commit && d.to !== d.from;
      const before = d.item.getBoundingClientRect().left;
      if (moved) {
        const at = tabs.findIndex(t => t.id === d.id);
        if (at >= 0) { const [t] = tabs.splice(at, 1); tabs.splice(d.to, 0, t); persist(); }
      } else {
        d.items.forEach(it => { if (it !== d.item) it.classList.add('cpt-settle'); });
      }
      bar.classList.remove('cpt-reordering');
      d.items.forEach(it => { it.style.transform = ''; });
      render();
      d.item.style.transform = `translateX(${before - d.item.getBoundingClientRect().left}px)`;
      d.item.offsetWidth;
      d.item.classList.add('cpt-settle'); d.item.style.transform = '';
      const done = () => d.items.forEach(it => { if (!(drag?.moved && drag.item === it)) it.classList.remove('cpt-settle', 'cpt-lifted'); });
      later(done, 220);
      refresh();
    }
    list.addEventListener('auxclick', e => {
      const item = e.target.closest('.cpt-item');
      if (item && e.button === 1) { e.preventDefault(); close(item.dataset.id); }
    }, opts);
    list.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
      e.preventDefault(); list.scrollLeft += e.deltaY;
    }, { passive: false, signal: abort.signal });
    document.addEventListener('keydown', e => {
      if (bar.hidden || e.isComposing || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || !/^[1-9]$/.test(e.key)) return;
      const tab = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
      if (tab) { e.preventDefault(); e.stopImmediatePropagation(); go(tab.id); }
    },{capture:true,signal:abort.signal});
    list.addEventListener('keydown', e => {
      const buttons = Array.from(list.querySelectorAll('.cpt-open'));
      const i = buttons.indexOf(document.activeElement); if (i < 0) return;
      let next;
      if (e.key === 'ArrowRight') next = (i+1)%buttons.length;
      if (e.key === 'ArrowLeft') next = (i+buttons.length-1)%buttons.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = buttons.length-1;
      if (next != null) { e.preventDefault(); buttons[next].focus(); }
      if (e.key === 'Delete') { e.preventDefault(); close(buttons[i].dataset.id); }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault(); const r = buttons[i].getBoundingClientRect(); tabMenu(buttons[i].dataset.id, r.left, r.bottom);
      }
    },opts);
    // 原生路由不总是改变地址栏；低频兜底只刷新可见窗口，不读取聊天内容或调用后端。
    const interval = setInterval(refresh, 1500);
    const runtime = { dispose() {
      if (disposed) return;
      if (drag) cancelAnimationFrame(drag.raf);
      drag = null;
      document.documentElement.classList.remove('cpt-dragging');
      disposed = true;
      statusWatch?.(); statusWatch = null;
      for (const [id, n] of nodes) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); statusApi?.releaseThreadMenu?.(id); }
      clearInterval(interval); clearTimeout(timer);
      for (const id of delays) clearTimeout(id);
      delays.clear();
      observer.disconnect(); langWatch.disconnect(); resized.disconnect(); abort.abort();
      spaced?.removeAttribute('data-codex-plus-tabs-space');
      bar.remove(); menu.remove(); style.remove();
      if (window.__codexPlusConversationTabs === runtime) delete window.__codexPlusConversationTabs;
    } };
    window.__codexPlusConversationTabs = runtime;
    refresh();
    return runtime;
  }
  /*
   * 跨项目会话列表：侧栏顶部搜索旁的入口 + 侧栏内替换原生列表。
   *
   * 入口是侧栏头部「搜索」旁边的小图标（复用原生头部按钮样式）；点开后原生 Chats /
   * Projects 分组被隐藏，同一个 [data-app-action-sidebar-scroll] 里显示按 updated_at
   * 倒序的扁平列表，再点一次切回原生列表。主内容区完全不动，也不是另开一个页面。
   *
   * 数据源是 Codex Pilot 后端只读会话索引（listRecentThreads），项目名由后端算好；
   * 状态与原生项目图标尽力复用 61-conversation-tab-status.js，取不到时静默降级。
   *
   * DOM 瞬态：原生侧栏由 React 反复重建，每轮 sync() 幂等补回入口与列表容器，
   * 不缓存 DOM 引用；所有节点带 data-codex-plus-ext，避免扫描自喂循环。
   * 只隐藏原生节点，绝不删除或替换它们，React 仍能正常更新自己的子树。
   */

  window.__codexPlusConversationList?.dispose?.();

  const CPL_EXT = 'conversation-list';
  const CPL_HEADER_ID = 'codex-plus-header-conversation-list';
  const CPL_ACTIVE_ATTR = 'data-codex-plus-conversation-list-active';
  const CPL_SCROLL_SELECTOR = '[data-app-action-sidebar-scroll]';
  // 原生头部按钮只有图标，中英文各一个 aria-label；命令面板里也可能有同名按钮，
  // 所以下面还要按位置排除。
  const CPL_SEARCH_SELECTOR = 'button[aria-label="搜索"], button[aria-label="Search"]';
  const CPL_PAGE_SIZE = 50;
  const CPL_MAX_ITEMS = 100;
  const CPL_ICON_LIST = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 5h9M7 10h9M7 15h9"/><circle cx="4" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="15" r="1" fill="currentColor" stroke="none"/></svg>';
  const CPL_ICON_FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.8 4.2h4.4l1.4 1.6h6.6v7.2H1.8z"/></svg>';
  // 分支图标：两个节点 + 一条汇入的弧线，尺寸比项目图标再小一号。
  const CPL_ICON_BRANCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="3.6" r="1.5"/><circle cx="4.5" cy="12.4" r="1.5"/><circle cx="11.5" cy="6.4" r="1.5"/><path d="M4.5 5.1v5.8M11.5 7.9c0 2.2-2.1 3.1-4.4 3.3"/></svg>';
  const CPL_STRINGS = {
    zh: {
      title: '最近会话', back: '返回原生列表', loading: '正在读取会话…',
      empty: '没有找到会话', failed: '读取失败：', untitled: '未命名对话',
      noProject: '未关联项目', directory: '目录：', more: '加载更多',
      count: (shown, total) => `已显示 ${shown} / ${total} 条`, limit: '已到列表上限',
    },
    en: {
      title: 'Recent threads', back: 'Back to native list', loading: 'Loading threads…',
      empty: 'No threads found', failed: 'Failed to load: ', untitled: 'Untitled thread',
      noProject: 'No project', directory: 'Folder: ', more: 'Load more',
      count: (shown, total) => `Showing ${shown} of ${total}`, limit: 'List limit reached',
    },
  };

  // 后端已给 displayTitle（优先会话名）；这里再兜一层：老版本后端只给 title，
  // 而 Codex 的 title 列存的是首条用户消息原文，可能几万字符，不能原样塞进
  // DOM / aria-label / tooltip。折叠空白并限长，阈值比后端的 120 宽一档，避免重复截断。
  function cleanTitle(value) {
    const flat = String(value || '').replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? flat.slice(0, 200) + '…' : flat;
  }

  function syncCodexPlusConversationList() {
    // 与设置页一致：设置开关开着、且对应内置拓展没被停用/顶替才算启用。
    const builtinActive = typeof codexPlusBuiltinExtensionActive === 'function'
      ? codexPlusBuiltinExtensionActive('conversation-list') : true;
    const enabled = codexPlusBackendSettings.enhancementsEnabled === true
      && codexPlusBackendSettings.codexAppConversationList === true && builtinActive;
    const eligible = document.body && !new URL(window.location.href).searchParams.has('initialRoute');
    if (!enabled || !eligible) {
      window.__codexPlusConversationList?.dispose?.();
      return;
    }
    const runtime = window.__codexPlusConversationList || createCodexPlusConversationList();
    runtime.sync();
  }

  function createCodexPlusConversationList() {
    // 注入发生在页面早期，这时 <html lang> 与 navigator.language 可能还是英文默认值，
    // 而原生界面随后才切成用户设置的语言。所以文案不写死，每轮按原生控件重新判定。
    const str = { ...CPL_STRINGS.en };
    let langKey = 'en';
    const abort = new AbortController();
    const opts = { signal: abort.signal };
    let disposed = false, active = false, style = null;
    let headerEntry = null, panel = null, listEl = null, statusEl = null, moreButton = null;
    let items = [], total = 0, loading = false, requestId = 0;
    let statusApi = null, statusLoading = false, statusContext = null, statusWatch = null;
    let statusIds = '', statusGeneration = 0;
    let nativeStates = new Map(), nativeProjects = new Map();
    const nodes = new Map();

    /** 以原生搜索按钮的 aria-label 为准（它就是「搜索」/「Search」），退回家语言标记。 */
    function syncLanguage() {
      const marker = document.querySelector(CPL_SEARCH_SELECTOR)?.getAttribute('aria-label')
        || document.documentElement.lang || navigator.language || 'en';
      const next = /搜索|^zh/i.test(marker) ? 'zh' : 'en';
      if (next === langKey) return;
      langKey = next;
      Object.assign(str, CPL_STRINGS[next]);
      render();
      applyActive();
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = String(text);
      return node;
    }
    function setStatus(text) { if (statusEl) statusEl.textContent = text; }
    function valid(session) { return session && typeof session.id === 'string' && session.id.length > 0; }

    function installStyle() {
      if (style?.isConnected) return;
      style = el('style');
      style.setAttribute('data-codex-plus-ext', CPL_EXT);
      style.textContent = `
        /* 头部入口：尺寸与配色全部抄原生搜索按钮，只补图标约束与选中态。 */
        .cpl-header-entry { display: inline-flex; align-items: center; justify-content: center; }
        .cpl-header-entry .cpl-header-icon { display: inline-flex; width: 16px; height: 16px; }
        .cpl-header-entry .cpl-header-icon svg { width: 16px; height: 16px; display: block; }
        .cpl-header-entry[data-cpl-active="true"] { background: rgba(127,127,127,.16); }
        [${CPL_ACTIVE_ATTR}="true"] > :not([data-codex-plus-ext]) { display: none !important; }
        /* 非激活时列表容器必须整个收起：它还留在滚动区里，display:flex 会撑出
           一大段空白，原生列表的滚动高度也跟着错乱。 */
        .cpl-panel { display: none; flex-direction: column; }
        [${CPL_ACTIVE_ATTR}="true"] > .cpl-panel { display: flex; }
        .cpl-list { padding: 2px 4px; }
        .cpl-item { border-radius: 8px; }
        .cpl-item:hover { background: rgba(127,127,127,.10); }
        .cpl-open { display: flex; flex-direction: column; gap: 3px; width: 100%; box-sizing: border-box;
          padding: 6px 8px; border: 0; background: transparent; color: inherit; text-align: left;
          cursor: pointer; font: inherit; }
        .cpl-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .cpl-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .cpl-status { display: inline-flex; align-items: center; flex: none; }
        .cpl-status[hidden] { display: none; }
        .cpl-project { display: flex; align-items: center; gap: 5px; min-width: 0; opacity: .68; }
        .cpl-project-icon { display: inline-flex; width: 12px; height: 12px; flex: none; }
        .cpl-project-icon svg { width: 12px; height: 12px; }
        .cpl-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; flex: 0 1 auto; min-width: 0; }
        /* git 分支：跟在项目名后面，长名字先截断项目名，分支保底留一点宽度。 */
        .cpl-branch { display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; }
        .cpl-branch[hidden] { display: none; }
        .cpl-branch-icon { display: inline-flex; width: 11px; height: 11px; flex: none; }
        .cpl-branch-icon svg { width: 11px; height: 11px; }
        .cpl-branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 96px; font-size: 11px; }
        .cpl-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 8px 8px 4px; font-size: 12px; opacity: .8; }
        .cpl-more { border: 1px solid rgba(127,127,127,.28); border-radius: 7px;
          background: transparent; color: inherit; padding: 4px 10px; cursor: pointer; font: inherit; }
        .cpl-more[hidden] { display: none; }
      `;
      document.head.append(style);
    }

    /**
     * 找侧栏头部那颗搜索按钮。
     *
     * 命令面板、设置页里也可能有 aria-label 为「搜索」的按钮，所以只在窗口左上角、
     * 且不在会话滚动区和主内容区里的那颗才算数。
     */
    function headerSearchButton() {
      const candidates = [...document.querySelectorAll(CPL_SEARCH_SELECTOR)];
      return candidates.find(button => {
        if (button.closest('[data-codex-plus-ext]')) return false;
        if (button.closest(CPL_SCROLL_SELECTOR) || button.closest('[data-app-shell-main-surface]')) return false;
        const rect = typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : null;
        // 最小 DOM 测试环境没有布局；真实页面里隐藏的按钮宽高为 0，要排除。
        if (rect && (!rect.width || !rect.height)) return false;
        if (!rect) return true;
        return rect.top < 200 && rect.left < 460;
      }) || null;
    }

    /** 头部入口：克隆原生搜索按钮，清掉它的交互属性后换上我们的图标。 */
    function buildHeaderEntry(template) {
      const button = template.cloneNode(true);
      button.id = CPL_HEADER_ID;
      button.classList.add('cpl-header-entry');
      button.type = 'button';
      for (const name of ['data-state', 'data-selected', 'aria-expanded', 'aria-haspopup',
        'aria-controls', 'aria-describedby', 'aria-current', 'aria-pressed', 'title']) {
        button.removeAttribute(name);
      }
      button.setAttribute('aria-label', str.title);
      button.textContent = '';
      const icon = el('span', 'cpl-header-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = CPL_ICON_LIST;
      button.append(icon);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }, true);
      if (typeof attachCodexPlusRailTooltip === 'function') attachCodexPlusRailTooltip(button, str.title, 'bottom');
      return button;
    }

    /** 入口紧跟搜索按钮，插在同一个头部行里；搜索按钮消失（侧栏收起）就一起收起。 */
    function ensureHeaderEntry() {
      const search = headerSearchButton();
      if (!search) {
        headerEntry?.remove();
        headerEntry = null;
        return;
      }
      const host = search.parentElement;
      if (!host) return;
      let entry = document.querySelector(`#${CPL_HEADER_ID}`);
      if (!entry || entry.parentElement !== host) {
        entry?.remove();
        entry = buildHeaderEntry(search);
        if (!entry) return;
        entry.setAttribute('data-codex-plus-ext', CPL_EXT);
        if (typeof markCodexPlusExtensionNode === 'function') markCodexPlusExtensionNode(entry, CPL_EXT);
      }
      // 头部也可能被 React 重排：不在搜索后面就挪回去，已在位不动。
      if (entry.previousElementSibling !== search) host.insertBefore(entry, search.nextSibling);
      headerEntry = entry;
    }

    function buildPanel() {
      const wrapper = el('div', 'cpl-panel');
      wrapper.setAttribute('data-codex-plus-ext', CPL_EXT);
      listEl = el('div', 'cpl-list');
      listEl.setAttribute('role', 'list');
      const footer = el('div', 'cpl-footer');
      statusEl = el('span', 'cpl-status cpl-footer-status');
      moreButton = el('button', 'cpl-more', str.more);
      moreButton.type = 'button';
      moreButton.hidden = true;
      moreButton.addEventListener('click', event => { event.preventDefault(); load(false); }, opts);
      footer.append(statusEl, moreButton);
      wrapper.append(listEl, footer);
      return wrapper;
    }

    function applyActive() {
      // React 可能换掉滚动容器：先清掉所有旧标记，只给当前容器加。
      document.querySelectorAll(`[${CPL_ACTIVE_ATTR}]`).forEach(node => node.removeAttribute(CPL_ACTIVE_ATTR));
      const scroll = document.querySelector(CPL_SCROLL_SELECTOR);
      if (active && scroll) scroll.setAttribute(CPL_ACTIVE_ATTR, 'true');
      if (headerEntry) {
        headerEntry.setAttribute('data-cpl-active', String(active));
        headerEntry.setAttribute('aria-pressed', String(active));
        headerEntry.setAttribute('aria-label', active ? str.back : str.title);
        if (active) headerEntry.setAttribute('data-selected', '');
        else headerEntry.removeAttribute('data-selected');
      }
    }

    /** 每轮轻量扫描都跑：原生侧栏重建后把入口与列表容器补回去。 */
    function sync() {
      if (disposed) return;
      installStyle();
      syncLanguage();
      ensureHeaderEntry();
      const scroll = document.querySelector(CPL_SCROLL_SELECTOR);
      if (!scroll) {
        applyActive();
        return;
      }
      if (!panel?.isConnected) {
        for (const [, n] of nodes) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); }
        nodes.clear();
        panel = buildPanel();
        scroll.append(panel);
        render();
      }
      applyActive();
    }

    function query(params) {
      const bridge = window.__codexSessionDeleteBridge;
      if (typeof bridge !== 'function') return Promise.reject(new Error('Codex 页面尚未连接'));
      return Promise.resolve(bridge('/extensions/history', { method: 'listRecentThreads', params })).then(result => {
        if (result?.status === 'failed' || result?.error) {
          throw new Error(result.message || result.error || '会话列表读取失败');
        }
        return result?.result;
      });
    }

    function node(id) {
      let n = nodes.get(id);
      if (n) return n;
      const item = el('div', 'cpl-item');
      item.setAttribute('data-codex-plus-ext', CPL_EXT);
      item.setAttribute('role', 'listitem');
      const open = el('button', 'cpl-open');
      open.type = 'button';
      const status = el('span', 'cpl-status');
      status.hidden = true;
      const label = el('span', 'cpl-label');
      const titleRow = el('span', 'cpl-title-row');
      titleRow.append(status, label);
      const project = el('span', 'cpl-project');
      const projectIcon = el('span', 'cpl-project-icon');
      projectIcon.setAttribute('aria-hidden', 'true');
      projectIcon.innerHTML = CPL_ICON_FOLDER;
      const projectLabel = el('span', 'cpl-project-name');
      const branch = el('span', 'cpl-branch');
      branch.hidden = true;
      const branchIcon = el('span', 'cpl-branch-icon');
      branchIcon.setAttribute('aria-hidden', 'true');
      branchIcon.innerHTML = CPL_ICON_BRANCH;
      const branchLabel = el('span', 'cpl-branch-name');
      branch.append(branchIcon, branchLabel);
      project.append(projectIcon, projectLabel, branch);
      open.append(titleRow, project);
      open.addEventListener('click', event => {
        event.preventDefault();
        const session = items.find(entry => entry.id === id);
        if (session) go(session);
      }, opts);
      item.append(open);
      n = { item, open, status, label, projectIcon, projectLabel, branch, branchLabel,
        title: null, projectName: null, branchName: null,
        statusRoot: null, projectRoot: null, state: null, projectKey: null };
      nodes.set(id, n);
      return n;
    }

    function render() {
      if (!listEl || !moreButton) return;
      // 后端已按 updated_at DESC 返回；同一秒内用 id 兜底，避免刷新时顺序跳动。
      const ordered = items.slice().sort((a, b) =>
        (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.id).localeCompare(String(b.id)));
      const wanted = new Set(ordered.map(session => session.id));
      for (const [id, n] of nodes) {
        if (!wanted.has(id)) {
          n.statusRoot?.dispose(); n.projectRoot?.dispose();
          n.item.remove(); nodes.delete(id);
        }
      }
      ordered.forEach(session => {
        const n = node(session.id);
        const title = cleanTitle(session.displayTitle || session.name || session.title) || str.untitled;
        if (n.title !== title) { n.title = title; n.label.textContent = title; n.open.setAttribute('aria-label', title); }
        const state = nativeStates.get(session.id);
        const native = !!statusContext && state != null && state !== 'idle';
        n.status.hidden = !native;
        if (native && statusApi?.mount) {
          n.statusRoot ??= statusApi.mount(n.status);
          if (n.state !== state) { n.statusRoot.render(state, statusContext); n.state = state; }
        }
        n.status.setAttribute('data-state', native ? state : 'unknown');
        const project = nativeProjects.get(session.id);
        const name = project?.name || session.projectName
          || (session.directory ? str.directory + session.directory : str.noProject);
        if (n.projectName !== name) { n.projectName = name; n.projectLabel.textContent = name; }
        // 只有 git 仓库才有分支；取不到就整块收起，不留空占位。
        const branch = String(session.gitBranch || '').trim();
        if (n.branchName !== branch) {
          n.branchName = branch;
          n.branchLabel.textContent = branch;
          n.branch.hidden = !branch;
        }
        const iconSource = project || (session.projectId
          ? { id: session.projectId, kind: session.projectKind || 'local', hostId: '' } : null);
        const key = iconSource ? JSON.stringify([iconSource.id, iconSource.kind]) : '';
        if (statusContext && statusApi?.mountProject && iconSource) {
          if (!n.projectRoot || n.projectKey !== key) {
            n.projectRoot ??= statusApi.mountProject(n.projectIcon, CPL_ICON_FOLDER);
            n.projectRoot.render(iconSource, statusContext);
            n.projectKey = key;
          }
        } else if (n.projectRoot) {
          n.projectRoot.dispose(); n.projectRoot = null; n.projectIcon.innerHTML = CPL_ICON_FOLDER; n.projectKey = key;
        }
        n.item.title = [title, name, branch, session.cwd].filter(Boolean).join('\n');
      });
      let ref = listEl.firstElementChild;
      for (const session of ordered) {
        const item = nodes.get(session.id).item;
        if (item === ref) ref = ref.nextElementSibling; else listEl.insertBefore(item, ref);
      }
      const canMore = items.length < total && items.length < CPL_MAX_ITEMS;
      moreButton.hidden = !canMore;
      moreButton.textContent = str.more;
      setStatus(items.length ? (items.length >= CPL_MAX_ITEMS ? str.limit : str.count(items.length, total)) : str.empty);
    }

    function load(reset) {
      if (loading || disposed) return;
      if (reset) { items = []; requestId++; }
      if (!reset && (items.length >= CPL_MAX_ITEMS || (total && items.length >= total))) return;
      loading = true;
      const generation = requestId;
      const offset = items.length;
      setStatus(str.loading);
      query({ limit: CPL_PAGE_SIZE, offset, excludeSubagents: true }).then(result => {
        loading = false;
        if (disposed || generation !== requestId) return;
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        total = Number(result?.total) || 0;
        items = items.concat(sessions.filter(valid));
        render();
        syncStatusWatch();
      }).catch(error => {
        loading = false;
        if (disposed || generation !== requestId) return;
        setStatus(str.failed + (error?.message || ''));
      });
    }

    function discoverStatusApi() {
      if (statusApi || statusLoading || typeof loadCodexPlusConversationTabStatusApi !== 'function') return;
      if (!document.querySelector('[data-app-shell-main-surface]')) return;
      statusLoading = true;
      Promise.resolve(loadCodexPlusConversationTabStatusApi()).then(api => {
        statusLoading = false;
        if (disposed || !api) return;
        statusApi = api;
        syncStatusWatch();
        render();
      }).catch(() => { statusLoading = false; });
    }

    function syncStatusWatch() {
      if (!statusApi || !items.length) return;
      const context = statusApi.context?.();
      if (!context) return;
      const ids = items.slice(0, CPL_MAX_ITEMS).map(session => session.id);
      const key = ids.join(',');
      if (key === statusIds && context === statusContext) return;
      const generation = ++statusGeneration;
      statusWatch?.(); statusWatch = null;
      statusIds = key; statusContext = context;
      try {
        statusWatch = statusApi.watch(context, ids, snapshot => {
          if (disposed || generation !== statusGeneration) return;
          nativeStates = new Map(snapshot);
          render();
        }, projects => {
          if (disposed || generation !== statusGeneration) return;
          nativeProjects = new Map(projects);
          render();
        });
      } catch { statusContext = null; }
    }

    function go(session) {
      const id = session.id;
      const row = document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"]`);
      if (row) row.click();
      else window.electronBridge?.sendMessageFromView?.({ type: 'open-in-main-window', path: `/local/${id}` });
      // 列表保持打开，像原生会话列表一样可以连续跳；标签栏开着时它自己会把会话加成标签。
    }

    function toggle() {
      if (disposed) return;
      active = !active;
      applyActive();
      if (active) {
        // 滚动区是原生列表在用的，切过来时可能停在中间；打开时间线一律回到最新。
        const scroll = document.querySelector(CPL_SCROLL_SELECTOR);
        if (scroll) scroll.scrollTop = 0;
        load(true);
        discoverStatusApi();
      }
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && active) toggle();
    }, opts);

    const runtime = {
      sync,
      toggle,
      isActive: () => active,
      dispose() {
        if (disposed) return;
        disposed = true;
        requestId++;
        statusWatch?.(); statusWatch = null;
        for (const [, n] of nodes) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); }
        nodes.clear();
        headerEntry?.remove();
        headerEntry = null;
        panel?.remove();
        style?.remove();
        document.querySelectorAll(`[${CPL_ACTIVE_ATTR}]`).forEach(node => node.removeAttribute(CPL_ACTIVE_ATTR));
        abort.abort();
        if (window.__codexPlusConversationList === runtime) delete window.__codexPlusConversationList;
      },
    };
    window.__codexPlusConversationList = runtime;
    installStyle();
    sync();
    return runtime;
  }
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
  function normalizeWorkspacePath(path) {
    const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || String(path || "").trim();
  }

  function sameWorkspacePath(left, right) {
    const leftPath = normalizeWorkspacePath(left);
    const rightPath = normalizeWorkspacePath(right);
    return !!leftPath && !!rightPath && leftPath === rightPath;
  }

  function displayProjectName(path) {
    const trimmed = String(path || "").replace(/\/+$/, "");
    return trimmed.split(/[\\/]+/).filter(Boolean).pop() || trimmed || "未命名项目";
  }

  function normalizeProjectLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function projectsSection() {
    return document.querySelector('[data-app-action-sidebar-section-heading="Projects"]');
  }


  /**
   * 同一时间最多显示几条 toast。
   *
   * 提示使用有界队列，超出上限时挤掉最旧的一条，避免连续提示遮住页面。
   */
  const codexPlusToastLimit = 3;
  const codexPlusToastLifetimeMs = 10000;
  const codexPlusToastGapPx = 48;

  /**
   * 按当前 DOM 顺序重排所有提示的纵向位置。
   *
   * 必须在每次「新增」和「移除」之后都调用：位置只在插入那一刻算的话，一旦有
   * 人被挤掉或超时消失，剩下几条会停在自己的旧层号上，出现空档和重叠。
   */
  function layoutCodexPlusToasts() {
    document.querySelectorAll(".codex-delete-toast").forEach((node, index) => {
      node.style.bottom = `${18 + index * codexPlusToastGapPx}px`;
    });
  }

  /** 移除一条提示并立刻重排剩下的。 */
  function dismissCodexPlusToast(toast) {
    toast.remove();
    layoutCodexPlusToasts();
  }

  /**
   * 显示一条提示。
   *
   * `options.type` 取 info / success / warn / error，对应 styles 里的四条配色；
   * 不传则保持原先的默认外观。
   */
  function showToast(message, options = {}) {
    const settings = options && typeof options === "object" ? options : {};
    const type = typeof settings.type === "string" ? settings.type : "";
    const live = document.querySelectorAll(".codex-delete-toast");
    // 队列满时挤掉最旧的（DOM 顺序即插入顺序）。用 dismiss 而不是裸 remove，
    // 它会顺带重排剩下几条的位置。
    if (live.length >= codexPlusToastLimit) {
      for (let index = 0; index <= live.length - codexPlusToastLimit; index += 1) {
        dismissCodexPlusToast(live[index]);
      }
    }
    const toast = document.createElement("div");
    toast.className = "codex-delete-toast";
    if (type) toast.dataset.toastType = type;
    toast.textContent = message;
    document.body.appendChild(toast);
    // append 之后统一重排：此时这条才进入 DOM，索引才是它真实的层号。
    layoutCodexPlusToasts();
    setTimeout(() => dismissCodexPlusToast(toast), codexPlusToastLifetimeMs);
    return () => dismissCodexPlusToast(toast);
  }

  function visibleElement(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function normalizedElementText(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function rowHref(row) {
    return row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
  }

  function isCurrentSessionRow(row, ref) {
    const currentId = locationThreadId();
    const currentIdentity = normalizedCodexThreadUuid(currentId) || currentId;
    const rowIdentity = normalizedCodexThreadUuid(ref.session_id) || ref.session_id;
    if (currentIdentity && currentIdentity !== rowIdentity) return false;
    // 新版原生 sidebarThreadRow 明确提供 active；false 不能被相同 pathname 覆盖。
    const nativeActive = row.getAttribute("data-app-action-sidebar-thread-active");
    if (nativeActive === "true" || nativeActive === "false") return nativeActive === "true";
    if (row.getAttribute("aria-current") === "page" || row.getAttribute("aria-current") === "true") return true;
    const href = rowHref(row);
    if (href) {
      try {
        const url = new URL(href, window.location.href);
        if (currentIdentity && url.href === window.location.href) return true;
      } catch {}
    }
    return !!currentIdentity && currentIdentity === rowIdentity;
  }

  function actionGroupFromRow(row) {
    return row.querySelector(`.${actionGroupClass}`);
  }

  function nativeActionButtonsFromRow(row) {
    return [...row.querySelectorAll('button,[role="button"],a')]
      .filter((node) => !node.closest(`.${actionGroupClass}`))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) return false;
        const label = [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.dataset?.state,
          node.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (/(pin|archive|置顶|归档)/i.test(label)) return true;
        const rowRect = row.getBoundingClientRect();
        return rect.left > rowRect.left + rowRect.width * 0.68;
      });
  }

  function syncActionGroupLayout(row, group) {
    syncActionGroupLayouts([{ row, group }]);
  }

  function syncActionGroupLayouts(entries, force = false) {
    // Batch each measurement phase across rows. A per-row write/read cycle
    // repeatedly lays out the app and delays the first resized background frame.
    const layouts = entries.filter(({ row, group }) =>
      row && group && (force || group.dataset.codexActionLayoutStable !== "true"))
      .map(({ row, group }) => {
        const rowRect = row.getBoundingClientRect();
        const nativeButtons = nativeActionButtonsFromRow(row);
        const native = nativeButtons.map(button => ({ button, rect: button.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0)
          .sort((a, b) => a.rect.left - b.rect.left)[0];
        const right = native ? Math.max(28, Math.round(rowRect.right - native.rect.left + 8)) : 28;
        const titleLeft = row.querySelector(selectors.threadTitle)?.getBoundingClientRect().left || rowRect.left + 40;
        const renderScale = row.offsetWidth > 0 ? rowRect.width / row.offsetWidth : 1;
        return { row, group, native, right, effectiveRight: right, titleLeft, renderScale,
          groupWidth: Math.ceil(group.getBoundingClientRect().width || 96) };
      });
    for (const layout of layouts) {
      // 颜色与悬停态不再从原生按钮的计算样式抄：那样拿到的是静止态，悬停时
      // 既不提亮也不变底色。外观改由按钮直接套用原生类名（syncNativeSessionActionStyle）。
      layout.group.style.setProperty("--codex-session-actions-right", `${layout.right}px`);
    }
    for (const layout of layouts) {
      if (!layout.native) continue;
      const groupRight = layout.group.getBoundingClientRect().right;
      const targetRight = layout.native.rect.left - 2;
      if (Number.isFinite(groupRight) && Number.isFinite(targetRight)) {
        layout.effectiveRight = Math.max(0, layout.right +
          (groupRight - targetRight) / Math.max(0.1, layout.renderScale));
      }
    }
    for (const { group, native, effectiveRight } of layouts) {
      if (native) group.style.setProperty("--codex-session-actions-right", `${effectiveRight}px`);
    }
    for (const layout of layouts) {
      const finalGroupLeft = layout.group.getBoundingClientRect().left;
      layout.titleMaxWidth = Math.max(24,
        (finalGroupLeft - layout.titleLeft - 8) / Math.max(0.1, layout.renderScale));
    }
    for (const { row, group, effectiveRight, groupWidth, titleMaxWidth } of layouts) {
      row.style.setProperty("--codex-session-title-mask", `${effectiveRight + groupWidth + 12}px`);
      row.style.setProperty("--codex-session-title-max-width", `${titleMaxWidth}px`);
      group.dataset.codexActionLayoutStable = "true";
    }
  }
  /**
   * Codex 启动壳自救。
   *
   * 现象（本机实测，2026-10-12）：Codex 的原生启动画面有时会一直停住——DOM 里
   * 只剩 splash 容器（`div.flex.items-center.justify-center.relative.size-full`），
   * `#root` 的 innerText 始终为空、`<main>` 始终不出现；而注入层一切正常
   * （`window.codexPlus` 已挂载、设置浮标在位、零异常），启动器侧
   * `latest-status.json` 也一直是 `running` / `progress:100`。
   * 也就是说宿主没有任何信号能发现「页面没渲染出来」，用户只能自己按刷新。
   * 实测手动 reload 一次即恢复。若本次使用了原生模块补丁，先让下一文档回退到原模块，
   * 避免刷新后重新套用同一套有问题的映射而继续卡住。
   *
   * 这里把「手动刷新」这一下自动化，并严格限次：
   *   - 只认空壳：`#root` 存在、innerText 为空、且没有 `<main>`。正常的启动画面
   *     渲染几秒内就会长出 `<main>`，所以宽限期足够长即可区分「慢」与「卡死」。
   *   - 宽限期分两档：注入时页面已经加载完成（`readyState=complete`）却仍是空壳，
   *     说明文档早就加载完、不是慢启动，等 3s 就刷新；否则保留 20s，避免在慢机器
   *     上打断真正还在挂载的页面（本机实测正常挂载要 5~14s）。
   *   - 只在主页面做。带 `initialRoute=` 的活动悬浮层与 quick-chat 是独立页面，
   *     它们本来就没有 `<main>`，刷新只会丢上下文。
   *   - 每次加载最多刷一次，且与上次刷新间隔不足冷却时间就不再刷；
   *     写不进 sessionStorage 时宁可不刷，避免退化成刷新循环。
   */
  const bootShellRecoveryStorageKey = "codexPlus.bootShellRecoveryAt";
  const bootShellRecoveryGraceMs = 20000;
  // 注入时就已经是空壳：文档加载完了却一个节点都没渲染，不必再等满 20s。
  const bootShellRecoveryStuckGraceMs = 3000;
  const bootShellRecoveryCooldownMs = 60000;
  const bootShellRecoveryPollMs = 1000;

  // 带 initialRoute 的是活动悬浮层 / quick-chat 等独立页面，它们本来就没有
  // <main>，刷它们只会丢上下文，必须跳过。
  function bootShellRecoveryAppliesHere() {
    return !/[?&]initialRoute=/.test(window.location.search);
  }

  // 页面是否已经「有东西」了：挂上 <main>，或 #root 里渲染出了任何文字。
  function bootShellRecoverySettled() {
    if (document.querySelector("main")) return true;
    const root = document.getElementById("root");
    if (!root) return false;
    return root.innerText.trim() !== "";
  }

  function bootShellRecoveryStuck() {
    const root = document.getElementById("root");
    if (!root) return false;
    if (document.querySelector("main")) return false;
    return root.innerText.trim() === "";
  }

  function bootShellRecoveryMayReload() {
    try {
      const last = Number(window.sessionStorage.getItem(bootShellRecoveryStorageKey)) || 0;
      return Date.now() - last >= bootShellRecoveryCooldownMs;
    } catch {
      // 记不下时间就无法限次，宁可不刷。
      return false;
    }
  }

  /**
   * 起一个不常驻的看门定时器：页面正常渲染就收工，空壳超时才限次刷新一次。
   * 只在模块末尾调一次。
   */
  function installBootShellRecovery() {
    if (!bootShellRecoveryAppliesHere()) return;
    const startedAt = Date.now();
    // 文档已经加载完却还是空壳 = 页面卡住而不是慢启动，不必等满 20s。
    const graceMs = document.readyState === "complete" && bootShellRecoveryStuck()
      ? bootShellRecoveryStuckGraceMs
      : bootShellRecoveryGraceMs;
    const timer = window.setInterval(() => {
      if (bootShellRecoverySettled()) {
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt < graceMs) return;
      window.clearInterval(timer);
      if (!bootShellRecoveryStuck() || !bootShellRecoveryMayReload()) return;
      try {
        window.sessionStorage.setItem(bootShellRecoveryStorageKey, String(Date.now()));
      } catch {
        return;
      }
      let nativeModuleFallback = false;
      try {
        nativeModuleFallback = window.__codexPlusNativeFastPrepareBootShellFallback?.() === true;
      } catch { /* 旧版或未安装模块补丁时沿用普通刷新，不阻塞原有自救。 */ }
      // 记一条诊断，事后能从 codex-plus.log 确认它真的触发过、卡了多久。
      if (typeof sendCodexPlusDiagnostic === "function") {
        sendCodexPlusDiagnostic("boot_shell_recovery_reload", {
          waitedMs: Date.now() - startedAt,
          graceMs,
          nativeModuleFallback,
        });
      }
      window.location.reload();
    }, bootShellRecoveryPollMs);
  }

  installBootShellRecovery();
  function syncActionGroupsLayout(force = false) {
    syncActionGroupLayouts(sessionRows().map(row => ({
      row, group: actionGroupFromRow(row),
    })), force);
  }

  function removeActionGroups(row) {
    document.querySelectorAll(`.${moreMenuClass}`).forEach((menu) => {
      if (menu.__codexSessionMoreRow === row) disposeSessionMoreMenu(menu);
    });
    row.querySelectorAll(`.${actionGroupClass}`).forEach((group) => group.remove());
  }

  function closeSessionMoreMenu(menu) {
    menu.hidden = true;
    const row = menu.__codexSessionMoreRow || menu.closest?.("[data-codex-delete-row]");
    row?.classList?.remove("codex-session-more-open");
    menu.__codexSessionMoreGroup?.querySelector?.(`.${moreButtonClass}`)?.setAttribute("aria-expanded", "false");
  }

  function disposeSessionMoreMenu(menu) {
    closeSessionMoreMenu(menu);
    menu.__codexSessionMoreCleanup?.();
    // 拓展用 render 自己画的菜单项（例如 dsh 前端插件的 React 组件）：菜单拆掉时一并卸载。
    menu.querySelectorAll?.("[data-codex-plus-extension-item]").forEach((item) => {
      const cleanup = item.__codexPlusRowActionCleanup;
      item.__codexPlusRowActionCleanup = null;
      if (typeof cleanup === "function") {
        try { cleanup(); } catch {}
      }
    });
    const group = menu.__codexSessionMoreGroup;
    if (group?.__codexSessionMoreMenu === menu) group.__codexSessionMoreMenu = null;
    menu.__codexSessionMoreCleanup = null;
    menu.__codexSessionMoreRow = null;
    menu.__codexSessionMoreGroup = null;
    menu.remove();
  }

  /** 按钮组记下的行内操作有没有缺（React 重建、克隆替换时可能丢）。 */
  function sessionInlineActionsMissing(group) {
    return String(group.dataset?.codexInlineActionKey || "").split("|").filter(Boolean)
      .some((id) => !group.querySelector(`[data-codex-plus-row-action="${id}"]`));
  }

  function pruneSessionMoreMenus(removedMenus = []) {
    let needsScan = false;
    // 菜单挂在 body 下，不会随 React 会话行一起卸载；复用现有观察器及时释放。
    const menus = new Set([...document.querySelectorAll(`.${moreMenuClass}`), ...removedMenus]);
    menus.forEach((menu) => {
      const row = menu.__codexSessionMoreRow;
      const group = menu.__codexSessionMoreGroup;
      if (!menu.isConnected || !row?.isConnected || !group?.isConnected || !row.contains(group)
          || !group.querySelector(`.${moreButtonClass}`)
          || sessionInlineActionsMissing(group)) {
        if (row?.isConnected) needsScan = true;
        disposeSessionMoreMenu(menu);
      }
    });
    return needsScan;
  }

  function pruneRemovedSessionActions(mutations) {
    let relevantRemoval = false;
    const removedMenus = new Set();
    const menuSelector = `.${moreMenuClass}`;
    const actionSelector = `.${actionGroupClass}, .${moreButtonClass}, [data-codex-plus-row-action], ${menuSelector}`;
    for (const mutation of mutations || []) {
      for (const node of mutation.removedNodes) {
        if (node.nodeType !== 1 || (!node.matches(actionSelector) && !node.querySelector(actionSelector))) continue;
        relevantRemoval = true;
        if (node.matches(menuSelector)) removedMenus.add(node);
        node.querySelectorAll(menuSelector).forEach((menu) => removedMenus.add(menu));
      }
    }
    // 同步移动和按钮克隆替换在观察器回调前已完成，只依据最终连接状态判断。
    return relevantRemoval && pruneSessionMoreMenus(removedMenus);
  }

  function stopActionButtonEvent(row, button, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    button.blur();
  }

  function installActionButtonEvents(row, button, onActivate) {
    ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => stopActionButtonEvent(row, button, event), true);
    });
    button.addEventListener("pointerenter", () => showActionButtonTooltip(button));
    button.addEventListener("pointerleave", hideActionButtonTooltip);
    button.addEventListener("focus", () => showActionButtonTooltip(button));
    button.addEventListener("blur", hideActionButtonTooltip);
    button.addEventListener("click", (event) => {
      hideActionButtonTooltip();
      onActivate(event);
    }, true);
  }

  function installMoreButtonEvents(row, button, onActivate) {
    ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => stopActionButtonEvent(row, button, event), true);
    });
    button.addEventListener("pointerup", onActivate, true);
    button.addEventListener("click", (event) => {
      hideActionButtonTooltip();
      stopActionButtonEvent(row, button, event);
    }, true);
  }

  function hideActionButtonTooltip() {
    document.querySelectorAll(`.${actionTooltipClass}`).forEach((node) => node.remove());
  }

  function closeSessionMoreMenus(exceptMenu = null) {
    document.querySelectorAll(`.${moreMenuClass}`).forEach((menu) => {
      if (menu !== exceptMenu) {
        closeSessionMoreMenu(menu);
      }
    });
  }

  function toggleSessionMoreMenu(row, button, menu) {
    const nextHidden = !menu.hidden;
    closeSessionMoreMenus(menu);
    menu.hidden = nextHidden;
    row.classList.toggle("codex-session-more-open", !menu.hidden);
    button.setAttribute("aria-expanded", String(!menu.hidden));
  }

  function installSessionMoreMenuAutoClose(row, menu) {
    const group = menu.__codexSessionMoreGroup || menu.closest?.(`.${actionGroupClass}`);
    let closeTimer = null;
    const closeIfOutside = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        if (menu.hidden) return;
        const active = document.activeElement;
        if (group?.matches?.(":hover") || menu.matches?.(":hover") || menu.contains(active)) return;
        closeSessionMoreMenu(menu);
      }, 80);
    };
    group?.addEventListener("pointerleave", closeIfOutside, true);
    menu.addEventListener("pointerleave", closeIfOutside, true);
    menu.addEventListener("focusout", closeIfOutside, true);
    menu.__codexSessionMoreCleanup = () => {
      window.clearTimeout(closeTimer);
      closeTimer = null;
      group?.removeEventListener("pointerleave", closeIfOutside, true);
      menu.removeEventListener("pointerleave", closeIfOutside, true);
      menu.removeEventListener("focusout", closeIfOutside, true);
    };
  }

  function updateSessionMoreMenuDirection(button, menu) {
    menu.classList.remove("codex-session-more-menu-open-up");
    const buttonRect = button.getBoundingClientRect();
    const estimatedMenuHeight = Math.max(80, menu.getBoundingClientRect().height || 76);
    if (buttonRect.bottom + 30 + estimatedMenuHeight > window.innerHeight - 8) {
      menu.classList.add("codex-session-more-menu-open-up");
    }
  }

  function positionSessionMoreMenu(button, menu) {
    const rect = button.getBoundingClientRect();
    const menuWidth = Math.max(104, menu.getBoundingClientRect().width || 104);
    const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.right - menuWidth));
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, rect.bottom + 4)}px`;
  }

  function createSessionMoreMenuItem(label, icon, onActivate) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "codex-session-more-menu-item";
    item.innerHTML = `<span class="codex-session-more-menu-icon">${icon}</span><span>${label}</span>`;
    item.addEventListener("click", onActivate, true);
    return item;
  }

  function showActionButtonTooltip(button) {
    const label = button.dataset.codexActionLabel || button.getAttribute("aria-label") || "";
    if (!label) return;
    hideActionButtonTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = actionTooltipClass;
    tooltip.textContent = label;
    document.body.appendChild(tooltip);
    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 8,
      Math.max(8, buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2),
    );
    const top = Math.min(
      window.innerHeight - tooltipRect.height - 8,
      buttonRect.bottom + gap,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function refreshActionButton(originalButton, row, onActivate) {
    if (!originalButton.isConnected) return;
    const replacement = originalButton.cloneNode(true);
    installActionButtonEvents(row, replacement, onActivate);
    originalButton.replaceWith(replacement);
    return replacement;
  }

  // 会话行图标按钮的线性图标统一画在 16 栅格上，线宽 1.05、圆角端点：与 Codex
  // 原生「置顶 / 归档」所用 light-16 图标的笔画粗细和墨迹范围一致。原生如果换成
  // 描边图标，syncNativeSessionActionStyle 会按它的 stroke-width 换算后覆盖。
  const sessionActionIconStrokeWidth = "1.05";

  function sessionActionStrokeIconSvg(paths) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="${sessionActionIconStrokeWidth}" stroke-linecap="round" stroke-linejoin="round" data-codex-session-action-icon="stroke">${paths}</svg>`;
  }


  function ellipsisIconSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" data-codex-session-action-icon="fill"><circle cx="3.5" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12.5" cy="8" r="1.1"></circle></svg>';
  }

  function configureSvgActionButton(button, label, svg) {
    button.setAttribute("aria-label", label);
    button.dataset.codexActionLabel = label;
    button.removeAttribute("title");
    // 原生按钮的图标包在一层 inner span 里（负责居中），这里保持同样结构，
    // 套用原生类名时 inner span 也一并换成原生的 inner 类名。
    button.innerHTML = `<span class="codex-session-action-inner">${svg}</span>`;
  }

  // Codex 原生按钮的外观由 CSS module 类名 + data-color / data-variant / data-size
  // 等属性共同决定，只抄 className 不够，这些属性要一起带上。
  const nativeSessionActionStyleAttributes = [
    "data-color", "data-variant", "data-size", "data-uniform", "data-pill",
    "data-squircle", "data-icon-size", "data-gutter-size",
  ];
  // 最近一次从原生按钮读到的样式快照；新建的按钮直接套用，不必等悬停。
  let nativeSessionActionStyle = null;

  function nativeSessionIconButtonFromRow(row) {
    for (const button of row?.querySelectorAll?.("button") || []) {
      if (button.closest(`.${actionGroupClass}, [data-codex-plus-ext]`)) continue;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
      if (!/(pin|archive|置顶|归档)/i.test(label)) continue;
      // 只认纯图标按钮：归档二次确认的「确认」是带文字的危险色按钮，不能当样板。
      // 原生图标也可能不是内联 svg，等宽（data-uniform）的图标按钮同样可以当样板。
      if ((button.textContent || "").trim()) continue;
      if (!button.querySelector("svg") && !button.hasAttribute("data-uniform")) continue;
      if (button.getAttribute("data-color") === "danger") continue;
      return button;
    }
    return null;
  }

  function nativeSessionIconStrokeWidth(svg) {
    const stroked = svg?.matches?.("[stroke-width]") ? svg : svg?.querySelector?.("[stroke-width]");
    const width = Number.parseFloat(stroked?.getAttribute("stroke-width") || "");
    const viewBoxWidth = Number.parseFloat((svg?.getAttribute("viewBox") || "").trim().split(/[\s,]+/)[2] || "");
    if (!(width > 0) || !(viewBoxWidth > 0)) return "";
    return String(Math.round((width * 16 / viewBoxWidth) * 100) / 100);
  }

  function readNativeSessionActionStyle(button) {
    const className = typeof button?.className === "string" ? button.className.trim() : "";
    if (!className) return null;
    const attributes = {};
    nativeSessionActionStyleAttributes.forEach((name) => {
      if (button.hasAttribute(name)) attributes[name] = button.getAttribute(name);
    });
    const inner = Array.from(button.children).find((child) => child.tagName === "SPAN" && child.querySelector("svg"));
    const innerClassName = typeof inner?.className === "string" ? inner.className.trim() : "";
    const strokeWidth = nativeSessionIconStrokeWidth(button.querySelector("svg"));
    return {
      className, attributes, innerClassName, strokeWidth,
      key: JSON.stringify([className, attributes, innerClassName, strokeWidth]),
    };
  }

  function applyNativeSessionActionStyle(button, style = nativeSessionActionStyle) {
    if (!(button instanceof HTMLElement)) return;
    // 自己的类名（删除 / 更多的识别类）记在 dataset 上，换原生类名时始终保留。
    if (!button.dataset.codexActionClasses) button.dataset.codexActionClasses = button.className;
    if (!style || button.__codexNativeStyleKey === style.key) return;
    button.className = `${style.className} ${button.dataset.codexActionClasses}`;
    nativeSessionActionStyleAttributes.forEach((name) => button.removeAttribute(name));
    Object.entries(style.attributes).forEach(([name, value]) => button.setAttribute(name, value));
    const inner = button.querySelector(".codex-session-action-inner");
    if (inner) inner.className = `codex-session-action-inner ${style.innerClassName}`.trim();
    button.querySelectorAll('svg[data-codex-session-action-icon="stroke"]').forEach((svg) => {
      svg.setAttribute("stroke-width", style.strokeWidth || sessionActionIconStrokeWidth);
    });
    button.setAttribute("data-codex-native-style", "true");
    button.__codexNativeStyleKey = style.key;
  }

  function syncNativeSessionActionStyle(row) {
    const native = nativeSessionIconButtonFromRow(row);
    const style = native ? readNativeSessionActionStyle(native) : null;
    const changed = !!style && style.key !== nativeSessionActionStyle?.key;
    if (changed) nativeSessionActionStyle = style;
    if (!nativeSessionActionStyle) return;
    // 原生样式变了（Codex 改版或首次读到）就刷新所有行，否则只补当前行。
    const scope = changed ? document : actionGroupFromRow(row);
    scope?.querySelectorAll?.(`.${actionButtonClass}`)
      .forEach((button) => applyNativeSessionActionStyle(button));
  }

  function installNativeSessionActionStyleSync(row) {
    if (row.__codexNativeActionStyleSync) return;
    row.__codexNativeActionStyleSync = true;
    // 原生置顶 / 归档按钮多数只在悬停时挂载，当帧还没渲染出来，等下一帧再读。
    row.addEventListener("pointerenter", () => {
      window.requestAnimationFrame(() => {
        if (row.isConnected) syncNativeSessionActionStyle(row);
      });
    }, { passive: true });
  }

  /**
   * 会话行操作（ctx.registerRowAction / codexPlus.registerRowAction）：placement 为 "inline" 的画成行上常驻的图标按钮，
   * 其余进「…」菜单；surfaces 默认只在侧栏，含 "archived" 的也画在归档页的行上。内置的删除、导出也是这样注册的
   * （见 96-builtin-extensions.js），这里只是宿主。增强总开关关闭时都不显示。
   */
  function sessionRowActionItems(surface = "sidebar") {
    if (codexPlusBackendSettings.enhancementsEnabled === false) return [];
    return codexPlusExtensionItems(codexPlusRegistry.rowActions)
      .filter((item) => (Array.isArray(item.surfaces) && item.surfaces.length ? item.surfaces : ["sidebar"]).includes(surface));
  }

  /** 行内按钮的图标：SVG 原样用，其余当文字字形。 */
  function sessionRowActionIconMarkup(icon) {
    const text = String(icon ?? "").trim();
    if (/^<svg[\s>]/i.test(text)) return text;
    const glyph = (text || "◇").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
    return `<span class="codex-session-action-glyph">${glyph}</span>`;
  }

  /** 拓展行操作的回调参数。归档页的行未必读得到会话 id，resolve() 必要时问 Codex Pilot 按标题找。 */
  function sessionRowActionContext(row, extra = {}) {
    const archived = extra.archived === true;
    const ref = archived ? archivedRefFromRow(row) : sessionRefFromRow(row);
    return {
      row,
      session_id: ref.session_id,
      title: ref.title || row.getAttribute?.("data-app-action-sidebar-thread-title") || "",
      archived,
      resolve: () => (archived ? resolveArchivedThread(row) : Promise.resolve(sessionRefFromRow(row))),
      close: () => closeSessionMoreMenus(),
      ...extra,
    };
  }

  function attachButton(row) {
    const items = sessionRowActionItems();
    const inlineItems = items.filter((item) => item.placement === "inline");
    // 菜单指纹：项变了（拓展注册 / 注销）就整组重建；空串表示没有菜单项，不渲染「…」按钮。
    const moreMenuKey = items.filter((item) => item.placement !== "inline").map((item) => `ext:${item.id}`).join("|");
    const inlineKey = inlineItems.map((item) => item.id).join("|");
    const needsMoreMenu = !!moreMenuKey;
    if (!inlineItems.length && !needsMoreMenu) {
      removeActionGroups(row);
      row.dataset.codexDeleteRow = "false";
      return;
    }
    const existingGroup = actionGroupFromRow(row);
    const existingMoreButton = existingGroup?.querySelector(`.${moreButtonClass}`);
    const groupReady = existingGroup?.dataset.codexActionGroupVersion === codexActionGroupVersion;
    const inlineReady = existingGroup?.dataset.codexInlineActionKey === inlineKey && !sessionInlineActionsMissing(existingGroup);
    const existingMenu = existingGroup?.__codexSessionMoreMenu;
    const menuReady = !needsMoreMenu || (existingMenu?.isConnected
      && existingMenu.__codexSessionMoreRow === row && existingMenu.__codexSessionMoreGroup === existingGroup
      && existingGroup.dataset.codexMoreMenuKey === moreMenuKey);
    if (groupReady && inlineReady && menuReady && needsMoreMenu === !!existingMoreButton) {
      return;
    }
    removeActionGroups(row);
    row.dataset.codexDeleteRow = "false";
    const ref = sessionRefFromRow(row);
    if (!ref.session_id) return;
    row.dataset.codexDeleteRow = "true";
    const group = document.createElement("div");
    group.className = actionGroupClass;
    group.setAttribute("data-codex-plus-ext", "session-actions");
    group.dataset.codexActionGroupVersion = codexActionGroupVersion;
    group.dataset.codexMoreMenuKey = moreMenuKey;
    group.dataset.codexInlineActionKey = inlineKey;
    if (needsMoreMenu) {
      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = `${actionButtonClass} ${moreButtonClass}`;
      moreButton.setAttribute("aria-haspopup", "menu");
      moreButton.setAttribute("aria-expanded", "false");
      configureSvgActionButton(moreButton, "更多操作", ellipsisIconSvg());
      applyNativeSessionActionStyle(moreButton);
      const moreMenu = document.createElement("div");
      moreMenu.className = moreMenuClass;
      moreMenu.setAttribute("data-codex-plus-ext", "session-more-menu");
      moreMenu.setAttribute("role", "menu");
      moreMenu.hidden = true;
      // 会话行操作按注册顺序（order）追加。注册 / 注销会改变 moreMenuKey，
      // 触发整组重建并重新走一遍这里，所以拓展项不会因为重建而丢失。
      appendCodexPlusExtensionRowActions(moreMenu, row, moreButton);
      const openMoreMenu = (event) => {
        stopActionButtonEvent(row, moreButton, event);
        hideActionButtonTooltip();
        toggleSessionMoreMenu(row, moreButton, moreMenu);
        if (!moreMenu.hidden) {
          positionSessionMoreMenu(moreButton, moreMenu);
          updateSessionMoreMenuDirection(moreButton, moreMenu);
        }
      };
      installMoreButtonEvents(row, moreButton, openMoreMenu);
      group.appendChild(moreButton);
      moreMenu.__codexSessionMoreRow = row;
      moreMenu.__codexSessionMoreGroup = group;
      group.__codexSessionMoreMenu = moreMenu;
      document.body.appendChild(moreMenu);
      installSessionMoreMenuAutoClose(row, moreMenu);
    }
    inlineItems.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      // 拓展自己的类名在套原生样式之前加上，换原生类名时一并保留。
      button.className = [actionButtonClass, ...String(item.className || "").split(/\s+/).filter(Boolean)].join(" ");
      button.setAttribute("data-codex-plus-row-action", item.id);
      const label = String(item.label || item.id);
      configureSvgActionButton(button, label, sessionRowActionIconMarkup(item.icon));
      if (typeof item.onMount === "function") {
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onMount", () => item.onMount({ button, row, session_id: ref.session_id }));
      }
      applyNativeSessionActionStyle(button);
      const activate = (event) => {
        stopActionButtonEvent(row, button, event);
        if (typeof item.onActivate !== "function") return;
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onActivate", () =>
          item.onActivate(sessionRowActionContext(row, { button, event })));
      };
      installActionButtonEvents(row, button, activate);
      group.appendChild(button);
      setTimeout(() => refreshActionButton(button, row, activate), 0);
    });
    row.appendChild(group);
    // 先套上原生按钮外观再量布局，避免尺寸在测量后才变化。
    syncNativeSessionActionStyle(row);
    installNativeSessionActionStyleSync(row);
    syncActionGroupLayout(row, group);
  }

  function tryAttachButton(row) {
    try {
      attachButton(row);
    } catch (error) {
      window.__codexSessionDeleteAttachButtonFailures = window.__codexSessionDeleteAttachButtonFailures || [];
      window.__codexSessionDeleteAttachButtonFailures.push(String(error?.stack || error));
    }
  }

  function reactArchivedThreadFromNode(node) {
    const reactKey = Object.keys(node).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
    let fiber = reactKey ? node[reactKey] : null;
    for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      if (props.archivedThread?.id) return props.archivedThread;
      const childThread = props.children?.props?.archivedThread;
      if (childThread?.id) return childThread;
    }
    return null;
  }

  function archivedThreadFromRow(row) {
    for (const node of [row, ...row.querySelectorAll("*")]) {
      const thread = reactArchivedThreadFromNode(node);
      if (thread?.id || thread?.sessionId) return thread;
    }
    return null;
  }

  function archivedRefFromRow(row) {
    const archivedThread = archivedThreadFromRow(row);
    if (archivedThread?.id || archivedThread?.sessionId) {
      return { session_id: archivedThread.id || archivedThread.sessionId, title: archivedThread.title || row.querySelector(".truncate.text-base")?.textContent?.trim() || "Untitled session" };
    }
    const sidebarRef = sessionRefFromRow(row);
    if (sidebarRef.session_id) return sidebarRef;
    const titleNode = row.querySelector(".truncate.text-base, [data-thread-title], a, div");
    const title = ((titleNode || row).textContent || "Untitled session")
      .replace("取消归档", "")
      .replace("删除", "")
      .replace(/\d{4}年\d{1,2}月\d{1,2}日.*$/, "")
      .replace(/\s+·\s+.*$/, "")
      .trim()
      .slice(0, 160);
    return { session_id: "", title };
  }

  async function resolveArchivedThread(row) {
    const ref = archivedRefFromRow(row);
    if (ref.session_id) return ref;
    const resolved = await postJson("/archived-thread", { title: ref.title });
    return resolved?.session_id ? resolved : ref;
  }

  function stopArchivedButtonEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  /** 归档页的行：surfaces 含 "archived" 的会话行操作画成「取消归档」旁的文字按钮。 */
  function attachArchivedPageDeleteButton(row) {
    const items = sessionRowActionItems("archived");
    row.querySelectorAll("[data-codex-archive-row-action]").forEach((button) => button.remove());
    row.dataset.codexArchiveDeleteRow = "false";
    if (!items.length) return;
    const unarchiveButton = Array.from(row.querySelectorAll("button")).find((button) => (button.textContent || "").trim() === "取消归档");
    if (!unarchiveButton) return;
    row.dataset.codexArchiveDeleteRow = "true";
    row.dataset.codexArchiveRowActionsVersion = codexArchiveRowActionsVersion;
    let insertionPoint = unarchiveButton;
    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = ["codex-archive-delete-all", "codex-archive-row-button", ...String(item.className || "").split(/\s+/).filter(Boolean)].join(" ");
      button.dataset.codexArchiveRowAction = item.id;
      button.textContent = String(item.label || item.id);
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopArchivedButtonEvent, true);
      });
      button.addEventListener("click", (event) => {
        stopArchivedButtonEvent(event);
        if (typeof item.onActivate !== "function") return;
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onActivate", () =>
          item.onActivate(sessionRowActionContext(row, { archived: true, button, event })));
      }, true);
      insertionPoint.insertAdjacentElement("afterend", button);
      insertionPoint = button;
    });
  }

  function conversationRoot() {
    return document.querySelector(".thread-scroll-container") || document.querySelector("main") || document.querySelector('[role="main"]');
  }

  function nodeOrAncestorLooksLikeCodexUserBubble(node) {
    if (node.nodeType !== 1) return false;
    const className = String(node.className || "");
    if (className.includes("bg-token-foreground/5") && node.parentElement?.classList?.contains("items-end")) return true;
    const bubble = node.closest?.("[class*='bg-token-foreground/5']");
    return !!bubble?.parentElement?.classList?.contains("items-end");
  }

  function nodeLooksLikeCodexUserBubble(node) {
    if (nodeOrAncestorLooksLikeCodexUserBubble(node)) return true;
    return !!node.querySelector?.(".group.flex.w-full.flex-col.items-end.justify-end.gap-1 > [class*='bg-token-foreground/5']");
  }

  function removeLegacyCodexServiceTierBadges() {
    document.querySelectorAll(`[data-codex-service-tier-badge="true"]`).forEach((badge) => badge.remove());
  }
  /**
   * 对外接口层：window.codexPlus
   *
   * 第三方用户脚本不认识 Codex Pilot 内部的闭包函数，只能通过这个对象调用能力。
   * 设计要点：
   *
   *   1. 只挂一个全局名。之前 42 个 window.__codexPlus* 里绝大多数是补丁哨兵，
   *      对外没有价值；新能力统一收进这里，避免命名空间继续发散。
   *   2. 注册表持久、DOM 瞬态。每个 register* 只把数据写进注册中心，渲染由消费方
   *      负责。第三方不需要关心宿主何时重建（overlay 重开、会话行重建）。
   *   3. 失败隔离。第三方回调一律经 runCodexPlusExtensionCallback 包一层，抛错
   *      记进该脚本的状态通道，不会让 Codex Pilot 自己的 UI 白屏。
   *
   * 这个分片必须在 renderer-inject 内部的所有 UI 消费方之前执行，因为它只做定义、
   * 不读 DOM；实际挂载发生在 99-tail 之前，那时所有依赖函数都已可用。
   */
  const codexPlusExtensionApiVersion = 1;
  const codexPlusExtensionAdapterVersion = "1.2.0";

  /** 类名与属性契约。一旦发布不再更名，新增用新名字。 */
  const codexPlusExtensionConstants = {
    pageClass: codexPlusPageClass,
    pageNavAttribute: "data-codex-plus-page-nav",
    railSelector: codexPlusRailSelector,
    railDestinationSelector: codexPlusRailDestinationSelector,
    actionGroupClass,
    moreMenuClass,
    toastClass: "codex-delete-toast",
    // 拓展自己插入的节点必须带这个属性，值是该脚本的 key。
    // 扫描调度靠它把拓展的写入排除在自喂循环之外（issue #1960）。
    extensionAttribute: "data-codex-plus-ext",
  };

  /**
   * 路由白名单。未在此声明的路由即使后端支持也不允许拓展调用。
   *
   * 刻意做成白名单而不是黑名单：新增路由时默认不可用，需要显式决定是否开放，
   * 避免内部路由（例如 `/settings/set`、`/manager/open-transient`）被顺手暴露出去。
   */
  const codexPlusExtensionRoutes = new Set([
    "/diagnostics/log",
    "/thread-usage-history",
    "/archived-thread",
    "/user-scripts/list",
    // 显式开放：给拓展注入 overlay 等独立 Codex 页面，不暴露任意 CDP 方法。
    "/cdp/targets",
    "/cdp/evaluate",
    // 只读：系统鼠标位置，写「桌宠跟随鼠标」这类功能用。
    "/system/cursor-position",
    // 只读：最近已完成的模型请求（模型、耗时、供应商、token、成败），写「请求提示」这类功能用。
    // 只读：进行中的模型请求（阶段、首字耗时、重试），与内置请求状态条同源。
    // 只读：当前会话最近的 token 事件（读 rollout 尾部，可秒级轮询），与内置用量状态栏同源。
    "/thread-usage-live",
    // 只读：Codex Pilot 版本与连接状态。
    "/backend/status",
    // 只读：设置的公开子集（当前供应商的名称、模式、模型、上下文窗口），不含地址、Key 与配置内容。
    "/settings/public",
    // 只读：模型目录（模型列表与每模型元数据，含上下文窗口），去掉了来源地址与本机路径。
    "/model-catalog/public",
  ]);

  /** 单次调用的默认超时，略短于桥接自身的 26s，让拓展先拿到可读的错误。 */
  const codexPlusExtensionCallTimeoutMs = 26000;

  /**
   * 调用后端。
   *
   * 直接暴露 __codexSessionDeleteBridge 有三个问题：名字语义错位（它早就不只用于
   * 会话删除）、没有超时、错误风格不统一（路由层返回 {status:"failed"}，浮层面板
   * 返回 {error}）。这里统一成 Promise reject，让拓展用 try/catch。
   */
  function codexPlusExtensionCall(route, payload = {}, options = {}) {
    if (typeof route !== "string" || !codexPlusExtensionRoutes.has(route)) {
      return Promise.reject(new Error(`未开放的路由：${route}`));
    }
    const bridge = window.__codexSessionDeleteBridge;
    if (typeof bridge !== "function") {
      return Promise.reject(new Error("Codex 页面尚未连接，请稍后重试"));
    }
    const timeout = Number.isFinite(options.timeout) ? Number(options.timeout) : codexPlusExtensionCallTimeoutMs;
    // 桥接协议没有 cancel 通道，超时只能放弃等待，服务端任务仍会跑完。
    const request = bridge(route, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`调用 ${route} 超时`)), timeout);
      Promise.resolve(request).then(
        (result) => {
          clearTimeout(timer);
          if (result?.status === "failed" || result?.error) {
            reject(new Error(result.message || result.error || `${route} 调用失败`));
            return;
          }
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * 当前脚本的 key。
   *
   * wrap_script 只在脚本初始化期间把 currentKey 设为脚本 key，异步回调里就是 null。
   * 而拓展完全可能在 await 之后才注册 UI，所以不能只看 currentKey——那样这些项会
   * 丢失归属，出问题时无法定位到是哪个脚本，扫描调度也认不出它的节点。
   * 这里保留 options.scriptKey 作为显式覆盖，默认回退到 currentKey。
   */
  function codexPlusCurrentExtensionScriptKey(options) {
    return options?.scriptKey || window.__codexPlusUserScripts?.currentKey || "";
  }

  /** 注册一个带 order 的拓展项，统一处理 id 前缀与失败上报。 */
  function codexPlusRegisterExtensionItem(kind, registry, definition, options = {}) {
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const id = `${scriptKey}:${kind}:${options.id || codexPlusExtensionIdSeed()}`;
    const dispose = registerCodexPlusExtension(kind, registry, id, definition, scriptKey);
    // 注册后立刻让所有入口重画一次，否则用户要等下一次 scan 才看得到新项。
    codexPlusRefreshExtensionHosts();
    return () => {
      dispose();
      codexPlusRefreshExtensionHosts();
    };
  }

  let codexPlusExtensionIdCounter = 0;
  function codexPlusExtensionIdSeed() {
    codexPlusExtensionIdCounter += 1;
    return `item-${codexPlusExtensionIdCounter}`;
  }

  /**
   * 通知各消费方重画。
   *
   * 每个消息都可能有消费方尚未初始化（例如浮层面板按需注入、overlay 未打开），
   * 所以逐项 try/catch，任何一个不存在或抛错都不影响其余。
   */
  function codexPlusRefreshExtensionHosts() {
    codexPlusRefreshExtensionHostsNow();
    scheduleCodexPlusExtensionHostsCatchUp();
  }

  /**
   * 页面刚加载时拓展往往先于 Codex 的界面注册：注册那一刻输入框、侧栏、顶栏还没渲染，立即刷新没有地方挂。
   * 首页静止时扫描也不会再跑，所以注册 / 撤销后再在 0.5、2、5 秒各补刷一次。连续注册共用同一组定时器；
   * 各刷新按指纹幂等，界面没变时不动 DOM。
   */
  let codexPlusExtensionHostsCatchUpTimers = [];
  function scheduleCodexPlusExtensionHostsCatchUp() {
    for (const timer of codexPlusExtensionHostsCatchUpTimers) clearTimeout(timer);
    codexPlusExtensionHostsCatchUpTimers = [500, 2000, 5000].map((delay) => setTimeout(codexPlusRefreshExtensionHostsNow, delay));
  }

  function codexPlusRefreshExtensionHostsNow() {
    for (const refresh of [
      refreshCodexPlusRailNavigation,
      refreshCodexPlusComposerActions,
      refreshCodexPlusMessageSlots,
      refreshCodexPlusSidePanels,
      refreshCodexPlusUiSlots,
      refreshExtensionSessionRows,
      refreshCodexPlusExtensionMenu,
    ]) {
      try {
        refresh?.();
      } catch {}
    }
  }

  /**
   * 已打开的菜单里补上／摘掉拓展项。
   *
   * 菜单是打开时一次性构建的 innerHTML，注册发生在它打开之后时不会自动出现。
   * 这里只处理「已打开」这一种情况：整块替换掉带 data-codex-plus-ext-menu 的容器。
   * 菜单没打开时什么都不做——下次打开自然会带上。
   */
  function refreshCodexPlusExtensionMenu() {
    const overlay = document.querySelector(".codex-plus-modal-overlay, .codex-plus-page-overlay");
    if (!overlay) return;
    const panel = overlay.querySelector('[data-codex-plus-panel="home"]');
    if (!panel) return;
    panel.querySelector("[data-codex-plus-ext-menu]")?.remove();
    const markup = renderCodexPlusExtensionMenuRows();
    if (markup) panel.insertAdjacentHTML("beforeend", markup);
  }

  /** 会话行按钮重画：让扫描在下一轮把这些行重建，从而带上拓展的项。 */
  function refreshExtensionSessionRows() {
    try {
      sessionRows().forEach((row) => {
        const group = actionGroupFromRow(row);
        if (group) delete group.dataset.codexActionLayoutStable;
        // 「…」按钮只在有菜单项时出现：拓展注册 / 注销会话行操作后立刻按新指纹
        // 重建（或摘掉）这一行的按钮组，不用等下一次扫描。
        tryAttachButton(row);
      });
      archivedPageRows().forEach(attachArchivedPageDeleteButton);
    } catch {}
  }

  /**
   * 注册一个整页视图，并自动配一个图标栏入口。
   *
   * 用户拓展采用「rail 入口 + 整页」的形态。抽成独立函数是因为
   * codexPlus.registerPage 与插件内核的 ctx.registerPage 共用这一套逻辑。
   */
  function codexPlusRegisterExtensionPage(definition, options = {}) {
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const pageId = `${scriptKey}:page:${options.id || codexPlusExtensionIdSeed()}`;
    const disposePage = registerCodexPlusExtension("page", codexPlusRegistry.pages, pageId, definition, scriptKey);
    // 入口与页面成对存在：页面没了，入口也该消失，否则点了没有任何反应。
    const entry = {
      ...definition,
      label: options.navLabel || definition.navLabel || definition.title || pageId,
      icon: options.icon || definition.icon,
      pageId,
      order: Math.max(1000, Number.isFinite(options.order) ? Number(options.order) : 0),
    };
    const navId = `${scriptKey}:navEntry:${pageId}`;
    let disposeNav = null;
    try {
      // options.nav === false：只要页面、不要图标栏入口（例如从 Codex 设置页里打开的拓展分区）。
      if (options.nav !== false) disposeNav = registerCodexPlusExtension("navEntry", codexPlusRegistry.navEntries, navId, entry, scriptKey);
    } catch {
      // 入口注册失败（配额满）时页面本身仍可用，不要回滚已成功的页面注册。
    }
    codexPlusRefreshExtensionHosts();
    return () => {
      try {
        disposeNav?.();
      } catch {}
      disposePage();
      codexPlusRefreshExtensionHosts();
    };
  }

  /**
   * 构建对外对象。
   *
   * 拆成函数而不是直接字面量，是为了让 99-tail 之前的挂载点能按顺序装配：
   * 依赖的函数都已在同一闭包里，此处只做引用。
   */
  function buildCodexPlusExtensionApi() {
    return {
      version: codexPlusExtensionAdapterVersion,
      apiVersion: codexPlusExtensionApiVersion,
      constants: codexPlusExtensionConstants,
      // 用 getter 而不是快照：脚本初始化结束后再读也能拿到自己的 key。
      get script() {
        const key = codexPlusCurrentExtensionScriptKey();
        return { key, manifest: codexPlusExtensionManifest(key) };
      },

      /** 创建一个拓展实例：ctx 上的注册都随实例卸载自动撤销，见 91-extension-runtime.js。 */
      extension: codexPlusCreateExtension,
      /** 早期名称。已有拓展（包括对话里生成的）在用，保留为别名。 */
      plugin: codexPlusCreateExtension,

      /** 当前已提供的服务：[{ name, owner }]。取值请在拓展里 inject 或 ctx.get。 */
      services() {
        return [...codexPlusServices.entries()].map(([name, entry]) => ({ name, owner: entry.owner }));
      },

      /** 当前打开的 Codex 会话 id；首页、新对话还没有 id 时为空串。 */
      currentSessionId() {
        return codexPlusCurrentSessionId();
      },
      /**
       * 当前打开的 Codex 会话：{ id, title, hostId, remote }。hostId 是会话所在的主机（本机为 "local"），
       * remote 表示远程 / SSH 会话（本机会话日志里没有它的用量）。没有会话时 id 为空串。
       */
      currentSession() {
        const ref = typeof currentSessionRef === "function" ? currentSessionRef() || {} : {};
        const hostId = String(ref.host_id || "local");
        return Object.freeze({ id: String(ref.session_id || ""), title: String(ref.title || ""), hostId, remote: hostId !== "local" });
      },

      /** 内置拓展的现状：[{ id, name, active, disabled, replacedBy }]。见 96-builtin-extensions.js。 */
      builtins() {
        return codexPlusBuiltinExtensionList();
      },

      /** 显示提示。type: info | success | warn | error */
      toast(message, options) {
        return runCodexPlusExtensionCallback(
          codexPlusCurrentExtensionScriptKey(),
          "toast",
          () => showToast(String(message ?? ""), options || {}),
        );
      },

      /** 调用后端白名单路由，失败时 reject。 */
      call: codexPlusExtensionCall,

      /**
       * 注册斜杠命令：在输入框输入「/name 参数」回车时调用 run(args, { editor, insertText, setText, toast })，
       * 输入框随后清空；输入「/」时在输入框上方提示匹配的拓展命令，Tab 补全。
       */
      registerCommand(definition, options = {}) {
        return codexPlusRegisterExtensionCommand(definition, options);
      },

      /**
       * 在输入区（发送按钮所在那一行）加一个图标按钮。
       * onActivate({ editor, insertText, close }) 中 insertText(text) 把文字插入当前输入框。
       */
      registerComposerAction(definition, options = {}) {
        return codexPlusRegisterExtensionItem("composerAction", codexPlusRegistry.composerActions, definition, options);
      },

      /**
       * 在每条对话消息的操作行（复制、编辑按钮旁）加一个图标按钮。
       * roles 限定 "user" / "assistant"；visible(message) 返回 false 时这条消息不显示；
       * onActivate({ message, close }) 里 message = { role, id, turnId, conversationId, text, element }。
       */
      registerMessageAction(definition, options = {}) {
        return codexPlusRegisterExtensionItem("messageAction", codexPlusRegistry.messageActions, definition, options);
      },

      /**
       * 在每条对话消息的正文下方挂一块内容：render({ message, container }) 往 container 里画。
       * 消息文字变化（流式输出）时会清空 container 重新调用；container 留空则不占位。
       */
      registerMessageDecoration(definition, options = {}) {
        return codexPlusRegisterExtensionItem("messageDecoration", codexPlusRegistry.messageDecorations, definition, options);
      },

      /**
       * 注册右侧面板：顶栏右侧出现一个开关按钮，打开时 Codex 主区域往左让出面板宽度。
       * render({ container, close }) 每次打开都调用，可返回清理函数（关闭时调用）。
       * 返回的撤销函数上带 open() / close() / toggle()。
       */
      registerSidePanel(definition, options = {}) {
        return codexPlusRegisterExtensionSidePanel(definition, options);
      },

      /**
       * 往 Codex 界面的固定位置放内容：slot 为 composer.above、thread.top、thread.bottom、sidebar.top、
       * sidebar.bottom、titlebar。render({ container, slot }) 在容器新建时调用（Codex 重建 DOM 后会再调），
       * 可返回清理函数。返回的撤销函数上带 refresh() 强制重画。
       */
      registerInputTrigger(definition, options = {}) {
        return codexPlusRegisterInputTrigger(definition, options);
      },
      registerShortcut(definition, options = {}) {
        return codexPlusRegisterShortcut(definition, options);
      },
      registerTheme(definition, options = {}) {
        return codexPlusRegisterTheme(definition, options);
      },
      ask(question) {
        return codexPlusAsk(question);
      },
      registerSlot(definition, options = {}) {
        return codexPlusRegisterExtensionSlot(definition, options);
      },
      /** 右下角悬浮球面板里加一个页签：render({ container, close })，可返回清理函数。 */
      registerFloatingTab(definition, options = {}) {
        return codexPlusRegisterFloatingTab(definition, options);
      },
      /** 对话里的工具调用 / 命令条目末尾挂内容：tools / kinds 过滤，render({ container, call })。 */
      registerToolView(definition, options = {}) {
        return codexPlusRegisterToolView(definition, options);
      },
      /** Codex 设置页左侧导航末尾加一项，点开是 render({ container, close }) 画的页面。 */
      registerSettingsSection(definition, options = {}) {
        return codexPlusRegisterSettingsSection(definition, options);
      },

      /** 在会话行「更多操作」里加一项。 */
      registerRowAction(definition, options = {}) {
        return codexPlusRegisterExtensionItem("rowAction", codexPlusRegistry.rowActions, definition, options);
      },

      /** 加一个图标栏入口（点击后走 registerPage 注册的页面）。 */
      registerNavEntry(definition, options = {}) {
        return codexPlusRegisterExtensionItem("navEntry", codexPlusRegistry.navEntries, definition, options);
      },

      /**
       * 在 Codex Pilot 菜单的「主页」面板里加一行。
       *
       * 两种形态，按 definition 里给的字段决定：
       *   - 开关：给 `onChange(next)`，可选 `toggleValue()` 提供当前值
       *   - 按钮：给 `onActivate({ close })`
       *
       * 这些是 Codex Pilot 自己的设置面板，改动会立刻反映到当前打开的菜单上；
       * 菜单重新打开时会从 `toggleValue()` 重新读一次状态。
       */
      registerMenuItem(definition, options = {}) {
        return codexPlusRegisterExtensionItem("menuItem", codexPlusRegistry.menuItems, definition, options);
      },

      /**
       * 注册一个整页视图。
       *
       * 同时自动配一个图标栏入口。
       * `options.navLabel` / `options.icon` 控制入口外观。
       *
       * render 每次打开都被重新调用，不要缓存 DOM（见本文件顶部的生命周期约定）。
       */
      registerPage(definition, options = {}) {
        return codexPlusRegisterExtensionPage(definition, options);
      },

      /** 注册清理函数，热重载时逆序执行。 */
      onCleanup(cleanup) {
        return window.__codexPlusUserScripts?.registerCleanup?.(cleanup);
      },

      /** 主动上报失败，供异步阶段的错误使用（同步阶段由 wrap_script 捕获）。 */
      fail(error) {
        codexPlusMarkExtensionFailure(
          window.__codexPlusUserScripts?.currentKey,
          String(error?.stack || error?.message || error),
        );
      },
    };
  }
  /**
   * 拓展运行时内核：codexPlus.extension(apply)
   *
   * 在 register* 之上加一层「拓展实例」：ctx 上的每一次注册（UI 项、事件监听、
   * 中间件、DOM 监听、定时器、自定义副作用）都绑定到实例的寿命上，卸载时按注册
   * 逆序自动撤销。拓展作者不必再自己维护 dispose 列表，热重载也不会残留旧实例。
   *
   * 两种拓展间耦合方式：
   *   - 事件：ctx.on / ctx.emit，一对多通知，处理器抛错互不影响
   *   - waterfall：ctx.intercept / ctx.waterfall，中间件链，handler(value, next)
   *     调 next(v) 交给下一个，不调即短路；没有中间件时原样返回
   *
   * 宿主后续会在协议层、界面层的关键点调用 codexPlusRunWaterfall /
   * codexPlusEmitExtensionEvent，拓展用同一套 ctx 接口挂上去。
   *
   * 和 91-extension-api.js 一样只做定义、不读 DOM，挂载在 99-startup。
   */

  /** 事件名 → 监听者集合。监听者带 scriptKey，出错时记到对应脚本。 */
  const codexPlusExtensionListeners = new Map();
  /** 中间件链名 → 中间件数组，按 order、再按注册先后排序。 */
  const codexPlusExtensionInterceptors = new Map();
  let codexPlusExtensionInterceptorSeq = 0;
  /** 存活的拓展实例，供诊断查看。 */
  const codexPlusExtensionInstances = new Set();

  /**
   * 拓展间服务。名字是一个扁平命名空间：ctx.provide(name, value) 提供，声明了 inject 的拓展
   * 在依赖齐全时才应用；提供者卸载或被替换时，依赖方先卸载、回到挂起，提供者回来后自动
   * 重新应用。内置服务（如 sessionQuery）由 Codex Pilot 提供，归属为 "builtin"。
   */
  const codexPlusServices = new Map();
  let codexPlusServiceSeq = 0;
  /** 等待依赖或依赖服务的拓展（生命周期句柄），服务变化时逐个复查。 */
  const codexPlusServiceFibers = new Set();
  const codexPlusServiceNamePattern = /^[A-Za-z][\w.-]{0,63}$/;

  function codexPlusNormalizeInject(inject) {
    if (!inject) return [];
    const names = Array.isArray(inject) ? inject : typeof inject === "object" ? Object.keys(inject) : [inject];
    return [...new Set(names.map(String).filter((name) => codexPlusServiceNamePattern.test(name)))];
  }

  /** 必需依赖：对象写法里 { name: { required: false } } 是可选依赖，缺了也应用，变了照样重载。 */
  function codexPlusRequiredInject(inject) {
    if (!inject || Array.isArray(inject) || typeof inject !== "object") return codexPlusNormalizeInject(inject);
    return codexPlusNormalizeInject(Object.keys(inject).filter((name) => inject[name]?.required !== false));
  }

  /**
   * 管理器保存拓展配置后先调这里：这个拓展的所有实例都接住新配置时返回 "applied"，否则 "reload"（由管理器整体热重载）。
   * 多实例时每份叠上自己实例的配置。
   */
  function codexPlusUpdateExtensionConfig(scriptKey, nextConfig) {
    const instances = [...codexPlusExtensionInstances].filter((ctx) => ctx.scriptKey === scriptKey && !ctx.disposed);
    if (!instances.length) return "reload";
    for (const ctx of instances) {
      const merged = ctx.instance ? { ...nextConfig, ...(ctx.manifest?.instance?.config ?? ctx.manifest?.instances?.find?.((item) => item.id === ctx.instance.id)?.config ?? {}) } : nextConfig;
      if (!ctx.__tryConfigUpdate(merged)) return "reload";
    }
    const script = window.__codexPlusUserScripts?.scripts?.[scriptKey];
    if (script?.manifest) script.manifest = { ...script.manifest, config: nextConfig };
    return "applied";
  }
  if (typeof window !== "undefined") {
    window.__codexPlusUserScripts ||= { scripts: {} };
    window.__codexPlusUserScripts.updateConfig = codexPlusUpdateExtensionConfig;
  }

  function codexPlusServiceChanged() {
    for (const fiber of [...codexPlusServiceFibers]) {
      try {
        fiber.check();
      } catch {}
    }
  }

  function codexPlusProvideService(name, value, owner) {
    if (!codexPlusServiceNamePattern.test(String(name))) throw new Error(`服务名不合法：${name}`);
    const existing = codexPlusServices.get(name);
    if (existing) throw new Error(`服务 ${name} 已由 ${existing.owner || "其它拓展"} 提供`);
    const entry = { value, owner, token: ++codexPlusServiceSeq };
    codexPlusServices.set(name, entry);
    codexPlusServiceChanged();
    return () => {
      if (codexPlusServices.get(name) !== entry) return;
      codexPlusServices.delete(name);
      codexPlusServiceChanged();
    };
  }

  /** 内置的只读会话查询服务：方法名与参数对齐会话查询接口，经桥接转到 Codex Pilot。 */
  function codexPlusSessionQueryService() {
    const invoke = (method, params) => {
      const bridge = window.__codexSessionDeleteBridge;
      if (typeof bridge !== "function") return Promise.reject(new Error("Codex 页面尚未连接，请稍后重试"));
      return Promise.resolve(bridge("/extensions/history", { method, params: params ?? null })).then((result) => {
        if (result?.status === "failed" || result?.error) throw new Error(result.message || result.error || `${method} 调用失败`);
        return result?.result;
      });
    };
    const withId = (method) => (id, options) => invoke(method, { id, options: options ?? {} });
    const readSession = (id) => invoke("readSession", { id });
    const readEventsSince = (query) => invoke("readEventsSince", query ?? {});
    return Object.freeze({
      listSessions: (options) => invoke("listSessions", options ?? {}),
      filterSessions: (filters) => invoke("filterSessions", filters ?? {}),
      readSession,
      readTitle: (id) => invoke("readTitle", { id }),
      listEvents: withId("listEvents"),
      filterEvents: withId("filterEvents"),
      readEvent: (query) => invoke("readEvent", query ?? {}),
      readEventsSince,
      searchSessions: (query) => invoke("searchSessions", query ?? {}),
      searchEvents: (query) => invoke("searchEvents", query ?? {}),
      /** 把会话事件日志折叠成状态：apply(state, event) 返回新状态（返回 undefined 视为不变）。 */
      async project(id, { init, apply } = {}) {
        if (typeof apply !== "function") throw new Error("project 需要 apply(state, event)");
        const { events } = await readSession(id);
        let state = typeof init === "function" ? init() : init;
        for (const event of events) {
          const next = apply(state, event);
          if (next !== undefined) state = next;
        }
        return state;
      },
      /**
       * 订阅会话的新事件：按 intervalMs（默认 2 秒）增量读取，handler(event) 逐条收到。
       * 默认从当前末尾开始（不回放历史），fromSeq 指定起点。返回撤销函数。
       */
      /** 订阅全部会话的新事件：handler(event, { sessionId })，返回撤销函数。等同 ctx.on("session/event")。 */
      observeAll(handler) {
        if (typeof handler !== "function") throw new Error("observeAll 需要 handler(event, { sessionId })");
        const listener = { handler, scriptKey: "builtin:sessionQuery" };
        if (!codexPlusExtensionListeners.has("session/event")) codexPlusExtensionListeners.set("session/event", new Set());
        codexPlusExtensionListeners.get("session/event").add(listener);
        codexPlusEnsureSessionWatcher();
        return () => {
          const listeners = codexPlusExtensionListeners.get("session/event");
          listeners?.delete(listener);
          if (listeners && !listeners.size) codexPlusExtensionListeners.delete("session/event");
        };
      },
      observeSession(id, handler, options = {}) {
        if (typeof handler !== "function") throw new Error("observeSession 需要 handler(event)");
        let stopped = false;
        let next = Number.isFinite(options.fromSeq) ? Number(options.fromSeq) : null;
        let timer = null;
        const interval = Math.max(500, Number(options.intervalMs) || 2000);
        const tick = async () => {
          if (stopped) return;
          try {
            if (next === null) {
              const tail = await invoke("listEvents", { id, options: { fromEnd: true, limit: 1 } });
              next = tail.length ? tail[0].seq + 1 : 0;
            } else {
              const events = await readEventsSince({ sessionId: id, seq: next, limit: 200 });
              for (const event of events) {
                if (stopped) return;
                next = event.seq + 1;
                try { handler(event); } catch {}
              }
            }
          } catch {}
          if (!stopped) timer = setTimeout(tick, interval);
        };
        void tick();
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      },
    });
  }

  /**
   * 会话写入：经 Codex 自己的 AppServerManager 调 app-server。
   *
   * 新版 Codex 在页面里用 `scope.get(管理器原子).forHost(hostId).sendRequest(method, params)` 发请求；原子是入口
   * 模块的一个导出（名字随构建变），这里按「scope.get 出来的值带 forHost」把它找出来并缓存。scope 取自任意
   * 带 React fiber 的界面节点，每次调用现取（界面重建后旧 scope 会失效）。只开放下面几个方法，不开放删除等。
   */
  const codexPlusSessionMethods = {
    list: "thread/list",
    create: "thread/start",
    fork: "thread/fork",
    rename: "thread/name/set",
    append: "thread/inject_items",
    startTurn: "turn/start",
    steer: "turn/steer",
    interrupt: "turn/interrupt",
    compact: "thread/compact/start",
  };
  let codexPlusManagerAtom = null;

  function codexPlusFindAppScope() {
    const candidates = document.querySelectorAll("[data-app-action-sidebar-thread-id], [data-codex-composer-root], main, aside");
    for (const node of candidates) {
      const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactFiber$"));
      let fiber = key ? node[key] : null;
      for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
        let hook = fiber.memoizedState;
        for (let index = 0; hook && index < 64; index += 1, hook = hook.next) {
          const scope = hook.memoizedState?.current;
          if (scope && typeof scope.get === "function" && scope.node) return scope;
        }
      }
    }
    return null;
  }

  async function codexPlusAppServerClient(hostId = "local") {
    const scope = codexPlusFindAppScope();
    if (!scope) throw new Error("Codex 界面还没准备好，稍后再试");
    const managerFrom = (atom) => {
      try {
        const manager = scope.get(atom);
        return manager && typeof manager.forHost === "function" ? manager : null;
      } catch {
        return null;
      }
    };
    let manager = codexPlusManagerAtom ? managerFrom(codexPlusManagerAtom) : null;
    if (!manager) {
      const module = await loadOptionalCodexAppModule("app-initial-");
      for (const value of Object.values(module || {})) {
        if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
        manager = managerFrom(value);
        if (manager) {
          codexPlusManagerAtom = value;
          break;
        }
      }
    }
    if (!manager) throw new Error("没有找到 Codex 的 app-server 连接（Codex 版本不兼容）");
    return manager.forHost(hostId);
  }

  /** 把 append 的条目整理成 app-server 的 ResponseItem：字符串当作用户消息，{ role, text } 按角色转成消息。 */
  function codexPlusSessionItem(entry) {
    if (typeof entry === "string") return { type: "message", role: "user", content: [{ type: "input_text", text: entry }] };
    if (entry && typeof entry === "object" && typeof entry.type === "string") return entry;
    const role = entry?.role === "assistant" || entry?.role === "developer" ? entry.role : "user";
    return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: String(entry?.text ?? "") }] };
  }

  /** 按方法名调用会话写入；params 形状见 codexPlusSessionsService。也给 Codex Pilot 进程经 CDP 调（后台、工具）。 */
  async function codexPlusSessionsCall(name, params = {}) {
    const method = codexPlusSessionMethods[name];
    if (!method) throw new Error(`会话服务没有方法 ${name}`);
    const client = await codexPlusAppServerClient(params.hostId || "local");
    switch (name) {
      case "list":
        return client.sendRequest(method, { limit: params.limit ?? 50, ...(params.cursor ? { cursor: params.cursor } : {}), ...(params.archived ? { archived: true } : {}) });
      case "fork":
        return (await client.sendRequest(method, { threadId: String(params.id), ...(params.options || {}) }))?.thread ?? null;
      case "append": {
        const items = (Array.isArray(params.items) ? params.items : [params.items]).map(codexPlusSessionItem);
        await client.sendRequest(method, { threadId: String(params.id), items });
        return { appended: items.length };
      }
      case "startTurn": {
        const input = typeof params.input === "string" ? [{ type: "text", text: params.input }] : params.input;
        if (!Array.isArray(input) || !input.length) throw new Error("startTurn 需要输入文字");
        return (await client.sendRequest(method, { threadId: String(params.id), input, ...(params.options || {}) }))?.turn ?? null;
      }
      case "interrupt": {
        // 没给 turnId 时取会话里正在跑的那一轮（dsh 的 agent.cancel 只知道会话）。
        let turnId = String(params.turnId || "");
        if (!turnId) {
          const read = await client.sendRequest("thread/read", { threadId: String(params.id), includeTurns: true });
          const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
          const running = [...turns].reverse().find((turn) => /^in[_-]?progress$/i.test(String(turn?.status?.type ?? turn?.status ?? "")));
          turnId = String(running?.id ?? "");
          if (!turnId) return { interrupted: false, reason: "会话里没有正在进行的一轮" };
        }
        return client.sendRequest(method, { threadId: String(params.id), turnId });
      }
      case "create":
        // 新建会话；给了 input 时紧接着发起第一轮。
        {
          const thread = (await client.sendRequest(method, { ...(params.options || {}) }))?.thread ?? null;
          if (thread?.id && params.input) {
            const turn = await codexPlusSessionsCall("startTurn", { id: thread.id, input: params.input, hostId: params.hostId });
            return { thread, turn };
          }
          return { thread, turn: null };
        }
      case "rename":
        if (!String(params.name || "").trim()) throw new Error("rename 需要新名字");
        return client.sendRequest(method, { threadId: String(params.id), name: String(params.name).trim() });
      case "steer": {
        // 会话正忙时往当前这一轮插话。
        const input = typeof params.input === "string" ? [{ type: "text", text: params.input }] : params.input;
        if (!Array.isArray(input) || !input.length) throw new Error("steer 需要输入文字");
        return client.sendRequest(method, { threadId: String(params.id), input, ...(params.turnId ? { expectedTurnId: String(params.turnId) } : {}) });
      }
      case "compact":
        return client.sendRequest(method, { threadId: String(params.id) });
      default:
        throw new Error(`会话服务没有方法 ${name}`);
    }
  }

  /** 内置的会话写入服务（inject: ["sessions"]）：新建、分叉、改名、追加条目、发起 / 插话 / 中断一轮、压缩。读请用 sessionQuery。 */
  function codexPlusSessionsService() {
    return Object.freeze({
      list: (options = {}) => codexPlusSessionsCall("list", options),
      create: (input, options) => codexPlusSessionsCall("create", { input, options }),
      fork: (id, options) => codexPlusSessionsCall("fork", { id, options }),
      rename: (id, name) => codexPlusSessionsCall("rename", { id, name }),
      append: (id, items) => codexPlusSessionsCall("append", { id, items }),
      startTurn: (id, input, options) => codexPlusSessionsCall("startTurn", { id, input, options }),
      steer: (id, input, turnId) => codexPlusSessionsCall("steer", { id, input, turnId }),
      interrupt: (id, turnId) => codexPlusSessionsCall("interrupt", { id, turnId }),
      compact: (id) => codexPlusSessionsCall("compact", { id }),
    });
  }

  function installCodexPlusBuiltinServices() {
    window.__codexPlusSessionsCall = codexPlusSessionsCall;
    // 后台、工具、钩子经 CDP 调：window.__codexPlusUiCall("ask", 参数)。
    window.__codexPlusUiCall = (name, params) => {
      if (name === "ask") return codexPlusAsk(params || {});
      if (name === "toast") return showToast(String(params?.message ?? ""), params?.options || {}), true;
      throw new Error(`界面服务没有方法 ${name}`);
    };
    if (!codexPlusServices.has("themes") && typeof codexPlusThemesService === "function") codexPlusProvideService("themes", codexPlusThemesService(), "builtin");
    if (!codexPlusServices.has("sessions")) codexPlusProvideService("sessions", codexPlusSessionsService(), "builtin");
    if (!codexPlusServices.has("sessionQuery")) codexPlusProvideService("sessionQuery", codexPlusSessionQueryService(), "builtin");
    // 全局的多语言服务：写成 inject: ["locale"] 的拓展也能用（ctx.locale 是按实例自动撤销的同一套接口）。
    if (!codexPlusServices.has("locale")) {
      codexPlusProvideService("locale", Object.freeze({
        get current() {
          return codexPlusCurrentLocale();
        },
        register(ns, langOrDicts, dict) {
          if (typeof langOrDicts === "string") return codexPlusRegisterLocale(String(ns), langOrDicts, dict);
          const disposers = Object.entries(langOrDicts || {}).map(([lang, value]) => codexPlusRegisterLocale(String(ns), lang, value));
          return () => disposers.forEach((dispose) => dispose());
        },
        bind: (ns) => (key, params) => codexPlusTranslate(String(ns), key, params),
        resolve: codexPlusResolveText,
      }), "builtin");
    }
    installCodexPlusLocaleWatcher();
    window.__codexPlusSyncBackendServices = syncCodexPlusBackendServices;
    syncCodexPlusBackendServices();
  }

  /**
   * 拓展后台声明的服务（codexpp.json 的 backend.provides）：登记成页面服务，值是一个代理，
   * 调用任意方法都经桥接转给提供方后台（没起就先起）。清单随注入包下发，热重载时增删。
   * 页面里已有同名服务时以页面的为准。
   */
  const codexPlusBackendServiceEntries = new Map();

  function codexPlusBackendServiceProxy(name) {
    return new Proxy({}, {
      get: (_, method) => (typeof method !== "string" || method === "then") ? undefined : (...args) => {
        const bridge = window.__codexSessionDeleteBridge;
        if (typeof bridge !== "function") return Promise.reject(new Error("Codex 页面尚未连接，请稍后重试"));
        return Promise.resolve(bridge("/extensions/services/call", { name, method, args })).then((result) => {
          if (result?.status === "failed" || result?.error) throw new Error(result.message || result.error || `${name}.${method} 调用失败`);
          return result?.result;
        });
      },
    });
  }

  function syncCodexPlusBackendServices() {
    const list = Array.isArray(window.__codexPlusBackendServices) ? window.__codexPlusBackendServices : [];
    const wanted = new Map(
      list
        .filter((item) => item && codexPlusServiceNamePattern.test(String(item.name)))
        .map((item) => [String(item.name), String(item.key || "")]),
    );
    for (const [name, entry] of [...codexPlusBackendServiceEntries]) {
      if (wanted.get(name) === entry.key) continue;
      codexPlusBackendServiceEntries.delete(name);
      entry.dispose();
    }
    for (const [name, key] of wanted) {
      if (codexPlusBackendServiceEntries.has(name) || codexPlusServices.has(name)) continue;
      try {
        const dispose = codexPlusProvideService(name, codexPlusBackendServiceProxy(name), `backend:${key}`);
        codexPlusBackendServiceEntries.set(name, { key, dispose });
      } catch {}
    }
  }

  /**
   * 多语言：词条按命名空间登记（同一命名空间可多次登记，后登记的优先）。查找顺序：当前语言 →
   * 主语言（zh-CN → zh）→ en，先在指定命名空间，再在 common；都没有就返回 key 本身。
   * 占位符写成 {name}。拓展包 locale/<语言>.json 自动登记到「拓展 id」命名空间。
   */
  const codexPlusLocaleEntries = new Map();
  const codexPlusFallbackLocale = "en";

  function codexPlusCurrentLocale() {
    const raw = (typeof document !== "undefined" && document.documentElement?.lang) || globalThis.navigator?.language || codexPlusFallbackLocale;
    return String(raw).trim() || codexPlusFallbackLocale;
  }

  function codexPlusLocaleChain(locale = codexPlusCurrentLocale()) {
    const exact = String(locale);
    const primary = exact.split(/[-_]/)[0].toLowerCase();
    return [...new Set([exact, exact.toLowerCase(), primary, codexPlusFallbackLocale])];
  }

  function codexPlusRegisterLocale(ns, lang, dict) {
    if (!dict || typeof dict !== "object") throw new Error(`词条必须是对象：${ns}/${lang}`);
    const entry = { lang: String(lang), dict };
    if (!codexPlusLocaleEntries.has(ns)) codexPlusLocaleEntries.set(ns, []);
    codexPlusLocaleEntries.get(ns).unshift(entry);
    return () => {
      const list = codexPlusLocaleEntries.get(ns) || [];
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (!list.length) codexPlusLocaleEntries.delete(ns);
    };
  }

  function codexPlusLocaleLookup(dict, key) {
    if (typeof dict[key] === "string") return dict[key];
    let node = dict;
    for (const part of String(key).split(".")) {
      if (!node || typeof node !== "object") return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  }

  function codexPlusTranslate(ns, key, params) {
    const chain = codexPlusLocaleChain();
    let text;
    for (const space of [ns, "common"]) {
      const list = codexPlusLocaleEntries.get(space);
      if (!list) continue;
      for (const lang of chain) {
        for (const entry of list) {
          if (entry.lang.toLowerCase() !== lang.toLowerCase()) continue;
          text = codexPlusLocaleLookup(entry.dict, key);
          if (text !== undefined) break;
        }
        if (text !== undefined) break;
      }
      if (text !== undefined) break;
    }
    if (text === undefined) text = String(key);
    if (!params || typeof params !== "object") return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
  }

  /** 解析 { en, zh, ... } 形式的多语言文本；本身是字符串就原样返回。 */
  function codexPlusResolveText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);
    for (const lang of codexPlusLocaleChain()) {
      const hit = Object.keys(value).find((key) => key.toLowerCase() === lang.toLowerCase());
      if (hit && typeof value[hit] === "string") return value[hit];
    }
    const first = Object.values(value).find((item) => typeof item === "string");
    return first ?? "";
  }

  /** 页面语言变化时广播 locale/change（参数 { locale }）。 */
  let codexPlusLocaleWatcherInstalled = false;
  function installCodexPlusLocaleWatcher() {
    if (codexPlusLocaleWatcherInstalled || typeof MutationObserver !== "function" || !document?.documentElement) return;
    codexPlusLocaleWatcherInstalled = true;
    let last = codexPlusCurrentLocale();
    new MutationObserver(() => {
      const next = codexPlusCurrentLocale();
      if (next === last) return;
      last = next;
      codexPlusEmitExtensionEvent("locale/change", [{ locale: next }]);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  /** 拓展包的清单（Rust 侧写进脚本状态记录）；单文件脚本没有清单。 */
  function codexPlusExtensionManifest(scriptKey) {
    const manifest = window.__codexPlusUserScripts?.scripts?.[scriptKey]?.manifest;
    if (!manifest || typeof manifest !== "object") return null;
    // 给拓展一份副本，避免它改到状态记录里的原件。
    try {
      return JSON.parse(JSON.stringify(manifest));
    } catch {
      return null;
    }
  }

  function codexPlusIsThenable(value) {
    return !!value && typeof value.then === "function";
  }

  /**
   * 全部会话的事件流：有拓展监听 `session/event` / `agent/status` 时，按会话更新时间增量读 rollout，
   * 把新事件逐条发出去。新版 Codex 的通知不经过页面，rollout 是页面能拿到的唯一完整来源。
   *   - `session/event`：(event, { sessionId })，event 形状同 sessionQuery 的事件日志
   *   - `agent/status`：({ sessionId, status: "running" | "idle" | "aborted", turn, reason? })
   *   - 更细的通知（agent 只是 { id, session: { id } } 描述，没有 steer / inject）：
   *     `tools/result`：(exec { callId, name, arguments }, result { isError: false, content })，工具结果写进会话时；
   *     `agent/created`：({ agent, source: "startup" })，观察开始后新出现的会话；
   *     `agent/error`：({ agent, turn, error })，一轮被中止（turn/aborted）时
   * 没人监听时自动停；监听开始前已有的事件不重放，之后新建的会话从头发。
   */
  const codexPlusSessionWatchEvents = ["session/event", "agent/status", "tools/result", "agent/created", "agent/error"];
  let codexPlusSessionWatcher = null;

  function codexPlusWantsSessionWatch() {
    return codexPlusSessionWatchEvents.some((event) => codexPlusExtensionListeners.get(event)?.size);
  }

  function codexPlusSessionStatusOf(event) {
    if (event.type === "turn/start") return { status: "running", turn: event.data?.turn };
    if (event.type === "turn/complete") return { status: "idle", turn: event.data?.turn };
    if (event.type === "turn/aborted") return { status: "aborted", turn: event.data?.turn, reason: event.data?.reason ?? null };
    return null;
  }

  function codexPlusEnsureSessionWatcher() {
    if (codexPlusSessionWatcher || !codexPlusWantsSessionWatch()) return;
    const query = codexPlusSessionQueryService();
    const cursors = new Map();
    // callId → { name, arguments }：tools/result 要带上调用时的工具名与参数。
    const calls = new Map();
    let primed = false;
    const tick = async () => {
      if (!codexPlusWantsSessionWatch()) {
        codexPlusSessionWatcher = null;
        return;
      }
      try {
        const sessions = await query.listSessions({ limit: 20 });
        for (const [index, session] of (sessions || []).entries()) {
          let cursor = cursors.get(session.id);
          if (!cursor) {
            if (primed) codexPlusEmitExtensionEvent("agent/created", [{ agent: codexPlusAgentDescriptor(session.id), source: "startup" }]);
            let next = 0;
            if (!primed) {
              const tail = await query.listEvents(session.id, { fromEnd: true, limit: 1 }).catch(() => []);
              next = tail.length ? tail[0].seq + 1 : 0;
            }
            cursor = { updatedAt: primed ? null : session.updatedAt, next };
            cursors.set(session.id, cursor);
            if (!primed) continue;
          }
          // 最近的几个会话每轮都看（更新时间精度只到秒），其余按更新时间变化再读。
          if (index >= 3 && cursor.updatedAt === session.updatedAt) continue;
          cursor.updatedAt = session.updatedAt;
          const events = await query.readEventsSince({ sessionId: session.id, seq: cursor.next, limit: 200 }).catch(() => []);
          for (const event of events || []) {
            cursor.next = event.seq + 1;
            codexPlusEmitExtensionEvent("session/event", [event, { sessionId: session.id }]);
            const status = codexPlusSessionStatusOf(event);
            if (status) codexPlusEmitExtensionEvent("agent/status", [{ sessionId: session.id, ...status }]);
            codexPlusEmitSessionNotices(session.id, event, calls);
          }
        }
        primed = true;
      } catch {}
      codexPlusSessionWatcher = setTimeout(tick, document.hidden ? 5000 : 1500);
    };
    codexPlusSessionWatcher = setTimeout(tick, 0);
  }

  /** 页面通知里的 agent 描述：只有会话 id，不能往会话里插话。 */
  function codexPlusAgentDescriptor(sessionId) {
    return Object.freeze({ id: sessionId, session: Object.freeze({ id: sessionId }) });
  }

  /** 会话事件 → tools/result、agent/error 通知。calls 记着工具调用，工具结果到了再配对。 */
  function codexPlusEmitSessionNotices(sessionId, event, calls) {
    if (event.type === "tool/call") {
      calls.set(event.data?.callId, { name: event.data?.name ?? "", arguments: event.data?.input ?? "" });
      if (calls.size > 500) calls.delete(calls.keys().next().value);
      return;
    }
    if (event.type === "tool/result" && codexPlusExtensionListeners.get("tools/result")?.size) {
      const call = calls.get(event.data?.callId) || {};
      let parsed = call.arguments;
      try { parsed = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments; } catch {}
      const agent = codexPlusAgentDescriptor(sessionId);
      codexPlusEmitExtensionEvent("tools/result", [
        { callId: event.data?.callId ?? "", name: call.name ?? "", arguments: parsed, agent },
        { isError: false, value: event.data?.output ?? "", content: [{ type: "text", text: String(event.data?.output ?? "") }] },
      ]);
      return;
    }
    if (event.type === "turn/aborted") {
      codexPlusEmitExtensionEvent("agent/error", [{ agent: codexPlusAgentDescriptor(sessionId), turn: event.data?.turn, error: new Error(String(event.data?.reason ?? "aborted")) }]);
    }
  }

  /**
   * Codex Pilot 后台经 CDP 发给拓展的公开事件（只认 codexpp/ 前缀）。拓展用 ctx.on 订阅。
   */
  window.__codexPlusEmitHostEvent = (event, payload) => {
    if (typeof event !== "string" || !event.startsWith("codexpp/")) return false;
    codexPlusEmitExtensionEvent(event, [payload]);
    return true;
  };
  /** 通知所有监听者。逐个隔离：一个处理器抛错不影响其余。 */
  function codexPlusEmitExtensionEvent(event, args = []) {
    const listeners = codexPlusExtensionListeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      runCodexPlusExtensionCallback(listener.scriptKey, `on:${event}`, () => listener.handler(...args));
    }
  }

  /**
   * 跑一条中间件链。
   *
   * 中间件可以是异步的：返回 Promise 时整条链的结果也是 Promise。中间件抛错（或
   * reject）时跳过它——若它已经调过 next，沿用下游的结果，避免下游被执行两次。
   */
  function codexPlusRunWaterfall(name, value) {
    const chain = [...(codexPlusExtensionInterceptors.get(name) || [])];
    const step = (index, current) => {
      if (index >= chain.length) return current;
      const item = chain[index];
      let called = false;
      let downstream;
      const next = (nextValue = current) => {
        called = true;
        downstream = step(index + 1, nextValue);
        return downstream;
      };
      const recover = () => (called ? downstream : step(index + 1, current));
      const outcome = runCodexPlusExtensionCallback(item.scriptKey, `intercept:${name}`, () => item.handler(current, next));
      if (!outcome.ok) return recover();
      if (codexPlusIsThenable(outcome.value)) {
        return Promise.resolve(outcome.value).catch((error) => {
          codexPlusMarkExtensionFailure(item.scriptKey, `intercept:${name}: ${String(error?.stack || error?.message || error)}`);
          return recover();
        });
      }
      return outcome.value;
    };
    return step(0, value);
  }

  /**
   * Codex 会话事件：把 app-server 推给页面的通知转成拓展事件 `codex/<method>`。
   *
   * 复用 20-menu 找到的通知分发器（dispatcher.subscribe），只订阅一组固定的通知；
   * 没有拓展监听时 emit 只是一次 Map 查找。分发器换了（Codex 重建客户端）就重新订阅。
   */
  function installCodexExtensionEventBridge(dispatcher) {
    if (!dispatcher || typeof dispatcher.subscribe !== "function") return false;
    // 列表放在函数里：本函数可能在内核分片的常量初始化之前被调用（测试单独执行前面的分片），
    // 顶层 const 会落进暂时性死区。
    const events = [
      "thread/started",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "error",
      // 用量与等待用户的通知（Agent 桌宠拓展的大肥鱼用它显示本轮用量、等待审批 / 提问）。
      "thread/tokenUsage/updated",
      "item/tool/requestUserInput",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
      "serverRequest/resolved",
      "item/tool/userInputAnswered",
      "item/approval/responded",
    ];
    try {
      const current = window.__codexPlusExtensionEventBridge;
      if (current?.dispatcher === dispatcher) return true;
      try {
        current?.unsubscribe?.();
      } catch {}
      const unsubscribers = events.map((method) => {
        try {
          return dispatcher.subscribe(method, (params) => {
            // 转发失败（例如内核尚未初始化）不能影响 Codex 自己的通知处理。
            try {
              codexPlusEmitExtensionEvent(`codex/${method}`, [params, { method }]);
            } catch {}
          });
        } catch {
          return null;
        }
      });
      window.__codexPlusExtensionEventBridge = {
        dispatcher,
        unsubscribe: () => unsubscribers.forEach((unsubscribe) => {
          try {
            if (typeof unsubscribe === "function") unsubscribe();
          } catch {}
        }),
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 发往 Codex app-server 的请求中间件：`codex/request` 链，值为 `{ method, params }`。
   *
   * 两个接入点：新版 Codex 的请求走 app-server 客户端 sendRequest（异步，见
   * codexPlusApplyExtensionRequestMiddlewareAsync）；旧的消息分发路径走这里，是同步的，
   * 中间件返回 Promise 时视为出错并原样放行。没有中间件时原样返回同一个对象，
   * 调用方靠对象身份判断「是否改过」。method 不允许改。
   */
  function codexPlusApplyExtensionRequestMiddleware(method, params) {
    try {
      if (!codexPlusExtensionInterceptors.has("codex/request")) return params;
      const result = codexPlusRunWaterfall("codex/request", { method, params });
      if (codexPlusIsThenable(result)) {
        Promise.resolve(result).catch(() => {});
        codexPlusMarkExtensionFailure("", "codex/request 中间件必须同步返回，本次请求已原样发出");
        return params;
      }
      return result && typeof result === "object" && result.params !== undefined ? result.params : params;
    } catch {
      // 页面早期（内核尚未初始化）或中间件整体失败时，绝不能挡住 Codex 自己的请求。
      return params;
    }
  }

  /** 有拓展挂了 codex/request 中间件：需要 app-server 客户端补丁（以及它依赖的类捕获）。 */
  function codexPlusExtensionWantsRequestMiddleware() {
    try {
      return codexPlusExtensionInterceptors.has("codex/request");
    } catch {
      return false;
    }
  }

  /**
   * 异步版：app-server 客户端的 sendRequest 本身是异步的，这里允许中间件返回 Promise。
   * 出错或超时（5 秒）一律原样放行，绝不能让 Codex 自己的请求卡住。
   */
  async function codexPlusApplyExtensionRequestMiddlewareAsync(method, params) {
    if (!codexPlusExtensionWantsRequestMiddleware()) return params;
    try {
      const result = await Promise.race([
        Promise.resolve(codexPlusRunWaterfall("codex/request", { method, params })),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      return result && typeof result === "object" && result.params !== undefined ? result.params : params;
    } catch {
      return params;
    }
  }

  /**
   * 创建一个拓展实例并执行 apply(ctx)。
   *
   * definition 可以是 apply 函数本身，也可以是 { id, apply }。apply 同步抛错时
   * 先回滚它已经做过的注册，再把错误抛给调用方——脚本初始化期间调用的话，
   * wrap_script 会把该脚本标成 failed。异步 apply reject 时同样回滚并上报。
   *
   * 必须在脚本同步初始化期间调用才能接上热重载：此时内核向用户脚本运行时登记
   * 一个清理函数，重载前整体卸载。之后（await 之后）创建的实例只能靠 ctx.dispose()。
   */
  function codexPlusCreateExtension(definition, options = {}) {
    const apply = typeof definition === "function" ? definition : definition?.apply;
    if (typeof apply !== "function") throw new Error("拓展必须提供 apply(ctx) 函数");
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const packageManifest = codexPlusExtensionManifest(scriptKey);
    // 清单声明了 instances：同一个拓展按实例各应用一次（同 dsh 同一插件开多份），配置是包配置叠上实例配置。
    const instances = Array.isArray(packageManifest?.instances) ? packageManifest.instances : [];
    if (instances.length && !options.instance) {
      const handles = instances.map((instance) => codexPlusCreateExtension(definition, { ...options, scriptKey, instance }));
      return handles[0];
    }
    const instance = options.instance ?? null;
    const manifest = instance
      ? { ...packageManifest, instance: { id: String(instance.id), name: instance.name ?? String(instance.id) }, config: { ...(packageManifest?.config ?? {}), ...(instance.config ?? {}) } }
      : packageManifest;
    const baseId = String(
      (typeof definition === "object" && definition?.id) || options.id || packageManifest?.id || scriptKey || "anonymous",
    );
    const extensionId = instance ? `${baseId}#${instance.id}` : baseId;
    const rawInject = (typeof definition === "object" && definition?.inject) || options.inject;
    const inject = codexPlusNormalizeInject(rawInject);
    const required = codexPlusRequiredInject(rawInject);
    const runtime = window.__codexPlusUserScripts;
    const reloadable = !!scriptKey && runtime?.currentKey === scriptKey && typeof runtime.registerCleanup === "function";
    if (!inject.length) {
      const ctx = codexPlusInstantiateExtension({ apply, scriptKey, manifest, extensionId, inject });
      if (reloadable) runtime.registerCleanup(() => ctx.dispose());
      return ctx;
    }
    const fiber = codexPlusCreateExtensionFiber({ apply, scriptKey, manifest, extensionId, inject, required });
    if (reloadable) runtime.registerCleanup(() => fiber.dispose());
    return fiber;
  }

  /**
   * 声明了 inject 的拓展：依赖齐全才创建实例；依赖消失或换了提供者就卸载实例、回到挂起，
   * 提供者回来再重新应用。返回的句柄可以随时 dispose。
   */
  function codexPlusCreateExtensionFiber({ apply, scriptKey, manifest, extensionId, inject, required = inject }) {
    let tokens = "";
    // apply 里提供服务会触发全体复查，又回到这个句柄：正在检查时只记下「需要再查一次」。
    let checking = false;
    let recheck = false;
    const fiber = {
      id: extensionId,
      scriptKey,
      inject: [...inject],
      state: "pending",
      ctx: null,
      check() {
        if (fiber.state === "disposed") return;
        if (checking) {
          recheck = true;
          return;
        }
        checking = true;
        try {
          fiber.update();
        } finally {
          checking = false;
        }
        if (recheck) {
          recheck = false;
          fiber.check();
        }
      },
      update() {
        const ready = required.every((name) => codexPlusServices.has(name));
        const current = inject.map((name) => codexPlusServices.get(name)?.token ?? "").join("|");
        if (fiber.ctx && (!ready || current !== tokens)) {
          const ctx = fiber.ctx;
          fiber.ctx = null;
          fiber.state = "pending";
          ctx.dispose();
        }
        if (!fiber.ctx && ready && fiber.state !== "disposed") {
          tokens = current;
          fiber.state = "active";
          try {
            fiber.ctx = codexPlusInstantiateExtension({ apply, scriptKey, manifest, extensionId, inject, fiber });
          } catch (error) {
            fiber.state = "failed";
            codexPlusMarkExtensionFailure(scriptKey, `${extensionId}: ${String(error?.stack || error?.message || error)}`);
          }
        }
      },
      dispose() {
        if (fiber.state === "disposed") return;
        fiber.state = "disposed";
        codexPlusServiceFibers.delete(fiber);
        const ctx = fiber.ctx;
        fiber.ctx = null;
        ctx?.dispose();
      },
    };
    codexPlusServiceFibers.add(fiber);
    fiber.check();
    return fiber;
  }

  /** 创建并应用一个拓展实例。inject 里的服务挂到 ctx 上；fiber 是它所属的生命周期句柄（可无）。 */
  function codexPlusInstantiateExtension({ apply, scriptKey, manifest, extensionId, inject = [], fiber = null }) {
    const disposers = [];
    let disposed = false;

    /** 登记一个撤销函数，返回「提前撤销」。实例已卸载时立刻执行。 */
    const track = (dispose) => {
      if (typeof dispose !== "function") return () => {};
      let active = true;
      const entry = () => {
        if (!active) return;
        active = false;
        dispose();
      };
      if (disposed) {
        runCodexPlusExtensionCallback(scriptKey, `${extensionId}.dispose`, entry);
        return () => {};
      }
      disposers.push(entry);
      return () => {
        const index = disposers.indexOf(entry);
        if (index >= 0) disposers.splice(index, 1);
        entry();
      };
    };

    // 多实例时注册项的 id 带上实例 id，同一个拓展的几份不会互相顶掉。
    const instanceId = manifest?.instance?.id;
    const registerOptions = (itemOptions) => ({
      ...(itemOptions || {}),
      ...(instanceId && itemOptions?.id ? { id: `${itemOptions.id}@${instanceId}` } : {}),
      scriptKey,
    });
    // 按拓展隔离的本地存储：键名自动带拓展 id 前缀，值按 JSON 存取。
    const storagePrefix = `codexpp:ext:${extensionId}:`;
    const storage = {
      get(key, fallback = null) {
        try {
          const raw = localStorage.getItem(storagePrefix + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        localStorage.setItem(storagePrefix + key, JSON.stringify(value));
      },
      remove(key) {
        localStorage.removeItem(storagePrefix + key);
      },
      keys() {
        const out = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(storagePrefix)) out.push(key.slice(storagePrefix.length));
        }
        return out;
      },
    };
    const info = { id: extensionId, scriptKey };
    const readyHandlers = new Set();
    let applied = false;
    const locale = Object.freeze({
      /** 当前语言 id（取 Codex 页面的 lang，如 zh-CN）。 */
      get current() {
        return codexPlusCurrentLocale();
      },
      /** register(ns, { zh: {...}, en: {...} }) 或 register(ns, "zh", {...})；随实例卸载撤销。 */
      register(ns, langOrDicts, dict) {
        const space = String(ns || extensionId);
        if (typeof langOrDicts === "string") return track(codexPlusRegisterLocale(space, langOrDicts, dict));
        const disposers = Object.entries(langOrDicts || {}).map(([lang, value]) => codexPlusRegisterLocale(space, lang, value));
        return track(() => disposers.forEach((dispose) => dispose()));
      },
      /** 绑定命名空间，返回 t(key, params)。 */
      bind(ns) {
        const space = String(ns || extensionId);
        return (key, params) => codexPlusTranslate(space, key, params);
      },
      /** 在本拓展的命名空间里翻译（包内 locale/*.json 已自动登记在这里）。 */
      t(key, params) {
        return codexPlusTranslate(extensionId, key, params);
      },
      /** 解析 { en, zh, ... } 形式的多语言文本。 */
      resolve: codexPlusResolveText,
    });

    // 生效配置（清单 config 默认值叠加用户在管理器 / 对话里设置的值）。改配置会热重载拓展，这里是只读快照。
    let config = Object.freeze({ ...(manifest?.config && typeof manifest.config === "object" ? manifest.config : {}) });
    const configHandlers = new Set();
    // 常驻后台：call 调方法（首次调用时 Codex Pilot 启动后台进程），on 订阅后台 emit 的事件（长轮询，
    // 随实例卸载停止；on 本身不启动后台）。走内部桥接路由，不经拓展路由白名单，key 固定为本脚本。
    // 用过后台的实例卸载时通知 Codex Pilot 停掉它；带实例标识，热重载时不会误停新实例拉起的后台。
    const backendHandlers = new Map();
    const backendInstance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let backendPolling = false;
    let backendStopTracked = false;
    const trackBackendStop = () => {
      if (backendStopTracked) return;
      backendStopTracked = true;
      track(() => {
        void backendBridge("/extensions/backend/stop", {}).catch(() => {});
      });
    };
    const backendBridge = (path, payload) => {
      const bridge = window.__codexSessionDeleteBridge;
      if (typeof bridge !== "function") return Promise.reject(new Error("Codex 页面尚未连接，请稍后重试"));
      return Promise.resolve(bridge(path, { key: scriptKey, instance: backendInstance, ...payload })).then((result) => {
        if (result?.status === "failed" || result?.error) throw new Error(result.message || result.error || `${path} 调用失败`);
        return result;
      });
    };
    const pollBackendEvents = async () => {
      if (backendPolling) return;
      backendPolling = true;
      // 首次订阅从队尾开始：后台已在跑时，订阅前的旧事件不重放给这个页面实例。
      let since = "latest";
      try {
        while (!disposed && backendHandlers.size) {
          let result;
          try {
            result = await backendBridge("/extensions/backend/events", { since, waitMs: since === "latest" ? 0 : 20000 });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          for (const item of result.events || []) {
            for (const name of [item.event, "*"]) {
              for (const handler of [...(backendHandlers.get(name) || [])]) {
                runCodexPlusExtensionCallback(scriptKey, `backend.on:${item.event}`, () => handler(item.payload, { event: item.event }));
              }
            }
          }
          since = Number(result.next) || (since === "latest" ? 0 : since);
          // 后台还没起：稍后再看，不空转。
          if (!result.running) await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } finally {
        backendPolling = false;
      }
    };
    // 调模型：经 Codex Pilot 协议代理用当前供应商（不跑拓展网关中间件）。
    const llm = Object.freeze({
      complete(options) {
        const payload = typeof options === "string" ? { input: options } : options ?? {};
        return backendBridge("/extensions/llm/complete", payload).then((result) => result.result);
      },
      listModels: () => backendBridge("/extensions/llm/models", {}).then((result) => result.result),
    });
    const backend = {
      call(method, params = null, callOptions = {}) {
        const timeoutMs = Number.isFinite(callOptions.timeout) ? Number(callOptions.timeout) : undefined;
        trackBackendStop();
        return backendBridge("/extensions/backend/call", { method: String(method), params, timeoutMs }).then((result) => result.result);
      },
      on(event, handler) {
        if (typeof handler !== "function") throw new Error("后台事件处理器必须是函数");
        const name = String(event);
        if (!backendHandlers.has(name)) backendHandlers.set(name, new Set());
        backendHandlers.get(name).add(handler);
        void pollBackendEvents();
        return track(() => {
          const set = backendHandlers.get(name);
          set?.delete(handler);
          if (set && !set.size) backendHandlers.delete(name);
        });
      },
    };
    const ctx = {
      id: extensionId,
      scriptKey,
      manifest,
      /** 清单 instances 里的哪一份（{ id, name }）；没声明实例时为 null。 */
      instance: manifest?.instance ?? null,
      get config() {
        return config;
      },
      /**
       * 配置原地更新：handler(新配置, 旧配置) 返回 true 表示接住了（ctx.config 换成新值，不重载）；
       * 这个拓展只要有一个实例没接，就照常整体热重载（同 Cordis 的 internal/update 否决重启）。
       */
      onConfigUpdate(handler) {
        if (typeof handler !== "function") throw new Error("onConfigUpdate 需要一个函数");
        configHandlers.add(handler);
        return track(() => configHandlers.delete(handler));
      },
      /** 内核用：问本实例能否原地接住新配置。 */
      __tryConfigUpdate(next) {
        if (!configHandlers.size) return false;
        const frozen = Object.freeze({ ...(next && typeof next === "object" ? next : {}) });
        for (const handler of [...configHandlers]) {
          const result = runCodexPlusExtensionCallback(scriptKey, `${extensionId}.onConfigUpdate`, () => handler(frozen, config));
          if (!result.ok || result.value !== true) return false;
        }
        config = frozen;
        return true;
      },
      backend,
      llm,
      get themes() {
        return codexPlusServices.get("themes")?.value;
      },
      get disposed() {
        return disposed;
      },
      storage,

      locale,

      /**
       * 包内资源的地址（data URL），可直接给 img.src / audio.src / CSS url()。资源放在包的 assets/ 下，
       * 例如 ctx.asset("assets/pet.png")；找不到时返回空串（单文件脚本没有资源）。
       */
      asset(path) {
        const key = String(path || "").replace(/^\.?\//, "");
        const assets = manifest?.assets && typeof manifest.assets === "object" ? manifest.assets : {};
        return assets[key] || assets[`assets/${key}`] || "";
      },

      /** 提供一个服务（扁平命名空间，重名抛错）；随实例卸载撤销，依赖它的拓展随之卸载。 */
      provide(name, value) {
        return track(codexPlusProvideService(String(name), value, scriptKey || extensionId));
      },
      /** 取一个服务，不存在时返回 undefined（可选依赖用这个；必需依赖请在 inject 里声明）。 */
      get(name) {
        return codexPlusServices.get(String(name))?.value;
      },
      /** 子作用域：deps 里的服务齐全时以子 ctx 调用 apply，服务消失时卸载、回来时重新应用。 */
      inject(deps, apply) {
        if (typeof apply !== "function") throw new Error("inject 需要 apply(ctx) 函数");
        const child = codexPlusCreateExtensionFiber({
          apply, scriptKey, manifest, extensionId, inject: codexPlusNormalizeInject(deps), required: codexPlusRequiredInject(deps),
        });
        track(() => child.dispose());
        return child;
      },

      /** 立即执行 fn；它返回的函数在卸载时调用。 */
      effect(fn) {
        if (typeof fn !== "function") throw new Error("effect 需要一个函数");
        const result = fn();
        if (!codexPlusIsThenable(result)) return track(result);
        // 异步 effect：等它给出撤销函数；实例先卸载了就在拿到时立刻撤销。
        let cancelled = false;
        let dispose = null;
        Promise.resolve(result).then((value) => {
          if (typeof value !== "function") return;
          if (cancelled) runCodexPlusExtensionCallback(scriptKey, `${extensionId}.dispose`, value);
          else dispose = value;
        }, (error) => ctx.fail(error));
        return track(() => {
          cancelled = true;
          dispose?.();
        });
      },

      registerRowAction(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("rowAction", codexPlusRegistry.rowActions, definition, registerOptions(itemOptions)));
      },
      registerNavEntry(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("navEntry", codexPlusRegistry.navEntries, definition, registerOptions(itemOptions)));
      },
      registerMenuItem(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("menuItem", codexPlusRegistry.menuItems, definition, registerOptions(itemOptions)));
      },
      registerPage(definition, itemOptions) {
        return track(codexPlusRegisterExtensionPage(definition, registerOptions(itemOptions)));
      },
      registerCommand(definition, itemOptions) {
        return track(codexPlusRegisterExtensionCommand(definition, registerOptions(itemOptions)));
      },
      registerComposerAction(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("composerAction", codexPlusRegistry.composerActions, definition, registerOptions(itemOptions)));
      },
      registerMessageAction(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("messageAction", codexPlusRegistry.messageActions, definition, registerOptions(itemOptions)));
      },
      registerMessageDecoration(definition, itemOptions) {
        return track(codexPlusRegisterExtensionItem("messageDecoration", codexPlusRegistry.messageDecorations, definition, registerOptions(itemOptions)));
      },
      registerSlot(definition, itemOptions) {
        const slot = codexPlusRegisterExtensionSlot(definition, registerOptions(itemOptions));
        const handle = track(slot);
        handle.refresh = slot.refresh;
        return handle;
      },
      registerFloatingTab(definition, itemOptions) {
        return track(codexPlusRegisterFloatingTab(definition, registerOptions(itemOptions)));
      },
      registerToolView(definition, itemOptions) {
        const view = codexPlusRegisterToolView(definition, registerOptions(itemOptions));
        const handle = track(view);
        handle.refresh = view.refresh;
        return handle;
      },
      registerSettingsSection(definition, itemOptions) {
        return track(codexPlusRegisterSettingsSection(definition, registerOptions(itemOptions)));
      },
      registerInputTrigger(definition, itemOptions) {
        return track(codexPlusRegisterInputTrigger(definition, registerOptions(itemOptions)));
      },
      registerShortcut(definition, itemOptions) {
        return track(codexPlusRegisterShortcut(definition, registerOptions(itemOptions)));
      },
      registerTheme(definition, itemOptions) {
        return track(codexPlusRegisterTheme(definition, registerOptions(itemOptions)));
      },
      /** 当前打开的 Codex 会话 id；首页、新对话还没有 id 时为空串。 */
      currentSessionId() {
        return codexPlusCurrentSessionId();
      },
      /** 弹对话框问用户，返回 { value, text }；取消为 null。 */
      ask(question) {
        return codexPlusAsk(question);
      },
      registerSidePanel(definition, itemOptions) {
        const panel = codexPlusRegisterExtensionSidePanel(definition, registerOptions(itemOptions));
        const handle = track(panel);
        handle.open = panel.open;
        handle.close = panel.close;
        handle.toggle = panel.toggle;
        return handle;
      },

      on(event, handler) {
        if (typeof event !== "string" || !event) throw new Error("事件名不能为空");
        if (typeof handler !== "function") throw new Error("事件处理器必须是函数");
        // ready / dispose 只属于本实例（同 Cordis）：ready 在 apply（含异步部分）完成后触发，dispose 随卸载。
        if (event === "ready") {
          if (applied) {
            queueMicrotask(() => !disposed && runCodexPlusExtensionCallback(scriptKey, `${extensionId}.ready`, handler));
            return () => {};
          }
          readyHandlers.add(handler);
          return track(() => readyHandlers.delete(handler));
        }
        if (event === "dispose") return track(() => runCodexPlusExtensionCallback(scriptKey, `${extensionId}.dispose`, handler));
        const listener = { handler, scriptKey };
        if (!codexPlusExtensionListeners.has(event)) codexPlusExtensionListeners.set(event, new Set());
        codexPlusExtensionListeners.get(event).add(listener);
        if (codexPlusSessionWatchEvents.includes(event)) codexPlusEnsureSessionWatcher();
        return track(() => {
          const listeners = codexPlusExtensionListeners.get(event);
          listeners?.delete(listener);
          if (listeners && !listeners.size) codexPlusExtensionListeners.delete(event);
        });
      },
      emit(event, ...args) {
        codexPlusEmitExtensionEvent(event, args);
      },

      intercept(name, handler, interceptOptions = {}) {
        if (typeof name !== "string" || !name) throw new Error("中间件链名不能为空");
        if (typeof handler !== "function") throw new Error("中间件必须是函数");
        const item = {
          handler,
          scriptKey,
          order: Number.isFinite(interceptOptions.order) ? Number(interceptOptions.order) : 0,
          seq: ++codexPlusExtensionInterceptorSeq,
        };
        const chain = [...(codexPlusExtensionInterceptors.get(name) || []), item];
        chain.sort((left, right) => left.order - right.order || left.seq - right.seq);
        codexPlusExtensionInterceptors.set(name, chain);
        return track(() => {
          const rest = (codexPlusExtensionInterceptors.get(name) || []).filter((entry) => entry !== item);
          if (rest.length) codexPlusExtensionInterceptors.set(name, rest);
          else codexPlusExtensionInterceptors.delete(name);
        });
      },
      waterfall(name, value) {
        return codexPlusRunWaterfall(name, value);
      },

      listen(target, type, handler, listenOptions) {
        if (!target || typeof target.addEventListener !== "function") throw new Error("listen 的目标必须支持 addEventListener");
        target.addEventListener(type, handler, listenOptions);
        return track(() => target.removeEventListener(type, handler, listenOptions));
      },
      setTimeout(handler, delay, ...args) {
        let timer = null;
        const revoke = track(() => window.clearTimeout(timer));
        timer = window.setTimeout(() => {
          revoke();
          runCodexPlusExtensionCallback(scriptKey, `${extensionId}.setTimeout`, () => handler(...args));
        }, delay);
        return revoke;
      },
      setInterval(handler, delay, ...args) {
        const timer = window.setInterval(() => {
          runCodexPlusExtensionCallback(scriptKey, `${extensionId}.setInterval`, () => handler(...args));
        }, delay);
        return track(() => window.clearInterval(timer));
      },
      /**
       * 跟着 Codex Pilot 的页面扫描跑：Codex 的界面变了（会话切换、侧栏重建、输入框重建……）时调用 handler，
       * 按帧合并、页面隐藏时不跑。phase：deferred（默认，完整扫描）或 light（每次变化都跑的轻量扫描，handler 要便宜）。
       * handler 插进页面的节点必须带 data-codex-plus-ext 属性，否则会触发自喂扫描循环。返回的撤销函数带 run()：立即跑一次。
       */
      onScan(handler, scanOptions = {}) {
        if (typeof handler !== "function") throw new Error("onScan 需要一个函数");
        const step = () => runCodexPlusExtensionCallback(scriptKey, `${extensionId}.onScan`, handler);
        const revoke = track(registerCodexPlusScanStep(scriptKey, step, scanOptions?.phase));
        revoke.run = () => {
          if (!disposed) step();
        };
        return revoke;
      },

      /**
       * 调后端路由。拓展包只能调清单 permissions.routes 声明过的路由；单文件脚本
       * 没有清单，沿用全局白名单。这是声明约束而非安全边界：拓展与页面同权。
       */
      call(route, payload, callOptions) {
        if (manifest) {
          const routes = Array.isArray(manifest.permissions?.routes) ? manifest.permissions.routes : [];
          if (!routes.includes(route)) {
            return Promise.reject(new Error(`拓展 ${extensionId} 未在 codexpp.json 声明路由权限：${route}`));
          }
        }
        return codexPlusExtensionCall(route, payload, callOptions);
      },
      toast(message, toastOptions) {
        return runCodexPlusExtensionCallback(scriptKey, `${extensionId}.toast`, () => showToast(String(message ?? ""), toastOptions || {}));
      },
      fail(error) {
        codexPlusMarkExtensionFailure(scriptKey, `${extensionId}: ${String(error?.stack || error?.message || error)}`);
      },

      /** 卸载：按注册逆序撤销，单项撤销抛错只记录、不中断其余撤销。 */
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const entry of disposers.splice(0).reverse()) {
          runCodexPlusExtensionCallback(scriptKey, `${extensionId}.dispose`, entry);
        }
        codexPlusExtensionInstances.delete(ctx);
        codexPlusEmitExtensionEvent("extension/dispose", [info]);
        if (typeof scheduleCodexPlusExtensionsChanged === "function") scheduleCodexPlusExtensionsChanged();
      },
    };

    // 拓展包自带的 locale/<语言>.json 登记到本拓展的命名空间。
    if (manifest?.locales && typeof manifest.locales === "object") {
      for (const [lang, dict] of Object.entries(manifest.locales)) {
        if (dict && typeof dict === "object") track(codexPlusRegisterLocale(extensionId, lang, dict));
      }
    }
    // 声明过的服务挂到 ctx 上（读的是当前提供者的值；换了提供者时整个实例会被重建）。
    for (const name of inject) {
      if (Object.prototype.hasOwnProperty.call(ctx, name)) continue;
      Object.defineProperty(ctx, name, { enumerable: true, get: () => codexPlusServices.get(name)?.value });
    }
    if (fiber) Object.defineProperty(ctx, "fiber", { value: fiber });
    codexPlusExtensionInstances.add(ctx);

    let result;
    try {
      result = apply(ctx);
    } catch (error) {
      ctx.dispose();
      throw error;
    }
    // apply 完成（异步 apply 等它 resolve）后才算应用好：发 extension/apply，再调本实例的 ready 监听器。
    const settle = () => {
      if (disposed) return;
      applied = true;
      codexPlusEmitExtensionEvent("extension/apply", [info]);
      if (typeof scheduleCodexPlusExtensionsChanged === "function") scheduleCodexPlusExtensionsChanged();
      for (const handler of [...readyHandlers]) runCodexPlusExtensionCallback(scriptKey, `${extensionId}.ready`, handler);
      readyHandlers.clear();
    };
    if (codexPlusIsThenable(result)) {
      Promise.resolve(result).then(settle, (error) => {
        ctx.fail(error);
        ctx.dispose();
      });
    } else {
      settle();
    }
    return ctx;
  }
  /**
   * 拓展的 RPC 层拦截点：`agent/pre-step`、`agent/request` 和 `codex/request`。
   *
   * 新版 Codex 把 app-server manager 搬进了宿主进程，页面经 MessagePort 用 capnweb 协议调它，
   * 页面里已经没有发 turn/start 的请求客户端（见 70-model-catalog 的类捕获，只剩旧路径）。
   * 页面能看到的只有 RPC 帧，所以在 MessagePort.prototype.postMessage 上按帧拦截：
   *
   *   - `["push", ["pipeline", id, ["sendRequest"], [method, params, opts]]]`：manager 的通用请求，
   *     走 `codex/request`。
   *   - `["push", ["pipeline", id, ["startConversation"], [params, callbacks]]]`：新会话的首轮，
   *     params 里带 input / collaborationMode，按 turn/start 处理。
   *   - `["resolve", exportId, { start: { request }, steer, resume, … }]`：宿主发起轮次前回调页面要参数，
   *     `start.request` 就是 turn/start 的原样参数，`steer` 是会话忙时改走 turn/steer 的候选。
   *
   * capnweb 的 import id 按 push 顺序隐式分配，所以改写某一帧要等中间件时，同一端口后面的帧
   * 必须排队、按原顺序发出。没有拓展挂这些拦截点时一律同步放行，零开销。
   *
   * 语义（`ctx.on(name, async (params, next) => …)`，先 `await next()` 拿下游决定再改）：
   *   - `agent/pre-step`：params `{ agent, turn, step, messages, signal }`，决定是
   *     `{ kind: "enter", messages }` 或 `{ kind: "reject", reason? }`。拒绝时这一轮不发出。
   *   - `agent/request`：params `{ agent, turn, step, signal }`，返回 `{ provider, model, reasoningEffort }`。
   * 同一条用户消息只跑一次这两条链（按 clientUserMessageId 缓存），结果套用到它的所有候选帧上。
   */
  const codexPlusRpcInterceptorVersion = 1;
  const codexPlusRpcMiddlewareTimeoutMs = 5000;
  const codexPlusRpcOpaque = Symbol("codexPlusRpcOpaque");
  const codexPlusRpcSourceItem = Symbol("codexPlusRpcSourceItem");
  const codexPlusRpcPortQueues = new WeakMap();
  const codexPlusRpcTurnCache = new Map();
  const codexPlusRpcTurnCacheLimit = 64;

  function codexPlusRpcIsPlainObject(value) {
    if (!value || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /** capnweb 值 → 普通 JS 值。数组编码成 `[[…]]`；其它数组是带标签的值（导出的回调、错误等），原样包起来不给改。 */
  function codexPlusRpcDecode(value) {
    if (Array.isArray(value)) {
      if (value.length === 1 && Array.isArray(value[0])) return value[0].map(codexPlusRpcDecode);
      return { [codexPlusRpcOpaque]: value };
    }
    if (codexPlusRpcIsPlainObject(value)) {
      const out = {};
      for (const key of Object.keys(value)) out[key] = codexPlusRpcDecode(value[key]);
      return out;
    }
    return value;
  }

  function codexPlusRpcEncode(value) {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, codexPlusRpcOpaque)) {
      return value[codexPlusRpcOpaque];
    }
    if (Array.isArray(value)) return [value.map(codexPlusRpcEncode)];
    if (codexPlusRpcIsPlainObject(value)) {
      const out = {};
      for (const key of Object.keys(value)) out[key] = codexPlusRpcEncode(value[key]);
      return out;
    }
    return value;
  }

  function codexPlusRpcHasListeners(name) {
    try {
      return !!codexPlusExtensionListeners.get(name)?.size;
    } catch {
      return false;
    }
  }

  function codexPlusRpcWantsRequestChain() {
    try {
      return codexPlusExtensionInterceptors.has("codex/request");
    } catch {
      return false;
    }
  }

  function codexPlusRpcWantsTurnHooks() {
    return codexPlusRpcHasListeners("agent/pre-step")
      || codexPlusRpcHasListeners("agent/request")
      || codexPlusRpcWantsRequestChain();
  }

  /**
   * 可等待下游的 waterfall：监听器按注册顺序 `handler(params, next)`，`next()` 不带参数、返回下游决定，
   * 链尾是 fallback。另外做了出错隔离：监听器抛错或 reject 时记到该拓展名下，按调用 next() 处理，
   * 不能因为一个拓展挡住 Codex 发消息。返回 undefined 也按 next() 处理。
   */
  function codexPlusRunListenerWaterfall(name, params, fallback) {
    const chain = [...(codexPlusExtensionListeners.get(name) || [])];
    const step = (index) => {
      if (index >= chain.length) return Promise.resolve().then(fallback);
      const item = chain[index];
      let downstream = null;
      const next = () => (downstream ||= step(index + 1));
      const outcome = runCodexPlusExtensionCallback(item.scriptKey, `on:${name}`, () => item.handler(params, next));
      if (!outcome.ok) return next();
      return Promise.resolve(outcome.value).then(
        (value) => (value === undefined ? next() : value),
        (error) => {
          codexPlusMarkExtensionFailure(item.scriptKey, `on:${name}: ${String(error?.stack || error?.message || error)}`);
          return next();
        },
      );
    };
    return step(0);
  }

  /** Codex 的 input 条目 → 拓展看到的用户消息。非文本条目（图片、提及等）原样放进 content，改写回去时保留。 */
  function codexPlusRpcInputToMessages(input, id) {
    const content = (Array.isArray(input) ? input : []).map((item) => {
      if (item?.type !== "text") return { ...item };
      const part = { type: "text", text: String(item.text ?? "") };
      Object.defineProperty(part, codexPlusRpcSourceItem, { value: item });
      return part;
    });
    return [{ role: "user", id: String(id || ""), source: { kind: "user" }, content }];
  }

  /** 拓展消息 → Codex 的 input 条目。文本没改的条目沿用原条目（保留 text_elements 等标注）。 */
  function codexPlusRpcMessagesToInput(messages) {
    const items = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = typeof message?.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message?.content) ? message.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type !== "text") {
          items.push({ ...part });
          continue;
        }
        const text = String(part.text ?? "");
        const source = part[codexPlusRpcSourceItem];
        items.push(source && source.text === text ? source : { type: "text", text, text_elements: [] });
      }
    }
    return items;
  }

  function codexPlusRpcSplitModel(model) {
    const id = typeof model === "string" ? model : "";
    const slash = id.indexOf("/");
    return slash > 0 ? { provider: id.slice(0, slash), base: id.slice(slash + 1) } : { provider: undefined, base: id };
  }

  /**
   * 对一条用户消息跑 `agent/pre-step` 与 `agent/request`。
   * 返回 { reject } 或 { input, model, reasoningEffort }（没变的字段为 undefined）。
   */
  async function codexPlusRpcRunTurnHooks({ messageId, conversationId, input, settings, signal }) {
    const agent = Object.freeze({
      id: String(conversationId || messageId || ""),
      session: Object.freeze({ id: String(conversationId || "") }),
    });
    const result = {};
    if (codexPlusRpcHasListeners("agent/pre-step")) {
      const messages = codexPlusRpcInputToMessages(input, messageId);
      const decision = await codexPlusRunListenerWaterfall(
        "agent/pre-step",
        { agent, turn: undefined, step: 1, messages, signal, conversationId },
        () => ({ kind: "enter", messages }),
      );
      if (decision?.kind === "reject") return { reject: String(decision.reason || "已被拓展拦截") };
      if (decision?.kind === "enter" && Array.isArray(decision.messages) && decision.messages !== messages) {
        result.input = codexPlusRpcMessagesToInput(decision.messages);
      }
    }
    if (codexPlusRpcHasListeners("agent/request")) {
      const { provider, base } = codexPlusRpcSplitModel(settings?.model);
      const seed = Object.freeze({
        provider,
        model: typeof settings?.model === "string" ? settings.model : undefined,
        reasoningEffort: settings?.reasoning_effort ?? undefined,
      });
      const config = await codexPlusRunListenerWaterfall(
        "agent/request",
        { agent, turn: undefined, step: 1, signal, conversationId },
        () => seed,
      );
      if (config && typeof config === "object" && config !== seed) {
        if (typeof config.model === "string" && config.model && config.model !== seed.model) {
          result.model = config.model;
        } else if (typeof config.provider === "string" && config.provider && config.provider !== provider && base) {
          // 只换了供应商：沿用 Codex Pilot 的「供应商/模型」写法拼回去。
          result.model = `${config.provider}/${base}`;
        }
        if (typeof config.reasoningEffort === "string" && config.reasoningEffort !== seed.reasoningEffort) {
          result.reasoningEffort = config.reasoningEffort;
        }
      }
    }
    return result;
  }

  /** 同一条用户消息的多个候选帧共用一次 hooks 结果。 */
  function codexPlusRpcTurnHooksOnce(key, run) {
    if (!key) return run();
    const cached = codexPlusRpcTurnCache.get(key);
    if (cached) return cached;
    const pending = run();
    codexPlusRpcTurnCache.set(key, pending);
    while (codexPlusRpcTurnCache.size > codexPlusRpcTurnCacheLimit) {
      codexPlusRpcTurnCache.delete(codexPlusRpcTurnCache.keys().next().value);
    }
    return pending;
  }

  function codexPlusRpcApplySettings(holder, outcome) {
    const settings = holder?.collaborationMode?.settings;
    if (!codexPlusRpcIsPlainObject(settings)) return;
    if (outcome.model !== undefined) settings.model = outcome.model;
    if (outcome.reasoningEffort !== undefined) settings.reasoning_effort = outcome.reasoningEffort;
  }

  /** 跑 `codex/request` 链；返回新的 params，没改返回原对象。 */
  async function codexPlusRpcRunRequestChain(method, params) {
    if (!codexPlusRpcWantsRequestChain()) return params;
    const result = await codexPlusRunWaterfall("codex/request", { method, params });
    return result && typeof result === "object" && result.params !== undefined ? result.params : params;
  }

  function codexPlusRpcRejectNotice(reason) {
    try {
      if (typeof showToast === "function") showToast(reason, { type: "warn" });
    } catch {}
  }

  /**
   * 处理一轮对话的参数（就地改 decoded 里的对象）。
   * carriers：[{ method, params, conversationId }]，第一个用来取 input；settings 是本轮的模型设置
   * （缺省取第一个 carrier 的）。settingsHolders：需要同步模型设置的对象（resume 等）。返回 { reject } 或 {}。
   */
  async function codexPlusRpcProcessTurn({ messageId, carriers, settings, settingsHolders, signal }) {
    const primary = carriers[0];
    const outcome = await codexPlusRpcTurnHooksOnce(messageId, () => codexPlusRpcRunTurnHooks({
      messageId,
      conversationId: primary.conversationId,
      input: primary.params.input,
      settings: settings || primary.params.collaborationMode?.settings,
      signal,
    }));
    if (outcome.reject) return outcome;
    for (const carrier of carriers) {
      if (outcome.input) carrier.params.input = outcome.input.map((item) => (codexPlusRpcIsPlainObject(item) ? { ...item } : item));
      codexPlusRpcApplySettings(carrier.params, outcome);
      if (outcome.model !== undefined && carrier.params.model != null) carrier.params.model = outcome.model;
      if (outcome.reasoningEffort !== undefined && carrier.params.effort != null) carrier.params.effort = outcome.reasoningEffort;
    }
    for (const holder of settingsHolders) codexPlusRpcApplySettings(holder, outcome);
    for (const carrier of carriers) {
      const next = await codexPlusRpcRunRequestChain(carrier.method, carrier.params);
      if (next !== carrier.params && codexPlusRpcIsPlainObject(next)) carrier.replace(next);
    }
    return {};
  }

  function codexPlusRpcPlanSendRequest(frame) {
    const expr = frame[1];
    const args = expr[3];
    const method = args[0];
    if (typeof method !== "string" || !codexPlusRpcWantsRequestChain()) return null;
    return async () => {
      const params = codexPlusRpcDecode(args[1]);
      const next = await codexPlusRpcRunRequestChain(method, params);
      if (next === params) return null;
      return ["push", [...expr.slice(0, 3), [method, codexPlusRpcEncode(next), ...args.slice(2)], ...expr.slice(4)], ...frame.slice(2)];
    };
  }

  function codexPlusRpcPlanStartConversation(frame) {
    const expr = frame[1];
    const args = expr[3];
    if (!codexPlusRpcIsPlainObject(args[0]) || !Array.isArray(args[0].input) || !codexPlusRpcWantsTurnHooks()) return null;
    return async (signal) => {
      let params = codexPlusRpcDecode(args[0]);
      const outcome = await codexPlusRpcProcessTurn({
        messageId: params.clientUserMessageId,
        carriers: [{ method: "turn/start", params, conversationId: undefined, replace: (next) => { params = next; } }],
        settingsHolders: [],
        signal,
      });
      if (outcome.reject) {
        codexPlusRpcRejectNotice(outcome.reject);
        // push 帧不能丢（会打乱 import id），改成调一个不存在的方法，让这次调用以错误结束。
        return ["push", ["pipeline", expr[1], ["__codexPlusRejectedByExtension"], []], ...frame.slice(2)];
      }
      return ["push", [...expr.slice(0, 3), [codexPlusRpcEncode(params), ...args.slice(1)], ...expr.slice(4)], ...frame.slice(2)];
    };
  }

  function codexPlusRpcPlanResolve(frame) {
    const value = frame[2];
    if (!codexPlusRpcIsPlainObject(value) || !codexPlusRpcWantsTurnHooks()) return null;
    const hasStart = codexPlusRpcIsPlainObject(value.start?.request) && Array.isArray(value.start.request.input);
    const hasSteer = codexPlusRpcIsPlainObject(value.steer) && Array.isArray(value.steer.input);
    if (!hasStart && !hasSteer) return null;
    return async (signal) => {
      const decoded = codexPlusRpcDecode(value);
      const conversationId = decoded.conversationId;
      const carriers = [];
      if (hasStart) {
        carriers.push({
          method: "turn/start",
          params: decoded.start.request,
          conversationId,
          replace: (next) => { decoded.start.request = next; },
        });
      }
      if (hasSteer) {
        carriers.push({
          method: "turn/steer",
          params: decoded.steer,
          conversationId,
          replace: (next) => { decoded.steer = next; },
        });
      }
      const messageId = decoded.start?.request?.clientUserMessageId || decoded.steer?.clientUserMessageId;
      const outcome = await codexPlusRpcProcessTurn({
        messageId,
        carriers,
        // 宿主常先只要 steer 候选（不带模型设置），这时从 resume 取，免得缓存下一份空配置。
        settings: decoded.start?.request?.collaborationMode?.settings || decoded.resume?.collaborationMode?.settings,
        settingsHolders: [decoded.resume].filter(Boolean),
        signal,
      });
      if (outcome.reject) {
        codexPlusRpcRejectNotice(outcome.reject);
        return ["reject", frame[1], ["error", "Error", outcome.reject]];
      }
      return ["resolve", frame[1], codexPlusRpcEncode(decoded), ...frame.slice(3)];
    };
  }

  /** 判断一帧要不要拦。返回 null（同步放行）或 async (signal) => 新帧 | null。 */
  function codexPlusRpcPlanFrame(frame) {
    if (!Array.isArray(frame)) return null;
    if (frame[0] === "push") {
      const expr = frame[1];
      if (!Array.isArray(expr) || expr[0] !== "pipeline" || !Array.isArray(expr[2]) || expr[2].length !== 1 || !Array.isArray(expr[3])) {
        return null;
      }
      if (expr[2][0] === "sendRequest") return codexPlusRpcPlanSendRequest(frame);
      if (expr[2][0] === "startConversation") return codexPlusRpcPlanStartConversation(frame);
      return null;
    }
    if (frame[0] === "resolve" && typeof frame[1] === "number" && frame.length > 2) return codexPlusRpcPlanResolve(frame);
    return null;
  }

  /** 带超时地跑一个改写计划；超时或出错返回 null（原样发出），同时 abort 交给拓展的 signal。 */
  async function codexPlusRpcRunPlan(plan) {
    const controller = new AbortController();
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => plan(controller.signal)),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new Error("Codex Pilot 拓展中间件超时"));
            resolve(null);
          }, codexPlusRpcMiddlewareTimeoutMs);
        }),
      ]);
    } catch (error) {
      codexPlusMarkExtensionFailure("", `rpc 拦截失败，已原样发出：${String(error?.message || error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 某个端口开始等中间件：之后的帧全部排队，按原顺序逐个处理、发出。 */
  async function codexPlusRpcDrainPort(port, original, first) {
    const state = { queue: [] };
    codexPlusRpcPortQueues.set(port, state);
    try {
      let entry = first;
      while (entry) {
        const [message, rest, plan] = entry;
        const replaced = plan ? await codexPlusRpcRunPlan(plan) : null;
        try {
          original.call(port, replaced || message, ...rest);
        } catch (error) {
          // 已经是异步发送，异常没法还给调用方；记下来，后面的帧照常发。
          codexPlusMarkExtensionFailure("", `rpc 帧发送失败：${String(error?.message || error)}`);
        }
        const queued = state.queue.shift();
        if (!queued) break;
        let nextPlan = null;
        try {
          nextPlan = codexPlusRpcPlanFrame(queued[0]);
        } catch {}
        entry = [queued[0], queued[1], nextPlan];
      }
    } finally {
      codexPlusRpcPortQueues.delete(port);
    }
  }

  function installCodexPlusRpcFrameInterceptor() {
    const proto = window.MessagePort?.prototype;
    if (!proto || typeof proto.postMessage !== "function") return false;
    const installed = window.__codexPlusRpcFrameInterceptor;
    if (installed?.version >= codexPlusRpcInterceptorVersion && proto.postMessage === installed.patched) return true;
    // 重复注入时包原生的那个，不叠层。
    const original = installed?.original || proto.postMessage;
    const patched = function codexPlusRpcPostMessage(message, ...rest) {
      const state = codexPlusRpcPortQueues.get(this);
      if (state) {
        state.queue.push([message, rest]);
        return undefined;
      }
      let plan = null;
      try {
        plan = codexPlusRpcPlanFrame(message);
      } catch {}
      if (!plan) return original.call(this, message, ...rest);
      void codexPlusRpcDrainPort(this, original, [message, rest, plan]);
      return undefined;
    };
    proto.postMessage = patched;
    window.__codexPlusRpcFrameInterceptor = { version: codexPlusRpcInterceptorVersion, original, patched };
    return true;
  }

  try {
    installCodexPlusRpcFrameInterceptor();
  } catch {}
  /**
   * 拓展宿主：把注册中心里的第三方项渲染出来。
   *
   * 与 91-extension-api.js 的分工：那边负责「收」（校验、配额、挂 API），这边负责
   * 「画」（把数据变成 DOM）。分开是因为画的部分要贴着既有 UI 的类名与结构走，
   * 而收的部分只需要一份数据契约。
   *
   * 全部采用「追加」而不是「重写」：内置项仍由原路径渲染，拓展项在其后补上。
   * 这样内置 UI 的行为零变化，出问题时摘掉这个分片即可回滚。
   */

  /**
   * 拓展节点的统一标记，扫描调度靠它识别（见 01-registry.js 的注释）。
   *
   * 选择器按「有归属/无归属」两档登记，而不是按脚本 key 逐个登记：一个脚本可能
   * 注册很多项，按 key 登记会白白吃掉全局选择器配额（上限 64），而扫描调度只需要
   * 知道「这个节点是我们的」——精确到脚本对排除自喂循环没有任何额外价值。
   */
  function markCodexPlusExtensionNode(node, scriptKey) {
    node.setAttribute(codexPlusExtensionConstants.extensionAttribute, scriptKey || "");
    registerCodexPlusExtensionSelector(`[${codexPlusExtensionConstants.extensionAttribute}]`);
    return node;
  }

  /** 取一个拓展项的图标：允许传 SVG 字符串，没给就用默认字形。 */
  function codexPlusExtensionIconMarkup(definition) {
    const icon = definition?.icon;
    if (typeof icon !== "string" || !icon.trim()) return `<span aria-hidden="true">◇</span>`;
    // 只接受 svg 或文本字形：注入任意 HTML 会让拓展有机会破坏内置 UI 结构。
    if (/^\s*<svg[\s>]/i.test(icon)) return `<span class="codex-plus-ext-icon" aria-hidden="true">${icon}</span>`;
    return `<span class="codex-plus-ext-icon" aria-hidden="true">${escapeHtml(icon)}</span>`;
  }

  /**
   * 打开一个拓展注册的整页视图。
   *
   * 复用内置的页面骨架（rail 高亮同步、缩放跟随、原生选中态压制都白拿），只是把
   * 内容区换掉。注意 overlay 每次打开都重建，所以 render 每次都要重新调用。
   */
  function openCodexPlusExtensionPage(id) {
    const definition = codexPlusRegistry.pages.get(id);
    if (!definition) return false;
    openCodexPlusModalForExtension(id, definition);
    return true;
  }

  /**
   * 渲染拓展页面。
   *
   * 不走 openCodexPlusModal 是因为那个函数的内容区来自内置模板字符串；这里要的是
   * 同一套外壳 + 自定义内容，所以单独走一遍，但外壳结构与类名完全对齐。
   */
  function openCodexPlusModalForExtension(id, definition) {
    closeCodexPlusPage();
    document.querySelectorAll(".codex-plus-modal-overlay").forEach((node) => node.remove());
    document.querySelectorAll(`.${codexPlusPageClass}, [data-codex-plus-dialog="true"]`).forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = codexPlusPageClass;
    overlay.dataset.codexPlusPage = "true";
    overlay.dataset.codexPlusExtensionPage = id;
    applyCodexPlusTheme(overlay);
    // 必须在写 innerHTML 之前设好缩放，否则内部 calc 会先按 1 算一遍（见内置实现注释）。
    applyCodexPlusZoom(overlay);
    overlay.innerHTML = `
      <div class="codex-plus-modal-content" role="dialog" aria-modal="true" aria-label="${escapeHtml(definition.title || "拓展页面")}">
        <div class="codex-plus-modal-header">
          <div class="codex-plus-modal-title"><span class="codex-plus-backend-indicator" data-codex-backend-indicator="true" data-status="checking"></span><span>${escapeHtml(definition.title || "拓展页面")}</span></div>
        </div>
        <div class="codex-plus-modal-body">
          <div class="codex-plus-panel" data-codex-plus-panel="extension" data-codex-plus-extension-panel="${id}"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    observeCodexPlusPageLayout(overlay);
    // 点亮当前拓展入口，并同步原生导航的选中态。
    setCodexPlusExtensionNavActive(id);
    // 点原生导航按钮时关闭覆盖层；拓展入口交给各自的页面回调。
    const rail = document.querySelector(codexPlusRailSelector);
    rail?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (target?.closest(`[${codexPlusExtensionConstants.extensionAttribute}]`)) return;
      if (target?.closest("button, a")) closeCodexPlusPageAfterNativeNavigation();
    }, true);

    const panel = overlay.querySelector(`[data-codex-plus-extension-panel="${id}"]`);
    if (!panel) return;
    // 拓展的 render 每次打开都重新调用，禁止缓存 DOM——见 91 顶部的生命周期约定。
    const outcome = runCodexPlusExtensionCallback(definition.scriptKey, "page.render", () =>
      definition.render({ container: panel, close: () => closeCodexPlusPage(), script: definition.scriptKey }));
    if (!outcome.ok) {
      panel.innerHTML = `<div class="codex-plus-row"><div><div class="codex-plus-row-title">拓展页面加载失败</div><div class="codex-plus-row-description">${escapeHtml(definition.scriptKey || "")}：${escapeHtml(outcome.error)}</div></div></div>`;
      panel.dataset.extensionError = "true";
    }
    definition.onCleanup && runCodexPlusExtensionCallback(definition.scriptKey, "page.onCleanup", () => {
      window.__codexPlusExtensionPageCleanup = definition.onCleanup;
    });
  }

  /**
   * 点亮某个拓展的图标栏入口。
   *
   * 清理其它拓展的选中态，再点亮目标并同步原生导航。
   */
  function setCodexPlusExtensionNavActive(pageId) {
    syncCodexPlusRailNativeSelection();
    const entry = codexPlusExtensionItems(codexPlusRegistry.navEntries)
      .find((item) => item.pageId === pageId);
    const elementId = entry ? `codex-plus-ext-rail-${entry.id.replace(/[^\w-]/g, "_")}` : "";
    // 先清掉所有拓展入口的选中态，避免两个页面之间切换时残留。
    document.querySelectorAll('[data-codex-plus-ext-rail-active="true"]').forEach((node) => {
      node.removeAttribute("data-codex-plus-ext-rail-active");
      const button = node.querySelector("button") || node;
      button?.removeAttribute("data-selected");
      button?.removeAttribute("aria-current");
    });
    if (!elementId) return;
    const wrapper = document.getElementById(elementId);
    if (!wrapper) return;
    wrapper.setAttribute("data-codex-plus-ext-rail-active", "true");
    const button = wrapper.querySelector("button") || wrapper;
    button.dataset.active = "true";
    button.setAttribute("aria-current", "page");
    button.setAttribute("data-selected", "");
    // 当前入口已选中，重新同步原生导航。
    syncCodexPlusRailNativeSelection();
  }

  /** 关闭当前拓展页面并执行其 onCleanup。 */
  function closeCodexPlusPage() {
    clearTimeout(window.__codexPlusPageNavigationCloseTimer);
    window.__codexPlusPageNavigationCloseTimer = null;
    const cleanup = window.__codexPlusExtensionPageCleanup;
    window.__codexPlusExtensionPageCleanup = null;
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch {}
    }
    window.removeEventListener("resize", window.__codexPlusPageResizeHandler);
    window.__codexPlusPageResizeHandler = null;
    window.__codexPlusPageLayoutObserver?.disconnect();
    window.__codexPlusPageLayoutObserver = null;
    window.__codexPlusPageLayoutTargets = null;
    document.querySelectorAll(`.${codexPlusPageClass}`).forEach((node) => node.remove());
    syncCodexPlusRailNativeSelection();
    restoreCodexPlusPageBackButton();
  }

  /** 拓展入口的 DOM 标记：用它反查注册表项，dispose 后据此清理。 */
  const codexPlusExtensionRailAttribute = "data-codex-plus-ext-rail";

  /** 拓展入口的稳定 id。用注册表 id 推导，dispose 与重建都能算回同一个值。 */
  function codexPlusExtensionRailElementId(entry) {
    return `codex-plus-ext-rail-${String(entry.id).replace(/[^\w-]/g, "_")}`;
  }

  /**
   * 图标栏上的拓展入口。
   *
   * 只渲染注册中心里的用户拓展，插在原生 primary 锚点之后，靠 id 幂等。
   */
  function refreshCodexPlusRailNavigation() {
    const rail = document.querySelector(codexPlusRailSelector);
    if (!rail) return false;
    const entries = codexPlusExtensionItems(codexPlusRegistry.navEntries);
    // 注意值域：属性里存的是注册表 id，所以这里也必须用注册表 id 比对。
    // 若拿元素 id（codex-plus-ext-rail-xxx）去比，两边永远不等，每次刷新都会把
    // 自己的入口当孤儿删掉，表现为「点了入口高亮立刻消失」。
    const liveIds = new Set(entries.map((entry) => entry.id));
    // 先清掉已不在注册表里的入口。dispose 之后没人来删 DOM，必须在这里收口，
    // 否则用户点一个已经注销的入口会什么都不发生。
    document.querySelectorAll(`[${codexPlusExtensionRailAttribute}]`).forEach((node) => {
      if (!liveIds.has(node.getAttribute(codexPlusExtensionRailAttribute) || "")) node.remove();
    });
    if (!entries.length) return false;
    const anchor = codexPlusRailPrimaryAnchor(rail);
    const host = anchor?.parentElement || rail;
    const template = codexPlusRailTemplateButton(rail);
    let cursor = anchor;
    entries.forEach((entry) => {
      const elementId = codexPlusExtensionRailElementId(entry);
      let wrapper = document.getElementById(elementId);
      if (!wrapper || wrapper.parentElement !== host || !codexPlusNavEntryReusable(wrapper)) {
        wrapper?.remove();
        wrapper = createCodexPlusRailButton({
          id: elementId,
          template,
          label: entry.label || entry.id,
          iconMarkup: codexPlusExtensionIconMarkup(entry),
          onActivate: () => {
            // 注册时若带了 pageId 就打开对应页面；否则交给拓展自己的 onActivate。
            const navigate = () => {
              if (entry.pageId && codexPlusRegistry.pages.has(entry.pageId)) {
                entry.navId = elementId;
                openCodexPlusExtensionPage(entry.pageId);
              } else if (typeof entry.onActivate === "function") {
                runCodexPlusExtensionCallback(entry.scriptKey, "navEntry.onActivate", () => entry.onActivate());
              }
            };
            navigate();
          },
        });
        if (!wrapper) return;
        // 这个属性是 dispose 后清理 DOM 的唯一线索，必须写。只靠
        // data-codex-plus-ext 认不出「这是 rail 入口」还是别的什么扩展节点。
        wrapper.setAttribute(codexPlusExtensionRailAttribute, entry.id);
        markCodexPlusExtensionNode(wrapper, entry.scriptKey);
        markCodexPlusExtensionNode(wrapper.firstElementChild || wrapper, entry.scriptKey);
      }
      if (cursor?.nextSibling) {
        if (cursor.nextSibling !== wrapper) host.insertBefore(wrapper, cursor.nextSibling);
      } else if (cursor) {
        host.appendChild(wrapper);
      } else if (host.firstElementChild !== wrapper) {
        host.insertBefore(wrapper, host.firstElementChild);
      }
      cursor = wrapper;
    });
    return true;
  }

  /**
   * 输入区按钮插槽：拓展用 registerComposerAction 注册的按钮，插在输入区 footer 里。
   *
   * footer 按输入框和发送按钮的位置打分，同一输入框只挂一份。按注册表指纹决定是否重建，避免每轮扫描都改 DOM。
   */
  function codexPlusComposerScope(footer) {
    let scope = footer?.parentElement;
    while (scope && scope !== document.body) {
      if (codexPlusComposerEditor(scope)) return scope;
      if (scope.matches?.('[data-codex-composer-root], [data-composer-surface-variant], form')) break;
      scope = scope.parentElement;
    }
    return null;
  }

  function codexPlusComposerEditor(scope) {
    return [...scope.querySelectorAll('.ProseMirror[contenteditable="true"], textarea:not(:disabled):not([readonly]), [role="textbox"][contenteditable="true"]')]
      .find((node) => visibleElement(node) && !isExtensionUiNode(node) && !node.closest('[inert], [aria-hidden="true"]')) || null;
  }

  function codexPlusComposerFooterScore(footer, editor) {
    let score = footer.contains(editor) ? 4 : 0;
    const send = codexPlusComposerSendButton(editor);
    if (send && footer.contains(send)) score += 2;
    return score;
  }

  function codexPlusComposerSendButton(editor) {
    let scope = editor.parentElement;
    while (scope && scope !== document.body) {
      const button = [...scope.querySelectorAll('button')].find((node) => {
        if (isExtensionUiNode(node) || !visibleElement(node) || node.disabled || node.getAttribute("aria-disabled") === "true") return false;
        const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.trim();
        return /^(?:Send|Send message|Send prompt|Submit|发送|发送消息|发送提示|提交)(?:\s|\(|（|$)/i.test(label)
          || node.getAttribute("data-testid") === "send-button" || node.getAttribute("data-action") === "send";
      });
      if (button) return button;
      if (scope.hasAttribute("data-codex-composer-root") || scope.hasAttribute("data-composer-surface-variant") || scope.tagName === "FORM") break;
      scope = scope.parentElement;
    }
    return null;
  }

  function codexPlusComposerActionHosts() {
    const hosts = new Map();
    document.querySelectorAll(".composer-footer, [data-composer-footer-responsive]").forEach((footer) => {
      if (!visibleElement(footer) || isExtensionUiNode(footer)) return;
      const scope = codexPlusComposerScope(footer);
      const editor = scope && codexPlusComposerEditor(scope);
      if (!editor) return;
      const score = codexPlusComposerFooterScore(footer, editor);
      const current = hosts.get(editor);
      if (!current || score >= current.score) hosts.set(editor, { footer, editor, score });
    });
    return [...hosts.values()];
  }

  /** 把文字插入输入框：先聚焦，再走浏览器的 insertText，让编辑器自己处理撤销栈与状态。 */
  function codexPlusInsertComposerText(editor, text) {
    if (!editor || typeof text !== "string" || !text) return false;
    editor.focus();
    return document.execCommand("insertText", false, text);
  }

  function refreshCodexPlusComposerActions() {
    const items = codexPlusExtensionItems(codexPlusRegistry.composerActions);
    const hosts = items.length ? codexPlusComposerActionHosts() : [];
    const hostFooters = new Set(hosts.map((host) => host.footer));
    document.querySelectorAll("[data-codex-plus-composer-actions]").forEach((node) => {
      if (!hostFooters.has(node.parentElement)) node.remove();
    });
    if (!items.length) return;
    if (!document.getElementById("codex-plus-composer-actions-style")) {
      const style = document.createElement("style");
      style.id = "codex-plus-composer-actions-style";
      markCodexPlusExtensionNode(style, "builtin-composer-actions");
      style.textContent = `[data-codex-plus-composer-actions]{display:inline-flex;align-items:center;gap:2px;margin-inline:2px}
        .codex-plus-composer-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-token-text-primary,currentColor);opacity:.9;cursor:pointer;font-size:15px;line-height:1}
        .codex-plus-composer-action:hover{background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}
        .codex-plus-composer-action:focus-visible{outline:2px solid currentColor;outline-offset:2px}
        .codex-plus-composer-action svg{width:16px;height:16px}`;
      document.head.append(style);
    }
    const renderKey = items.map((item) => `${item.id}|${item.label || ""}|${item.icon || ""}`).join("\n");
    for (const { footer, editor } of hosts) {
      let root = [...footer.children].find((node) => node.hasAttribute?.("data-codex-plus-composer-actions"));
      if (!root) {
        root = document.createElement("div");
        root.setAttribute("data-codex-plus-composer-actions", "");
        markCodexPlusExtensionNode(root, "builtin-composer-actions");
        // 追加到输入框底栏。
        footer.appendChild(root);
      }
      root.__codexPlusComposerEditor = editor;
      if (root.dataset.renderKey === renderKey) continue;
      root.dataset.renderKey = renderKey;
      root.textContent = "";
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "codex-plus-composer-action";
        button.setAttribute("aria-label", item.label || item.id);
        markCodexPlusExtensionNode(button, item.scriptKey);
        button.innerHTML = codexPlusExtensionIconMarkup(item);
        attachCodexPlusRailTooltip(button, item.label || item.id, "top");
        // 按下时不抢走输入框焦点，否则插入文字会落在别处。
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = root.__codexPlusComposerEditor;
          runCodexPlusExtensionCallback(item.scriptKey, "composerAction.onActivate", () => item.onActivate?.({
            editor: target,
            insertText: (text) => codexPlusInsertComposerText(target, text),
            close: () => hideCodexPlusRailTooltip(),
          }));
        });
        root.appendChild(button);
      }
    }
  }

  /**
   * 斜杠命令：拓展用 registerCommand 注册，在 Codex 输入框里「/name 参数」回车触发。
   *
   * 键盘监听挂在 document 的捕获阶段，先于输入框自己的处理；只拦截「整段输入恰好是一条已注册
   * 拓展命令」的回车，其它输入（包括 Codex 自己的斜杠命令）原样放行。命令名按注册表查，
   * 同名时先注册的生效。提示浮层带拓展标记，不触发扫描自喂。
   */
  const codexPlusCommandPattern = /^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

  function codexPlusRegisterExtensionCommand(definition, options = {}) {
    const name = String(definition?.name || "").trim();
    if (!/^[A-Za-z0-9][\w-]{0,31}$/.test(name)) throw new Error("命令名只能是字母、数字、_、-，最长 32 个字符");
    if (typeof definition?.run !== "function") throw new Error(`命令 /${name} 必须提供 run(args, context)`);
    const dispose = codexPlusRegisterExtensionItem("command", codexPlusRegistry.commands, { ...definition, name }, { ...options, id: options.id || `cmd-${name}` });
    installCodexPlusCommandHandlers();
    return dispose;
  }

  /** 当前打开的 Codex 会话 id（首页、新对话还没有 id 时为空串）。 */
  function codexPlusCurrentSessionId() {
    try {
      const fromRow = normalizedCodexThreadUuid(currentSessionRef()?.session_id);
      if (fromRow) return fromRow;
    } catch {}
    // 侧栏收起或当前会话不在列表里时，取可见输入框上方标着的会话 id（多个标签页只认看得见的那个）。
    const marked = [...document.querySelectorAll("[data-above-composer-conversation-id]")]
      // 这个标记节点本身常是空的（empty:hidden），按它所在输入框是否可见判断。
      .find((node) => node.closest("[data-codex-composer-root]")?.getBoundingClientRect().width > 0);
    return normalizedCodexThreadUuid(marked?.getAttribute("data-above-composer-conversation-id")) || "";
  }

  function codexPlusFindExtensionCommand(name) {
    return codexPlusExtensionItems(codexPlusRegistry.commands).find((item) => item.name === name) || null;
  }

  function codexPlusComposerEditorFrom(target) {
    const editor = target?.closest?.("[data-codex-composer], .ProseMirror, [contenteditable=true]");
    return editor && !isExtensionUiNode(editor) ? editor : null;
  }

  function codexPlusClearComposer(editor) {
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
  }

  function hideCodexPlusCommandHints() {
    document.getElementById("codex-plus-command-hints")?.remove();
  }

  /** 输入「/前缀」时在输入框上方列出匹配的拓展命令。 */
  function showCodexPlusCommandHints(editor, prefix) {
    const matches = codexPlusExtensionItems(codexPlusRegistry.commands)
      .filter((item) => item.name.startsWith(prefix))
      .slice(0, 8);
    if (!matches.length) {
      hideCodexPlusCommandHints();
      return;
    }
    let panel = document.getElementById("codex-plus-command-hints");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "codex-plus-command-hints";
      panel.setAttribute("role", "listbox");
      markCodexPlusExtensionNode(panel, "builtin-commands");
      document.body.appendChild(panel);
    }
    panel.textContent = "";
    for (const item of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "codex-plus-command-hint";
      row.setAttribute("role", "option");
      row.innerHTML = `<strong>/${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description || "")}</span>`;
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => {
        codexPlusClearComposer(editor);
        document.execCommand("insertText", false, `/${item.name} `);
        hideCodexPlusCommandHints();
      });
      panel.appendChild(row);
    }
    const rect = editor.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
    panel.style.minWidth = `${Math.round(Math.min(rect.width, 420))}px`;
  }

  // 「已装过」记在本份注入代码里，不记在 window 上：重建后新代码注入到没刷新的页面时，
  // window 上的标记是旧代码留下的，照它跳过就只剩读旧注册表的旧监听器。旧监听器按 window 上存的引用摘掉。
  let codexPlusCommandHandlersInstalled = false;

  function installCodexPlusCommandHandlers() {
    if (codexPlusCommandHandlersInstalled) return;
    codexPlusCommandHandlersInstalled = true;
    if (!document.getElementById("codex-plus-command-hints-style")) {
      const style = document.createElement("style");
      style.id = "codex-plus-command-hints-style";
      markCodexPlusExtensionNode(style, "builtin-commands");
      style.textContent = `#codex-plus-command-hints{position:fixed;z-index:2147483645;display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:var(--color-token-main-surface-primary,var(--codex-plus-bg-elevated,#262626));color:var(--color-token-text-primary,var(--codex-plus-text,#eee));box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13px}
        .codex-plus-command-hint{display:flex;gap:10px;align-items:baseline;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}
        .codex-plus-command-hint:hover,.codex-plus-command-hint:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent)}
        .codex-plus-command-hint span{opacity:.65}`;
      document.head.append(style);
    }
    const onKeyDown = (event) => {
      if (event.isComposing) return;
      const editor = codexPlusComposerEditorFrom(event.target);
      if (!editor) return;
      const text = (editor.innerText || "").trim();
      if (event.key === "Escape") {
        hideCodexPlusCommandHints();
        return;
      }
      if (event.key === "Tab" && document.getElementById("codex-plus-command-hints") && /^\/[\w-]*$/.test(text)) {
        const first = codexPlusExtensionItems(codexPlusRegistry.commands).find((item) => item.name.startsWith(text.slice(1)));
        if (!first) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        codexPlusClearComposer(editor);
        document.execCommand("insertText", false, `/${first.name} `);
        hideCodexPlusCommandHints();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const match = codexPlusCommandPattern.exec(text);
      const command = match && codexPlusFindExtensionCommand(match[1]);
      if (!command) return;
      // 是拓展命令：不让 Codex 把它当消息发出去。
      event.preventDefault();
      event.stopImmediatePropagation();
      hideCodexPlusCommandHints();
      codexPlusClearComposer(editor);
      const result = runCodexPlusExtensionCallback(command.scriptKey, `command./${command.name}`, () => command.run(match[2] || "", {
        editor,
        insertText: (value) => codexPlusInsertComposerText(editor, value),
        setText: (value) => {
          codexPlusClearComposer(editor);
          return codexPlusInsertComposerText(editor, value);
        },
        toast: (message, toastOptions) => showToast(String(message ?? ""), toastOptions || {}),
        sessionId: codexPlusCurrentSessionId(),
      }));
      if (result.ok && result.value && typeof result.value.then === "function") {
        result.value.catch((error) => codexPlusMarkExtensionFailure(command.scriptKey, `command./${command.name}: ${String(error?.stack || error?.message || error)}`));
      }
    };
    const onInput = (event) => {
      const editor = codexPlusComposerEditorFrom(event.target);
      if (!editor) return;
      const text = (editor.innerText || "").trim();
      const prefix = /^\/([\w-]*)$/.exec(text);
      if (prefix && codexPlusRegistry.commands.size) showCodexPlusCommandHints(editor, prefix[1]);
      else hideCodexPlusCommandHints();
    };
    document.removeEventListener("keydown", window.__codexPlusCommandKeyHandler, true);
    document.removeEventListener("input", window.__codexPlusCommandInputHandler, true);
    window.__codexPlusCommandKeyHandler = onKeyDown;
    window.__codexPlusCommandInputHandler = onInput;
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onInput, true);
  }

  /**
   * 拓展注册的菜单项。
   *
   * 接入方式是「在 home 面板末尾追加一块」而不是把内置的一百多行模板拆成数组——
   * 拆模板动的是内置 UI 主干，出问题会影响所有人；追加只影响新内容，回滚时删掉
   * 这个调用即可。
   *
   * 每次 openCodexPlusModal 都会重新调用，所以不需要在别处维护刷新逻辑。
   */
  function renderCodexPlusExtensionMenuRows() {
    const items = codexPlusExtensionItems(codexPlusRegistry.menuItems);
    if (!items.length) return "";
    const rows = items.map((item) => {
      const title = escapeHtml(item.label || item.id);
      const description = escapeHtml(item.description || "");
      // 有 onChange 的渲染成开关，否则渲染成动作按钮。
      let control;
      if (typeof item.onChange === "function") {
        const enabled = typeof item.toggleValue === "function" ? item.toggleValue() === true : false;
        control = `<button type="button" class="codex-plus-toggle" data-codex-plus-ext-setting="${escapeHtml(item.id)}" data-enabled="${String(enabled)}" aria-pressed="${String(enabled)}"><span></span></button>`;
      } else {
        control = `<button type="button" class="codex-plus-action-button" data-codex-plus-ext-action="${escapeHtml(item.id)}">${escapeHtml(item.buttonLabel || "打开")}</button>`;
      }
      return `<div class="codex-plus-row" data-codex-plus-ext-row="${escapeHtml(item.id)}">`
        + `<div><div class="codex-plus-row-title">${title}</div>`
        + (description ? `<div class="codex-plus-row-description">${description}</div>` : "")
        + `</div>${control}</div>`;
    }).join("");
    // 整块包一层：dispose 后能一次性摘掉，测试也好定位。
    return `<div data-codex-plus-ext-menu="true">${rows}</div>`;
  }

  /**
   * 处理拓展菜单项的点击。
   *
   * 由 openCodexPlusModal 的委托监听调用；返回 true 表示已处理，调用方应 return。
   */
  function handleCodexPlusExtensionMenuClick(target) {
    const action = target?.closest?.("[data-codex-plus-ext-action]");
    if (action) {
      const id = action.getAttribute("data-codex-plus-ext-action") || "";
      const item = codexPlusRegistry.menuItems.get(id);
      if (!item) return true;
      runCodexPlusExtensionCallback(item.scriptKey, "menuItem.onActivate", () =>
        item.onActivate({ close: () => document.querySelector(".codex-plus-modal-close")?.click() }));
      return true;
    }
    const toggle = target?.closest?.("[data-codex-plus-ext-setting]");
    if (toggle) {
      const id = toggle.getAttribute("data-codex-plus-ext-setting") || "";
      const item = codexPlusRegistry.menuItems.get(id);
      if (!item) return true;
      const next = toggle.getAttribute("data-enabled") !== "true";
      toggle.setAttribute("data-enabled", String(next));
      toggle.setAttribute("aria-pressed", String(next));
      runCodexPlusExtensionCallback(item.scriptKey, "menuItem.onChange", () => item.onChange(next));
      return true;
    }
    return false;
  }

  /**
   * 会话行「更多操作」里的拓展项。
   *
   * 由 attachButton 在构建 moreMenu 时调用。返回的节点直接 append 进菜单，
   * 所以样式与内置项一致；点击后关闭菜单再执行回调。
   */
  function appendCodexPlusExtensionRowActions(moreMenu, row, moreButton) {
    const items = sessionRowActionItems().filter((item) => item.placement !== "inline");
    if (!items.length) return;
    items.forEach((definition) => {
      // 自绘项：render({ container, session_id, title, close }) 往菜单里的一个容器画（返回的清理函数在菜单拆掉时调用）。
      if (typeof definition.render === "function") {
        const item = document.createElement("div");
        item.className = "codex-session-more-menu-custom";
        item.dataset.codexPlusExtensionItem = definition.id;
        markCodexPlusExtensionNode(item, definition.scriptKey);
        moreMenu.appendChild(item);
        const ref = sessionRefFromRow(row);
        const result = runCodexPlusExtensionCallback(definition.scriptKey, "rowAction.render", () => definition.render({
          container: item,
          row,
          session_id: ref.session_id,
          title: ref.title || row.getAttribute("data-app-action-sidebar-thread-title") || "",
          close: () => closeSessionMoreMenus(),
        }));
        if (result.ok && typeof result.value === "function") item.__codexPlusRowActionCleanup = result.value;
        return;
      }
      const item = createSessionMoreMenuItem(definition.label || definition.id, definition.icon || "◇", (event) => {
        stopActionButtonEvent(row, moreButton, event);
        closeSessionMoreMenus();
        runCodexPlusExtensionCallback(definition.scriptKey, "rowAction.onActivate", () =>
          definition.onActivate(sessionRowActionContext(row, { event })));
      });
      // 加分隔线：拓展项与内置项在语义上没有关联，挨着排会让人以为是一组。
      item.dataset.codexPlusExtensionItem = definition.id;
      markCodexPlusExtensionNode(item, definition.scriptKey);
      moreMenu.appendChild(item);
    });
  }
  /**
   * 消息插槽与侧边面板。
   *
   * 拓展用 registerMessageAction 往每条对话消息的操作行里加按钮，用 registerMessageDecoration
   * 在消息正文下方挂一块自己的内容，用 registerSidePanel 在顶栏加一个开关、在右侧开一个抽屉。
   *
   * 消息节点由 Codex 虚拟化渲染、随滚动与流式输出反复重建，所以这里不缓存任何消息 DOM：每次
   * 刷新都按选择器重新找消息，缺了就补。普通扫描刻意不理会对话内容的变化（流式输出时会扫爆），
   * 所以只在有消息插槽注册时，单独给对话滚动区挂一个去抖观察器；注册项清空时摘掉。
   */
  const codexPlusMessageSlotAttribute = "data-codex-plus-message-slot";
  const codexPlusMessageSlotRefreshDelayMs = 300;

  /** 当前页面上的对话消息：助手消息是带标注目标的消息组，用户消息是带锚点的消息单元。 */
  function codexPlusMessageNodes() {
    const result = [];
    document.querySelectorAll("[data-response-annotation-target]").forEach((node) => {
      if (isExtensionUiNode(node) || !node.querySelector(':scope > [data-conversation-role="assistant"]')) return;
      result.push({ role: "assistant", node });
    });
    document.querySelectorAll("[data-local-conversation-user-anchor]").forEach((node) => {
      if (!isExtensionUiNode(node)) result.push({ role: "user", node });
    });
    return result;
  }

  /** 交给拓展的消息信息。每次现取，不要缓存：同一条消息的文字在流式输出时会变。 */
  function codexPlusMessageInfo(role, node) {
    const unitKey = (node.closest("[data-content-search-unit-key]") || node).getAttribute("data-content-search-unit-key") || "";
    const body = role === "assistant"
      ? node.querySelector('[data-markdown-text-style="assistant-message"]') || node.querySelector('[class*="MarkdownRoot"]')
      : node.querySelector("[data-user-message-bubble]");
    const conversationId = node.getAttribute("data-response-annotation-conversation")
      || node.closest(".thread-scroll-container")?.querySelector("[data-response-annotation-conversation]")?.getAttribute("data-response-annotation-conversation")
      || "";
    return {
      role,
      id: (role === "assistant" && node.getAttribute("data-response-annotation-target")) || unitKey,
      turnId: unitKey.split(":")[0] || "",
      conversationId,
      text: String(body?.textContent || "").trim(),
      element: node,
    };
  }

  /** 一条消息上插槽的挂载位置：操作按钮进原生操作行，装饰放在正文与操作行之间。 */
  function codexPlusMessageSlotHosts(role, node) {
    if (role === "assistant") {
      const actionRow = node.querySelector(":scope > .turn-action-controls");
      return { decorationParent: node, decorationBefore: actionRow, actionParent: actionRow?.firstElementChild || null };
    }
    const group = node.querySelector('[class*="group/user-message"]');
    const bubble = group?.querySelector(":scope > [data-user-message-bubble]");
    const actionRow = group?.querySelector(":scope > .flex-row-reverse");
    return {
      decorationParent: group || null,
      decorationBefore: bubble?.nextElementSibling || null,
      actionParent: actionRow?.querySelector(":scope > .isolate") || actionRow || null,
    };
  }

  function codexPlusMessageItemApplies(item, info) {
    const roles = typeof item.roles === "string" ? [item.roles] : item.roles;
    if (Array.isArray(roles) && roles.length && !roles.includes(info.role)) return false;
    if (typeof item.visible !== "function") return true;
    const result = runCodexPlusExtensionCallback(item.scriptKey, "message.visible", () => item.visible(info));
    return result.ok && result.value !== false;
  }

  function codexPlusMessageSlotChild(parent, slot) {
    return [...parent.children].find((child) => child.getAttribute?.(codexPlusMessageSlotAttribute) === slot) || null;
  }

  function codexPlusRenderMessageActions(parent, role, items, info) {
    let root = codexPlusMessageSlotChild(parent, "actions");
    const visible = items.filter((item) => codexPlusMessageItemApplies(item, info));
    if (!visible.length) {
      root?.remove();
      return;
    }
    const renderKey = visible.map((item) => `${item.id}|${item.label || ""}|${item.icon || ""}`).join("\n");
    if (root?.dataset.renderKey === renderKey) return;
    if (!root) {
      root = document.createElement("span");
      root.setAttribute(codexPlusMessageSlotAttribute, "actions");
      markCodexPlusExtensionNode(root, "builtin-message-slots");
      parent.appendChild(root);
    }
    root.dataset.renderKey = renderKey;
    root.textContent = "";
    // 借原生按钮的类名，悬停、尺寸、显隐都和复制 / 编辑按钮一致。
    const nativeClass = parent.querySelector(`button:not([${codexPlusExtensionConstants.extensionAttribute}])`)?.className || "";
    for (const item of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${nativeClass} codex-plus-message-action`.trim();
      button.setAttribute("aria-label", item.label || item.id);
      markCodexPlusExtensionNode(button, item.scriptKey);
      button.innerHTML = codexPlusExtensionIconMarkup(item);
      attachCodexPlusRailTooltip(button, item.label || item.id, "bottom");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const node = button.closest(role === "assistant" ? "[data-response-annotation-target]" : "[data-local-conversation-user-anchor]");
        if (!node) return;
        runCodexPlusExtensionCallback(item.scriptKey, "messageAction.onActivate", () => item.onActivate?.({
          message: codexPlusMessageInfo(role, node),
          close: () => hideCodexPlusRailTooltip(),
        }));
      });
      root.appendChild(button);
    }
  }

  function codexPlusRenderMessageDecorations(hosts, role, items, info) {
    const parent = hosts.decorationParent;
    if (!parent) return;
    let root = codexPlusMessageSlotChild(parent, "decorations");
    const applicable = items.filter((item) => codexPlusMessageItemApplies(item, info));
    if (!applicable.length) {
      root?.remove();
      return;
    }
    // 文字变了（流式输出、编辑后重发）才重画；只比长度和结尾，避免每轮都拼整段字符串。
    const renderKey = `${applicable.map((item) => item.id).join("\n")}|${info.id}|${info.text.length}|${info.text.slice(-32)}`;
    if (!root) {
      root = document.createElement("div");
      root.className = "codex-plus-message-decorations";
      root.dataset.role = role;
      root.setAttribute(codexPlusMessageSlotAttribute, "decorations");
      markCodexPlusExtensionNode(root, "builtin-message-slots");
    }
    // React 重排后操作行可能跑到装饰前面：每次都校正位置（位置已对时不动 DOM）。
    const before = hosts.decorationBefore && hosts.decorationBefore !== root && hosts.decorationBefore.parentElement === parent
      ? hosts.decorationBefore
      : null;
    if (root.parentElement !== parent || (before ? root.nextElementSibling !== before : parent.lastElementChild !== root)) {
      parent.insertBefore(root, before);
    }
    if (root.dataset.renderKey === renderKey) return;
    root.dataset.renderKey = renderKey;
    root.textContent = "";
    for (const item of applicable) {
      const container = document.createElement("div");
      container.className = "codex-plus-message-decoration";
      markCodexPlusExtensionNode(container, item.scriptKey);
      root.appendChild(container);
      runCodexPlusExtensionCallback(item.scriptKey, "messageDecoration.render", () => item.render({ message: info, container }));
    }
  }

  function installCodexPlusSlotStyle() {
    if (document.getElementById("codex-plus-slot-style")) return;
    const style = document.createElement("style");
    style.id = "codex-plus-slot-style";
    markCodexPlusExtensionNode(style, "builtin-message-slots");
    style.textContent = `[data-codex-plus-message-slot="actions"]{display:contents}
      .codex-plus-message-action .codex-plus-ext-icon,.codex-plus-message-action svg{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;font-size:14px;line-height:1}
      .codex-plus-message-decorations{display:flex;flex-direction:column;gap:6px;margin-top:8px;min-width:0}
      .codex-plus-message-decorations[data-role="user"]{align-self:flex-end;align-items:flex-end;max-width:var(--user-chat-width,100%)}
      .codex-plus-message-decoration:empty,.codex-plus-message-decorations:has(> .codex-plus-message-decoration:empty:only-child){display:none}
      html[data-codex-plus-side-panel-open] main[data-app-shell-main-surface]{margin-right:var(--codex-plus-side-panel-width,360px)!important}
      .codex-plus-side-panel{position:fixed;right:0;bottom:0;top:var(--codex-plus-side-panel-top,44px);width:var(--codex-plus-side-panel-width,360px);z-index:40;display:flex;flex-direction:column;min-height:0;background:var(--color-token-main-surface-primary,var(--color-token-bg-primary,Canvas));color:var(--color-token-text-primary,CanvasText);border-left:1px solid var(--color-token-border-light,color-mix(in srgb,currentColor 12%,transparent))}
      .codex-plus-side-panel-header{display:flex;align-items:center;gap:8px;height:40px;padding:0 8px 0 14px;flex:none;border-bottom:1px solid var(--color-token-border-light,color-mix(in srgb,currentColor 10%,transparent))}
      .codex-plus-side-panel-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .codex-plus-side-panel-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--color-token-text-secondary,currentColor);cursor:pointer}
      .codex-plus-side-panel-close:hover{background:var(--color-token-list-hover-background,color-mix(in srgb,currentColor 10%,transparent))}
      .codex-plus-side-panel-body{flex:1;min-height:0;overflow:auto;padding:12px 14px}
      .codex-plus-side-panel-toggle .codex-plus-ext-icon,.codex-plus-side-panel-toggle svg{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;font-size:14px;line-height:1}
      .codex-plus-side-panel-toggle[aria-pressed="true"]{background:var(--color-token-list-hover-background,color-mix(in srgb,currentColor 12%,transparent))}
      .codex-plus-ui-slot{display:flex;flex-direction:column;gap:6px;min-width:0}
      .codex-plus-ui-slot:not(:has(.codex-plus-ui-slot-item:not(:empty):not(:has(> [data-hidden="true"]:only-child)))){display:none}
      .codex-plus-ui-slot-item:has(> [data-hidden="true"]:only-child){display:none}
      .codex-plus-ui-slot-item:empty{display:none}
      [data-codex-plus-ui-slot="composer.above"]{margin:0 0 8px}
      [data-codex-plus-ui-slot="thread.top"],[data-codex-plus-ui-slot="thread.bottom"]{width:min(100%,var(--thread-content-max-width,768px));margin:12px auto;padding:0 16px;box-sizing:border-box}
      [data-codex-plus-ui-slot="sidebar.top"],[data-codex-plus-ui-slot="sidebar.bottom"]{padding:6px 8px}
      [data-codex-plus-ui-slot="titlebar"]{display:contents}
      [data-codex-plus-ui-slot="titlebar"] .codex-plus-ui-slot-item{display:contents}
      [data-codex-plus-ui-slot="turn.after"]{margin-top:6px}
      [data-codex-plus-ui-slot="sessionRow.prefix"],[data-codex-plus-ui-slot="sessionRow.suffix"]{flex-direction:row;align-items:center;flex:none;gap:4px}
      [data-codex-plus-ui-slot="sessionRow.prefix"]{margin-right:4px}
      [data-codex-plus-ui-slot="sessionRow.suffix"]{margin-left:4px}
      [data-codex-plus-ui-slot="composer.left"],[data-codex-plus-ui-slot="composer.right"],[data-codex-plus-ui-slot="header.title"],[data-codex-plus-ui-slot="sidebar.section"],[data-codex-plus-ui-slot="projectRow.suffix"]{flex-direction:row;align-items:center;flex:none;gap:4px}
      [data-codex-plus-ui-slot="composer.right"]{margin-right:4px}
      [data-codex-plus-ui-slot="composer.model"]{flex-direction:row;align-items:center;flex:none;gap:4px;margin-left:2px}
      [data-codex-plus-ui-slot="settings.nav"]{gap:2px}
      .codex-plus-settings-nav-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;cursor:pointer}
      [data-codex-plus-ui-slot="header.title"]{margin-left:6px}
      [data-codex-plus-ui-slot="composer.below"]{margin:6px 0 0}
      [data-codex-plus-ui-slot="home.above"]{margin:0 0 10px}
      [data-codex-plus-ui-slot="approval"]{padding:0 16px 12px}
      [data-codex-plus-ui-slot="activity.after"]{margin:4px 0 2px}
      [data-codex-plus-ui-slot="overlay"]{position:fixed;inset:0;z-index:2147483600;pointer-events:none}
      [data-codex-plus-ui-slot="overlay"] .codex-plus-ui-slot-item>*{pointer-events:auto}`;
    document.head.append(style);
  }

  let codexPlusMessageSlotsRendered = false;
  let codexPlusMessageObserver = null;
  let codexPlusMessageObserverTargets = [];
  let codexPlusMessageRefreshTimer = 0;

  function scheduleCodexPlusMessageSlotsRefresh() {
    if (codexPlusMessageRefreshTimer) return;
    codexPlusMessageRefreshTimer = setTimeout(() => {
      codexPlusMessageRefreshTimer = 0;
      refreshCodexPlusMessageSlots();
      // 对话区里的界面插槽（每轮末尾、对话顶部 / 底部）也跟着对话内容走：切会话、新一轮出现时补上。
      if (codexPlusHasThreadUiSlots()) refreshCodexPlusUiSlots();
    }, codexPlusMessageSlotRefreshDelayMs);
  }

  /** 只是我们自己的节点在变就不理，否则「写入 → 观察到 → 再写入」会自喂（issue #1960）。 */
  function codexPlusMutationIsOurs(mutation) {
    const own = (node) => isCodexPlusExtensionNode(node?.nodeType === 1 ? node : node?.parentElement);
    if (own(mutation.target)) return true;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length > 0 && changed.every((node) => node.nodeType === 1 && isCodexPlusExtensionNode(node));
  }

  /** Codex 的多个标签页各有一个对话滚动区（非当前的隐藏着），全部观察：切标签时不漏。 */
  function syncCodexPlusMessageObserver(active) {
    const targets = active ? [...document.querySelectorAll(".thread-scroll-container")] : [];
    if (targets.length === codexPlusMessageObserverTargets.length && targets.every((node, index) => node === codexPlusMessageObserverTargets[index])) return;
    codexPlusMessageObserver?.disconnect();
    codexPlusMessageObserverTargets = targets;
    if (!targets.length) return;
    codexPlusMessageObserver ||= new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !codexPlusMutationIsOurs(mutation))) scheduleCodexPlusMessageSlotsRefresh();
    });
    for (const target of targets) codexPlusMessageObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  /** 有没有挂在对话区里的界面插槽：它们和消息插槽共用对话区的观察器。 */
  function codexPlusHasThreadUiSlots() {
    return codexPlusExtensionItems(codexPlusRegistry.slots).some((item) => ["thread.top", "thread.bottom", "turn.after", "composer.above", "approval", "activity.after"].includes(item.slot));
  }

  function refreshCodexPlusMessageSlots() {
    const actions = codexPlusExtensionItems(codexPlusRegistry.messageActions);
    const decorations = codexPlusExtensionItems(codexPlusRegistry.messageDecorations);
    const active = actions.length > 0 || decorations.length > 0;
    syncCodexPlusMessageObserver(active || codexPlusHasThreadUiSlots());
    if (!active) {
      if (codexPlusMessageSlotsRendered) {
        document.querySelectorAll(`[${codexPlusMessageSlotAttribute}]`).forEach((node) => node.remove());
        codexPlusMessageSlotsRendered = false;
      }
      return;
    }
    installCodexPlusSlotStyle();
    codexPlusMessageSlotsRendered = true;
    for (const { role, node } of codexPlusMessageNodes()) {
      const info = codexPlusMessageInfo(role, node);
      const hosts = codexPlusMessageSlotHosts(role, node);
      if (hosts.actionParent) codexPlusRenderMessageActions(hosts.actionParent, role, actions, info);
      codexPlusRenderMessageDecorations(hosts, role, decorations, info);
    }
  }

  /**
   * 侧边面板：同一时间只开一个。面板挂在 body 上（不进 React 管的树），打开时给 html 打标记，
   * 由样式把 Codex 主区域往左让出面板宽度。开关按钮放在标题栏右上角「新建标签页」按钮前面
   * （首页和会话页都有）；找不到时退到会话顶栏右侧按钮组的最前面。
   */
  let codexPlusOpenSidePanelState = null;

  function codexPlusSidePanelToolbar() {
    const layoutToggle = [...document.querySelectorAll("button[data-app-shell-workspace-layout-toggle]")].find((node) => visibleElement(node));
    const wrapper = layoutToggle?.parentElement;
    if (wrapper?.parentElement) return { host: wrapper.parentElement, before: wrapper, sample: layoutToggle };
    const cluster = [...document.querySelectorAll("[data-app-shell-header-toolbar] > .ms-auto")].find((node) => visibleElement(node));
    if (!cluster) return null;
    return { host: cluster, before: cluster.firstChild, sample: cluster.querySelector(`button:not([${codexPlusExtensionConstants.extensionAttribute}])`) };
  }

  function codexPlusSidePanelWidth(definition) {
    const width = Number(definition?.width);
    return Number.isFinite(width) ? Math.min(720, Math.max(240, Math.round(width))) : 360;
  }

  /** 面板从主区域顶边开始，不盖住顶栏（开关按钮就在顶栏里）。隐藏标签页的 main 尺寸为 0，跳过。 */
  function syncCodexPlusSidePanelTop() {
    const main = [...document.querySelectorAll("main[data-app-shell-main-surface]")].find((node) => node.getBoundingClientRect().width > 0);
    const toolbar = document.querySelector("[data-app-shell-header-toolbar]");
    const top = main
      ? Math.max(0, Math.round(main.getBoundingClientRect().top))
      : toolbar ? Math.round(toolbar.getBoundingClientRect().bottom) : 44;
    document.documentElement.style.setProperty("--codex-plus-side-panel-top", `${top}px`);
  }

  function closeCodexPlusSidePanel() {
    const state = codexPlusOpenSidePanelState;
    if (!state) return false;
    codexPlusOpenSidePanelState = null;
    if (typeof state.cleanup === "function") {
      runCodexPlusExtensionCallback(state.scriptKey, "sidePanel.cleanup", state.cleanup);
    }
    state.panel.remove();
    delete document.documentElement.dataset.codexPlusSidePanelOpen;
    document.documentElement.style.removeProperty("--codex-plus-side-panel-width");
    refreshCodexPlusSidePanels();
    return true;
  }

  function openCodexPlusSidePanel(id) {
    const definition = codexPlusRegistry.sidePanels.get(id);
    if (!definition) return false;
    if (codexPlusOpenSidePanelState?.id === id) return true;
    closeCodexPlusSidePanel();
    installCodexPlusSlotStyle();
    const title = String(definition.title || definition.label || id);
    const panel = document.createElement("aside");
    panel.className = "codex-plus-side-panel";
    panel.dataset.codexPlusSidePanel = id;
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", title);
    markCodexPlusExtensionNode(panel, definition.scriptKey);
    panel.innerHTML = `<div class="codex-plus-side-panel-header"><span class="codex-plus-side-panel-title">${escapeHtml(title)}</span><button type="button" class="codex-plus-side-panel-close" aria-label="关闭"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="codex-plus-side-panel-body"></div>`;
    panel.querySelector(".codex-plus-side-panel-close").addEventListener("click", () => closeCodexPlusSidePanel());
    document.documentElement.style.setProperty("--codex-plus-side-panel-width", `${codexPlusSidePanelWidth(definition)}px`);
    document.documentElement.dataset.codexPlusSidePanelOpen = "true";
    syncCodexPlusSidePanelTop();
    document.body.appendChild(panel);
    const state = { id, scriptKey: definition.scriptKey, panel, cleanup: null };
    codexPlusOpenSidePanelState = state;
    const container = panel.querySelector(".codex-plus-side-panel-body");
    const result = runCodexPlusExtensionCallback(definition.scriptKey, "sidePanel.render", () => definition.render({
      container,
      close: () => {
        if (codexPlusOpenSidePanelState === state) closeCodexPlusSidePanel();
      },
    }));
    if (result.ok && typeof result.value === "function") state.cleanup = result.value;
    refreshCodexPlusSidePanels();
    return true;
  }

  function toggleCodexPlusSidePanel(id) {
    return codexPlusOpenSidePanelState?.id === id ? closeCodexPlusSidePanel() : openCodexPlusSidePanel(id);
  }

  function refreshCodexPlusSidePanels() {
    const items = codexPlusExtensionItems(codexPlusRegistry.sidePanels);
    const openId = codexPlusOpenSidePanelState?.id || "";
    // 面板的注册被撤销（拓展卸载、热重载）时一并关掉。
    if (openId && !codexPlusRegistry.sidePanels.has(openId)) {
      closeCodexPlusSidePanel();
      return;
    }
    // 面板被别的代码摘掉了（例如 body 被整体重建）：重新挂回去，内容仍是拓展上次画的。
    if (openId && !codexPlusOpenSidePanelState.panel.isConnected) document.body.appendChild(codexPlusOpenSidePanelState.panel);
    if (openId) syncCodexPlusSidePanelTop();
    const toolbar = items.length ? codexPlusSidePanelToolbar() : null;
    document.querySelectorAll("[data-codex-plus-side-panel-toggles]").forEach((node) => {
      if (node.parentElement !== toolbar?.host) node.remove();
    });
    if (!toolbar) return;
    installCodexPlusSlotStyle();
    let root = [...toolbar.host.children].find((node) => node.hasAttribute?.("data-codex-plus-side-panel-toggles"));
    if (!root) {
      root = document.createElement("div");
      root.style.display = "contents";
      root.setAttribute("data-codex-plus-side-panel-toggles", "");
      markCodexPlusExtensionNode(root, "builtin-side-panels");
      toolbar.host.insertBefore(root, toolbar.before && toolbar.before.parentElement === toolbar.host ? toolbar.before : null);
    }
    const renderKey = `${openId}\n${items.map((item) => `${item.id}|${item.title || ""}|${item.icon || ""}`).join("\n")}`;
    if (root.dataset.renderKey === renderKey) return;
    root.dataset.renderKey = renderKey;
    root.textContent = "";
    const nativeClass = toolbar.sample?.className || "";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${nativeClass} codex-plus-side-panel-toggle`.trim();
      const label = String(item.title || item.label || item.id);
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", item.id === openId ? "true" : "false");
      markCodexPlusExtensionNode(button, item.scriptKey);
      button.innerHTML = codexPlusExtensionIconMarkup(item);
      attachCodexPlusRailTooltip(button, label, "bottom");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        hideCodexPlusRailTooltip();
        toggleCodexPlusSidePanel(item.id);
      });
      root.appendChild(button);
    }
  }

  /** 注册侧边面板；返回的撤销函数上带 open / close，拓展可以自己控制开合。 */
  function codexPlusRegisterExtensionSidePanel(definition, options = {}) {
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const id = `${scriptKey}:sidePanel:${options.id || codexPlusExtensionIdSeed()}`;
    const dispose = registerCodexPlusExtension("sidePanel", codexPlusRegistry.sidePanels, id, definition, scriptKey);
    codexPlusRefreshExtensionHosts();
    const handle = () => {
      dispose();
      codexPlusRefreshExtensionHosts();
    };
    handle.open = () => openCodexPlusSidePanel(id);
    handle.close = () => (codexPlusOpenSidePanelState?.id === id ? closeCodexPlusSidePanel() : false);
    handle.toggle = () => toggleCodexPlusSidePanel(id);
    return handle;
  }

  /**
   * 通用界面插槽：拓展用 registerSlot({ slot, render }) 往 Codex 界面的固定位置放自己的内容。
   *
   * 位置：composer.above（输入框上方）、thread.top / thread.bottom（对话区顶部 / 底部）、
   * sidebar.top / sidebar.bottom（左侧栏列表顶部 / 底部）、titlebar（标题栏右侧按钮组）、
   * turn.after（每一轮对话的末尾，render 收到 turnKey）、sessionRow.prefix / sessionRow.suffix
   * （侧栏每个会话行标题前 / 后，render 收到 sessionId、title）、overlay（铺满窗口的浮层，默认不挡点击）、
   * activity.after（对话里每个活动条目——命令、工具 / 子 agent 调用、出错、推理——的末尾，render 收到
   * kind、itemIds、text；条目在 Codex 折叠的「用时 Ns」里，展开后才渲染）、
   * composer.left / composer.right（输入框底栏左侧按钮组末尾 / 右侧按钮组开头）、composer.below（输入框下方）、
   * home.above（新对话首页输入框上方）、header.title（顶栏标题后面）、approval（审批卡片底部，render 收到 kind）、
   * projectRow.suffix（侧栏项目行名称后，render 收到 projectId、label）、sidebar.section（侧栏分组标题右侧，
   * render 收到 section）。
   * 每个位置一个带拓展标记的宿主节点，里面每个注册项一个容器；容器新建时调用 render（DOM 会随 Codex 重建，
   * 重建后会再调一次），render 返回的函数在该项被撤下时调用。注册返回的句柄带 refresh() 主动重画。
   */
  const codexPlusUiSlotNames = [
    "composer.above", "composer.below", "composer.left", "composer.right", "composer.model", "home.above", "settings.nav",
    "thread.top", "thread.bottom", "turn.after", "header.title", "titlebar", "approval",
    "sidebar.top", "sidebar.bottom", "sidebar.section", "sessionRow.prefix", "sessionRow.suffix", "projectRow.suffix",
    "overlay",
    "activity.after",
  ];
  const codexPlusUiSlotVersions = new Map();

  function codexPlusUiSlotAnchors(slot) {
    const visible = (selector) => [...document.querySelectorAll(selector)].filter((node) => visibleElement(node) && !isExtensionUiNode(node));
    switch (slot) {
      // place：start（最前）、end（最后），或一个兄弟节点（放在它前面）。
      case "composer.above":
        return visible("[data-codex-composer-root]").map((node) => ({ parent: node.parentElement, place: node }));
      case "thread.top":
      case "thread.bottom":
        // 对话内容层的末尾是一个给输入框让位的粘底空白层；底部插槽放在它前面，紧跟最后一条消息。
        return visible(".thread-scroll-container").map((scroll) => scroll.firstElementChild).filter(Boolean)
          .map((content) => ({
            parent: content,
            place: slot === "thread.top"
              ? "start"
              : [...content.children].find((child) => child.classList.contains("sticky") && !isExtensionUiNode(child)) || "end",
          }));
      case "sidebar.top":
      case "sidebar.bottom":
        return visible("[data-app-action-sidebar-scroll]")
          .map((list) => ({ parent: list, place: slot === "sidebar.top" ? "start" : "end" }));
      case "turn.after":
        // 每一轮的容器带 data-turn-key（虚拟列表只渲染可见的几轮）。
        return visible(".thread-scroll-container [data-turn-key]")
          .map((turn) => ({ parent: turn, place: "end", info: { turnKey: turn.getAttribute("data-turn-key") || "" } }));
      case "sessionRow.prefix":
      case "sessionRow.suffix":
        return visible("[data-app-action-sidebar-thread-row]").flatMap((row) => {
          const title = row.querySelector("[data-thread-title-trigger]");
          if (!title?.parentElement) return [];
          const info = {
            sessionId: String(row.getAttribute("data-app-action-sidebar-thread-id") || "").replace(/^local:/, ""),
            title: row.getAttribute("data-app-action-sidebar-thread-title") || "",
          };
          const next = title.nextElementSibling;
          return [{ parent: title.parentElement, place: slot === "sessionRow.prefix" ? title : (next && !isExtensionUiNode(next) ? next : "end"), info }];
        });
      case "composer.below":
        return visible("[data-codex-composer-root]").map((node) => ({ parent: node, place: "end" }));
      case "composer.left":
        // 底栏左侧按钮组（添加内容、权限……）：「添加内容」按钮所在的那一行 flex。
        return visible("[data-composer-footer-responsive]")
          .map((footer) => {
            // 只认带「添加内容 / 权限」的那一行；首页顶上的工作区栏（项目、运行位置）也带导航目标，不算。
            const row = footer.querySelector('[data-composer-navigation-target="add-context"], [data-composer-navigation-target="permissions"]')?.closest("div.flex");
            return row && footer.contains(row) ? row : null;
          })
          .filter(Boolean)
          .map((row) => ({ parent: row, place: "end" }));
      case "composer.right":
        // 底栏右侧按钮组（发送）：放在最前面。
        return visible('[data-composer-footer-responsive] > [class*="col-start-3"]')
          .map((group) => group.querySelector(":scope div.shrink-0.items-center"))
          .filter(Boolean)
          .map((row) => ({ parent: row, place: "start" }));
      case "composer.model": {
        // 模型 / 推理强度选择按钮后面。
        // 按钮外面包着一层提示用的 span，挂在包着它的那一行 flex 里、紧跟在这一项后面。
        return visible('[data-composer-navigation-target="reasoning"]').flatMap((button) => {
          const row = button.parentElement?.closest("div.flex");
          if (!row) return [];
          const item = [...row.children].find((child) => child.contains(button));
          const next = item?.nextElementSibling;
          return [{ parent: row, place: next && !isExtensionUiNode(next) ? next : "end" }];
        });
      }
      case "settings.nav": {
        // Codex 设置页左侧导航（各项带 data-settings-panel-slug）的末尾；sampleClass 是原生导航项的类名，可以借来对齐样式。
        const items = visible("[data-settings-panel-slug]");
        if (!items.length) return [];
        let list = items[0].parentElement;
        while (list && !items.every((item) => list.contains(item))) list = list.parentElement;
        if (!list) return [];
        return [{ parent: list, place: "end", info: { sampleClass: items[0].className || "" } }];
      }
      case "home.above":
        return visible('[data-codex-composer-root][data-composer-placement="home"]').map((node) => ({ parent: node.parentElement, place: node }));
      case "header.title":
        return visible("[data-app-shell-titlebar-content]").map((node) => ({ parent: node, place: "end" }));
      case "approval":
        return visible("[data-codex-approval-surface]").map((card) => ({
          parent: card,
          place: "end",
          info: { kind: card.tagName === "FORM" || card.querySelector("form") ? "form" : "card" },
        }));
      case "sidebar.section":
        return visible("[data-app-action-sidebar-section]").flatMap((section) => {
          const actions = section.querySelector(':scope [class*="nav-section-title"] > div.shrink-0');
          return actions ? [{ parent: actions, place: "start", info: { section: section.getAttribute("data-app-action-sidebar-section-heading") || "" } }] : [];
        });
      case "projectRow.suffix":
        return visible("[data-app-action-sidebar-project-row]").flatMap((row) => {
          const label = row.querySelector("[data-marquee-text]")?.parentElement;
          if (!label?.parentElement) return [];
          return [{
            parent: label.parentElement,
            place: label.nextElementSibling && !isExtensionUiNode(label.nextElementSibling) ? label.nextElementSibling : "end",
            info: {
              projectId: row.getAttribute("data-app-action-sidebar-project-id") || "",
              label: row.getAttribute("data-app-action-sidebar-project-label") || "",
            },
          }];
        });
      case "overlay":
        return document.body ? [{ parent: document.body, place: "end" }] : [];
      case "activity.after":
        // 活动条目带 data-local-conversation-item-target-ids（空格分隔的条目 id，前缀即类型）；挂在条目自己里面的末尾。
        return visible(".thread-scroll-container [data-local-conversation-item-target-ids]").map((item) => {
          const itemIds = String(item.getAttribute("data-local-conversation-item-target-ids") || "").split(/\s+/).filter(Boolean);
          return { parent: item, place: "end", info: { kind: codexPlusActivityKind(itemIds[0] || ""), itemIds, text: (item.innerText || "").trim().slice(0, 300) } };
        });
      case "titlebar": {
        const toolbar = codexPlusSidePanelToolbar();
        if (!toolbar) return [];
        return [{ parent: toolbar.host, place: toolbar.before && toolbar.before.parentElement === toolbar.host ? toolbar.before : "end" }];
      }
      default:
        return [];
    }
  }

  /** 活动条目 id 的前缀 → 类型。 */
  function codexPlusActivityKind(id) {
    if (/^exec-/.test(id)) return "command";
    if (/^turn-error-/.test(id)) return "error";
    if (/plan/i.test(id)) return "plan";
    if (/reason/i.test(id)) return "reasoning";
    if (/patch|file-?change/i.test(id)) return "fileChange";
    if (/^call_|^fc_|tool|mcp/i.test(id)) return "toolCall";
    return "other";
  }

  function codexPlusRunSlotCleanup(node) {
    const cleanup = node.__codexPlusSlotCleanup;
    node.__codexPlusSlotCleanup = null;
    if (typeof cleanup === "function") runCodexPlusExtensionCallback(node.dataset.scriptKey || "", "slot.cleanup", cleanup);
  }

  let codexPlusUiSlotsRendered = false;

  function refreshCodexPlusUiSlots() {
    const items = codexPlusExtensionItems(codexPlusRegistry.slots);
    if (!items.length) {
      if (codexPlusUiSlotsRendered) {
        document.querySelectorAll("[data-codex-plus-ui-slot]").forEach((host) => {
          host.querySelectorAll("[data-codex-plus-slot-item]").forEach(codexPlusRunSlotCleanup);
          host.remove();
        });
        codexPlusUiSlotsRendered = false;
      }
      return;
    }
    codexPlusUiSlotsRendered = true;
    installCodexPlusSlotStyle();
    for (const slot of codexPlusUiSlotNames) {
      const slotItems = items.filter((item) => item.slot === slot);
      const anchors = slotItems.length ? codexPlusUiSlotAnchors(slot) : [];
      const parents = new Set(anchors.map((anchor) => anchor.parent));
      document.querySelectorAll(`[data-codex-plus-ui-slot="${slot}"]`).forEach((host) => {
        if (parents.has(host.parentElement)) return;
        host.querySelectorAll("[data-codex-plus-slot-item]").forEach(codexPlusRunSlotCleanup);
        host.remove();
      });
      for (const { parent, place, info } of anchors) {
        if (!parent) continue;
        let host = [...parent.children].find((node) => node.getAttribute?.("data-codex-plus-ui-slot") === slot);
        if (!host) {
          host = document.createElement("div");
          host.className = "codex-plus-ui-slot";
          host.setAttribute("data-codex-plus-ui-slot", slot);
          markCodexPlusExtensionNode(host, "builtin-ui-slots");
        }
        // 位置不对（Codex 重排了兄弟节点）时挪回去；位置已对时不动 DOM。
        if (place === "start") {
          if (parent.firstChild !== host) parent.insertBefore(host, parent.firstChild);
        } else if (place === "end" || !place || place.parentElement !== parent) {
          if (parent.lastChild !== host) parent.appendChild(host);
        } else if (host.nextSibling !== place) {
          parent.insertBefore(host, place);
        }
        const wanted = new Set(slotItems.map((item) => item.id));
        for (const child of [...host.children]) {
          if (!wanted.has(child.dataset.slotItemId)) {
            codexPlusRunSlotCleanup(child);
            child.remove();
          }
        }
        // 按注册顺序就位：只在顺序不对时挪动，已就位的节点不碰（挪动会让里面的输入框失焦）。
        let previous = null;
        const placeAfterPrevious = (container) => {
          const expected = previous ? previous.nextElementSibling : host.firstElementChild;
          if (expected !== container) host.insertBefore(container, expected);
          previous = container;
        };
        for (const item of slotItems) {
          const version = String(codexPlusUiSlotVersions.get(item.id) || 0);
          let container = [...host.children].find((child) => child.dataset.slotItemId === item.id);
          // 同一个宿主换了归属（会话行被复用给别的会话）时整项重画。
          const infoKey = info ? JSON.stringify(info) : "";
          if (container && container.dataset.slotVersion === version && (container.__codexPlusSlotInfo ?? "") === infoKey) {
            placeAfterPrevious(container);
            continue;
          }
          if (container) {
            codexPlusRunSlotCleanup(container);
            container.textContent = "";
          } else {
            container = document.createElement("div");
            container.className = "codex-plus-ui-slot-item";
            container.setAttribute("data-codex-plus-slot-item", "");
            container.dataset.slotItemId = item.id;
            container.dataset.scriptKey = item.scriptKey;
            markCodexPlusExtensionNode(container, item.scriptKey);
          }
          container.dataset.slotVersion = version;
          container.__codexPlusSlotInfo = infoKey;
          placeAfterPrevious(container);
          const result = runCodexPlusExtensionCallback(item.scriptKey, "slot.render", () => item.render({ container, slot, ...(info || {}) }));
          if (result.ok && typeof result.value === "function") container.__codexPlusSlotCleanup = result.value;
        }
      }
    }
  }

  /** 注册界面插槽；返回的撤销函数上带 refresh()，强制所有位置重画该项。 */
  function codexPlusRegisterExtensionSlot(definition, options = {}) {
    if (!codexPlusUiSlotNames.includes(definition?.slot)) {
      throw new Error(`未知的插槽位置 ${definition?.slot}，可用：${codexPlusUiSlotNames.join("、")}`);
    }
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const id = `${scriptKey}:slot:${options.id || codexPlusExtensionIdSeed()}`;
    const dispose = registerCodexPlusExtension("slot", codexPlusRegistry.slots, id, definition, scriptKey);
    codexPlusRefreshExtensionHosts();
    const handle = () => {
      dispose();
      codexPlusUiSlotVersions.delete(id);
      codexPlusRefreshExtensionHosts();
    };
    handle.refresh = () => {
      codexPlusUiSlotVersions.set(id, (codexPlusUiSlotVersions.get(id) || 0) + 1);
      refreshCodexPlusUiSlots();
    };
    return handle;
  }
  /**
   * 拓展的输入触发、快捷键、主题与向用户提问。
   *
   * - 输入触发：registerInputTrigger({ trigger: "#", items(query) => [{ label, description?, insert }] })。
   *   @、$、/ 是 Codex 自己的提及与命令，不让拓展占用。
   *   输入框里光标前是「触发符 + 查询词」时弹出候选，选中后把这一段换成 insert。
   * - 快捷键：registerShortcut({ key: "Mod+Shift+K", run, allowInInput? })。Mod 在 macOS 是 ⌘，其余是 Ctrl。
   * - 主题：registerTheme({ id, name, variables: { "--x": "值" }, css })，同一时间只有一个生效，选择记在本机。
   * - 提问：codexPlusAsk({ title, message, options?, input? }) → 用户的回答，取消时为 null。后台经 CDP 也能调。
   */

  // ---------------------------------------------------------------- 输入触发
  const codexPlusTriggerPattern = /^[#%&~!^:+][\w-]{0,7}$/;
  /** Codex 自己占用的触发符：@ 提及文件 / 应用，$ 提及技能，/ 是斜杠命令。拓展抢这些只会和原生菜单打架。 */
  const codexPlusReservedTriggers = /^[@$/]/;
  let codexPlusTriggerState = null;

  // 「已装过」记在本份注入代码里（见 installCodexPlusCommandHandlers 的说明）。
  let codexPlusInputTriggerHandlersInstalled = false;
  let codexPlusShortcutHandlerInstalled = false;

  function codexPlusRegisterInputTrigger(definition, options = {}) {
    const trigger = String(definition?.trigger || "");
    if (codexPlusReservedTriggers.test(trigger)) throw new Error(`触发符 ${trigger[0]} 是 Codex 自己在用的（@ 提及、$ 技能、/ 命令），换一个，例如 "#"`);
    if (!codexPlusTriggerPattern.test(trigger)) throw new Error("trigger 是一个符号开头的短前缀，例如 \"#\"、\"%\"、\"#issue\"");
    if (typeof definition?.items !== "function") throw new Error(`输入触发 ${trigger} 需要 items(query) 返回候选`);
    const dispose = codexPlusRegisterExtensionItem("inputTrigger", codexPlusRegistry.inputTriggers, { ...definition, trigger }, options);
    installCodexPlusInputTriggerHandlers();
    return dispose;
  }

  /** 光标前的文字（只看光标所在的文本节点，够用且不受富文本结构影响）。 */
  function codexPlusTextBeforeCaret(editor) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
    const node = selection.anchorNode;
    if (!node || !editor.contains(node) || node.nodeType !== Node.TEXT_NODE) return null;
    return node.textContent.slice(0, selection.anchorOffset);
  }

  function codexPlusMatchInputTrigger(before) {
    let best = null;
    for (const item of codexPlusExtensionItems(codexPlusRegistry.inputTriggers)) {
      const index = before.lastIndexOf(item.trigger);
      if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) continue;
      const query = before.slice(index + item.trigger.length);
      if (/\s/.test(query) || query.length > 64) continue;
      if (!best || index > best.index || (index === best.index && item.trigger.length > best.item.trigger.length)) best = { item, index, query };
    }
    return best;
  }

  function hideCodexPlusTriggerHints() {
    codexPlusTriggerState = null;
    document.getElementById("codex-plus-input-trigger-hints")?.remove();
  }

  function codexPlusAcceptTrigger(choice) {
    const state = codexPlusTriggerState;
    if (!state || !choice) return;
    const { editor, match } = state;
    hideCodexPlusTriggerHints();
    editor.focus();
    const selection = window.getSelection();
    const length = match.item.trigger.length + match.query.length;
    for (let index = 0; index < length; index += 1) selection.modify("extend", "backward", "character");
    document.execCommand("insertText", false, String(choice.insert ?? choice.label ?? ""));
    if (typeof choice.onSelect === "function") runCodexPlusExtensionCallback(match.item.scriptKey, "inputTrigger.onSelect", () => choice.onSelect());
  }

  function renderCodexPlusTriggerHints() {
    const state = codexPlusTriggerState;
    if (!state) return;
    if (!state.items.length) {
      document.getElementById("codex-plus-input-trigger-hints")?.remove();
      return;
    }
    let panel = document.getElementById("codex-plus-input-trigger-hints");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "codex-plus-input-trigger-hints";
      panel.className = "codex-plus-hint-panel";
      panel.setAttribute("role", "listbox");
      markCodexPlusExtensionNode(panel, "builtin-input-triggers");
      document.body.appendChild(panel);
    }
    panel.textContent = "";
    state.items.forEach((choice, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "codex-plus-command-hint";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === state.active));
      row.innerHTML = `<strong>${escapeHtml(String(choice.label ?? choice.insert ?? ""))}</strong><span>${escapeHtml(String(choice.description || ""))}</span>`;
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => codexPlusAcceptTrigger(choice));
      panel.appendChild(row);
    });
    const rect = state.editor.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
    panel.style.minWidth = `${Math.round(Math.min(rect.width, 420))}px`;
  }

  async function updateCodexPlusTriggerHints(editor) {
    const before = codexPlusTextBeforeCaret(editor);
    const match = before === null ? null : codexPlusMatchInputTrigger(before);
    if (!match) {
      hideCodexPlusTriggerHints();
      return;
    }
    const token = Symbol("trigger");
    codexPlusTriggerState = { editor, match, items: codexPlusTriggerState?.items || [], active: 0, token };
    const result = runCodexPlusExtensionCallback(match.item.scriptKey, `inputTrigger.items:${match.item.trigger}`, () => match.item.items(match.query, { editor }));
    if (!result.ok) return hideCodexPlusTriggerHints();
    let items;
    try {
      items = await result.value;
    } catch (error) {
      codexPlusMarkExtensionFailure(match.item.scriptKey, `inputTrigger.items: ${String(error?.stack || error?.message || error)}`);
      return hideCodexPlusTriggerHints();
    }
    // 等候选期间用户又输入了：以最新一次为准。
    if (codexPlusTriggerState?.token !== token) return;
    codexPlusTriggerState.items = (Array.isArray(items) ? items : []).filter((choice) => choice && typeof choice === "object").slice(0, 12);
    renderCodexPlusTriggerHints();
  }

  function installCodexPlusInputTriggerHandlers() {
    // 共用命令提示的样式（命令提示的处理器同时装上也无妨：没有命令时它什么都不做）。
    installCodexPlusCommandHandlers();
    if (!document.getElementById("codex-plus-input-trigger-style")) {
      const style = document.createElement("style");
      style.id = "codex-plus-input-trigger-style";
      markCodexPlusExtensionNode(style, "builtin-input-triggers");
      style.textContent = `#codex-plus-input-trigger-hints{position:fixed;z-index:2147483645;display:flex;flex-direction:column;gap:2px;max-height:min(360px,50vh);overflow:auto;padding:6px;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:var(--color-token-main-surface-primary,var(--codex-plus-bg-elevated,#262626));color:var(--color-token-text-primary,var(--codex-plus-text,#eee));box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13px}
        #codex-plus-input-trigger-hints .codex-plus-command-hint[aria-selected="true"]{background:color-mix(in srgb,currentColor 12%,transparent)}`;
      document.head.append(style);
    }
    if (codexPlusInputTriggerHandlersInstalled) return;
    codexPlusInputTriggerHandlersInstalled = true;
    const onInput = (event) => {
      if (!codexPlusRegistry.inputTriggers.size) return;
      const editor = codexPlusComposerEditorFrom(event.target);
      if (editor) void updateCodexPlusTriggerHints(editor);
    };
    const onKeyDown = (event) => {
      const state = codexPlusTriggerState;
      if (!state || !state.items.length || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        hideCodexPlusTriggerHints();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        state.active = (state.active + step + state.items.length) % state.items.length;
        renderCodexPlusTriggerHints();
      } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        codexPlusAcceptTrigger(state.items[state.active]);
      }
    };
    const onFocusOut = (event) => {
      if (codexPlusTriggerState && event.target === codexPlusTriggerState.editor) setTimeout(() => {
        if (codexPlusTriggerState && !codexPlusTriggerState.editor.contains(document.activeElement)) hideCodexPlusTriggerHints();
      }, 150);
    };
    const previous = window.__codexPlusInputTriggerHandlers;
    if (previous) {
      document.removeEventListener("input", previous.onInput, true);
      document.removeEventListener("keydown", previous.onKeyDown, true);
      document.removeEventListener("focusout", previous.onFocusOut, true);
    }
    window.__codexPlusInputTriggerHandlers = { onInput, onKeyDown, onFocusOut };
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusOut, true);
  }

  // ---------------------------------------------------------------- 快捷键
  const codexPlusIsMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

  /** "Mod+Shift+K" → { mod, ctrl, meta, shift, alt, key }；key 按 event.key 小写比较。 */
  function codexPlusParseShortcut(text) {
    const parts = String(text || "").split("+").map((part) => part.trim()).filter(Boolean);
    const spec = { ctrl: false, meta: false, shift: false, alt: false, key: "" };
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "mod") spec[codexPlusIsMac ? "meta" : "ctrl"] = true;
      else if (lower === "ctrl" || lower === "control") spec.ctrl = true;
      else if (lower === "cmd" || lower === "meta" || lower === "command") spec.meta = true;
      else if (lower === "shift") spec.shift = true;
      else if (lower === "alt" || lower === "option") spec.alt = true;
      else if (spec.key) throw new Error(`快捷键 ${text} 只能有一个主键`);
      else spec.key = lower === "space" ? " " : lower;
    }
    if (!spec.key) throw new Error(`快捷键 ${text} 缺少主键`);
    if (!spec.ctrl && !spec.meta && !spec.alt && !/^f\d{1,2}$/.test(spec.key)) throw new Error(`快捷键 ${text} 需要带 Mod / Ctrl / Alt（或用 F1~F12），免得吞掉普通输入`);
    return spec;
  }

  function codexPlusShortcutMatches(spec, event) {
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "").toLowerCase();
    const sameKey = key === spec.key || code === `key${spec.key}` || code === `digit${spec.key}`;
    return sameKey && event.ctrlKey === spec.ctrl && event.metaKey === spec.meta && event.shiftKey === spec.shift && event.altKey === spec.alt;
  }

  function codexPlusRegisterShortcut(definition, options = {}) {
    if (typeof definition?.run !== "function") throw new Error("快捷键需要 run()");
    const spec = codexPlusParseShortcut(definition.key);
    const dispose = codexPlusRegisterExtensionItem("shortcut", codexPlusRegistry.shortcuts, { ...definition, spec }, options);
    if (!codexPlusShortcutHandlerInstalled) {
      codexPlusShortcutHandlerInstalled = true;
      document.removeEventListener("keydown", window.__codexPlusShortcutHandler, true);
      window.__codexPlusShortcutHandler = (event) => {
        if (event.isComposing || !codexPlusRegistry.shortcuts.size) return;
        const inInput = !!event.target?.closest?.("input, textarea, [contenteditable=true]");
        const item = codexPlusExtensionItems(codexPlusRegistry.shortcuts)
          .find((candidate) => codexPlusShortcutMatches(candidate.spec, event) && (!inInput || candidate.allowInInput !== false));
        if (!item) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const result = runCodexPlusExtensionCallback(item.scriptKey, `shortcut:${item.key}`, () => item.run({ event }));
        if (result.ok && codexPlusIsThenable(result.value)) {
          result.value.catch((error) => codexPlusMarkExtensionFailure(item.scriptKey, `shortcut:${item.key}: ${String(error?.stack || error?.message || error)}`));
        }
      };
      document.addEventListener("keydown", window.__codexPlusShortcutHandler, true);
    }
    return dispose;
  }

  // ---------------------------------------------------------------- 主题
  const codexPlusThemeStorageKey = "codexPlusExtensionTheme";

  function codexPlusCurrentThemeId() {
    try {
      return localStorage.getItem(codexPlusThemeStorageKey) || "";
    } catch {
      return "";
    }
  }

  function codexPlusThemeCss(theme) {
    const variables = Object.entries(theme.variables || {})
      .filter(([name]) => /^--[\w-]+$/.test(name))
      .map(([name, value]) => `${name}:${String(value).replace(/[;{}]/g, "")}`)
      .join(";");
    return `${variables ? `:root{${variables}}\n` : ""}${typeof theme.css === "string" ? theme.css : ""}`;
  }

  /** 把记住的主题画上去；主题没注册（拓展停用）时撤掉样式但保留选择，拓展回来后自动恢复。 */
  function applyCodexPlusTheme() {
    const id = codexPlusCurrentThemeId();
    const theme = id ? codexPlusExtensionItems(codexPlusRegistry.themes).find((item) => item.themeId === id) : null;
    let style = document.getElementById("codex-plus-extension-theme");
    if (!theme) {
      style?.remove();
      document.documentElement.removeAttribute("data-codex-plus-theme");
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "codex-plus-extension-theme";
      markCodexPlusExtensionNode(style, theme.scriptKey);
      document.head.append(style);
    }
    const css = codexPlusThemeCss(theme);
    if (style.textContent !== css) style.textContent = css;
    document.documentElement.setAttribute("data-codex-plus-theme", id);
  }

  function codexPlusRegisterTheme(definition, options = {}) {
    const themeId = String(definition?.id || "").trim();
    if (!/^[\w-]{1,48}$/.test(themeId)) throw new Error("主题 id 只能是字母、数字、_、-");
    if (!definition.variables && typeof definition.css !== "string") throw new Error(`主题 ${themeId} 需要 variables 或 css`);
    const dispose = codexPlusRegisterExtensionItem("theme", codexPlusRegistry.themes, { ...definition, themeId, name: definition.name || themeId }, { ...options, id: options.id || `theme-${themeId}` });
    applyCodexPlusTheme();
    return () => {
      dispose();
      applyCodexPlusTheme();
    };
  }

  /** 内置的主题服务（inject: ["themes"]，ctx.themes 同一套）：列出、切换、当前。 */
  function codexPlusThemesService() {
    return Object.freeze({
      list: () => codexPlusExtensionItems(codexPlusRegistry.themes).map((item) => ({ id: item.themeId, name: codexPlusResolveText(item.name), extension: item.scriptKey })),
      get current() {
        return codexPlusCurrentThemeId() || null;
      },
      apply(id) {
        const next = id ? String(id) : "";
        if (next && !codexPlusExtensionItems(codexPlusRegistry.themes).some((item) => item.themeId === next)) throw new Error(`没有主题 ${next}`);
        try {
          if (next) localStorage.setItem(codexPlusThemeStorageKey, next);
          else localStorage.removeItem(codexPlusThemeStorageKey);
        } catch {}
        applyCodexPlusTheme();
        codexPlusEmitExtensionEvent("theme/change", [{ id: next || null }]);
        return next || null;
      },
    });
  }

  // ---------------------------------------------------------------- 向用户提问
  /**
   * 弹一个对话框问用户：options 给按钮（字符串或 { value, label }），input 给输入框（{ placeholder, default, multiline }）。
   * 返回 { value, text }；用户关掉或超时返回 null。同一时间只显示一个，后来的排队。
   */
  let codexPlusAskQueue = Promise.resolve();

  function codexPlusAsk(question = {}) {
    const run = () => new Promise((resolve) => {
      const options = (Array.isArray(question.options) && question.options.length ? question.options : [{ value: "ok", label: "确定" }])
        .slice(0, 6)
        .map((option) => (typeof option === "object" && option ? { value: option.value ?? option.label, label: String(option.label ?? option.value) } : { value: option, label: String(option) }));
      const overlay = document.createElement("div");
      overlay.className = "codex-plus-ask-overlay";
      markCodexPlusExtensionNode(overlay, "builtin-ask");
      const input = question.input
        ? (question.input.multiline ? `<textarea class="codex-plus-ask-input" rows="4"></textarea>` : `<input class="codex-plus-ask-input" type="text">`)
        : "";
      overlay.innerHTML = `<div class="codex-plus-ask" role="dialog" aria-modal="true">
        <div class="codex-plus-ask-title">${escapeHtml(String(codexPlusResolveText(question.title) || "拓展想问你"))}</div>
        ${question.message ? `<div class="codex-plus-ask-message">${escapeHtml(String(codexPlusResolveText(question.message)))}</div>` : ""}
        ${input}
        <div class="codex-plus-ask-actions">
          <button type="button" class="codex-plus-ask-cancel">取消</button>
          ${options.map((option, index) => `<button type="button" class="codex-plus-ask-option" data-index="${index}">${escapeHtml(option.label)}</button>`).join("")}
        </div></div>`;
      const field = overlay.querySelector(".codex-plus-ask-input");
      if (field) {
        field.value = String(question.input.default ?? "");
        field.placeholder = String(question.input.placeholder ?? "");
      }
      let timer = null;
      const finish = (answer) => {
        clearTimeout(timer);
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(answer);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(null);
        } else if (event.key === "Enter" && !event.shiftKey && (!field || field.tagName === "INPUT")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish({ value: options[options.length - 1].value, text: field ? field.value : null });
        }
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest(".codex-plus-ask-cancel")) return finish(null);
        const button = event.target.closest(".codex-plus-ask-option");
        if (button) finish({ value: options[Number(button.dataset.index)].value, text: field ? field.value : null });
      });
      document.addEventListener("keydown", onKey, true);
      installCodexPlusAskStyle();
      document.body.appendChild(overlay);
      (field || overlay.querySelector(".codex-plus-ask-option:last-child"))?.focus();
      const timeoutMs = Number(question.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => finish(null), timeoutMs);
    });
    const answer = codexPlusAskQueue.then(run, run);
    codexPlusAskQueue = answer.catch(() => null);
    return answer;
  }

  function installCodexPlusAskStyle() {
    if (document.getElementById("codex-plus-ask-style")) return;
    const style = document.createElement("style");
    style.id = "codex-plus-ask-style";
    markCodexPlusExtensionNode(style, "builtin-ask");
    style.textContent = `.codex-plus-ask-overlay{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
      .codex-plus-ask{width:min(440px,calc(100vw - 48px));display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:14px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:var(--color-token-main-surface-primary,var(--codex-plus-bg-elevated,#262626));color:var(--color-token-text-primary,var(--codex-plus-text,#eee));box-shadow:0 16px 48px rgba(0,0,0,.35);font-size:13px}
      .codex-plus-ask-title{font-size:15px;font-weight:600}
      .codex-plus-ask-message{white-space:pre-wrap;opacity:.8;line-height:1.5}
      .codex-plus-ask-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;resize:vertical}
      .codex-plus-ask-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
      .codex-plus-ask-actions button{padding:6px 14px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:transparent;color:inherit;cursor:pointer;font:inherit}
      .codex-plus-ask-actions .codex-plus-ask-option:last-child{background:var(--color-token-text-primary,#eee);color:var(--color-token-main-surface-primary,#111);border-color:transparent}`;
    document.head.append(style);
  }

  // ---------------------------------------------------------------- 拓展变更事件
  /** 拓展装上 / 卸下后合并成一次 `extensions/changed`（热重载时一批拓展会连续变动）。 */
  let codexPlusExtensionsChangedTimer = null;

  function scheduleCodexPlusExtensionsChanged() {
    clearTimeout(codexPlusExtensionsChangedTimer);
    codexPlusExtensionsChangedTimer = setTimeout(() => {
      const extensions = [...codexPlusExtensionInstances].map((instance) => ({ id: instance.id, scriptKey: instance.scriptKey, version: instance.manifest?.version ?? null }));
      codexPlusEmitExtensionEvent("extensions/changed", [{ extensions }]);
    }, 300);
  }
  /**
   * 更多视图接口：悬浮球页签、工具调用视图、Codex 设置页分区。
   *
   * - registerFloatingTab：右下角悬浮球面板里加一个页签（开启「回答大纲」时可见）。
   *   悬浮球是单独注入的脚本，这里把注册项同步到 window.__codexPlusFloatingTabs，再请它重画。
   * - registerToolView：对话里的工具调用 / 命令条目末尾挂一块自己的内容（在 activity.after 插槽上），
   *   按工具名或条目类型匹配；render 收到的 call 带工具名、参数、结果（从会话日志里按调用 id 找）。
   * - registerSettingsSection：Codex 设置页左侧导航末尾加一项，点开是拓展自己画的页面。
   */

  // ---------------------------------------------------------------- 悬浮球页签
  function syncCodexPlusFloatingTabs() {
    const tabs = new Map();
    for (const item of codexPlusExtensionItems(codexPlusRegistry.floatingTabs)) {
      tabs.set(item.id, {
        id: item.id,
        title: String(item.title || item.label || item.id),
        icon: item.icon,
        scriptKey: item.scriptKey,
        render: (context) => {
          const result = runCodexPlusExtensionCallback(item.scriptKey, "floatingTab.render", () => item.render(context));
          return result.ok ? result.value : undefined;
        },
        fail: (error) => codexPlusMarkExtensionFailure(item.scriptKey, `floatingTab: ${String(error?.stack || error?.message || error)}`),
      });
    }
    window.__codexPlusFloatingTabs = tabs;
    try {
      window.__codexStepwisePanel?.renderFloat?.({ preserveMorph: true });
    } catch {}
  }
  function codexPlusRegisterFloatingTab(definition, options = {}) {
    if (typeof definition?.render !== "function") throw new Error("悬浮球页签需要 render({ container, close })");
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const id = `${scriptKey}:floatingTab:${options.id || codexPlusExtensionIdSeed()}`;
    const dispose = registerCodexPlusExtension("floatingTab", codexPlusRegistry.floatingTabs, id, definition, scriptKey);
    syncCodexPlusFloatingTabs();
    return () => {
      dispose();
      syncCodexPlusFloatingTabs();
    };
  }
  // ---------------------------------------------------------------- 工具调用视图
  /** 会话的工具调用表（调用 id → 工具名、参数、结果），读一次缓存 3 秒。 */
  const codexPlusToolCallCache = new Map();

  function codexPlusToolCalls(sessionId) {
    const cached = codexPlusToolCallCache.get(sessionId);
    if (cached && Date.now() - cached.at < 3000) return cached.promise;
    const promise = (async () => {
      const query = codexPlusServices.get("sessionQuery")?.value;
      if (!query || !sessionId) return new Map();
      const { events } = await query.readSession(sessionId);
      const calls = new Map();
      for (const event of events || []) {
        if (event.type === "tool/call") {
          let input = event.data?.input;
          try { input = typeof input === "string" ? JSON.parse(input) : input; } catch {}
          calls.set(event.data?.callId, { callId: event.data?.callId, name: event.data?.name || "", input, output: null });
        } else if (event.type === "tool/result" && calls.has(event.data?.callId)) {
          calls.get(event.data.callId).output = event.data?.output ?? null;
        }
      }
      return calls;
    })();
    codexPlusToolCallCache.set(sessionId, { at: Date.now(), promise });
    if (codexPlusToolCallCache.size > 8) codexPlusToolCallCache.delete(codexPlusToolCallCache.keys().next().value);
    promise.catch(() => codexPlusToolCallCache.delete(sessionId));
    return promise;
  }

  /** 条目 id 里带着调用 id（命令条目是 exec-<调用 id>）：按包含关系找。 */
  function codexPlusFindToolCall(calls, itemIds) {
    for (const itemId of itemIds || []) {
      if (calls.has(itemId)) return calls.get(itemId);
      for (const [callId, call] of calls) if (callId && itemId.includes(callId)) return call;
    }
    return null;
  }

  function codexPlusToolViewMatches(definition, call) {
    const kinds = definition.kinds ? [].concat(definition.kinds) : null;
    if (kinds && !kinds.includes(call.kind)) return false;
    const tools = definition.tools ? [].concat(definition.tools) : null;
    if (!tools) return true;
    return tools.some((pattern) => pattern instanceof RegExp ? pattern.test(call.name) : String(pattern) === call.name || new RegExp(`^(?:${pattern})$`).test(call.name));
  }

  function codexPlusRegisterToolView(definition, options = {}) {
    if (typeof definition?.render !== "function") throw new Error("工具调用视图需要 render({ container, call })");
    return codexPlusRegisterExtensionSlot({
      slot: "activity.after",
      order: definition.order,
      render: ({ container, kind, itemIds, text }) => {
        let cleanup = null;
        let cancelled = false;
        const sessionId = codexPlusCurrentSessionId();
        const base = { kind, itemIds, text, sessionId, callId: null, name: "", input: null, output: null };
        const draw = (call) => {
          if (cancelled || !codexPlusToolViewMatches(definition, call)) return;
          const result = runCodexPlusExtensionCallback(options.scriptKey || codexPlusCurrentExtensionScriptKey(options), "toolView.render", () => definition.render({ container, call }));
          if (result.ok && typeof result.value === "function") cleanup = result.value;
        };
        if (!definition.tools && !definition.resolve) draw(base);
        else {
          codexPlusToolCalls(sessionId).then((calls) => {
            const found = codexPlusFindToolCall(calls, itemIds);
            draw(found ? { ...base, ...found, kind } : base);
          }).catch(() => draw(base));
        }
        return () => {
          cancelled = true;
          if (typeof cleanup === "function") cleanup();
        };
      },
    }, options);
  }

  // ---------------------------------------------------------------- Codex 设置页分区
  function codexPlusRegisterSettingsSection(definition, options = {}) {
    if (typeof definition?.render !== "function") throw new Error("设置分区需要 render({ container, close })");
    const scriptKey = codexPlusCurrentExtensionScriptKey(options);
    const id = options.id || codexPlusExtensionIdSeed();
    const disposePage = codexPlusRegisterExtensionPage(definition, { ...options, scriptKey, id: `settings-${id}`, nav: false });
    const pageId = `${scriptKey}:page:settings-${id}`;
    const title = String(definition.title || id);
    const disposeSlot = codexPlusRegisterExtensionSlot({
      slot: "settings.nav",
      order: definition.order,
      render: ({ container, sampleClass }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `${sampleClass || ""} codex-plus-settings-nav-item`.trim();
        button.innerHTML = `${codexPlusExtensionIconMarkup(definition)}<span>${escapeHtml(title)}</span>`;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openCodexPlusExtensionPage(pageId);
        });
        container.appendChild(button);
      },
    }, { scriptKey, id: `settings-nav-${id}` });
    return () => {
      disposeSlot();
      disposePage();
    };
  }
  function scanLightweight() {
    // 拓展的轻量扫描步骤统一经 ctx.onScan 登记。
    runCodexPlusScanSteps("light");
    installStyle();
    syncCodexPlusConversationTabs();
    syncCodexPlusConversationList();
    installCodexAppServerClientPrototypePatch();
    // 拓展注册的图标栏入口也在这里补（见 installCodexPlusNavigationEntries）。
    installCodexPlusNavigationEntries();
    // 输入区 footer 会随会话切换、首页与对话页切换而重建，拓展的输入区按钮每轮补一次（按指纹幂等）。
    refreshCodexPlusComposerActions();
    // 消息插槽与侧边面板：消息、顶栏都会重建，按指纹幂等补齐；对话内容变化由插槽自己的观察器跟。
    refreshCodexPlusMessageSlots();
    refreshCodexPlusSidePanels();
    refreshCodexPlusUiSlots();
    installCodexPlusPageNavigationCloseHandler();
    scheduleBackendHeartbeat();
  }

  function scanDeferred() {
    // 拓展卸下时自动撤销其扫描步骤。
    runCodexPlusScanSteps();
    // 会话行和归档页的操作宿主继续承载第三方拓展 rowAction。
    sessionRows().forEach(tryAttachButton);
    archivedPageRows().forEach(attachArchivedPageDeleteButton);
    removeLegacyCodexServiceTierBadges();
    ensureCodexAppServerClient();
  }

  /**
   * 扫描步骤登记处：登记号 → { step, phase, owner }。拓展经公开的 ctx.onScan 登记（内置拓展也一样），卸下时撤销；
   * owner 是登记它的拓展（scriptKey，如 builtin:activity-overlay-right），runCodexPlusScanStep 按 owner 点名跑。
   */
  function codexPlusScanSteps() {
    globalThis.__codexPlusScanSteps ??= new Map();
    return globalThis.__codexPlusScanSteps;
  }

  /** phase：deferred（默认，跟着完整扫描）或 light（跟着轻量扫描）。返回撤销函数。 */
  function registerCodexPlusScanStep(owner, step, phase = "deferred") {
    const steps = codexPlusScanSteps();
    globalThis.__codexPlusScanStepSeq = (globalThis.__codexPlusScanStepSeq || 0) + 1;
    const id = `${owner}#${globalThis.__codexPlusScanStepSeq}`;
    const entry = { step, phase: phase === "light" ? "light" : "deferred", owner: String(owner) };
    steps.set(id, entry);
    return () => {
      if (steps.get(id) === entry) steps.delete(id);
    };
  }

  function runCodexPlusScanSteps(phase = "deferred") {
    for (const entry of [...codexPlusScanSteps().values()]) if (entry.phase === phase) runScanStep(entry.step);
  }

  /** 只跑某个拓展登记的步骤（它没装上时什么也不做）。 */
  function runCodexPlusScanStep(owner) {
    for (const entry of [...codexPlusScanSteps().values()]) if (entry.owner === owner) runScanStep(entry.step);
  }

  function runScanStep(step) {
    try {
      step();
    } catch (error) {
      window.__codexSessionDeleteScanFailures = window.__codexSessionDeleteScanFailures || [];
      window.__codexSessionDeleteScanFailures.push(String(error?.stack || error));
    }
  }

  function scan() {
    pruneSessionMoreMenus();
    if (document.hidden) {
      window.__codexSessionDeleteScanPending = true;
      return;
    }
    runScanStep(scanLightweight);
    scheduleDeferredScan();
  }
  /**
   * 内置拓展：Codex Pilot 自带的功能也挂在拓展内核上，和第三方拓展走同一套生命周期
   * （没有特权功能：自带的也能单独停用、被别的拓展顶替）。
   *
   *   - 每个内置功能是一个拓展实例（scriptKey = builtin:<id>）：实例在时功能可用，卸载时功能撤下；
   *   - 管理器「内置拓展」里可以单独停用（用户脚本配置里 scripts["builtin:<id>"] = false）；
   *   - 第三方拓展包在 codexpp.json 里声明 `replaces: ["<id>"]`，它启用时对应的内置拓展让位；
   *   - 功能自己的设置开关（如「原生 Fast 强制解锁」）照旧生效：内置拓展是外面一层，两者都开功能才出现。
   *
   * 停用 / 顶替状态由 Codex Pilot 随用户脚本注入包下发（window.__codexPlusBuiltinExtensionState），
   * 热重载时更新。功能的开关检查在注入早期（本分片执行前）、以及只抽单个分片的测试里也会被调用，所以只记
   * 「停用的」：globalThis.__codexPlusBuiltinInactive 里没有的 id 都算启用，功能侧写成
   * `!globalThis.__codexPlusBuiltinInactive?.has("<id>")`。实例卸载时加进集合，装上时移出。
   */
  function codexPlusBuiltinInactiveIds() {
    if (!(globalThis.__codexPlusBuiltinInactive instanceof Set)) globalThis.__codexPlusBuiltinInactive = new Set();
    return globalThis.__codexPlusBuiltinInactive;
  }

  /** 内置拓展是否在用（没被停用、没被顶替）。 */
  function codexPlusBuiltinExtensionActive(id) {
    return !globalThis.__codexPlusBuiltinInactive?.has(id);
  }

  /**
   * 内置拓展清单：每一项只有 apply(ctx)，和第三方拓展一样只用公开的 ctx 接口（onScan、on、effect、registerSlot……），
   * 装上即生效、卸下时登记的东西自动撤销。管理器里的名字与说明在 Rust 侧 BUILTIN_EXTENSIONS 维护，两边 id 要一致。
   * 没有 apply 的几项由 Rust 侧（启动器、注入、本地代理）或独立运行时按停用状态生效，页面侧只登记。
   */
  function codexPlusBuiltinExtensionCatalog() {
    return [
      // Agent 桌宠（含大肥鱼）、用量状态栏、请求状态条已改成随 Codex Pilot 发布的官方拓展包（bundled:agent-pet、
      // bundled:usage-statusline、bundled:proxy-request-status），不再是内置拓展。
      // 以下由 Rust 侧（启动、注入、本地代理）按设置项生效，多数要重启 Codex，页面侧只登记。被顶替时 Rust 侧按
      // 「关」处理（builtin_takeover），顶替它的拓展用 preload（页面最早期脚本）、launch（启动前后）、网关中间件写等价功能。
      { id: "native-fast-unlock", name: "原生 Fast 强制解锁" },
      { id: "native-predictions", name: "原生输入预测" },
      { id: "native-project-sections", name: "API 模式项目分区" },
      { id: "conversation-tabs", name: "对话标签栏" },
      { id: "conversation-list", name: "跨项目会话列表" },
      { id: "reasoning-collapse", name: "第三方模型回答完自动折叠过程" },
      { id: "native-browser-identification", name: "原生 Edge / Chrome 请求标识兼容" },
    ];
  }

  /** 下发的停用 / 顶替状态：{ disabled: [id], replacedBy: { id: 拓展 key } }。 */
  function codexPlusBuiltinExtensionState() {
    const state = window.__codexPlusBuiltinExtensionState;
    return {
      disabled: new Set(Array.isArray(state?.disabled) ? state.disabled.map(String) : []),
      replacedBy: state?.replacedBy && typeof state.replacedBy === "object" ? state.replacedBy : {},
    };
  }

  // 同页重复注入：先卸下上一份注入包装上的内置拓展（它们的监听、中间件、扫描步骤挂在旧内核上，新内核看不到）。
  window.__codexPlusBuiltinExtensionHandles?.forEach((handle) => {
    try {
      handle.dispose();
    } catch {}
  });
  // 退役分组时先还原旧菜单，再结束旧运行时，避免热注入后遗留折叠行和定时器。
  window.__codexPlusModelPickerGroupsRuntime?.releaseDom?.();
  window.__codexPlusModelPickerGroupsRuntime?.dispose?.();
  delete window.__codexPlusModelPickerGroupsRuntime;
  // 回答大纲已退役；旧页面热注入时主动结束它独立维护的观察器和面板。
  window.__codexStepwisePanel?.destroy?.();
  delete window.__codexStepwisePanel;
  // 同页升级时撤下退役分类的布局和额度策略，原生数据保持原样。
  document.documentElement?.removeAttribute?.("data-codex-plus-activity-overlay-right");
  document.getElementById?.("codex-plus-avatar-overlay-layout-style")?.remove();
  document.getElementById?.("codex-plus-instance-identity")?.remove();
  delete globalThis.__CODEX_PLUS_ACTIVITY_OVERLAY_SYNC__;
  window.__codexPlusOfficialUsageWindowCleanup?.();
  window.__codexPlusNativeQuotaBootstrap?.dispose?.();
  if (window.__codexPlusOfficialUsageRuntime) {
    const runtime = window.__codexPlusOfficialUsageRuntime;
    // 已安装的旧 Query 包装仍会读同一个对象，让后续写入直接回传真实快照。
    runtime.rewrite = (value) => runtime.rawPayloads?.get(value) || value;
  }
  const codexPlusBuiltinExtensionHandles = window.__codexPlusBuiltinExtensionHandles = new Map();

  // 用量状态栏、请求状态条的数据服务 codexpp.usage / codexpp.proxyStatus 改由对应的官方拓展包提供
  // （assets/extensions/usage-statusline、proxy-request-status）。

  /** 按下发状态装上 / 卸下内置拓展。重复调用只处理有变化的项。 */
  function syncCodexPlusBuiltinExtensions() {
    const inactive = codexPlusBuiltinInactiveIds();
    const state = codexPlusBuiltinExtensionState();
    for (const definition of codexPlusBuiltinExtensionCatalog()) {
      const wanted = !state.disabled.has(definition.id) && !state.replacedBy[definition.id];
      const handle = codexPlusBuiltinExtensionHandles.get(definition.id);
      if (wanted && !handle) {
        try {
          const ctx = codexPlusCreateExtension({
            id: `builtin:${definition.id}`,
            apply(ctx) {
              // 停用集合是功能侧「这个内置拓展装着没有」的读数：装上前移出；卸下时最先记回（最后登记、最先撤销），
              // 功能自己的撤销步骤（再对齐一次）读到的就是停用。
              inactive.delete(definition.id);
              try {
                if (typeof definition.apply === "function") definition.apply(ctx);
              } finally {
                ctx.effect(() => () => inactive.add(definition.id));
              }
            },
          }, { scriptKey: `builtin:${definition.id}` });
          codexPlusBuiltinExtensionHandles.set(definition.id, ctx);
        } catch (error) {
          inactive.add(definition.id);
          codexPlusMarkExtensionFailure(`builtin:${definition.id}`, String(error?.stack || error?.message || error));
        }
      } else if (!wanted && handle) {
        codexPlusBuiltinExtensionHandles.delete(definition.id);
        handle.dispose();
      } else if (!wanted && !inactive.has(definition.id)) {
        // 还没装上过（注入早期按默认启用跑着）：直接记成停用，补一轮扫描让按停用集合判断的功能撤下。
        inactive.add(definition.id);
        scheduleDeferredScan();
      }
    }
  }

  /** 内置拓展的现状：给 codexPlus.builtins() 与诊断用。 */
  function codexPlusBuiltinExtensionList() {
    const state = codexPlusBuiltinExtensionState();
    return codexPlusBuiltinExtensionCatalog().map(({ id, name }) => ({
      id,
      name,
      active: codexPlusBuiltinExtensionActive(id),
      disabled: state.disabled.has(id),
      replacedBy: state.replacedBy[id] || null,
    }));
  }
  window.__codexPlusScanScheduleCleanup?.();
  clearTimeout(window.__codexSessionDeleteScanTimer);
  cancelAnimationFrame(window.__codexSessionDeleteDeferredRaf);
  window.__codexSessionDeleteScanTimer = null;
  window.__codexSessionDeleteDeferredRaf = 0;
  window.__codexSessionDeleteScanPending = false;
  window.__codexSessionDeleteDeferredPending = false;

  /**
   * 这个节点是不是 Codex Pilot 自己（或拓展）的 UI。
   *
   * 内置选择器写在这里；拓展通过注册中心登记的选择器走 isCodexPlusExtensionNode，
   * 那边已把选择器合并成一个串并在 Set 变化时重建缓存，所以这里每次调用只多一次
   * closest()，不会因为拓展数量增长而线性变慢。
   */
  function isExtensionUiNode(node) {
    if (!node?.closest) return false;
    if (node.closest(`[data-codex-plus-ext], .codex-delete-toast, .codex-delete-confirm-overlay, .codex-plus-modal-overlay, .${codexPlusPageClass}, .${codexServiceTierBadgeClass}, .${sessionShareButtonClass}, .codex-zed-remote-button, .codex-zed-remote-toast, #codex-plus-menu`)) {
      return true;
    }
    return isCodexPlusExtensionNode(node);
  }

  function scanRelevantSelector() {
    return [
      selectors.sidebarThread,
      '[data-app-action-sidebar-section-heading="Chats"]',
      '[data-app-action-sidebar-section-heading="Projects"]',
      '[data-codex-archive-page-row="true"]',
      "[data-codex-archive-delete-all]",
      '[data-message-author-role]',
      '[data-testid="conversation-turn"]',
      '[data-tab-id^="sidechat:"]',
      '[class*="user-message"]',
      '[class*="UserMessage"]',
      ".composer-footer",
      selectors.appHeader,
      selectors.archiveNav,
      selectors.pluginNavButton,
      'aside.app-shell-left-panel nav[role="navigation"]',
      'nav[data-app-navigation-rail]',
      // 审批卡片出现时补上拓展的 approval 插槽。
      "[data-codex-approval-surface]",
      // Codex 设置页导航出现时补上 settings.nav 插槽。
      "[data-settings-panel-slug]",
    ].join(", ");
  }

  function nodeSelfOrAncestorMatchesScanRelevance(node) {
    if (node.nodeType !== 1) return false;
    if (isExtensionUiNode(node)) return false;
    const relevantSelector = scanRelevantSelector();
    return !!node.closest?.(relevantSelector) ||
      nodeOrAncestorLooksLikeCodexUserBubble(node);
  }

  function isScanRelevantNode(node) {
    if (node.nodeType !== 1) return false;
    if (isExtensionUiNode(node)) return false;
    return nodeSelfOrAncestorMatchesScanRelevance(node) || !!node.querySelector?.(scanRelevantSelector()) || nodeLooksLikeCodexUserBubble(node);
  }

  function isChatContentMutation(mutation) {
    const target = mutation.target;
    if (!target?.closest?.('[data-message-author-role], [data-testid="conversation-turn"], main .prose')) return false;
    return !Array.from(mutation.addedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node)) &&
      !Array.from(mutation.removedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node));
  }

  function shouldScheduleScan(mutations) {
    if (!mutations) return true;
    return mutations.some((mutation) => {
      if (isChatContentMutation(mutation)) return false;
      const target = mutation.target;
      if (isExtensionUiNode(target)) return false;
      const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
      const changedElements = changedNodes.filter((node) => node.nodeType === 1);
      // 我们自己插入的节点挂在 Codex 的容器里，而容器本身是 scan-relevant，
      // 于是「写入 → 观察到自己的写入 → 200ms 后再 scan → 再写入」形成自喂循环，
      // 空闲时也每秒全量扫描五次，macOS 上足以吃满一个核（issue #1960）。
      // 一次变更如果只动了我们自己的 UI，就不该再排一次 scan。
      if (changedElements.length && changedElements.every(isExtensionUiNode)) return false;
      if (target?.nodeType === 1 && nodeSelfOrAncestorMatchesScanRelevance(target)) return true;
      return changedElements.some((node) => isScanRelevantNode(node));
    });
  }

  function runScheduledScan() {
    clearTimeout(window.__codexSessionDeleteScanTimer);
    window.__codexSessionDeleteScanTimer = null;
    if (document.hidden) {
      window.__codexSessionDeleteScanPending = true;
      return;
    }
    window.__codexSessionDeleteScanPending = false;
    scan();
  }

  function scheduleDeferredScan() {
    window.__codexSessionDeleteDeferredPending = true;
    if (document.hidden || window.__codexSessionDeleteDeferredRaf) return;
    window.__codexSessionDeleteDeferredRaf = requestAnimationFrame(() => {
      window.__codexSessionDeleteDeferredRaf = 0;
      if (document.hidden) return;
      window.__codexSessionDeleteDeferredPending = false;
      runScanStep(scanDeferred);
    });
  }

  function scheduleScan(mutations) {
    // 隐藏页面和已排队的扫描也要清理，不能让孤立菜单等待下一次可见扫描。
    const sessionActionsNeedScan = pruneRemovedSessionActions(mutations);
    window.__codexSessionDeleteLastMutations = mutations;
    if (window.__codexSessionDeleteScanPending) return;
    // 原生页面可能只移除带归属标记的按钮组；所属行仍在时需要补回操作入口。
    if (!sessionActionsNeedScan && !shouldScheduleScan(mutations)) return;
    window.__codexSessionDeleteScanPending = true;
    if (document.hidden) return;
    window.__codexSessionDeleteScanTimer = setTimeout(runScheduledScan, 200);
  }

  const onScanVisibilityChange = () => {
    if (document.hidden) {
      clearTimeout(window.__codexSessionDeleteScanTimer);
      window.__codexSessionDeleteScanTimer = null;
      cancelAnimationFrame(window.__codexSessionDeleteDeferredRaf);
      window.__codexSessionDeleteDeferredRaf = 0;
      return;
    }
    // Hidden mutations describe one current DOM, not a history to replay.
    if (window.__codexSessionDeleteScanPending) {
      clearTimeout(window.__codexSessionDeleteScanTimer);
      window.__codexSessionDeleteScanTimer = setTimeout(runScheduledScan, 0);
    } else if (window.__codexSessionDeleteDeferredPending) scheduleDeferredScan();
  };
  document.addEventListener("visibilitychange", onScanVisibilityChange);
  window.__codexPlusScanScheduleCleanup = () => {
    document.removeEventListener("visibilitychange", onScanVisibilityChange);
    clearTimeout(window.__codexSessionDeleteScanTimer);
    cancelAnimationFrame(window.__codexSessionDeleteDeferredRaf);
    window.__codexSessionDeleteScanPending = false;
    window.__codexSessionDeleteDeferredPending = false;
  };

  /** 等原生导航挂载后补画用户拓展入口，最多重试六秒。 */
  function scheduleExtensionNavStartupRetry() {
    clearInterval(window.__codexPlusSidebarNavRetryTimer);
    let attempts = 0;
    window.__codexPlusSidebarNavRetryTimer = setInterval(() => {
      attempts += 1;
      const installed = document.querySelector(codexPlusRailSelector);
      if (installed || attempts > 20) {
        clearInterval(window.__codexPlusSidebarNavRetryTimer);
        window.__codexPlusSidebarNavRetryTimer = null;
        if (installed) {
          try {
            installCodexPlusNavigationEntries();
          } catch {}
        }
        return;
      }
      try {
        installCodexPlusNavigationEntries();
      } catch {}
    }, 300);
  }

  void loadBackendSettingsForStartup();
  scan();
  scheduleExtensionNavStartupRetry();
  window.removeEventListener("resize", window.__codexPlusResizeHandler);
  installCodexConfigReadDeadline();
  void installCodexForkReadinessFallback();
  // 会话行、消息插槽等共用宿主仍需响应窗口尺寸变化。
  let codexPlusResizeRafId = 0;
  window.__codexPlusResizeHandler = () => {
    cancelAnimationFrame(codexPlusResizeRafId);
    codexPlusResizeRafId = requestAnimationFrame(() => {
      syncActionGroupsLayout(true);
    });
  };
  window.addEventListener("resize", window.__codexPlusResizeHandler);
  window.__codexSessionDeleteObserver?.disconnect();
  window.__codexSessionDeleteObserver = new MutationObserver((mutations) => {
    scheduleScan(mutations);
  });
  window.__codexSessionDeleteObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    // 原生会话行可能原地把临时 ID 更新为持久 UUID，拓展操作需要跟随更新会话引用。
    attributes: true,
    attributeFilter: ["data-app-action-sidebar-thread-id", "href"],
  });
  // 会话复制 / 自动命名两项已下线；同页重复注入时摘掉旧脚本留下的触发器监听。
  document.removeEventListener("pointerdown", window.__codexSessionActionTriggerHandler, true);
  document.removeEventListener("click", window.__codexSessionActionTriggerClickHandler, true);
  window.__codexSessionActionTriggerHandler = null;
  window.__codexSessionActionTriggerClickHandler = null;
  // 对外接口层在此刻挂载：此时所有分片都已执行完毕，闭包里的函数全部就绪。
  // 放在 99-tail 收尾之前，确保 IIFE 结束前 window.codexPlus 已经可用——
  // 用户脚本的注入晚于本脚本，不会撞上这个时间点。
  installCodexPlusBuiltinServices();
  window.codexPlus = buildCodexPlusExtensionApi();
  // 内置功能挂到拓展内核上；下发停用 / 顶替状态后会再次对齐。
  window.__codexPlusSyncBuiltinExtensions = syncCodexPlusBuiltinExtensions;
  syncCodexPlusBuiltinExtensions();
})();

// === 粘贴修复 (CodexPilot 页面增强) ===
