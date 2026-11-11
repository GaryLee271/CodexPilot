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
