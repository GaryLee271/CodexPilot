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
