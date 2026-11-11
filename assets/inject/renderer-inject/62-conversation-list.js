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
        const title = String(session.title || '').trim() || str.untitled;
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
