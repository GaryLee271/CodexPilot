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
