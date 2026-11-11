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
