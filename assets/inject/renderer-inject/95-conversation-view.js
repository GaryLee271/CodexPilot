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
