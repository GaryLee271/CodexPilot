const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const statusSource = fs.readFileSync(`${__dirname}/renderer-inject/61-conversation-tab-status.js`, "utf8");
const source = statusSource + fs.readFileSync(`${__dirname}/renderer-inject/61-conversation-tabs.js`, "utf8");
const key = "codex-plus:conversation-tabs:v1";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

// 模拟原生已完成初始化的模块缓存；适配器不得为了识别功能而提前执行工厂。
function cachedModules(modules) {
  return Object.fromEntries(Object.keys(modules).map(id => [id, { get exports() { return modules[id]; } }]));
}

// 用最小 DOM 驱动真实分片的事件和生命周期；不复制排序、关闭或持久化实现。
function fixture(options = {}) {
  const observers = [], timers = new Map(), intervals = new Map(), frames = new Map(), actions = [];
  let seq = 0, now = 0, document;
  const events = (target) => {
    target.listeners = new Map();
    target.addEventListener = (type, callback, opts = {}) => {
      const set = target.listeners.get(type) || new Set();
      set.add(callback); target.listeners.set(type, set);
      opts.signal?.addEventListener("abort", () => set.delete(callback), { once: true });
    };
    target.fire = (type, detail = {}) => {
      const event = { type, target, detail: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...detail };
      for (const callback of target.listeners.get(type) || []) callback(event);
      return event;
    };
  };
  class Element {
    constructor(tag = "div") {
      events(this); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.hidden = false; this.disabled = false; this.scrollLeft = 0;
      const classes = new Set();
      this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) };
      Object.defineProperty(this, "className", { get: () => [...classes].join(" "), set: value => { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); } });
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
    insertBefore(node, ref) { node.remove(); const at = this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, node); node.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
    get isConnected() { return this === document.documentElement || !!this.parentElement?.isConnected; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    get offsetLeft() { return Math.max(0, this.parentElement?.children.indexOf(this) ?? 0) * 170; }
    get offsetWidth() { return 168; }
    get clientWidth() { return 600; }
    get scrollWidth() { return this.children.length * 170; }
    matches(selector) {
      if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
      if (selector === "button:not(:disabled)") return this.tagName === "BUTTON" && !this.disabled;
      if (selector.includes(" ")) { const at = selector.lastIndexOf(" "); return this.matches(selector.slice(at + 1)) && !!this.parentElement?.closest(selector.slice(0, at)); }
      if (selector.startsWith(".")) return selector.slice(1).split(".").every(name => this.classList.contains(name));
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      if (selector.startsWith("[")) { const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector); return !!match && (match[2] === undefined ? this.hasAttribute(match[1]) : this.getAttribute(match[1]) === match[2]); }
      return this.tagName === selector.toUpperCase();
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    getBoundingClientRect() { const width = this.hidden || this.getAttribute("data-fixture-hidden") === "true" ? 0 : this.rect?.width ?? 800; return { x: 200, y: 44, left: 200 + (this.classList.contains("cpt-item") ? this.offsetLeft : 0), right: 200 + width, top: 44, bottom: 84, height: 40, width, ...this.rect }; }
    focus() { document.activeElement = this; }
    click() { this.fire("click"); }
    dispatchEvent(event) { return this.fire(event.type, event); }
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  document = { hidden: false, createElement: tag => new Element(tag) }; events(document);
  document.documentElement = new Element("html"); document.documentElement.lang = options.lang || "zh-CN";
  document.head = new Element("head"); document.body = new Element("body"); document.documentElement.append(document.head, document.body); document.activeElement = document.body;
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  const main = new Element("main"), content = new Element(), titlebar = new Element("header"), sidebar = new Element("aside");
  if (!options.loadingShell) main.setAttribute("data-app-shell-main-surface", "default");
  content.setAttribute("data-app-shell-main-content-layout", "true"); titlebar.setAttribute("data-app-shell-main-titlebar", "true"); titlebar.rect = { bottom: 44 };
  main.append(content); document.body.append(sidebar, titlebar, main);
  const rows = ids.map((id, i) => {
    const row = new Element();
    for (const [name, value] of Object.entries({ row: "", id: `local:${id}`, "host-id": "local", kind: "local", title: `对话 ${i + 1}`, active: i === 0 ? "true" : "false" })) row.setAttribute(`data-app-action-sidebar-thread-${name}`, value);
    row.click = () => { actions.push({ type: "sidebar", id }); if (!options.delayedNavigation) activate(i); };
    row.addEventListener("contextmenu", () => actions.push({ type: "contextmenu", id }));
    sidebar.append(row); return row;
  });
  function activate(index) { rows.forEach((row, i) => row.setAttribute("data-app-action-sidebar-thread-active", String(i === index))); }
  const data = options.data || new Map();
  const storage = { getItem: name => data.get(name) ?? null, setItem: (name, value) => data.set(name, value) };
  const window = { location: { href: options.url || "app://-/index.html" }, localStorage: storage, electronBridge: { sendMessageFromView: message => { actions.push(message); if (!options.delayedNavigation) activate(ids.indexOf(message.path.split("/").at(-1))); } } }; events(window);
  const context = vm.createContext({
    window, document, location: window.location, navigator: { language: "zh-CN", userAgent: options.windows ? "Windows" : "Macintosh" }, URL, AbortController: class extends AbortController { constructor() { super(); require("node:events").setMaxListeners(0, this.signal); } },
    codexPlusBackendSettings: { enhancementsEnabled: true, codexAppConversationTabs: options.enabled !== false },
    performance: { now: () => now }, innerWidth: 1200, innerHeight: 800, getComputedStyle: () => ({ backgroundColor: "rgb(255, 255, 255)" }),
    MutationObserver: class { constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); } observe() { this.connected = true; } disconnect() { this.connected = false; } },
    ResizeObserver: class { observe() {} disconnect() {} }, MouseEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    setTimeout: (fn, delay) => { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++seq; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    requestAnimationFrame: fn => { const id = ++seq; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    sessionRefFromRow: row => row.canonical || {},
  });
  const load = () => {
    vm.runInContext(source, context);
    if (options.nativeStatus) context.loadCodexPlusConversationTabStatusApi = () => Promise.resolve(options.nativeStatus);
    if (options.nativeStatusLoader) context.loadCodexPlusConversationTabStatusApi = options.nativeStatusLoader;
    context.syncCodexPlusConversationTabs();
  };
  const refresh = () => { now += 1600; for (const fn of [...intervals.values()]) fn(); };
  load();
  return { context, window, document, content, main, sidebar, rows, actions, data, observers, timers, intervals, frames, activate, refresh, load,
    items: () => document.querySelectorAll(".cpt-item"), list: () => document.querySelector(".cpt-list"),
    saved: () => JSON.parse(data.get(key) || "[]"),
    route: value => {
      main.setAttribute("data-app-shell-active-page", "true");
      main.__reactFiber$fixture = { memoizedProps: { value }, return: null };
    },
    flush: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    open: index => { activate(index); refresh(); },
    key: (value, extra = {}) => document.fire("keydown", { key: value, metaKey: !options.windows, ctrlKey: !!options.windows, ...extra }),
    close: index => { const item = document.querySelectorAll(".cpt-item")[index]; document.querySelector(".cpt-list").fire("click", { target: item.querySelector(".cpt-close") }); },
  };
}

test("默认关闭和子窗口不创建 UI；关闭总开关释放监听与布局，缓存保留", () => {
  for (const options of [{ enabled: false }, { url: "app://-/index.html?initialRoute=/local/" + ids[0] }]) {
    const h = fixture(options); assert.equal(h.items().length, 0); assert.equal(h.intervals.size, 0);
  }
  const h = fixture(); h.open(1);
  assert.equal(h.items().length, 2); assert.ok(h.content.hasAttribute("data-codex-plus-tabs-space"));
  const saved = h.data.get(key);
  h.context.codexPlusBackendSettings.enhancementsEnabled = false; h.context.syncCodexPlusConversationTabs();
  assert.equal(h.items().length, 0); assert.equal(h.intervals.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.observers.some(o => o.connected), false); assert.equal(h.content.hasAttribute("data-codex-plus-tabs-space"), false);
  assert.equal(h.data.get(key), saved);
  h.context.codexPlusBackendSettings.enhancementsEnabled = true; h.context.syncCodexPlusConversationTabs();
  assert.equal(h.items().length, 2);
});

test("原生点击与折叠行的消息回退、快捷键和运行状态均沿本地会话 UUID", () => {
  const h = fixture(); h.open(1); h.open(2);
  h.key("1"); assert.equal(h.actions.at(-1).id, ids[0]);
  h.rows[1].setAttribute("data-fixture-hidden", "true"); h.key("2");
  assert.equal(h.actions.at(-1).type, "open-in-main-window");
  assert.equal(h.actions.at(-1).path, `/local/${ids[1]}`);
  h.key("9"); assert.equal(h.actions.at(-1).id, ids[2]);
  h.rows[2].setAttribute("data-fixture-hidden", "true"); h.refresh();
  assert.equal(h.items()[2].querySelector(".cpt-open").getAttribute("aria-selected"), "true", "收起侧栏不能丢失原生选中项");
  const indicator = h.document.createElement("span"); indicator.setAttribute("data-loading-indicator", ""); h.rows[2].append(indicator); h.refresh();
  assert.equal(h.items()[2].querySelector(".cpt-dot").hidden, false);
  indicator.remove(); h.refresh(); assert.equal(h.items()[2].querySelector(".cpt-dot").hidden, true);
  const windows = fixture({ windows: true }); windows.open(1); windows.key("1"); assert.equal(windows.actions.at(-1).id, ids[0]);
});

test("侧栏行卸载后，点击标签的选中态不能在后续轮询中消失", () => {
  const h = fixture(); h.open(1);
  h.rows.forEach(row => row.remove());
  h.key("1");
  const selected = () => h.items().filter(item => item.querySelector(".cpt-open").getAttribute("aria-selected") === "true").map(item => item.dataset.id);
  assert.deepEqual(selected(), [ids[0]], "点击时应立即高亮目标标签");
  for (let i = 0; i < 4; i++) {
    h.refresh();
    assert.deepEqual(selected(), [ids[0]], "没有新的原生路由证据时，轮询不能清空当前标签");
  }
  h.key("2"); h.refresh();
  assert.deepEqual(selected(), [ids[1]], "读不到路由时仍应能切回上次已确认的标签");
  assert.equal(h.actions.at(-1).path, `/local/${ids[1]}`);
});

test("原生当前路由优先于侧栏旧选中项；首页与远端页面清除高亮，路由短暂缺失不清除", () => {
  const h = fixture();
  const local = id => ({ routeKind: "local-thread", conversationId: id, pathname: `/local/${id}`, hostId: null });
  const selected = () => h.items().filter(item => item.classList.contains("cpt-active")).map(item => item.dataset.id);
  h.route(local(ids[1])); h.refresh(); assert.deepEqual(selected(), [ids[1]], "原生路由已切换时不能回到侧栏旧行");
  h.rows.forEach(row => row.remove());
  for (let i = 0; i < 4; i++) { h.refresh(); assert.deepEqual(selected(), [ids[1]]); }
  h.route(null); h.refresh(); assert.deepEqual(selected(), [ids[1]]);
  h.route({ routeKind: "home", pathname: "/", conversationId: null }); h.refresh(); assert.deepEqual(selected(), []);
  h.route(local(ids[0])); h.refresh(); assert.deepEqual(selected(), [ids[0]]);
  h.route({ ...local(ids[2]), hostId: "remote-host" }); h.refresh(); assert.deepEqual(selected(), []);
  assert.equal(h.items().length, 2, "远端路由不能生成本地标签");
  h.route({ routeKind: "remote-thread", pathname: `/remote/${ids[2]}` }); h.refresh(); assert.deepEqual(selected(), []);
});

test("忽略隐藏 retained 页面的路由，并读取 React 已提交的 alternate 树", () => {
  const h = fixture();
  const local = id => ({ routeKind: "local-thread", conversationId: id, pathname: `/local/${id}`, hostId: "local" });
  h.route(local(ids[0]));
  const hidden = h.document.createElement("div"), retained = h.document.createElement("div");
  hidden.setAttribute("data-app-shell-active-page", "false"); retained.setAttribute("data-app-shell-active-page", "true");
  retained.__reactFiber$fixture = { memoizedProps: { value: local(ids[2]) } };
  hidden.append(retained); h.document.body.insertBefore(hidden, h.main);
  h.refresh(); assert.equal(h.items().length, 1, "隐藏页不能抢走当前路由或生成标签");
  const oldRoot = { stateNode: {} }, newRoot = {};
  oldRoot.stateNode.current = newRoot;
  h.main.__reactFiber$fixture = {
    memoizedProps: { value: local(ids[0]) }, return: oldRoot,
    alternate: { memoizedProps: { value: local(ids[1]) }, return: newRoot },
  };
  h.refresh();
  assert.equal(h.items().find(item => item.classList.contains("cpt-active")).dataset.id, ids[1]);
});

test("原生确认仍在旧路由时，失败导航超时应回到真实当前标签", () => {
  const h = fixture({ delayedNavigation: true }); h.open(1); h.activate(0);
  h.route({ routeKind: "local-thread", conversationId: ids[0], pathname: `/local/${ids[0]}`, hostId: "local" }); h.refresh();
  h.key("2");
  assert.equal(h.items()[1].querySelector(".cpt-open").getAttribute("aria-selected"), "true");
  h.refresh();
  assert.equal(h.items()[0].querySelector(".cpt-open").getAttribute("aria-selected"), "true", "不能通过无限保留乐观选中态掩盖导航失败");
});

test("关闭当前、其他、右侧和最后一个标签只操作标签及导航，迟到选中态不会复活", () => {
  const h = fixture({ delayedNavigation: true }); h.open(1); h.open(2); h.close(2); h.refresh();
  assert.deepEqual(h.saved().map(t => t.id), ids.slice(0, 2));
  h.list().fire("contextmenu", { target: h.items()[0], clientX: 300, clientY: 70 });
  h.document.querySelector("#codex-plus-conversation-tabs-menu").children[2].click();
  assert.deepEqual(h.saved().map(t => t.id), [ids[0]]);
  h.activate(0); h.refresh(); h.close(0); h.refresh();
  assert.deepEqual(h.saved(), []); assert.equal(h.actions.at(-1).path, "/");
  assert.ok(h.actions.every(a => ["sidebar", "open-in-main-window"].includes(a.type)));
});

test("拖动提交顺序并可重载，Escape 撤销，重复注入只有一个运行时", () => {
  const h = fixture(); h.open(1); h.open(2);
  const drag = (target, from, to, cancel = false) => {
    const list = h.list(); list.fire("pointerdown", { target, button: 0, pointerId: 1, clientX: from });
    list.fire("pointermove", { target, pointerId: 1, buttons: 1, clientX: to });
    if (cancel) h.document.fire("keydown", { key: "Escape" }); else list.fire("pointerup", { pointerId: 1 });
  };
  drag(h.items()[0], 0, 400);
  assert.deepEqual(h.saved().map(t => t.id), [ids[1], ids[2], ids[0]]);
  drag(h.items()[0], 0, 400, true);
  assert.deepEqual(h.saved().map(t => t.id), [ids[1], ids[2], ids[0]]);
  h.load(); assert.equal(h.intervals.size, 1); assert.equal(h.items().length, 3);
  assert.equal(h.timers.size, 0, "热重注入必须取消旧拖动的收尾计时器");
  assert.deepEqual(h.saved().map(t => t.id), [ids[1], ids[2], ids[0]]);
});

test("临时 ID 仅随已核验正式引用转换，不按标题合并；远端及未知归属不进入标签", () => {
  const h = fixture();
  h.route({ routeKind: "client-local-thread", clientThreadId: "client-new-thread:temporary", pathname: "/local/client-new-thread:temporary" });
  h.rows[1].setAttribute("data-app-action-sidebar-thread-id", "local:client-new-thread:temporary");
  h.rows[1].setAttribute("data-app-action-sidebar-thread-title", "对话 1"); h.open(1);
  assert.deepEqual(h.saved().map(t => t.id), [ids[0]]);
  h.rows[1].canonical = { host_id: "local", session_id: ids[1] }; h.refresh();
  assert.deepEqual(h.saved().map(t => t.id), ids.slice(0, 2));
  h.rows[2].setAttribute("data-app-action-sidebar-thread-host-id", "remote"); h.open(2);
  assert.equal(h.saved().length, 2);
  h.rows[2].setAttribute("data-app-action-sidebar-thread-host-id", ""); h.refresh(); assert.equal(h.saved().length, 2);
});

test("坏缓存安全回退，重复 UUID 去重，外部元数据不进入持久化", () => {
  for (const value of ["null", "{}", "malformed"]) assert.equal(fixture({ data: new Map([[key, value]]) }).items().length, 1);
  const h = fixture({ data: new Map([[key, JSON.stringify([{ id: ids[0], title: "旧", agent: "unused", running: true }, { id: ids[0], title: "新" }, { id: "../../escape", title: "非法" }])]]) });
  assert.equal(h.saved().length, 1); assert.deepEqual(Object.keys(h.saved()[0]).sort(), ["id", "title"]);
});

// 原生适配器替身只提供状态快照；用真实标签运行时验证订阅、清除时机和生命周期。
function nativeStatus() {
  const states = new Map(ids.map(id => [id, "idle"])), projects = new Map(ids.map(id => [id, null]));
  const watchers = new Set(), roots = new Set(), projectRoots = new Set();
  const context = { scope: { node: {} }, intl: { value: {} } };
  const api = {
    context: () => context,
    watch: (_, wanted, changed, projectsChanged) => {
      const emit = () => { changed(new Map(wanted.map(id => [id, states.get(id)]))); projectsChanged?.(new Map(wanted.map(id => [id, projects.get(id)]))); };
      watchers.add(emit); emit(); return () => watchers.delete(emit);
    },
    mount: element => {
      const root = { render: state => element.nativeState = state, dispose: () => roots.delete(root) };
      roots.add(root); return root;
    },
    mountProject: element => {
      const root = { render: project => element.nativeProject = project, dispose: () => projectRoots.delete(root) };
      projectRoots.add(root); return root;
    },
    description: state => state === "idle" ? "" : `原生状态：${state}`,
  };
  return { api, watchers, roots, projectRoots,
    set(id, state) { states.set(id, state); for (const emit of watchers) emit(); },
    setProject(id, project) { projects.set(id, project); for (const emit of watchers) emit(); },
  };
}

test("标题下方固定显示小项目行，原生重命名与会话移动在侧栏卸载后仍同步，归属不落盘", async () => {
  const native = nativeStatus(), h = fixture({ nativeStatus: native.api });
  await Promise.resolve();
  const first = () => h.items()[0];
  assert.equal(first().querySelector(".cpt-open").children[0].className, "cpt-title-row");
  assert.equal(first().querySelector(".cpt-open").children[1].className, "cpt-project");
  assert.equal(first().querySelector(".cpt-project-name").textContent, "未关联项目");
  const project = { id: "project-a", name: "自定义项目名", path: "/work/different-folder", kind: "local", hostId: "" };
  native.setProject(ids[0], project); h.flush();
  assert.equal(first().querySelector(".cpt-project-name").textContent, "自定义项目名", "名称必须来自原生项目，不取目录名");
  assert.equal(first().querySelector(".cpt-project-icon").nativeProject.id, "project-a");
  assert.ok(first().title.includes(project.path));
  h.rows[0].remove(); native.setProject(ids[0], { ...project, name: "重命名后的项目" }); h.flush();
  assert.equal(first().querySelector(".cpt-project-name").textContent, "重命名后的项目");
  native.setProject(ids[0], { ...project, id: "project-b", name: "另一个项目" }); h.flush();
  assert.equal(first().querySelector(".cpt-project-icon").nativeProject.id, "project-b");
  native.setProject(ids[0], null); h.flush();
  assert.equal(first().querySelector(".cpt-project-name").textContent, "未关联项目");
  assert.equal(first().querySelector(".cpt-project-icon").nativeProject, null);
  assert.deepEqual(Object.keys(h.saved()[0]).sort(), ["id", "title"]);
  h.open(1); h.close(1); h.refresh(); assert.equal(native.projectRoots.size, 1);
  h.load(); await Promise.resolve(); assert.equal(native.projectRoots.size, 1);
  h.window.__codexPlusConversationTabs.dispose(); assert.equal(native.projectRoots.size, 0);
});

test("收起侧栏并卸载会话行后，标签仍能按目标会话打开原生对话选项", async () => {
  const native = nativeStatus(), opened = [], released = [];
  native.api.canOpenThreadMenu = () => true;
  native.api.openThreadMenu = (context, id, x, y) => { opened.push({ id, x, y }); return true; };
  native.api.releaseThreadMenu = id => released.push(id);
  const h = fixture({ nativeStatus: native.api }); await Promise.resolve(); h.open(1);
  h.rows.forEach(row => row.remove());
  h.list().fire("contextmenu", { target: h.items()[0], clientX: 300, clientY: 70 });
  const option = h.document.querySelector("#codex-plus-conversation-tabs-menu").children[4];
  assert.equal(option.disabled, false, "会话行卸载不代表会话不存在");
  assert.equal(option.textContent, "对话选项…");
  option.click();
  assert.equal(opened.length, 1); assert.equal(opened[0].id, ids[0], "右键后台标签不能误用当前会话");
  assert.equal(h.actions.length, 0, "打开选项不能切换会话或展开侧栏");
  h.close(0); assert.deepEqual(released, [ids[0]]);
  h.window.__codexPlusConversationTabs.dispose(); assert.deepEqual(released, ids.slice(0, 2));
});

test("现有侧栏行继续使用原生事件；菜单适配失配时不误报会话不存在或保留展开态", async () => {
  const h = fixture();
  h.list().fire("contextmenu", { target: h.items()[0], clientX: 300, clientY: 70 });
  h.document.querySelector("#codex-plus-conversation-tabs-menu").children[4].click();
  assert.deepEqual(h.actions, [{ type: "contextmenu", id: ids[0] }]);
  h.rows.forEach(row => row.remove());
  h.list().fire("contextmenu", { target: h.items()[0], clientX: 300, clientY: 70 });
  const unavailable = h.document.querySelector("#codex-plus-conversation-tabs-menu").children[4];
  assert.equal(unavailable.textContent, "对话选项…"); assert.equal(unavailable.disabled, true);
  for (const open of [() => false, () => Promise.reject(new Error("menu unavailable")), () => { throw new Error("module unavailable"); }]) {
    const native = nativeStatus(); native.api.canOpenThreadMenu = () => true; native.api.openThreadMenu = open;
    const h = fixture({ nativeStatus: native.api }); await Promise.resolve(); h.rows.forEach(row => row.remove());
    h.list().fire("contextmenu", { target: h.items()[0], clientX: 300, clientY: 70 });
    const option = h.document.querySelector("#codex-plus-conversation-tabs-menu").children[4]; option.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(option.getAttribute("aria-expanded"), "false");
  }
});

test("项目模块不可用时保留固定副标题与文件夹图标，英文界面使用英文占位", () => {
  for (const [lang, expected] of [["zh-CN", "项目未识别"], ["en-US", "Project unavailable"]]) {
    const h = fixture({ lang });
    assert.equal(h.items()[0].querySelector(".cpt-project-name").textContent, expected);
    assert.match(h.items()[0].querySelector(".cpt-project-icon").innerHTML, /<svg/);
  }
});

test("原生状态实时订阅：后台、折叠和行卸载仍同步，切换标签不提前清除未读", async () => {
  const native = nativeStatus(), h = fixture({ nativeStatus: native.api });
  await Promise.resolve(); h.open(1);
  native.set(ids[0], "active"); h.flush();
  const first = () => h.items()[0].querySelector(".cpt-status");
  assert.equal(first().nativeState, "active"); assert.equal(first().hidden, false);
  assert.equal(h.items()[0].querySelector(".cpt-dot").hidden, true, "原生图标出现后不能叠加旧蓝点");
  assert.equal(h.items()[0].querySelector(".cpt-open").getAttribute("aria-busy"), "true");
  h.rows[0].remove(); native.set(ids[0], "unread"); h.flush();
  assert.equal(first().nativeState, "unread", "会话行卸载后完成状态仍应实时变成未读");
  h.key("1"); h.refresh();
  assert.equal(first().nativeState, "unread", "点击只导航，必须等待原生确认已读");
  native.set(ids[0], "idle"); h.flush(); assert.equal(first().hidden, true);
  for (const state of ["input", "approval", "error", "active", "idle"]) {
    native.set(ids[1], state); h.flush();
    const status = h.items()[1].querySelector(".cpt-status");
    assert.equal(status.nativeState, state); assert.equal(status.hidden, state === "idle");
  }
  h.document.hidden = true; native.set(ids[0], "unread"); h.flush();
  h.document.hidden = false; h.document.fire("visibilitychange"); h.flush();
  assert.equal(first().nativeState, "unread");
  assert.deepEqual(h.saved().map(tab => Object.keys(tab).sort()), [["id", "title"], ["id", "title"]]);
});

test("状态订阅与原生图标随关闭、开关和热重注入释放，迟到发现不复活旧实例", async () => {
  const native = nativeStatus(), h = fixture({ nativeStatus: native.api });
  await Promise.resolve(); h.open(1); h.close(1); h.refresh();
  assert.equal(native.watchers.size, 1); assert.equal(native.roots.size, 1);
  h.load(); await Promise.resolve();
  assert.equal(native.watchers.size, 1); assert.equal(native.roots.size, 1);
  h.context.codexPlusBackendSettings.codexAppConversationTabs = false; h.context.syncCodexPlusConversationTabs();
  assert.equal(native.watchers.size, 0); assert.equal(native.roots.size, 0); assert.equal(h.timers.size, 0);
  let resolve;
  const late = fixture({ nativeStatus: new Promise(r => resolve = r) });
  late.window.__codexPlusConversationTabs.dispose(); resolve(native.api); await Promise.resolve();
  assert.equal(native.watchers.size, 0); assert.equal(native.roots.size, 0); assert.equal(late.items().length, 0);
});

test("原生模块按职责唯一定位，host 验证和图标优先级由原生读取结果驱动", () => {
  const scope = {}, values = new Map(ids.map(id => [`local:${id}`, "unread"]));
  const context = vm.createContext({}); vm.runInContext(statusSource, context);
  function attention(get, key, fallback = get(key)) { return ("idle" === fallback || "unread" === fallback) && false ? "active" : fallback; }
  function rows(get, keys) { return keys.flatMap(key => [{ kind: "local", hostId: key === `local:${ids[1]}` ? "remote" : "local", gitBranch: null, workspaceKind: "project", summary: null }]); }
  const exports = {
    states: { attention, rows, stateSignal: { scope } },
    indicator: { Icon() {} }, react: { Component: class {}, createElement() {} }, dom: { createRoot() {} },
  };
  const require = id => exports[id];
  require.c = cachedModules(exports);
  // 特征来自职责片段；测试刻意不依赖任何真实 Rspack 数字 ID 或混淆导出名。
  require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn',
    indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function',
  };
  // String(function) 保留空白，模拟当前 Rspack 的压缩输出。
  attention.toString = () => '("idle"===state||"unread"===state)&&working?"active":state';
  const api = context.codexPlusConversationTabStatusApi(require);
  assert.ok(api);
  let snapshot;
  const stop = api.watch({ scope: { watch: callback => { callback({ get: key => values.get(key) }); return () => {}; } } }, ids, value => snapshot = value);
  assert.equal(typeof stop, "function"); assert.equal(snapshot.get(ids[0]), "unread"); assert.equal(snapshot.has(ids[1]), false);
  values.set(`local:${ids[0]}`, "approval");
  api.watch({ scope: { watch: callback => callback({ get: key => values.get(key) }) } }, [ids[0]], value => snapshot = value);
  assert.equal(snapshot.get(ids[0]), "approval", "不在增强中重算状态优先级");
  require.m.duplicate = require.m.states;
  assert.equal(context.codexPlusConversationTabStatusApi(require), null, "出现歧义时必须降级，不能任选一个模块");
});

test("冷启动探测不执行尚未初始化的原生模块，避免 Rspack 将启动错误永久缓存在工厂里", () => {
  const context = vm.createContext({}); vm.runInContext(statusSource, context);
  const scope = {}, executed = [], modules = {
    react: { Component: class {}, createElement() {} }, dom: { createRoot() {} },
  };
  let nativeReady = false;
  // 与真实 Rspack 一致：首次工厂异常记在缓存中，后续即使依赖已就绪也继续抛出同一个错误。
  const require = id => {
    const cached = require.c[id]; if (cached) { if (cached.error) throw cached.error; return cached.exports; }
    const entry = require.c[id] = { exports: {} }; executed.push(id);
    try {
      if (!nativeReady) throw new Error("AppServices not initialized");
      entry.exports = modules[id] || { scope };
      return entry.exports;
    } catch (error) { entry.error = error; throw error; }
  };
  require.c = cachedModules(modules);
  require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn', indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function',
    metadata: 'sidebar_workspace_task_groups_task_dirs projectlessThreadIds gitRepositoryName',
    projectIcon: 'gizmo.display.theme gizmo.display.emoji markerClassName:',
    threadRow: 'entryFallback: sidebarThreadRow onArchivePendingWorktree: threadKey:',
  };
  assert.equal(context.codexPlusConversationTabStatusApi(require), null);
  assert.deepEqual(executed, [], "启动探测必须只读已初始化缓存，不能提前执行原生工厂");
  nativeReady = true;
  assert.doesNotThrow(() => require("states"), "标签探测不能把原生之后正常的启动变成持续失败");
});

test("loading 壳不启动原生标签适配，主界面出现且缓存准备完成后再接入，重试有界", async () => {
  const native = nativeStatus(); let calls = 0;
  const h = fixture({ loadingShell: true, nativeStatusLoader: async () => ++calls === 1 ? null : native.api });
  for (let i = 0; i < 3; i++) h.refresh();
  assert.equal(calls, 0, "页面仍是启动壳时不导入或执行原生模块");
  h.main.setAttribute("data-app-shell-main-surface", "default"); h.refresh(); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(native.watchers.size, 0);
  h.refresh(); await Promise.resolve();
  assert.equal(calls, 2); assert.equal(native.watchers.size, 1, "首轮缓存未就绪不能永久失去状态和项目信息");
  for (let i = 0; i < 4; i++) h.refresh(); assert.equal(calls, 2);
  let misses = 0;
  const unsupported = fixture({ nativeStatusLoader: async () => { misses++; return null; } });
  for (let i = 0; i < 30; i++) { unsupported.refresh(); await Promise.resolve(); }
  assert.equal(misses, 20, "原生版本不兼容时不能无限扫描模块");
  unsupported.window.__codexPlusConversationTabs.dispose(); unsupported.refresh(); assert.equal(misses, 20);
});

test("项目归属跟随原生 signal，隔离远端同 ID，元数据失配时仍保留状态订阅", () => {
  const scope = {}, projectSignal = { scope };
  const context = vm.createContext({}); vm.runInContext(statusSource, context);
  function attention(get, key) { return get(key); }
  attention.toString = () => '("idle"===state||"unread"===state)&&working?"active":state';
  function rows(get, keys) { return keys.flatMap(key => [{ kind: "local", hostId: key === `local:${ids[1]}` ? "remote" : "local", gitBranch: null, workspaceKind: "project", summary: null }]); }
  const modules = {
    states: { attention, rows, stateSignal: { scope } }, indicator: { Icon() {} },
    react: { Component: class {}, createElement() {} }, dom: { createRoot() {} },
    metadata: { renamedExport: projectSignal },
  };
  // 模拟当前压缩产物的绑定/导出关系；更换导出名仍须读同一份原生索引。
  const metadataSource = 'sidebar_workspace_task_groups_task_dirs projectlessThreadIds gitRepositoryName;let signal=(0,signals.make)(scopes.app,(key,{get:read})=>read(index).get(key)??null);runtime.d(exports,{},{renamedExport:()=>signal})';
  let failRequire = false, failRead = false;
  const require = id => { if (id === "metadata" && failRequire) throw new Error("module unavailable"); return modules[id]; };
  require.c = cachedModules(modules);
  require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn', indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function', metadata: metadataSource,
  };
  const groups = new Map([[`local:${ids[0]}`, { projectId: "native-project", label: "原生自定义名", path: "/work/different-name", projectKind: "local" }]]);
  function observe() {
    const api = context.codexPlusConversationTabStatusApi(require); assert.ok(api);
    let states, projects;
    api.watch({ scope: { watch: callback => callback({ get: (signal, key) => {
      if (signal !== projectSignal) return "unread";
      if (failRead) throw new Error("index not ready");
      return groups.get(key) ?? null;
    } }) } }, ids, value => states = value, value => projects = value);
    return { states, projects };
  }
  let snapshot = observe();
  assert.equal(snapshot.projects.get(ids[0]).name, "原生自定义名");
  assert.equal(snapshot.projects.get(ids[0]).path, "/work/different-name");
  assert.equal(snapshot.projects.has(ids[1]), false, "远端行不能进入本地项目映射");
  assert.equal(snapshot.projects.get(ids[2]), null, "只有原生明确无归属才显示未关联项目");
  groups.set(`local:${ids[0]}`, { projectId: "moved-project", label: "移动后项目", projectKind: "remote", hostId: "native-host" });
  assert.equal(observe().projects.get(ids[0]).id, "moved-project");
  failRead = true; snapshot = observe();
  assert.equal(snapshot.projects.size, 0); assert.equal(snapshot.states.get(ids[0]), "unread");
  failRead = false;
  for (const failure of ["require", "duplicate", "binding", "scope"]) {
    failRequire = failure === "require";
    if (failRequire) delete require.c.metadata;
    if (failure === "duplicate") require.m.otherMetadata = metadataSource;
    if (failure === "binding") require.m.metadata = metadataSource.replace(';runtime.d', ',other=(0,s.make)(s.app,(key,{get:read})=>read(index).get(key)??null);runtime.d');
    if (failure === "scope") modules.metadata.renamedExport = { scope: {} };
    snapshot = observe();
    assert.equal(snapshot.projects.size, 0, `项目适配 ${failure} 失配应独立降级`);
    assert.equal(snapshot.states.get(ids[0]), "unread");
    delete require.m.otherMetadata; require.m.metadata = metadataSource; modules.metadata.renamedExport = projectSignal;
    require.c = cachedModules(modules);
  }
});

test("新会话用原生临时 key 查项目，正式 UUID 保持不变，映射切换后仍跟随项目更新", () => {
  const scope = {}, projectSignal = { scope }, entrySignal = { scope }, context = vm.createContext({});
  vm.runInContext(statusSource, context);
  function attention() { return "unread"; } attention.toString = () => '("idle"===state||"unread"===state)&&working?"active":state';
  function rows(get, keys) { return keys.flatMap(key => [{ kind: "local", key, hostId: "local", gitBranch: null, workspaceKind: "project", summary: null }]); }
  function entry(get, key) { return get(entrySignal, key); }
  entry.toString = () => 'function nativeEntry(get,key){let row=get(index).byKey.get(key);return{...row,summary:{...row.summary,hasUnreadTurn:false}}}';
  const modules = {
    states: { attention, rows, RenamedEntry: entry, stateSignal: { scope } }, indicator: { Icon() {} },
    react: { Component: class {}, createElement() {} }, dom: { createRoot() {} }, metadata: { RenamedProject: projectSignal },
  };
  const require = id => modules[id]; require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn', indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function',
    metadata: 'sidebar_workspace_task_groups_task_dirs projectlessThreadIds gitRepositoryName;let signal=(0,s.make)(s.app,(key,{get:read})=>read(index).get(key)??null);runtime.d(exports,{},{RenamedProject:()=>signal})',
  };
  require.c = cachedModules(modules);
  const id = ids[0], key = `local:${id}`, temporary = "local:client-new-thread:creation-id";
  let reference = { kind: "local", key: temporary, summary: { conversationId: id, hostId: "local" } }, failRead = false;
  const project = { projectId: "native-python-project", label: "自定义 Python 项目", path: "/work/different-directory-name", projectKind: "local" };
  const groups = new Map([[temporary, project]]), api = context.codexPlusConversationTabStatusApi(require);
  let states, projects, emit;
  api.watch({ scope: { watch: callback => {
    emit = () => callback({ get: (signal, key) => {
      if (signal === entrySignal) { if (failRead) throw new Error("entry not ready"); return reference; }
      if (signal === projectSignal) return groups.get(key) ?? null;
    } }); emit(); return () => {};
  } } }, [id], value => states = value, value => projects = value);
  assert.equal(projects.get(id)?.id, project.projectId, "项目索引只有临时 key 时也必须找到原生项目");
  assert.equal(projects.get(id)?.name, project.label, "不能用工作目录名替代原生项目名");
  assert.deepEqual([...projects.keys()], [id], "向标签运行时返回的身份仍是正式 UUID");
  groups.delete(temporary); groups.set(key, { ...project, label: "完成持久化后的项目" }); emit();
  assert.equal(projects.get(id)?.name, "完成持久化后的项目", "索引先切到正式 key、原生条目仍留临时 key 时需要回退");
  reference = { ...reference, key }; emit(); assert.equal(projects.get(id)?.name, "完成持久化后的项目");
  groups.delete(key); emit(); assert.equal(projects.get(id), null);
  groups.set(temporary, project);
  for (const summary of [{ conversationId: id, hostId: "remote" }, { conversationId: ids[1], hostId: "local" }]) {
    reference = { kind: "local", key: temporary, summary }; emit();
    assert.equal(projects.get(id), null, "不能借用其他主机或其他会话的临时项目归属");
  }
  failRead = true; emit(); assert.equal(projects.size, 0); assert.equal(states.get(id), "unread");
});

test("项目图标共用原生 Intl 和 AppScope，缺少上下文或渲染失败时保留文件夹", () => {
  const scope = {}, renders = []; let unmounted = 0;
  const context = vm.createContext({}); vm.runInContext(statusSource, context);
  function attention() {} attention.toString = () => '("idle"===state||"unread"===state)&&working?"active":state';
  function rows(get, keys) { return keys.flatMap(key => [{ gitBranch: null, workspaceKind: "project", summary: null }]); }
  function Icon() {}
  const modules = {
    states: { attention, rows, stateSignal: { scope } }, indicator: { Indicator() {} },
    projectIcon: { Icon }, react: { Component: class { constructor(props) { this.props = props; } }, createElement: (type, props, ...children) => ({ type, props, children }) },
    dom: { createRoot: () => ({ render: tree => renders.push(tree), unmount: () => unmounted++ }) },
  };
  const require = id => modules[id]; require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn', indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function', projectIcon: 'gizmo.display.theme gizmo.display.emoji markerClassName:',
  };
  require.c = cachedModules(modules);
  const api = context.codexPlusConversationTabStatusApi(require);
  const native = { intl: { Provider() {}, value: {} }, appScope: { Provider() {}, value: new Map() } };
  const root = api.mountProject({}, '<svg width="12"></svg>');
  root.render({ id: "native-project", kind: "local", hostId: "" }, native);
  const boundary = renders.at(-1), intl = boundary.children[0], app = intl.children[0], icon = app.children[0];
  assert.equal(intl.type, native.intl.Provider); assert.equal(app.type, native.appScope.Provider);
  assert.equal(icon.type, Icon); assert.equal(icon.props.projectId, "native-project"); assert.equal(icon.props.size, 12);
  const failed = new boundary.type(boundary.props); failed.state = { failed: true };
  assert.equal(failed.render(), boundary.props.fallback, "组件异常不能留下空图标");
  root.render({ id: "native-project" }, { intl: native.intl });
  assert.equal(renders.at(-1).children[0].children[0].props.className, "cpt-project-fallback");
  root.dispose(); assert.equal(unmounted, 1);
});

test("未挂载侧栏时按 UUID 创建原生菜单宿主，隔离 host 并在关闭标签时取消迟到打开", async () => {
  const h = fixture({ enabled: false }), scopeToken = {}, events = [], roots = [];
  const temporary = "local:client-new-thread:creation-id";
  function attention() {} attention.toString = () => '("idle"===state||"unread"===state)&&working?"active":state';
  function rows(get, keys) { return keys.flatMap(key => [{ kind: "local", hostId: key.endsWith(ids[1]) ? "remote" : "local", gitBranch: null, workspaceKind: "project", summary: null }]); }
  function entry(get, key) { return { kind: "local", key: key.endsWith(ids[0]) ? temporary : key, summary: { conversationId: key.slice(6), hostId: "local" } }; }
  entry.toString = () => 'function nativeEntry(get,key){let row=get(index).byKey.get(key);return{...row,summary:{...row.summary,hasUnreadTurn:false}}}';
  const ThreadRow = { $$typeof: Symbol.for("react.memo") }, Provider = {};
  const modules = {
    states: { attention, rows, entry, stateSignal: { scope: scopeToken } }, indicator: { Indicator() {} },
    threadRow: { RenamedExport: ThreadRow },
    react: { Component: class {}, createElement: (type, props, ...children) => ({ type, props, children }) },
    dom: { createRoot: host => {
      const root = { host, unmount() { host.replaceChildren(); root.unmounted = true; }, render(tree) {
        const native = tree.children[0].children[0]; assert.equal(native.type, ThreadRow);
        const row = h.document.createElement("div"); row.setAttribute("data-app-action-sidebar-thread-id", native.props.threadKey);
        row.addEventListener("contextmenu", event => events.push({ id: native.props.threadKey, x: event.clientX, y: event.clientY }));
        host.replaceChildren(row);
      } }; roots.push(root); return root;
    } },
  };
  const require = id => modules[id]; require.m = {
    states: 'questionKey pendingThreadStart summaryHostId hasUnreadTurn', indicator: 'statusState: unreadCount attention working:',
    react: '.createElement=function .useState=function', dom: '.createRoot=function',
    threadRow: 'entryFallback: sidebarThreadRow onArchivePendingWorktree: threadKey:',
  };
  require.c = cachedModules(modules);
  const api = h.context.codexPlusConversationTabStatusApi(require), context = { scope: { get() {} }, providers: [{ Provider, value: {} }] };
  assert.equal(api.canOpenThreadMenu(context, ids[0]), true);
  assert.equal(api.canOpenThreadMenu(context, ids[1]), false, "远端同 UUID 不得生成本地菜单");
  assert.equal(api.canOpenThreadMenu(context, "client-new-thread:temporary"), false);
  assert.equal(api.canOpenThreadMenu({ scope: context.scope }, ids[0]), false);
  assert.equal(await api.openThreadMenu(context, ids[0], 410, 90), true);
  assert.deepEqual(events, [{ id: temporary, x: 410, y: 90 }], "原生菜单也必须使用已核验的新会话临时 key");
  assert.equal(roots[0].host.hidden, true); assert.ok(roots[0].host.hasAttribute("data-codex-plus-ext"));
  assert.equal(await api.openThreadMenu(context, ids[0], 420, 95), true); assert.equal(roots.length, 1, "同一标签复用宿主以保留原生确认弹窗状态");
  const pending = api.openThreadMenu(context, ids[2], 430, 100); api.releaseThreadMenu(ids[2]);
  assert.equal(await pending, false); assert.equal(events.length, 2, "已关闭标签不能迟到弹出原生菜单");
  assert.equal(roots[1].unmounted, true); assert.equal(roots[1].host.isConnected, false);
  const cancelled = api.openThreadMenu(context, ids[0], 440, 105); api.cancelThreadMenu(ids[0]);
  assert.equal(await cancelled, false); assert.equal(events.length, 2, "已关闭的标签菜单不能迟到打开");
  api.releaseThreadMenu(ids[0]); assert.equal(roots[0].unmounted, true); assert.equal(h.timers.size, 0);
  require.m.anotherThreadRow = require.m.threadRow;
  assert.equal(h.context.codexPlusConversationTabStatusApi(require).canOpenThreadMenu(context, ids[0]), false, "模块歧义只禁用菜单适配");
});
