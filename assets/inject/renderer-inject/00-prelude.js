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
