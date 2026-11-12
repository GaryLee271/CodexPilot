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
      today: '今天', yesterday: '昨天', earlier: '更早',
      count: (shown, total) => `已显示 ${shown} / ${total} 条`, limit: '已到列表上限',
    },
    en: {
      title: 'Recent threads', back: 'Back to native list', loading: 'Loading threads…',
      empty: 'No threads found', failed: 'Failed to load: ', untitled: 'Untitled thread',
      noProject: 'No project', directory: 'Folder: ', more: 'Load more',
      today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier',
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

  /**
   * 时间分区：按本地日历日算组。今天 / 昨天用相对词，昨天之前且仍在本周内
   * （周一为一周起点）显示星期几，本周之前显示实际日期；跨年补年份。
   * now 与 strings / lang 由调用方传入，方便单测固定「今天」和语言。
   * Codex 的 updated_at 是秒级时间戳，也兼容毫秒；取不到时间的归到「更早」。
   */
  function cplConversationGroup(updatedAt, now, strings, lang) {
    const weekdays = lang === 'zh'
      ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const unknown = { key: 'unknown', label: strings.earlier };
    const raw = Number(updatedAt);
    if (!Number.isFinite(raw) || raw <= 0) return unknown;
    const stamp = new Date(raw < 1e12 ? raw * 1000 : raw);
    if (Number.isNaN(stamp.getTime())) return unknown;
    const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = startOfDay(now);
    const day = startOfDay(stamp);
    // 夏令时切换那天只有 23 / 25 小时，round 才能算成同一个日历日差值。
    const diff = Math.round((today - day) / 86400000);
    // 周一 = 0，周日 = 6：今天距本周一开始过了几天。
    const mondayBasedWeekday = (today.getDay() + 6) % 7;
    let label;
    if (diff <= 0) label = strings.today;
    else if (diff === 1) label = strings.yesterday;
    else if (diff <= mondayBasedWeekday) label = weekdays[stamp.getDay()];
    else {
      const month = day.getMonth() + 1, date = day.getDate();
      const sameYear = day.getFullYear() === now.getFullYear();
      label = lang === 'zh'
        ? (sameYear ? `${month}月${date}日` : `${day.getFullYear()}年${month}月${date}日`)
        : (sameYear ? `${months[day.getMonth()]} ${date}` : `${months[day.getMonth()]} ${date}, ${day.getFullYear()}`);
    }
    return { key: `d${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`, label };
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
    let disposed = false, active = false, style = null, surfaceColor = '', pinTop = '';
    let headerEntry = null, panel = null, listEl = null, statusEl = null, moreButton = null;
    let items = [], total = 0, loading = false, requestId = 0;
    let statusApi = null, statusLoading = false, statusContext = null, statusWatch = null;
    let statusIds = '', statusGeneration = 0;
    let nativeStates = new Map(), nativeProjects = new Map();
    const nodes = new Map();
    const groups = new Map();

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
        .cpl-list { padding: 2px 4px; overflow-anchor: none; }
        /* 每组会话连同标题包一个 section。sticky 的约束框是 section 而不是整个列表：
           滚到下一组时，上一组标题会被自己 section 的末尾顶走。平铺着放的话多个标题
           会同时钉在 top:0 叠在一起（分组之间没有会话时尤其明显）。 */
        .cpl-section { display: block; }
        /* 时间分区标题：跟着滚动吸顶，直到本组末尾把它顶走。底色由 syncSurface() 实测
           侧栏真实背景后写进 --cpl-surface-bg，和列表逐像素同色，所以看不出色块；
           不透明才能挡住滚上来的会话文字。显式清掉圆角/边框，别被原生样式命中。
           文字用次要色，不能用 opacity —— 那会把整块背景一起变透明。
           top 不写死 0：sticky 是相对滚动容器的 padding box 定位，容器有上内边距时
           标题只能钉在 padding 下沿，上面那条缝会露出正在滚动的会话文字。syncSurface()
           会实测容器 padding-top 写进 --cpl-pin-top（负值），把标题顶到真正的视口上缘。
           line-height 写绝对值：默认 1.5 会算出 16.5px，标题和条目高度带 .5px 小数，
           滚动时每帧的像素对齐结果来回跳，看起来就是发虚/抖动。 */
        .cpl-group { position: sticky; top: var(--cpl-pin-top, 0px); z-index: 1; padding: 10px 8px 4px;
          border: 0; border-radius: 0; box-shadow: none;
          font-size: 11px; font-weight: 500; line-height: 16px;
          color: var(--codex-plus-text-secondary, var(--color-token-text-secondary, inherit));
          background: var(--cpl-surface-bg, var(--codex-plus-bg-primary, Canvas)); }
        .cpl-section:first-child > .cpl-group { padding-top: 4px; }
        .cpl-item { border-radius: 8px; }
        .cpl-item:hover { background: rgba(127,127,127,.10); }
        .cpl-open { display: flex; flex-direction: column; gap: 3px; width: 100%; box-sizing: border-box;
          padding: 6px 8px; border: 0; background: transparent; color: inherit; text-align: left;
          cursor: pointer; font: inherit; }
        .cpl-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .cpl-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; }
        .cpl-status { display: inline-flex; align-items: center; flex: none; }
        .cpl-status[hidden] { display: none; }
        .cpl-project { display: flex; align-items: center; gap: 5px; min-width: 0; opacity: .68; }
        .cpl-project-icon { display: inline-flex; width: 12px; height: 12px; flex: none; }
        .cpl-project-icon svg { width: 12px; height: 12px; }
        .cpl-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; flex: 0 1 auto; min-width: 0; }
        /* git 分支：跟在项目名后面，长名字先截断项目名，分支保底留一点宽度。 */
        .cpl-branch { display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; }
        .cpl-branch[hidden] { display: none; }
        .cpl-branch-icon { display: inline-flex; width: 11px; height: 11px; flex: none; }
        .cpl-branch-icon svg { width: 11px; height: 11px; }
        .cpl-branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 96px; font-size: 11px; line-height: 16px; }
        .cpl-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 8px 8px 4px; font-size: 12px; opacity: .8; }
        .cpl-more { border: 1px solid rgba(127,127,127,.28); border-radius: 7px;
          background: transparent; color: inherit; padding: 4px 10px; cursor: pointer; font: inherit; }
        .cpl-more[hidden] { display: none; }
      `;
      document.head.append(style);
    }

    /**
     * 把任意 CSS 颜色解析成 [r, g, b, a]。
     *
     * 侧栏的底色不是 rgb()：Codex 用的是 `oklab(… / .65)` 和
     * `color(srgb … / .85)`，只认 rgb 会让整条祖先链全被跳过、一路落到
     * <html> 的 #f5f5f5 —— 那正是之前一直显示灰条的原因。这里优先让浏览器
     * 自己解析：画到 1×1 canvas 上再读像素；没有 2d 上下文时才退回 rgb 正则。
     */
    let colorProbe;
    function parseColor(value) {
      try {
        if (colorProbe === undefined) {
          const canvas = document.createElement('canvas');
          canvas.width = 1; canvas.height = 1;
          colorProbe = typeof canvas.getContext === 'function'
            ? canvas.getContext('2d', { willReadFrequently: true }) : null;
        }
        if (colorProbe) {
          const sentinel = 'rgba(0, 0, 0, 0)';
          colorProbe.clearRect(0, 0, 1, 1);
          colorProbe.fillStyle = sentinel;
          colorProbe.fillStyle = value;
          // 赋值无效时 fillStyle 保持原值，用它判断这种语法能不能解析。
          if (String(colorProbe.fillStyle) !== sentinel) {
            colorProbe.fillRect(0, 0, 1, 1);
            const data = colorProbe.getImageData(0, 0, 1, 1).data;
            return [data[0], data[1], data[2], data[3] / 255];
          }
        }
      } catch { colorProbe = null; }
      const match = /^rgba?\(([^)]+)\)$/.exec(value);
      if (!match) return null;
      const parts = match[1].split(',').map(part => Number(part.trim()));
      if (parts.length < 3 || !parts.every(Number.isFinite)) return null;
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    }

    /** canvas 读回的 alpha 只有 8 位精度（.65 → .651），逐层累加会偏差一个色阶，
        能从原始字符串里取到精确值就取。 */
    function exactAlpha(value, fallback) {
      const slash = /\/\s*([0-9.]+)\s*\)/.exec(value);
      const legacy = /^rgba\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*([0-9.]+)\s*\)$/.exec(value);
      const alpha = Number(slash ? slash[1] : legacy ? legacy[1] : NaN);
      return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : fallback;
    }

    /**
     * 吸顶标题要和列表背景逐像素一致，不能靠猜主题变量：Codex 的
     * --color-token-bg-primary 在当前主题下是浅灰，侧栏实际却是白的，
     * 套上去就是一块显眼的灰条。这里从滚动容器沿祖先链读出真实背景色，
     * 半透明层按 alpha 合成，最后写成一个不透明的 rgb() 给 CSS 用。
     *
     * 顺带量一次滚动容器的 padding-top：sticky 以 padding box 为基准，
     * 不把这层内边距补掉，标题就贴不住视口上缘，上面会留一条露字的缝。
     */
    function syncSurface() {
      if (typeof getComputedStyle !== 'function') return;
      const scroller = document.querySelector(CPL_SCROLL_SELECTOR);
      if (scroller) {
        const pad = Number.parseFloat(getComputedStyle(scroller).paddingTop);
        const nextTop = Number.isFinite(pad) && pad > 0 ? `${-pad}px` : '0px';
        if (nextTop !== pinTop) {
          pinTop = nextTop;
          document.documentElement.style.setProperty('--cpl-pin-top', nextTop);
        }
      }
      let node = scroller || document.body;
      const layers = [];
      while (node && node.nodeType === 1) {
        const value = String(getComputedStyle(node).backgroundColor || '').trim();
        const layer = value && value !== 'transparent' ? parseColor(value) : null;
        if (layer) {
          const alpha = exactAlpha(value, layer[3]);
          if (alpha > 0) {
            layers.push([layer[0], layer[1], layer[2], alpha]);
            if (alpha >= 1) break;
          }
        }
        node = node.parentElement;
      }
      // 读不到可解析的背景（或环境没有布局）时别写变量，交给 CSS 的语义色兜底。
      if (!layers.length) return;
      let color = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const [r, g, b, a] = layers[i];
        color = [r * a + color[0] * (1 - a), g * a + color[1] * (1 - a), b * a + color[2] * (1 - a)];
      }
      const next = `rgb(${color.map(Math.round).join(',')})`;
      if (next === surfaceColor) return;
      surfaceColor = next;
      document.documentElement.style.setProperty('--cpl-surface-bg', next);
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
      syncSurface();
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
        groups.clear();
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

    /** 分组标题按 key 复用：分页追加、语言切换、状态刷新都只改文本，不重建 DOM。
        标题连同组内会话放在同一个 section 里，sticky 才有「被本组末尾顶走」的边界。 */
    function groupNode(group) {
      let g = groups.get(group.key);
      if (g) return g;
      const box = el('div', 'cpl-section');
      box.setAttribute('data-codex-plus-ext', CPL_EXT);
      const item = el('div', 'cpl-group');
      item.setAttribute('data-codex-plus-ext', CPL_EXT);
      item.setAttribute('role', 'presentation');
      box.append(item);
      g = { box, item, label: null };
      groups.set(group.key, g);
      return g;
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
      // 时间分区只改展示：ordered 仍按 updated_at 倒序，遇到新日期就开一个新 section。
      // 分页跨到同一天时 section 按 key 复用，不会重复；没有会话的日期自然不出现。
      const now = new Date();
      const buckets = [];
      let lastKey = null;
      for (const session of ordered) {
        const group = cplConversationGroup(session.updatedAt, now, str, langKey);
        if (group.key !== lastKey) { buckets.push({ group, items: [] }); lastKey = group.key; }
        buckets[buckets.length - 1].items.push(nodes.get(session.id).item);
      }
      const wantedGroups = new Set();
      for (const bucket of buckets) {
        const g = groupNode(bucket.group);
        if (g.label !== bucket.group.label) { g.label = bucket.group.label; g.item.textContent = bucket.group.label; }
        wantedGroups.add(bucket.group.key);
        // 标题永远在组首，组内会话按顺序跟在后面；换组的会话节点会被 append 直接搬过来。
        // 顺序没变就别碰 DOM：append 即使搬的是同一批节点，也会先摘再插、触发重排和
        // 滚动锚定，会话状态每秒刷新时列表就会跟着抖一下。
        const kids = g.box.children;
        let same = kids.length === bucket.items.length + 1 && kids[0] === g.item;
        if (same) {
          for (let i = 0; i < bucket.items.length; i += 1) {
            if (kids[i + 1] !== bucket.items[i]) { same = false; break; }
          }
        }
        if (!same) g.box.append(g.item, ...bucket.items);
      }
      for (const [key, g] of groups) {
        if (!wantedGroups.has(key)) { g.box.remove(); groups.delete(key); }
      }
      let ref = listEl.firstElementChild;
      for (const bucket of buckets) {
        const box = groups.get(bucket.group.key).box;
        if (box === ref) ref = ref.nextElementSibling; else listEl.insertBefore(box, ref);
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
        groups.clear();
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
