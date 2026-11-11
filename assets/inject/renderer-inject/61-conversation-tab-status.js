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
