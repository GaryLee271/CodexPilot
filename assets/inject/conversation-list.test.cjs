const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(`${__dirname}/renderer-inject/62-conversation-list.js`, "utf8");
const ENTRY_ID = "codex-plus-header-conversation-list";
const ACTIVE = "data-codex-plus-conversation-list-active";
// 分片在 vm realm 里创建的对象，跨 realm deepStrictEqual 会因原型不同失败，先归一化。
const plain = value => JSON.parse(JSON.stringify(value));
const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

const BASE_SESSIONS = [
  { id: IDS[1], title: "中间", updatedAt: 200, directory: "other", cwd: "/work/other" },
  { id: IDS[2], title: "最旧", updatedAt: 100, projectName: "Beta", projectId: "p-b", projectKind: "local", gitBranch: "codex/feature", cwd: "/work/beta" },
  { id: IDS[0], title: "最新", updatedAt: 300, projectName: "Alpha", projectId: "p-a", projectKind: "local", gitBranch: "main", cwd: "/work/alpha" },
];

// 最小 DOM 驱动真实分片：模拟原生侧栏滚动区与分组，不复制列表实现。
function fixture(options = {}) {
  const actions = [], bridgeCalls = [], states = [], projects = [];
  let document, aside;
  const listeners = (target) => {
    target.listeners = new Map();
    target.addEventListener = (type, callback, opts = {}) => {
      const set = target.listeners.get(type) || new Set();
      set.add(callback); target.listeners.set(type, set);
      opts?.signal?.addEventListener?.("abort", () => set.delete(callback), { once: true });
    };
    target.fire = (type, detail = {}) => {
      const event = { type, target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...detail };
      for (const callback of target.listeners.get(type) || []) callback(event);
      return event;
    };
  };
  class Element {
    constructor(tag = "div") {
      listeners(this);
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
      this.dataset = {}; this.hidden = false;
      const classes = new Set();
      this.classList = {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle: (x, on) => on ? classes.add(x) : classes.delete(x),
      };
      Object.defineProperty(this, "className", {
        get: () => [...classes].join(" "),
        set: value => { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); },
      });
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove?.(); this.children.push(node); node.parentElement = this; } }
    insertBefore(node, ref) { node.remove?.(); const at = this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, node); node.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    get isConnected() { return this === document.documentElement || !!this.parentElement?.isConnected; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    get previousElementSibling() {
      const siblings = this.parentElement?.children || [];
      const at = siblings.indexOf(this);
      return at > 0 ? siblings[at - 1] : null;
    }
    matches(selector) {
      if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
      // 支持「标签 + 属性」组合，如 button[aria-label="搜索"]。
      const compound = /^([a-z][\w-]*)(\[[^\]]+\])$/.exec(selector);
      if (compound) return this.tagName === compound[1].toUpperCase() && this.matches(compound[2]);
      if (selector.startsWith(".")) return selector.slice(1).split(".").every(name => this.classList.contains(name));
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      if (selector.startsWith("[")) {
        const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
        return !!match && (match[2] === undefined ? this.hasAttribute(match[1]) : this.getAttribute(match[1]) === match[2]);
      }
      return this.tagName === selector.toUpperCase();
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    click() { this.fire("click"); }
    // 只复制标签、类名与属性：分片克隆原生按钮后会清空内容再换图标。
    cloneNode() {
      const copy = new Element(this.tagName.toLowerCase());
      copy.className = this.className;
      for (const [name, value] of this.attributes) copy.attributes.set(name, value);
      return copy;
    }
  }
  document = { createElement: tag => new Element(tag) };
  listeners(document);
  document.documentElement = new Element("html");
  document.documentElement.lang = "zh-CN";
  document.head = new Element("head");
  document.body = new Element("body");
  document.documentElement.append(document.head, document.body);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  const main = new Element("main");
  main.setAttribute("data-app-shell-main-surface", "default");
  aside = new Element("aside");
  // 真实布局：侧栏 = 头部（品牌 + 铃铛 + 搜索） + 会话滚动区。入口要挂在头部、紧跟搜索。
  const header = new Element("div");
  const brand = new Element("div");
  brand.textContent = "Codex";
  const bell = new Element("button");
  bell.setAttribute("aria-label", "通知");
  const search = new Element("button");
  search.setAttribute("aria-label", "搜索");
  header.append(brand, bell, search);
  document.body.append(main, aside);
  const scroll = new Element();
  scroll.setAttribute("data-app-action-sidebar-scroll", "");
  const chats = new Element();
  chats.setAttribute("data-app-action-sidebar-section", "");
  chats.setAttribute("data-app-action-sidebar-section-heading", "Chats");
  const projectsSection = new Element();
  projectsSection.setAttribute("data-app-action-sidebar-section", "");
  projectsSection.setAttribute("data-app-action-sidebar-section-heading", "Projects");
  scroll.append(chats, projectsSection);
  aside.append(header, scroll);
  const rows = IDS.map(id => {
    const row = new Element();
    row.setAttribute("data-app-action-sidebar-thread-id", `local:${id}`);
    row.click = () => actions.push({ type: "row", id });
    chats.append(row);
    return row;
  });
  const sessions = options.sessions || BASE_SESSIONS;
  const window = {
    location: { href: options.url || "app://-/index.html" },
    electronBridge: { sendMessageFromView: message => actions.push(message) },
    __codexSessionDeleteBridge: (route, payload) => {
      bridgeCalls.push({ route, payload });
      if (options.bridgeError) return Promise.resolve({ status: "failed", message: options.bridgeError });
      const { limit = 50, offset = 0 } = payload.params || {};
      return Promise.resolve({
        status: "ok",
        result: { sessions: sessions.slice(offset, offset + limit), total: sessions.length, offset, limit },
      });
    },
  };
  const nativeStatus = options.nativeStatus ? {
    context: () => ({}),
    watch: (context, ids, changed, projectsChanged) => {
      changed(new Map([[IDS[0], "active"]]));
      projectsChanged(new Map([[IDS[0], { id: "p-a", name: "Alpha 原生", kind: "local" }]]));
      return () => {};
    },
    mount: () => ({ render: state => states.push(state), dispose() {} }),
    mountProject: () => ({ render: project => projects.push(project), dispose() {} }),
  } : undefined;
  const context = vm.createContext({
    window, document, console,
    navigator: { language: "zh-CN" }, URL, AbortController,
    codexPlusBackendSettings: { enhancementsEnabled: true, codexAppConversationList: options.enabled !== false },
    loadCodexPlusConversationTabStatusApi: nativeStatus ? () => Promise.resolve(nativeStatus) : undefined,
  });
  vm.runInContext(source, context);
  context.syncCodexPlusConversationList();
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    context, window, document, actions, bridgeCalls, states, projects, rows, aside, scroll, header, search, flush,
    entry: () => document.querySelector(`#${ENTRY_ID}`),
    panel: () => document.querySelector(".cpl-panel"),
    sync: () => context.syncCodexPlusConversationList(),
    toggle: () => context.window.__codexPlusConversationList.toggle(),
    active: () => context.window.__codexPlusConversationList.isActive(),
    items: () => document.querySelectorAll(".cpl-item"),
    labels: () => document.querySelectorAll(".cpl-label").map(node => node.textContent),
    names: () => document.querySelectorAll(".cpl-project-name").map(node => node.textContent),
    branches: () => document.querySelectorAll(".cpl-branch-name").map(node => node.textContent),
    branchHidden: () => document.querySelectorAll(".cpl-branch").map(node => node.hidden),
    more: () => document.querySelector(".cpl-more"),
  };
}

test("独立开关与子窗口门控；侧栏头部搜索旁入口与侧栏内列表", () => {
  const closed = fixture({ enabled: false });
  assert.equal(closed.entry(), null);
  assert.equal(closed.context.window.__codexPlusConversationList, undefined);
  const child = fixture({ url: "app://-/index.html?initialRoute=/local/" + IDS[0] });
  assert.equal(child.entry(), null);

  const h = fixture();
  assert.ok(h.entry(), "侧栏头部出现最近会话入口");
  assert.equal(h.entry().getAttribute("data-codex-plus-ext"), "conversation-list");
  assert.equal(h.entry().parentElement, h.header, "入口挂在侧栏头部");
  assert.equal(h.entry().previousElementSibling, h.search, "紧跟在搜索按钮后面");
  assert.ok(h.panel(), "列表容器挂在原生滚动区内");
  assert.equal(h.panel().parentElement, h.scroll);
  assert.equal(h.scroll.hasAttribute(ACTIVE), false, "默认仍是原生列表");

  h.context.codexPlusBackendSettings.codexAppConversationList = false;
  h.sync();
  assert.equal(h.entry(), null);
  assert.equal(h.panel(), null);
  assert.equal(h.scroll.hasAttribute(ACTIVE), false);
  assert.equal(h.context.window.__codexPlusConversationList, undefined);
});

test("点击入口在侧栏内切换视图：原生分组只隐藏不删除，再点切回", async () => {
  const h = fixture();
  const nativeSections = h.document.querySelectorAll("[data-app-action-sidebar-section]");
  assert.equal(nativeSections.length, 2);
  h.scroll.scrollTop = 320;
  h.entry().click();
  await h.flush();
  assert.equal(h.active(), true);
  assert.equal(h.scroll.scrollTop, 0, "打开时间线回到最新，不沿用原生列表的滚动位置");
  assert.equal(h.scroll.getAttribute(ACTIVE), "true", "滚动区标记为替换视图");
  assert.equal(h.document.querySelectorAll("[data-app-action-sidebar-section]").length, 2, "原生分组仍在 DOM 里");
  assert.equal(h.entry().getAttribute("aria-pressed"), "true");
  assert.equal(h.items().length, 3);

  h.toggle();
  assert.equal(h.active(), false);
  assert.equal(h.scroll.hasAttribute(ACTIVE), false);
  assert.equal(h.entry().getAttribute("aria-pressed"), "false");
});

test("按更新时间倒序，两行显示标题/状态、项目与分支，目录兜底", async () => {
  const h = fixture();
  h.toggle();
  await h.flush();
  assert.deepEqual(plain(h.bridgeCalls[0]), {
    route: "/extensions/history",
    payload: { method: "listRecentThreads", params: { limit: 50, offset: 0, excludeSubagents: true } },
  });
  assert.deepEqual(h.labels(), ["最新", "中间", "最旧"]);
  assert.deepEqual(h.names(), ["Alpha", "目录：other", "Beta"]);
  assert.deepEqual(h.branches(), ["main", "", "codex/feature"], "git 项目显示当前分支");
  assert.deepEqual(h.branchHidden(), [false, true, false], "非 git 会话不占位");
  const first = h.items()[0];
  assert.ok(first.querySelector(".cpl-title-row"));
  assert.ok(first.querySelector(".cpl-project"));
  assert.equal(first.querySelector(".cpl-status").hidden, true, "无原生状态时状态位隐藏");
});

test("同秒按 id 稳定排序，避免刷新时列表跳动", async () => {
  const h = fixture({ sessions: [
    { id: "b", title: "B", updatedAt: 100, cwd: "/w" },
    { id: "a", title: "A", updatedAt: 100, cwd: "/w" },
  ] });
  h.toggle();
  await h.flush();
  assert.deepEqual(h.labels(), ["A", "B"]);
});

test("点击条目切换会话且列表保持打开；侧栏没有该行时回退主窗口消息", async () => {
  const h = fixture();
  h.toggle();
  await h.flush();
  h.items()[0].querySelector(".cpl-open").click();
  assert.deepEqual(plain(h.actions[0]), { type: "row", id: IDS[0] });
  assert.equal(h.active(), true, "像原生列表一样可以连续跳");

  h.rows.forEach(row => row.remove());
  h.items()[0].querySelector(".cpl-open").click();
  assert.deepEqual(plain(h.actions[1]), { type: "open-in-main-window", path: `/local/${IDS[0]}` });
});

test("滚动加载按分页追加，到 100 条上限后不再请求", async () => {
  const many = Array.from({ length: 120 }, (_, index) => ({
    id: `t-${String(index).padStart(3, "0")}`, title: `会话 ${index}`, updatedAt: 10000 - index,
    projectName: "批量", cwd: "/work/batch",
  }));
  const h = fixture({ sessions: many });
  h.toggle();
  await h.flush();
  assert.equal(h.items().length, 50);
  h.more().click();
  await h.flush();
  assert.equal(h.items().length, 100);
  assert.deepEqual(plain(h.bridgeCalls[1].payload.params), { limit: 50, offset: 50, excludeSubagents: true });
  assert.equal(h.more().hidden, true);
});

test("后端失败只提示；原生适配可用时接管状态与项目名", async () => {
  const failed = fixture({ bridgeError: "读取失败" });
  failed.toggle();
  await failed.flush();
  assert.ok(failed.document.querySelector(".cpl-footer-status").textContent.includes("读取失败"));

  const h = fixture({ nativeStatus: true });
  h.toggle();
  await h.flush();
  assert.deepEqual(h.states, ["active"]);
  assert.equal(h.names()[0], "Alpha 原生");
  assert.equal(h.items()[0].querySelector(".cpl-status").hidden, false);
});

test("原生侧栏被 React 重建后，每轮 sync 补回入口与列表", async () => {
  const h = fixture();
  h.toggle();
  await h.flush();
  assert.equal(h.items().length, 3);
  h.scroll.remove();
  const rebuilt = h.document.createElement("div");
  rebuilt.setAttribute("data-app-action-sidebar-scroll", "");
  h.aside.append(rebuilt);
  h.sync();
  assert.ok(h.entry(), "侧栏重建后头部入口仍在");
  assert.equal(h.panel().parentElement, rebuilt, "列表挂到新的滚动区");
  assert.equal(rebuilt.getAttribute(ACTIVE), "true", "替换视图状态不丢");
  assert.equal(h.items().length, 3, "数据重画，不依赖旧 DOM");
  h.context.window.__codexPlusConversationList.dispose();
  assert.equal(rebuilt.hasAttribute(ACTIVE), false);
  assert.equal(h.entry(), null);
});
