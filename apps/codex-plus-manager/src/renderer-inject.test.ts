import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

describe("session more menu lifecycle", () => {
  async function runtime() {
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/90-action-groups.js", import.meta.url), "utf8",
    );
    const menus: ReturnType<typeof fixture>[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    let menuQueries = 0;
    const events = () => {
      const listeners = new Map<string, () => void>();
      return {
        listeners,
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name),
      };
    };
    function fixture() {
      const classes = new Set(["codex-session-more-open"]);
      const button = { expanded: "true", setAttribute: (_: string, value: string) => { button.expanded = value; } };
      const deleteButton = { dataset: { codexDeleteVersion: "7" } };
      const group = {
        ...events(), isConnected: true, hasDelete: true,
        dataset: { codexActionGroupVersion: "7", codexMoreMenuKey: "ext:export", codexInlineActionKey: "delete" },
        __codexSessionMoreMenu: null as unknown,
        querySelector: (selector: string) => selector === ".more-button" ? button
          : selector === '[data-codex-plus-row-action="delete"]' && group.hasDelete ? deleteButton : null,
        matches: () => false, remove: () => { group.isConnected = false; },
      };
      const row = {
        isConnected: true, dataset: {}, querySelectorAll: () => [group],
        contains: (node: unknown) => node === group, classList: { remove: (name: string) => classes.delete(name) },
      };
      const menu = {
        ...events(), hidden: false, removed: false, isConnected: true, classes, row, group, button,
        __codexSessionMoreRow: row as typeof row | null,
        __codexSessionMoreGroup: group as typeof group | null,
        __codexSessionMoreCleanup: null as (() => void) | null,
        remove: () => { menu.removed = true; menu.isConnected = false; },
        matches: () => false, contains: () => false,
      };
      group.__codexSessionMoreMenu = menu;
      return menu;
    }
    const api = new Function("document", "window", "codexPlusSettings", "codexPlusBackendSettings",
      "moreMenuClass", "moreButtonClass", "buttonClass", "actionGroupClass", "exportButtonClass",
      "codexDeleteVersion", "codexActionGroupVersion", "actionGroupFromRow", "sessionRefFromRow",
      "codexPlusRegistry", "codexPlusExtensionItems",
      `${source.split("  function tryAttachButton(row)")[0]}
       return { pruneSessionMoreMenus, pruneRemovedSessionActions, attachButton, closeSessionMoreMenus, installSessionMoreMenuAutoClose };`,
    )(
      { querySelectorAll: () => { menuQueries++; return menus.filter((menu) => !menu.removed); }, activeElement: null },
      {
        setTimeout: (callback: () => void) => {
          const id = ++timerId;
          timers.set(id, () => { timers.delete(id); callback(); });
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
      () => ({ sessionDelete: true, markdownExport: true }), { enhancementsEnabled: true },
      "more-menu", "more-button", "delete-button", "actions", "export-button", "7", "7",
      (row: { querySelectorAll: () => unknown[] }) => row.querySelectorAll()[0], () => ({}),
      // 内置的删除（行内按钮）与导出（菜单项）都是注册进来的会话行操作。
      { rowActions: new Map([["export", { id: "export", label: "导出" }], ["delete", { id: "delete", label: "删除", placement: "inline" }]]) },
      (registry: Map<string, unknown>) => [...registry.values()],
    );
    return {
      ...api, timers, menuQueries: () => menuQueries,
      fixture: () => {
        const menu = fixture();
        menus.push(menu);
        return menu;
      },
    };
  }

  it("disposes detached owners and groups without removing connected or synchronously moved rows", async () => {
    const api = await runtime();
    const live = api.fixture();
    const detachedRow = api.fixture();
    const detachedGroup = api.fixture();
    const unrelatedGroup = api.fixture();
    const moved = api.fixture();
    detachedRow.row.isConnected = false;
    detachedGroup.group.isConnected = false;
    unrelatedGroup.row.contains = () => false;
    moved.row.isConnected = false;
    moved.row.isConnected = true;
    assert.equal(api.pruneSessionMoreMenus(), true);
    assert.equal(live.removed, false);
    assert.equal(moved.removed, false);
    for (const menu of [detachedRow, detachedGroup, unrelatedGroup]) {
      assert.equal(menu.removed, true);
      assert.equal(menu.hidden, true);
      assert.equal(menu.button.expanded, "false");
      assert.equal(menu.classes.has("codex-session-more-open"), false);
      assert.equal(menu.__codexSessionMoreRow, null);
      assert.equal(menu.__codexSessionMoreGroup, null);
      assert.equal(menu.group.__codexSessionMoreMenu, null);
    }
    assert.equal(api.pruneSessionMoreMenus(), false);
    assert.equal(live.removed, false);
  });

  it("only reuses action groups with a connected menu owned by the same row and group", async () => {
    const api = await runtime();
    const live = api.fixture();
    api.attachButton(live.row);
    assert.equal(live.group.isConnected, true);
    for (const damage of ["disposed", "menu-removed", "different-owner", "different-group"]) {
      const menu = api.fixture();
      if (damage === "disposed") {
        menu.row.isConnected = false;
        api.pruneSessionMoreMenus();
        menu.row.isConnected = true;
      } else if (damage === "menu-removed") menu.isConnected = false;
      else if (damage === "different-owner") menu.__codexSessionMoreRow = live.row;
      else menu.__codexSessionMoreGroup = live.group;
      api.attachButton(menu.row);
      assert.equal(menu.group.isConnected, false, `${damage} must rebuild the retained group`);
    }
  });

  it("requests repair for a missing delete button but leaves complete action groups alone", async () => {
    const api = await runtime();
    const menu = api.fixture();
    assert.equal(api.pruneSessionMoreMenus(), false);
    menu.group.hasDelete = false;
    assert.equal(api.pruneSessionMoreMenus(), true);
    assert.equal(menu.removed, true);
    assert.equal(api.pruneSessionMoreMenus(), false);
  });

  it("ignores unrelated removals and checks action ancestors and removed body menus", async () => {
    const api = await runtime();
    const menu = api.fixture();
    const node = (matches: boolean, descendant: boolean) => ({
      nodeType: 1, matches: () => matches, querySelector: () => descendant ? {} : null,
      querySelectorAll: () => [],
    });
    for (let i = 0; i < 200; i++) api.pruneRemovedSessionActions([{ removedNodes: [node(false, false)] }]);
    assert.equal(api.menuQueries(), 0, "streamed prose must not sweep body menus");
    assert.equal(api.pruneRemovedSessionActions([{ removedNodes: [node(false, true)] }]), false);
    assert.equal(api.menuQueries(), 1, "a synchronous move still checks final owner state");
    menu.row.isConnected = false;
    api.pruneRemovedSessionActions([{ removedNodes: [node(false, true)] }]);
    assert.equal(menu.removed, true, "sidebar ancestor removal must release owner references");
    const removed = api.fixture();
    removed.remove();
    Object.assign(removed, node(true, false));
    assert.equal(api.pruneRemovedSessionActions([{ removedNodes: [removed] }]), true);
    assert.equal(removed.__codexSessionMoreRow, null, "body menu removal must also be disposed");
  });

  it("resets expansion state when another menu opens or all menus close", async () => {
    const api = await runtime();
    const first = api.fixture();
    const second = api.fixture();
    api.closeSessionMoreMenus(second);
    assert.equal(first.hidden, true);
    assert.equal(first.button.expanded, "false");
    assert.equal(second.hidden, false);
    api.closeSessionMoreMenus();
    assert.equal(second.hidden, true);
    assert.equal(second.button.expanded, "false");
  });

  it("coalesces auto-close timers and cancels listeners and timers on disposal", async () => {
    const api = await runtime();
    const menu = api.fixture();
    api.installSessionMoreMenuAutoClose(menu.row, menu);
    menu.group.listeners.get("pointerleave")!();
    menu.listeners.get("focusout")!();
    assert.equal(api.timers.size, 1);
    for (const callback of api.timers.values()) callback();
    assert.equal(menu.hidden, true);
    assert.equal(menu.button.expanded, "false");
    menu.listeners.get("pointerleave")!();
    menu.row.isConnected = false;
    api.pruneSessionMoreMenus();
    assert.equal(api.timers.size, 0);
    assert.equal(menu.group.listeners.size, 0);
    assert.equal(menu.listeners.size, 0);
    assert.equal(menu.__codexSessionMoreCleanup, null);
  });

  it("prunes removed elements before pending, hidden and relevance scan guards", async () => {
    const schedule = await readFile(
      new URL("../../../assets/inject/renderer-inject/98-scan-schedule.js", import.meta.url), "utf8",
    );
    const source = schedule.slice(schedule.indexOf("  function scheduleScan("), schedule.indexOf("  const onScanVisibilityChange"));
    let pruned = 0;
    let relevanceChecks = 0;
    const window = { __codexSessionDeleteScanPending: true };
    const scheduleScan = new Function("window", "document", "pruneRemovedSessionActions", "shouldScheduleScan",
      `${source}\nreturn scheduleScan;`,
    )(window, { hidden: true }, (mutations: Array<{ removedNodes: Array<{ nodeType: number }> }>) => {
      if (mutations.some((mutation) => mutation.removedNodes.some((node) => node.nodeType === 1))) pruned++;
    }, () => { relevanceChecks++; return false; });
    scheduleScan([{ removedNodes: [{ nodeType: 1 }] }]);
    assert.equal(pruned, 1);
    assert.equal(relevanceChecks, 0);
    window.__codexSessionDeleteScanPending = false;
    scheduleScan([{ removedNodes: [{ nodeType: 1 }] }]);
    assert.equal(pruned, 2);
    assert.equal(relevanceChecks, 1);
    scheduleScan([{ removedNodes: [{ nodeType: 3 }] }]);
    assert.equal(pruned, 2);
    const view = await readFile(
      new URL("../../../assets/inject/renderer-inject/95-conversation-view.js", import.meta.url), "utf8",
    );
    assert.match(view, /function scan\(\) \{\s*pruneSessionMoreMenus\(\);\s*if \(document.hidden\)/);
  });

  it("schedules one repair for a removed owned group even when normal relevance filtering skips it", async () => {
    const schedule = await readFile(
      new URL("../../../assets/inject/renderer-inject/98-scan-schedule.js", import.meta.url), "utf8",
    );
    const source = schedule.slice(schedule.indexOf("  function scheduleScan("), schedule.indexOf("  const onScanVisibilityChange"));
    const window = { __codexSessionDeleteScanPending: false };
    const timers: Array<() => void> = [];
    let needsScan = true;
    const scheduleScan = new Function("window", "document", "pruneRemovedSessionActions", "shouldScheduleScan",
      "setTimeout", "runScheduledScan", `${source}\nreturn scheduleScan;`,
    )(window, { hidden: false }, () => needsScan, () => false,
      (callback: () => void) => { timers.push(callback); return timers.length; },
      () => { window.__codexSessionDeleteScanPending = false; });
    const removed = [{ removedNodes: [{ nodeType: 1 }] }];
    scheduleScan(removed);
    scheduleScan(removed);
    assert.equal(timers.length, 1);
    timers[0]();
    needsScan = false;
    scheduleScan(removed);
    assert.equal(timers.length, 1, "normal removal of owned UI must not feed a scan loop");
  });
});

describe("session row action buttons", () => {
  // 只够 attachButton 用的极简 DOM：支持复合简单选择器（tag / .class / [attr] / [attr="v"]）
  // 和逗号并列，不支持后代组合符。innerHTML 只识别本模块会写入的两种结构。
  class FakeElement {
    tagName: string;
    className = "";
    attributes = new Map<string, string>();
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    dataset: Record<string, string> = {};
    listeners = new Map<string, unknown>();
    hidden = false;
    type = "";
    text = "";
    style = { setProperty: () => {} };
    [key: string]: unknown;
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get isConnected(): boolean { return this.parentElement ? this.parentElement.isConnected : this.tagName === "BODY"; }
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    set innerHTML(html: string) {
      this.children = [];
      this.text = "";
      const inner = html.match(/^<span class="codex-session-action-inner">(<svg[^>]*>)/);
      if (inner) {
        const span = this.appendChild(new FakeElement("span"));
        span.className = "codex-session-action-inner";
        const svg = span.appendChild(new FakeElement("svg"));
        for (const [, name, value] of inner[1].matchAll(/([\w-]+)="([^"]*)"/g)) svg.setAttribute(name, value);
        return;
      }
      this.text = html.replace(/<[^>]*>/g, "");
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    blur() {}
    appendChild(child: FakeElement) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    replaceWith(next: FakeElement) {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children[parent.children.indexOf(this)] = next;
      next.parentElement = parent;
      this.parentElement = null;
    }
    cloneNode(): FakeElement { return this; }
    addEventListener(name: string, callback: unknown) { this.listeners.set(name, callback); }
    removeEventListener(name: string) { this.listeners.delete(name); }
    matches(selector: string): boolean {
      return selector.split(",").some((part) => {
        const compound = part.trim();
        const tag = compound.match(/^[a-z]+/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const classes = [...compound.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        const ownClasses = this.className.split(/\s+/);
        if (!classes.every((name) => ownClasses.includes(name))) return false;
        return [...compound.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
          value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
      });
    }
    closest(selector: string): FakeElement | null {
      for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector: string): FakeElement[] {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }

  /** 内置拓展「会话删除」「Markdown 导出」开着时注册的会话行操作（见 96-builtin-extensions.js）。 */
  async function runtime(settings: { inlineAction: boolean; menuAction: boolean }) {
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/90-action-groups.js", import.meta.url), "utf8",
    );
    const body = new FakeElement("body");
    const document = {
      body,
      createElement: (tag: string) => new FakeElement(tag),
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    };
    const registry = { rowActions: new Map<string, { id: string; label: string; order: number; placement?: string; icon?: string; className?: string }>() };
    const api = new Function("document", "window", "HTMLElement", "codexPlusSettings", "codexPlusBackendSettings",
      "moreMenuClass", "moreButtonClass", "buttonClass", "actionGroupClass", "exportButtonClass", "actionButtonClass",
      "codexDeleteVersion", "codexActionGroupVersion", "actionGroupFromRow", "sessionRefFromRow",
      "codexPlusRegistry", "codexPlusExtensionItems", "appendCodexPlusExtensionRowActions", "syncActionGroupLayout",
      "runCodexPlusExtensionCallback", "releaseDeleteFocus", "actionTooltipClass",
      `${source.split("  function tryAttachButton(row)")[0]}
       return { attachButton, icon: sessionActionStrokeIconSvg('<path d="M2 8h12"/>') };`,
    )(
      document, { setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0 }, FakeElement,
      () => settings, { enhancementsEnabled: true },
      "more-menu", "more-button", "delete-button", "actions", "export-button", "action-button", "8", "8",
      (row: FakeElement) => row.querySelector(".actions"), () => ({ session_id: "thread-1" }),
      registry, (map: Map<string, { order: number }>) => [...map.values()].sort((a, b) => a.order - b.order),
      (menu: FakeElement) => registry.rowActions.forEach((item) => {
        if (item.placement === "inline") return;
        const node = menu.appendChild(new FakeElement("button"));
        node.text = `${item.icon ?? ""}${item.label}`;
      }),
      () => {},
      (_key: string, _label: string, callback: () => unknown) => ({ ok: true, value: callback() }),
      () => {}, "action-tooltip",
    );
    if (settings.menuAction) registry.rowActions.set("test:menu-action", { id: "test:menu-action", label: "导出", icon: "⇩", order: 10 });
    if (settings.inlineAction) {
      registry.rowActions.set("test:inline-action", {
        id: "test:inline-action", label: "删除", icon: api.icon, placement: "inline", className: "delete-button", order: 10,
      });
    }
    const row = body.appendChild(new FakeElement("div"));
    return { ...api, body, row, registry };
  }

  it("only renders the more button when a menu item exists", async () => {
    const deleteOnly = await runtime({ inlineAction: true, menuAction: false });
    deleteOnly.attachButton(deleteOnly.row);
    const group = deleteOnly.row.querySelector(".actions");
    assert.ok(group, "the delete button still gets its group");
    assert.ok(group.querySelector(".delete-button"));
    assert.equal(group.querySelector(".more-button"), null, "no export and no extension action means no … button");
    assert.equal(deleteOnly.body.querySelector(".more-menu"), null);

    const nothing = await runtime({ inlineAction: false, menuAction: false });
    nothing.attachButton(nothing.row);
    assert.equal(nothing.row.querySelector(".actions"), null, "no delete and no menu item renders nothing");

    const exportOnly = await runtime({ inlineAction: false, menuAction: true });
    exportOnly.attachButton(exportOnly.row);
    assert.ok(exportOnly.row.querySelector(".more-button"));
    const menu = exportOnly.body.querySelector(".more-menu");
    assert.deepEqual(menu?.children.map((item: { textContent: string }) => item.textContent), ["⇩导出"]);
  });

  it("adds and removes the more button as extension row actions register and dispose", async () => {
    const api = await runtime({ inlineAction: true, menuAction: false });
    api.attachButton(api.row);
    assert.equal(api.row.querySelector(".more-button"), null);
    api.registry.rowActions.set("script:rowAction:a", { id: "script:rowAction:a", label: "拓展操作", order: 1000 });
    api.attachButton(api.row);
    assert.ok(api.row.querySelector(".more-button"), "a registered row action brings the … button back");
    assert.deepEqual(api.body.querySelector(".more-menu")?.children.map((item: { textContent: string }) => item.textContent), ["拓展操作"]);
    api.registry.rowActions.delete("script:rowAction:a");
    api.attachButton(api.row);
    assert.equal(api.row.querySelector(".more-button"), null, "disposing the last row action removes it again");
    assert.equal(api.body.querySelector(".more-menu"), null, "its detached menu is disposed as well");
    assert.ok(api.row.querySelector(".delete-button"));
  });

  it("renders inline row actions from the registry with their own class, glyph and activation context", async () => {
    const api = await runtime({ inlineAction: true, menuAction: false });
    const activations: Array<{ session_id: string; archived: boolean; title: string }> = [];
    api.registry.rowActions.set("user:pin:rowAction:star", {
      id: "user:pin:rowAction:star", label: "收藏", icon: "★", placement: "inline", className: "my-star", order: 1000,
      onActivate: (context: { session_id: string; archived: boolean; title: string }) => activations.push(context),
    } as never);
    api.attachButton(api.row);
    const group = api.row.querySelector(".actions")!;
    assert.equal(group.dataset.codexInlineActionKey, "test:inline-action|user:pin:rowAction:star", "行内按钮按 order 排，内置的删除在前");
    assert.equal(group.querySelector(".more-button"), null, "只有行内操作时不出「…」");
    const star = group.querySelector('[data-codex-plus-row-action="user:pin:rowAction:star"]')!;
    assert.equal(star.className, "action-button my-star");
    assert.equal(star.getAttribute("aria-label"), "收藏");
    assert.equal(star.textContent, "★");
    const event = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    (star.listeners.get("click") as (event: unknown) => void)(event);
    assert.equal(activations.length, 1);
    assert.equal(activations[0].session_id, "thread-1");
    assert.equal(activations[0].archived, false);
    // 行内按钮被 React 摘掉时整组按指纹重建。
    star.remove();
    api.attachButton(api.row);
    assert.ok(api.row.querySelector('[data-codex-plus-row-action="user:pin:rowAction:star"]'));
  });

  it("dresses an extension button in the native pin/archive button classes and data attributes", async () => {
    const api = await runtime({ inlineAction: true, menuAction: false });
    const native = api.row.appendChild(new FakeElement("button"));
    native.className = "_Button_abc pointer-events-auto";
    native.setAttribute("aria-label", "归档聊天");
    native.setAttribute("data-color", "secondary");
    native.setAttribute("data-variant", "transparent");
    native.setAttribute("data-size", "3xs");
    native.setAttribute("data-uniform", "");
    const inner = native.appendChild(new FakeElement("span"));
    inner.className = "_ButtonInner_abc";
    inner.appendChild(new FakeElement("svg")).setAttribute("viewBox", "0 0 16 16");
    api.attachButton(api.row);

    const button = api.row.querySelector(".delete-button")!;
    assert.equal(button.className, "_Button_abc pointer-events-auto action-button delete-button");
    assert.equal(button.getAttribute("data-codex-native-style"), "true");
    for (const [name, value] of [["data-color", "secondary"], ["data-variant", "transparent"], ["data-size", "3xs"], ["data-uniform", ""]]) {
      assert.equal(button.getAttribute(name), value, name);
    }
    assert.equal(button.querySelector(".codex-session-action-inner")?.className, "codex-session-action-inner _ButtonInner_abc");
    const svg = button.querySelector("svg")!;
    assert.equal(svg.getAttribute("data-codex-session-action-icon"), "stroke", "extension icon keeps its stroke style");
    assert.equal(svg.getAttribute("stroke-width"), "1.05", "fill-based native icons keep the matched light weight");
    assert.equal(button.closest("[data-codex-plus-ext]")?.getAttribute("data-codex-plus-ext"), "session-actions");
  });

  it("ignores the danger confirm button and converts a stroked native icon to the 16 grid", async () => {
    const api = await runtime({ inlineAction: true, menuAction: false });
    const confirm = api.row.appendChild(new FakeElement("button"));
    confirm.className = "_Button_danger";
    confirm.setAttribute("aria-label", "归档聊天");
    confirm.setAttribute("data-color", "danger");
    confirm.appendChild(new FakeElement("svg"));
    const pin = api.row.appendChild(new FakeElement("button"));
    pin.className = "_Button_pin";
    pin.setAttribute("aria-label", "Pin chat");
    const svg = pin.appendChild(new FakeElement("svg"));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("stroke-width", "1.5");
    api.attachButton(api.row);

    const button = api.row.querySelector(".delete-button")!;
    assert.equal(button.className, "_Button_pin action-button delete-button", "never borrows the danger confirm style");
    assert.equal(button.querySelector("svg")?.getAttribute("stroke-width"), "1", "24-grid 1.5 maps to 16-grid 1");
  });

  it("keeps the fallback look aligned with native icon buttons instead of a red or filled hover", async () => {
    const style = await readFile(
      new URL("../../../assets/inject/renderer-inject/10-style.js", import.meta.url), "utf8",
    );
    const fallback = style.slice(style.indexOf(".${actionButtonClass}:not([data-codex-native-style]) {"));
    assert.match(fallback, /width: var\(--control-size-4xs, 20px\);/);
    assert.match(fallback, /border-radius: var\(--control-radius-sm, var\(--radius-sm, 6px\)\);/);
    assert.match(fallback, /color: var\(--color-text-secondary-ghost,/);
    assert.match(fallback, /width: var\(--control-icon-size-xs, 14px\);/);
    // 悬停只提亮文字色、不铺底色，与原生 transparent 变体一致。
    assert.match(style, /:not\(\[data-codex-native-style\]\)\[aria-expanded="true"\] \{\s*background: transparent;\s*color: var\(--color-text-secondary-ghost-hover,/);
    assert.doesNotMatch(style, /--codex-session-action-hover-background|--codex-session-action-color/);
    assert.doesNotMatch(style, /\.\$\{buttonClass\}:hover/);
  });
});

it("keeps background-resume scan scheduling bounded and independent of retired features", async () => {
  const schedule = await readFile(
    new URL("../../../assets/inject/renderer-inject/98-scan-schedule.js", import.meta.url),
    "utf8",
  );
  assert.match(schedule, /if \(document\.hidden\) \{\s*clearTimeout/);
  assert.match(schedule, /window\.__codexSessionDeleteScanPending/);
  assert.match(schedule, /window\.__codexSessionDeleteDeferredPending/);
  assert.match(schedule, /requestAnimationFrame/);
  assert.match(schedule, /document\.addEventListener\("visibilitychange", onScanVisibilityChange\)/);
  assert.match(schedule, /window\.__codexPlusScanScheduleCleanup/);
  assert.doesNotMatch(schedule, /scheduleZedRemoteMenuRefresh|__codexZedRemoteMenuRefresh/);
  const view = await readFile(
    new URL("../../../assets/inject/renderer-inject/95-conversation-view.js", import.meta.url),
    "utf8",
  );
  const scan = view.match(/^  function scan\(\) \{[^]*?^  \}/m)?.[0];
  assert.ok(scan);
  assert.match(scan, /if \(document\.hidden\)/);
  assert.match(scan, /scheduleDeferredScan\(\)/);
  assert.doesNotMatch(scan, /requestAnimationFrame/);
});

describe("app-server client capture locating", () => {
  const marker = "AppServerRequestClient is missing a message dispatcher";
  // 与 Codex 26.10xx 的产物同形：类在 app-initial 里，sendRequest 首句就是 marker。
  const classSource = "var a=1;\nfYt=class{hostId;async sendRequest(e,t,n){if(this.dispatchMessage==null)"
    + `throw Error(\`${marker}\`);return this.enqueueRequest(e,t,n)}}`;

  async function runtime(assets: Record<string, string>) {
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8",
    );
    const section = source.slice(source.indexOf("  // issue #2177"),
      source.indexOf("    function installCodexAppServerClientPrototypePatch()"));
    assert.ok(section.includes("async function installCodexAppServerClientCapture()"));
    const visible: string[] = [];
    const fetched: string[] = [];
    const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const window: Record<string, unknown> = {
      setTimeout: (callback: () => void, delay: number) => { timers.push({ delay, callback }); return timers.length; },
    };
    const api = new Function("window", "fetch", "codexAppAssetCandidateUrls", "codexAppAssetUrl",
      "sendCodexPlusDiagnostic", "codexAppServerClientCaptureMarker", "codexAppServerClientCaptureAnchor",
      `${section}\nreturn { installCodexAppServerClientCapture };`,
    )(
      window,
      async (url: string) => {
        fetched.push(url);
        return { ok: url in assets, text: async () => assets[url] || "" };
      },
      () => visible.slice(),
      (part: string) => visible.find((url) => url.includes(part)) || "",
      (event: string, detail: Record<string, unknown>) => diagnostics.push({ event, detail }),
      marker,
      "async sendRequest(",
    );
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    async function fireTimer() {
      const timer = timers.shift();
      assert.ok(timer, "expected a pending retry");
      timer.callback();
      await flush();
      return timer.delay;
    }
    return { api, window, visible, fetched, diagnostics, timers, fireTimer, flush };
  }

  it("retries until the class asset becomes visible and does not refetch checked assets", async () => {
    const shared = "app://-/assets/app-shared-1.js";
    const initial = "app://-/assets/app-initial-2.js";
    const env = await runtime({ [shared]: "export const x=1;", [initial]: classSource });
    // 首轮 Fast 模块还没执行完，只看得到入口与 modulepreload 的 app-shared。
    env.visible.push("app://-/assets/index-0.js", shared);
    await env.api.installCodexAppServerClientCapture();
    assert.equal(env.window.__codexPlusAppServerClientCapture, undefined);
    assert.equal(env.diagnostics.length, 0, "a miss that will be retried is not reported as a failure");
    assert.equal(env.timers.length, 1);

    env.visible.push(initial);
    assert.equal(await env.fireTimer(), 1000);
    assert.deepEqual(env.window.__codexPlusAppServerClientCapture, {
      urlRegex: "app://-/assets/app-initial-2\\.js", lineNumber: 1, columnNumber: 41,
    });
    assert.equal(env.fetched.filter((url) => url === shared).length, 1);
    assert.equal(env.diagnostics.at(-1)?.event, "app_server_client_capture_located");
    assert.equal(env.diagnostics.at(-1)?.detail.attempts, 2);
    assert.equal(env.timers.length, 0);
    // 已定位后再被扫描调用不会重新拉取。
    const fetchCount = env.fetched.length;
    await env.api.installCodexAppServerClientCapture();
    assert.equal(env.fetched.length, fetchCount);
  });

  it("still finds the class in app-shared on the first pass for older Codex builds", async () => {
    const shared = "app://-/assets/app-shared-9.js";
    const env = await runtime({ [shared]: classSource });
    env.visible.push(shared);
    await env.api.installCodexAppServerClientCapture();
    assert.equal((env.window.__codexPlusAppServerClientCapture as { lineNumber: number }).lineNumber, 1);
    assert.equal(env.timers.length, 0);
  });

  it("reports one failure after the bounded retries run out", async () => {
    const shared = "app://-/assets/app-shared-1.js";
    const env = await runtime({ [shared]: "export const x=1;" });
    env.visible.push(shared);
    await env.api.installCodexAppServerClientCapture();
    const delays: number[] = [];
    while (env.timers.length) delays.push(await env.fireTimer());
    assert.ok(delays.reduce((sum, delay) => sum + delay, 0) < 90000, "retries finish inside the launcher wait window");
    assert.equal(env.fetched.length, 1);
    assert.deepEqual(env.diagnostics, [{
      event: "app_server_client_capture_locate_failed",
      detail: { reason: "anchor_missing", candidateCount: 0, checkedCount: 1, attempts: delays.length + 1 },
    }]);
  });
});

it("keeps model grouping and whitelist unlock out of the settings catalog", async () => {
  const catalog = JSON.parse(await readFile(settingsCatalogUrl, "utf8"));
  const page = await settingsCatalogRuntime(async () => catalog);
  await page.load();
  const html = page.sections();
  // 实际渲染设置页，确认两处入口均退役，同时保留 Fast 与输入预测的入口。
  assert.doesNotMatch(html, /模型分组|模型白名单解锁|modelWhitelistUnlock|model-picker-groups/);
  assert.match(html, /nativeFastUnlock/);
  assert.match(html, /codexAppNativePredictions/);
});

function installRendererStyle(renderer: string) {
  const start = renderer.indexOf("  function installStyle()");
  const end = renderer.indexOf("\n  function defaultCodexPlusSettings", start);
  assert.ok(start >= 0 && end > start);
  const source = renderer.slice(start, end);
  const requiredNames = new Set([
    "styleId",
    "codexDeleteStyleVersion",
    ...Array.from(source.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)/g), (match) => match[1]),
  ]);
  const declarations = Array.from(requiredNames, (name) => {
    const declaration = renderer.match(new RegExp(`^  const ${name} = .+;$`, "m"))
      ?? renderer.match(new RegExp(`^  const ${name} = [\\s\\S]*?^  };$`, "m"));
    assert.ok(declaration, `missing renderer declaration for ${name}`);
    return declaration[0];
  }).join("\n");
  const appended: Array<{ dataset: Record<string, string>; id?: string; textContent?: string }> = [];
  const document = {
    getElementById() {
      return null;
    },
    createElement() {
      return { dataset: {} };
    },
    documentElement: {
      appendChild(node: (typeof appended)[number]) {
        appended.push(node);
      },
    },
  };
  const install = new Function("document", `${declarations}\n${source}\ninstallStyle();`) as (documentValue: typeof document) => void;

  install(document);
  return appended;
}

const settingsCatalogUrl = new URL("../../../crates/codex-plus-core/assets/enhancement-settings.json", import.meta.url);

/**
 * 把注入页里按清单生成设置页的那段代码切出来执行：/settings/catalog 由 postJson 桩返回，
 * 其余依赖（键映射、转义、行内输入框的取值）都取产物里的真实实现或固定值。
 */
async function settingsCatalogRuntime(
  postJson: (path: string) => Promise<unknown>,
  platform: { windows: boolean; mac: boolean } = { windows: false, mac: true },
  backendSettings: Record<string, unknown> = { enhancementsEnabled: true },
) {
  const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const slice = (startMarker: string, endMarker: string) => {
    const start = renderer.indexOf(startMarker);
    const end = renderer.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing ${startMarker}`);
    return renderer.slice(start, end);
  };
  const diagnostics: Array<{ name: string; detail: unknown }> = [];
  const runtime = new Function(
    "postJson", "sendCodexPlusDiagnostic", "codexPlusIsWindowsPlatform", "codexPlusIsMacPlatform", "codexPlusBackendSettings",
    `${slice("  const codexPlusBackendSettingMap = {", "  const codexPlusBackendMappedSettings")}
${slice("  function escapeHtml(value) {", "\n  }\n")}
  }
  let refreshes = 0;
  function renderBackendStatus() {}
  function refreshCodexPlusBackendToggles() {}
  const codexPlusBuiltinInventoryLoaded = true;

${slice("  let codexPlusSettingsCatalog = null;", "  function refreshCodexPlusSettingsCatalogView()")}
  function refreshCodexPlusSettingsCatalogView() { refreshes += 1; }
  return {
    load: loadCodexPlusSettingsCatalog,
    sections: renderCodexPlusSettingsCatalogSections,
    status: () => codexPlusSettingsCatalogStatus,
    refreshes: () => refreshes,
  };`,
  )(postJson, (name: string, detail: unknown) => { diagnostics.push({ name, detail }); }, platform.windows, platform.mac, backendSettings) as {
    load: () => Promise<unknown>;
    sections: () => string;
    status: () => { status: string; message: string };
    refreshes: () => number;
  };
  return { ...runtime, diagnostics };
}

/** 从生成的 HTML 里读出分组与每行的标题、说明、绑定的设置 key。 */
function parseSettingsSections(html: string) {
  return Array.from(html.matchAll(/<section class="codex-plus-settings-section" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g), ([, title, body]) => ({
    title,
    rows: Array.from(body.matchAll(/<div class="codex-plus-row"(?: data-codex-plus-setting-row="([^"]+)")?[^>]*>\s*<div><div class="codex-plus-row-title">([\s\S]*?)<\/div><div class="codex-plus-row-description"[^>]*>([^<]*)<\/div>(?:<div class="codex-plus-row-description" data-codex-plus-native-fast-status="true"[^>]*><\/div>)?<\/div>([\s\S]*?)(?=<div class="codex-plus-row"|$)/g), ([, key, rowTitle, description, control]) => ({
      key: key ?? "",
      // 标题后面可能跟着「实验」「需重启」小标签，拆开分别校验。
      title: rowTitle.replace(/<em class="codex-plus-feature-tag"[^>]*>[^<]*<\/em>/g, ""),
      tags: Array.from(rowTitle.matchAll(/<em class="codex-plus-feature-tag"[^>]*>([^<]*)<\/em>/g), ([, tag]) => tag),
      description,
      control,
    })),
  }));
}

describe("renderer injection header compatibility", () => {
  it("uses the same model enhancement settings regardless of a legacy launch mode", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const settingsStart = renderer.indexOf("  function defaultCodexPlusSettings()");
    const settingsEnd = renderer.indexOf("  function setCodexPlusSetting(", settingsStart);
    assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
    const runtime = new Function(
      "window", "localStorage", "codexPlusBackendSettings", "codexPlusBackendSettingsLoaded",
      "conversationViewDefaultWidth", "codexPlusSettingsKey",
      renderer.slice(settingsStart, settingsEnd) + "\nreturn codexPlusSettings();",
    );
    for (const launchMode of [undefined, "relay", "patch"]) {
      for (const enhancementsEnabled of [false, true]) {
        for (const codexAppNativeFastUnlock of [false, true]) {
          const settings = { launchMode, enhancementsEnabled, codexAppNativeFastUnlock };
          const result = runtime({}, { getItem: () => '{"modelWhitelistUnlock":true}' }, settings, true, 900, "fixture");
          const expected = enhancementsEnabled && codexAppNativeFastUnlock;
          assert.equal(result.nativeFastUnlock, expected);
          assert.equal(Object.hasOwn(result, "modelWhitelistUnlock"), false);
        }
      }
    }
    assert.doesNotMatch(renderer, /codexPlusBackendSettings\.launchMode|data-relay-unneeded|兼容增强|完整增强/);
    assert.doesNotMatch(renderer, /codexMenuLocalizationScopeSelector\(\)/);
    const catalog = JSON.parse(await readFile(settingsCatalogUrl, "utf8"));
    const page = await settingsCatalogRuntime(async () => catalog);
    await page.load();
    const html = page.sections();
    assert.match(html, /data-codex-backend-setting="enhancementsEnabled"/);
    assert.match(html, /data-codex-plus-setting="nativeFastUnlock"/);
    assert.doesNotMatch(html, /modelWhitelistUnlock/);
  });

  it("keeps the retired in-place session copy and auto-rename actions out of every menu", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    // 会话行「…」菜单与 Codex 原生「聊天操作」菜单里都不能再出现这两项。
    assert.doesNotMatch(renderer, /原地复制会话|自动重命名当前会话|已自动重命名/);
    assert.doesNotMatch(renderer, /function (?:activateSessionCopyMenuItem|createSessionCopyMenuItem|refreshSessionCopyMenuItems|sessionCopyMenuRow|sessionCopyMenuScopes|activateSessionAutoRenameMenuItem|nativeSessionRenameCapability|isNativeSessionRenameMenuItem|visibleSessionRenameDialog|rememberSessionActionTrigger)\(/);
    assert.doesNotMatch(renderer, /sessionCopyMenuItemClass|sessionCopyMenuItemVersion|sessionCopyMenuActivationTimeoutMs|sessionAutoRenameTimeoutMs|lastSessionActionTrigger/);
    assert.doesNotMatch(renderer, /__codexSessionCopyRow|__codexSessionAutoRenameRow|codexSessionCopyMenu|codexSessionAutoRenameMenu/);
    assert.doesNotMatch(renderer, /从这里创建聊天分支|Fork from here/);
    // 旧版本同页注入时挂上的触发器监听要被摘掉，不能留下悬空回调。
    assert.match(renderer, /document\.removeEventListener\("pointerdown", window\.__codexSessionActionTriggerHandler, true\);/);
    assert.doesNotMatch(renderer, /document\.addEventListener\("(?:pointerdown|click)", window\.__codexSessionActionTriggerHandler/);
  });

  it("does not install a session sharing button after sharing is retired", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    // 后端的 /share/create、/session/export 早已删除，页面里的按钮、导入监听与开关一起下线。
    assert.doesNotMatch(renderer, /function (?:installSessionShareButton|createSessionShare|installSessionShareImportListener)\(/);
    assert.doesNotMatch(renderer, /codexAppSessionShare|"\/session\/export"/);
  });

  it("removes the legacy Codex Pilot top-bar entry", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.doesNotMatch(renderer, /function installCodexPlusMenu\(\)/);
    assert.doesNotMatch(renderer, /function findNativeMenuInsertionPoint\(\)/);
    assert.doesNotMatch(renderer, /codex-plus-trigger/);
  });

  it("removes fixed sidebar entries while keeping user extension navigation", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    assert.doesNotMatch(renderer, /function (?:installCodexPlusSidebarNavigation|installCodexPlusRailNavigation|openCodexPlusPage|openCodexPlusExtensions)\(/);
    assert.doesNotMatch(renderer, /codexPlusSidebarNavId|codexPlusRailNavId|codexPlusRailExtensionsId|codexPlusSidebarPluginMarketId|codexPlusRailPluginMarketId/);
    const source = renderer.match(/^  function installCodexPlusNavigationEntries\([^]*?^  \}/m)?.[0];
    assert.ok(source);
    const removed: string[] = [];
    let refreshed = 0;
    const fixed = ["codex-plus-sidebar-nav", "codex-plus-rail-nav", "codex-plus-rail-extensions", "codex-plus-rail-sponsor", "codex-plus-rail-plugin-market", "codex-plus-sidebar-plugin-market"];
    const nodes = new Map([...fixed, "codex-plus-ext-rail-notes", "builtin:projects"].map(id => [id, { remove() { removed.push(id); } }]));
    const install = new Function("document", "refreshCodexPlusRailNavigation", `
      const codexPlusMenuId = "codex-plus-menu";
      ${source}
      return installCodexPlusNavigationEntries;
    `)({ getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [] }, () => { refreshed++; });
    install();
    assert.deepEqual(removed, fixed);
    assert.equal(refreshed, 1);
  });

  it("移除固定推荐入口，保留拓展页面的界面缩放", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.doesNotMatch(renderer, /codexPlusRailSponsorId|codexPlusSponsorTab|openCodexPlusSponsor|推荐内容/);
    assert.doesNotMatch(renderer, /fetchCodexPlusAds|Ad-List|ads\.codexpp\.cc|codex-plus-ad-card/);
    // 旧版已挂载的入口会在热注入时清除。
    assert.match(renderer, /"codex-plus-rail-sponsor"/);

    // 弹窗里的 tab 条已删除，不该再有残留。
    assert.doesNotMatch(renderer, /codex-plus-tab-button/);

    // 界面缩放：读 Codex 的 zoom 变量，套到 overlay 上，尺寸用 calc 反向抵消。
    assert.match(renderer, /const codexPlusWindowZoomVar = "--codex-window-zoom"/);
    assert.match(renderer, /function codexPlusWindowZoom\(\)/);
    assert.match(renderer, /function applyCodexPlusZoom\(overlay\)/);
    assert.match(renderer, /overlay\.style\.setProperty\("zoom", String\(zoom\)\)/);
    assert.match(renderer, /width: calc\(100vw \/ var\(--codex-plus-zoom, 1\)\)/);
    // 页面模式的 left 偏移要按 zoom 折算回布局坐标，CSS 里的 width 用的是同一个空间，
    // 两边量纲不一致会把右边缘算短（曾出现 62 + 1652 = 1714，视口 1727）。
    assert.match(renderer, /const layoutLeft = zoom === 1 \? left : left \/ zoom;/);
    assert.match(renderer, /overlay\.style\.setProperty\("--codex-plus-page-left", `\$\{layoutLeft\}px`\)/);
  });

  it("颜色走 Codex 的语义令牌，不写死调色板", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    // applyCodexPlusTheme 读宿主算好的令牌，取不到才回落。
    assert.match(renderer, /function applyCodexPlusTheme\(overlay\)/);
    assert.match(renderer, /--color-token-text-primary/);
    assert.match(renderer, /--color-token-text-secondary/);
    assert.match(renderer, /--color-token-bg-primary/);
    // 早先写死的 zinc 调色板不能再出现在主题函数里。
    const themeBody = renderer.slice(
      renderer.indexOf("function applyCodexPlusTheme(overlay)"),
      renderer.indexOf("  // ── 设置项清单", renderer.indexOf("function applyCodexPlusTheme(overlay)")),
    );
    assert.ok(themeBody.length > 0, "找不到 applyCodexPlusTheme 的函数体");
    assert.ok(!themeBody.includes('text: "#f3f4f6"'), "主题函数里残留硬编码的正文色");
    assert.ok(!themeBody.includes('textSecondary: "#a1a1aa"'), "主题函数里残留硬编码的次要色");
  });

  it("移除万物皆拓展页面与市场，保留内置拓展开关和菜单拓展接口", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    assert.doesNotMatch(renderer, /data-codex-extensions-search|data-codex-extensions-select|data-codex-market-install/);
    assert.doesNotMatch(renderer, /function loadScriptMarket\(|postJson\("\/script-market\/(?:list|install)"/);
    assert.match(renderer, /function loadCodexPlusBuiltinInventory\(/);
    assert.match(renderer, /data-codex-builtin-extension/);
    assert.match(renderer, /function setCodexPlusBuiltinExtensionEnabled\(/);
    assert.match(renderer, /function renderCodexPlusExtensionMenuRows\(/);
  });

  it("does not install Codex Pilot UI in embedded browser documents", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /window\.top\s*!==\s*window/);
    assert.match(renderer, /!window\.electronBridge/);
    assert.ok(renderer.includes("/^app:\\\/\\\/\\-\\//i.test(window.location.href)"));
    assert.match(renderer, /codexPlusIsNodeTestHarness/);
  });

  it("initializes renderer styles without unresolved template identifiers", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    const appended = installRendererStyle(renderer);

    assert.equal(appended.length, 1);
    assert.match(appended[0].textContent ?? "", /\.codex-plus-rail-icon/);
  });

  it("does not override the host document root typography or foreground", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const appended = installRendererStyle(renderer);
    const css = appended[0].textContent ?? "";
    const rootRule = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";

    assert.doesNotMatch(rootRule, /(?:^|;)\s*font(?:-family)?\s*:/);
    assert.doesNotMatch(rootRule, /(?:^|;)\s*color\s*:/);
    assert.match(css, /:where\([^)]*codex-plus-modal-overlay[^)]*\)\s*\{[^}]*font-family:\s*inherit;/s);
  });

  it("labels settings switches and keeps their checked state in sync while backend controls wait", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const createButton = (key: string, title: string, relayUnneeded = false) => {
      const attributes: Record<string, string> = { "data-codex-plus-setting": key };
      return {
        attributes,
        dataset: { relayUnneeded: String(relayUnneeded) } as Record<string, string>,
        disabled: false,
        getAttribute: (name: string) => attributes[name] ?? null,
        setAttribute: (name: string, value: string) => { attributes[name] = value; },
        closest: () => ({ querySelector: () => ({ textContent: title }) }),
      };
    };
    const mapped = createButton("sideChatSave", "旁支保存");
    const local = createButton("threadScrollRestore", "切换对话保留位置");
    const unavailable = createButton("nativeFastUnlock", "原生 Fast 强制解锁", true);
    const buttons = [mapped, local, unavailable];
    const labelStart = renderer.indexOf('    overlay.querySelectorAll(".codex-plus-toggle[data-codex-plus-setting],');
    const labelEnd = renderer.indexOf("    const closeButton", labelStart);
    assert.ok(labelStart >= 0 && labelEnd > labelStart);
    new Function("overlay", renderer.slice(labelStart, labelEnd))({ querySelectorAll: () => buttons });
    for (const [button, label] of [[mapped, "旁支保存"], [local, "切换对话保留位置"], [unavailable, "原生 Fast 强制解锁"]] as const) {
      assert.equal(button.attributes.role, "switch");
      assert.equal(button.attributes["aria-label"], label);
      assert.equal(button.attributes["aria-checked"], "false");
    }

    const renderStart = renderer.indexOf("  function renderCodexPlusMenu()");
    const renderEnd = renderer.indexOf("\n  let codexPlusBackendSettings =", renderStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart);
    const settings: Record<string, boolean> = { sideChatSave: true, threadScrollRestore: true, nativeFastUnlock: true };
    const render = new Function("document", "codexPlusSettings", "codexPlusBackendMappedSettings", "refreshConversationViewControls",
      `let codexPlusBackendSettingsLoaded = false; const codexPlusBackendSettings = {};
${renderer.slice(renderStart, renderEnd)}
return (loaded) => { codexPlusBackendSettingsLoaded = loaded; renderCodexPlusMenu(); };`,
    )(
      { querySelectorAll: (selector: string) => selector === ".codex-plus-toggle[data-codex-plus-setting]" ? buttons : [] },
      () => settings,
      new Set(["sideChatSave", "nativeFastUnlock"]),
      () => {},
      () => {},
    ) as (loaded: boolean) => void;
    render(false);
    assert.equal(mapped.dataset.pending, "true");
    assert.equal(mapped.disabled, true);
    assert.equal(local.dataset.pending, "false");
    assert.equal(local.disabled, false);
    for (const button of buttons) assert.equal(button.attributes["aria-checked"], button.dataset.enabled);
    assert.equal(mapped.attributes["aria-checked"], "true");

    for (const key of Object.keys(settings)) settings[key] = false;
    render(true);
    for (const button of buttons) {
      assert.equal(button.dataset.pending, "false");
      assert.equal(button.dataset.enabled, "false");
      assert.equal(button.attributes["aria-checked"], "false");
    }
    assert.equal(mapped.disabled, false);
    assert.equal(local.disabled, false);
    assert.equal(unavailable.disabled, true, "a relay-unavailable switch stays disabled after settings load");
  });

  it("refreshes backend switches from enabled to disabled without losing their accessible state", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const start = renderer.indexOf("  function syncCodexPlusBackendToggleButtons()");
    const end = renderer.indexOf("\n  let codexPlusBuiltinInventory =", start);
    assert.ok(start >= 0 && end > start);
    const settings = { enhancementsEnabled: true };
    const attributes: Record<string, string> = {};
    let attributeWrites = 0;
    const button = {
      dataset: {} as Record<string, string>,
      disabled: true,
      getAttribute: () => "enhancementsEnabled",
      setAttribute: (name: string, value: string) => { attributes[name] = value; attributeWrites += 1; },
    };
    let menuRefreshes = 0;
    const refresh = new Function("document", "codexPlusBackendSettings", "syncAnswerOutlinePanel", "runScanStep", "syncCodexPlusTypingEffects", "renderCodexPlusMenu", "scan", "syncCodexPlusSettingsCatalogDescriptions",
      `${renderer.slice(start, end)}\nreturn refreshCodexPlusBackendToggles;`,
    )(
      { querySelectorAll: () => [button] }, settings, () => {}, () => {}, () => {},
      () => { menuRefreshes += 1; }, () => {}, () => {},
    ) as () => void;
    refresh();
    assert.equal(button.dataset.enabled, "true");
    assert.equal(attributes["aria-checked"], "true");
    settings.enhancementsEnabled = false;
    refresh();
    assert.equal(button.dataset.enabled, "false");
    assert.equal(attributes["aria-checked"], "false");
    assert.equal(button.disabled, true, "backend refresh preserves the control's existing disabled state");
    assert.equal(menuRefreshes, 2, "each backend refresh also synchronizes the other settings controls");
    // 心跳每 5 秒同步一次：值没变就不写属性，避免无谓的 DOM 变更触发扫描。
    const writes = attributeWrites;
    refresh();
    assert.equal(attributeWrites, writes);
  });

  it("groups the settings homepage into labelled cards and keeps hidden service controls hidden", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const homeStart = renderer.indexOf('data-codex-plus-panel="home"');
    const homeEnd = renderer.indexOf("${renderCodexPlusExtensionMenuRows()}", homeStart);
    assert.ok(homeStart >= 0 && homeEnd > homeStart);
    // 模板里只剩清单挂载点和固定的「工具与关于」；设置分组全部按清单生成。
    const template = renderer.slice(homeStart, homeEnd);
    assert.match(template, /\$\{renderCodexPlusSettingsCatalogSections\(\)\}\s*<section class="codex-plus-settings-section" aria-label="工具与关于" data-codex-plus-settings-tools="true">/);
    const catalog = JSON.parse(await readFile(settingsCatalogUrl, "utf8"));
    const page = await settingsCatalogRuntime(async () => catalog);
    await page.load();
    const html = page.sections() + template.slice(template.indexOf('<section class="codex-plus-settings-section" aria-label="工具与关于"'));
    const sections = Array.from(html.matchAll(/<section class="codex-plus-settings-section" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g));
    const expectedGroups = catalog.groups
      .filter((group: { id: string }) => catalog.items.some((item: { group: string; surfaces: string[] }) => item.group === group.id && item.surfaces.includes("codex"))
        || catalog.builtins.some((entry: { group: string }) => entry.group === group.id))
      .map((group: { title: string }) => group.title);
    assert.deepEqual(sections.map((match) => match[1]), [...expectedGroups, "工具与关于"]);
    for (const [, title, contents] of sections) {
      assert.ok(contents.includes(`<h2 class="codex-plus-settings-section-title">${title}</h2>`));
      assert.ok(contents.includes('class="codex-plus-settings-card"'));
      assert.ok(contents.includes('class="codex-plus-row"'));
    }
    const css = installRendererStyle(renderer)[0].textContent ?? "";
    assert.match(css, /\.codex-plus-settings\s+\.codex-plus-row\[hidden\]\s*\{\s*display:\s*none\s*;/);
  });

  // 桥接连续失败时仍需通知看门狗修复；HTTP 服务移除后不能用另一个端点掩盖断连。
  it("tracks bridge failures without an HTTP fallback", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    assert.match(renderer, /const CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD = 3;/);
    assert.match(renderer, /function recordCodexPlusBridgeFailure\(\) \{\s*codexPlusBridgeFailureCount \+= 1;/);
    assert.match(renderer, /health\.failures = codexPlusBridgeFailureCount;/);
    assert.match(renderer, /bridgeDegraded && rawStatus === "ok" \? "degraded" : rawStatus/);
    assert.match(renderer, /桥接降级，自动修复中/);
    assert.doesNotMatch(renderer, /fetchBackendStatusFromHelper|helperBase|__CODEX_SESSION_DELETE_HELPER__|navigator\.sendBeacon/);
    // 降级状态有专属样式（指示灯与文本）
    assert.match(renderer, /\.codex-plus-backend-indicator\[data-status="degraded"\]/);
    assert.match(renderer, /\.codex-plus-backend-label\[data-status="degraded"\]/);
  });
});

/** 从注入脚本里取出 `shouldScheduleScan`，配上可控的依赖来跑。 */
function shouldScheduleScanRuntime(renderer: string) {
  const start = renderer.indexOf("  function shouldScheduleScan(");
  const end = renderer.indexOf("\n  function runScheduledScan(", start);
  assert.ok(start >= 0 && end > start, "shouldScheduleScan not found in renderer-inject.js");
  const source = renderer.slice(start, end);
  const factory = new Function(
    "isChatContentMutation",
    "isExtensionUiNode",
    "nodeSelfOrAncestorMatchesScanRelevance",
    "isScanRelevantNode",
    `${source}\nreturn shouldScheduleScan;`,
  );
  return factory(
    () => false,
    (node: { extension?: boolean }) => Boolean(node?.extension),
    // Codex 的容器（header / 侧栏 nav）本身就是 scan-relevant，这是自喂循环的关键前提。
    (node: { relevant?: boolean }) => Boolean(node?.relevant),
    (node: { relevant?: boolean; extension?: boolean }) =>
      Boolean(node?.relevant) && !node?.extension,
  ) as (mutations: unknown[]) => boolean;
}

const codexContainer = { nodeType: 1, relevant: true };

function mutation(addedNodes: unknown[] = [], removedNodes: unknown[] = []) {
  return { target: codexContainer, addedNodes, removedNodes };
}

describe("renderer injection scan scheduling", () => {
  const rendererPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  // issue #1960：我们把自己的节点挂进 Codex 的容器，容器是 scan-relevant，
  // 于是每次写入都会再排一次 scan，scan 又重新写入，空闲时 CPU 被吃满。
  it("ignores mutations that only move the extension's own nodes", async () => {
    const shouldScheduleScan = shouldScheduleScanRuntime(await readFile(rendererPath, "utf8"));
    const ownNode = { nodeType: 1, extension: true };

    assert.equal(shouldScheduleScan([mutation([ownNode])]), false);
    // appendChild 一个已经在位的子节点会同时报 removed + added。
    assert.equal(shouldScheduleScan([mutation([ownNode], [ownNode])]), false);
  });

  it("still scans when Codex itself changes the same container", async () => {
    const shouldScheduleScan = shouldScheduleScanRuntime(await readFile(rendererPath, "utf8"));
    const codexNode = { nodeType: 1, relevant: true };
    const ownNode = { nodeType: 1, extension: true };

    assert.equal(shouldScheduleScan([mutation([codexNode])]), true);
    // 混合变更里只要有一个不是我们的，就不能跳过。
    assert.equal(shouldScheduleScan([mutation([ownNode, codexNode])]), true);
    // 属性变更没有 added/removed 节点，仍按容器相关性判定。
    assert.equal(shouldScheduleScan([mutation()]), true);
  });
});

/** 取出共用的 module loader，用假时钟驱动它的失败冷却。 */
function moduleLoaderRuntime(renderer: string) {
  const start = renderer.indexOf("  // issue #1960：失败必须被记住。");
  const end = renderer.indexOf("\n  async function loadOptionalCodexAppModule(", start);
  assert.ok(start >= 0 && end > start, "loadCodexAppModule not found in renderer-inject.js");
  const source = renderer.slice(start, end);

  let sweeps = 0;
  let clock = 1_000_000;
  const factory = new Function(
    "codexServiceTierModulePromises",
    "codexAppModuleFailures",
    "codexAppModuleRetryCooldownMs",
    "codexAppModuleMaxAttempts",
    "codexAppAssetUrl",
    "codexAppAssetUrlFromScriptText",
    "Date",
    `${source}\nreturn loadCodexAppModule;`,
  );
  const load = factory(
    new Map(),
    new Map(),
    30000,
    8,
    () => "",
    // 真实实现在这里会把全部 app asset 拉一遍；这里只计数并同样返回“没找到”。
    async () => {
      sweeps += 1;
      return "";
    },
    { now: () => clock },
  ) as (namePart: string) => Promise<unknown>;

  const attempt = async (namePart = "vscode-api-") => {
    try {
      await load(namePart);
    } catch {
      /* 预期失败 */
    }
  };
  return { attempt, sweeps: () => sweeps, advance: (ms: number) => { clock += ms; } };
}

describe("renderer injection codex app module loader", () => {
  const rendererPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  // issue #1960：失败以前只是把 promise 删掉，等于没有负缓存，
  // 调用方一重试就重新 fetch 全部 app asset（实测 301 次请求/秒）。
  it("does not re-sweep every asset while the failure is still in cooldown", async () => {
    const loader = moduleLoaderRuntime(await readFile(rendererPath, "utf8"));

    for (let i = 0; i < 20; i += 1) await loader.attempt();

    assert.equal(loader.sweeps(), 1);
  });

  it("retries once per cooldown window, then gives up for good", async () => {
    const loader = moduleLoaderRuntime(await readFile(rendererPath, "utf8"));

    // 冷却期满就允许再试一次，避免 Codex 更新后 asset 回来了却永远发现不了。
    for (let i = 0; i < 30; i += 1) {
      await loader.attempt();
      loader.advance(30001);
    }

    // 连续失败达到上限(8)后彻底停手，而不是每个冷却窗口都再扫一遍。
    assert.equal(loader.sweeps(), 8);
  });

  it("keeps failures separate per asset prefix", async () => {
    const loader = moduleLoaderRuntime(await readFile(rendererPath, "utf8"));

    await loader.attempt("vscode-api-");
    await loader.attempt("app-initial-");
    await loader.attempt("vscode-api-");

    // 两个前缀各自试了一次；第三次命中 vscode-api- 自己的冷却。
    assert.equal(loader.sweeps(), 2);
  });
});


// issue #2256/#2255：app-server model request patch 的 miss 熔断以前被 provider
// 重试路径提前 return 绕过，失败变成 250ms 无限重试（每轮全量 fetch 全部 app asset）。
describe("renderer injection app-server model request patch", () => {
  const rendererPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  interface AppServerPatchHarness {
    install: () => void;
    sweeps: () => number;
    diagnostics: () => string[];
    settle: () => Promise<void>;
  }

  function appServerPatchRuntime(renderer: string, patchSucceeds: boolean): AppServerPatchHarness {
    const start = renderer.indexOf("  const appServerModelRequestPatchMaxMisses = ");
    const end = renderer.indexOf("\n  function ensureCodexAppServerClient(", start);
    assert.ok(start >= 0 && end > start, "app-server model request patch block not found");
    const source = renderer.slice(start, end);

    let sweeps = 0;
    let pending: Array<() => void> = [];
    const diagnostics: string[] = [];
    const timers: Array<number> = [];
    const fakeWindow: Record<string, unknown> = {
      setTimeout: ((fn: () => void) => {
        timers.push(0);
        pending.push(fn);
        return 0;
      }) as unknown,
      clearTimeout: () => {},
    };

    const factory = new Function(
      "window",
      "codexAppServerModelRequestPatchVersion",
      "codexRemoteSessionProviderPatchEnabled",
      "loadAppServerRequestCandidates",
      "patchAppServerModelRequestClient",
      "sendCodexPlusDiagnostic",
      "Date",
      `${source}\nreturn installAppServerModelRequestPatch;`,
    );

    const install = factory(
      fakeWindow,
      1,
      // provider patch 开关两态都要测：以前 enabled 时走提前 return 绕过熔断。
      () => true,
      () =>
        new Promise((resolve) => {
          sweeps += 1;
          pending.push(() => resolve({ modules: [{}], candidates: [{}], sources: [], discovery: "fallback" }));
        }),
      () => patchSucceeds,
      (event: string) => diagnostics.push(event),
      Date,
    ) as () => void;

    const settle = async () => {
      // 重试定时器是挂起的回调：排空 sweep 再触发到期的 retry，直到没有新定时器。
      for (let round = 0; round < 32; round += 1) {
        if (!pending.length) break;
        const flushSweeps = pending;
        pending = [];
        flushSweeps.forEach((resolve) => resolve());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    };

    return { install, sweeps: () => sweeps, diagnostics: () => diagnostics, settle };
  }

  it("does not start a new sweep while the previous one is still running", async () => {
    const harness = appServerPatchRuntime(await readFile(rendererPath, "utf8"), false);

    for (let i = 0; i < 20; i += 1) harness.install();

    assert.equal(harness.sweeps(), 1);
    await harness.settle();
  });

  it("stops retrying via the provider path once maxMisses is reached", async () => {
    const harness = appServerPatchRuntime(await readFile(rendererPath, "utf8"), false);

    // 反复 install + settle，让每轮 miss 走完 provider 重试调度。
    for (let i = 0; i < 40; i += 1) {
      harness.install();
      await harness.settle();
    }

    // 关键回归断言：以前 provider 路径无限重试（40 轮 = 40 次 sweep），
    // 现在到 maxMisses(8) 就熔断停手。
    assert.equal(harness.sweeps(), 8);
    assert.equal(harness.diagnostics().filter((e) => e === "model_app_server_request_patch_not_found").length, 1);
    assert.deepEqual(harness.diagnostics().at(-1), "model_app_server_request_patch_skipped");
    const settled = harness.sweeps();
    harness.install();
    await harness.settle();
    assert.equal(harness.sweeps(), settled);
  });

  it("keeps working normally when the patch actually lands", async () => {
    const harness = appServerPatchRuntime(await readFile(rendererPath, "utf8"), true);

    harness.install();
    await harness.settle();
    for (let i = 0; i < 10; i += 1) harness.install();

    assert.equal(harness.sweeps(), 1);
    assert.deepEqual(harness.diagnostics(), ["model_app_server_request_patch_installed"]);
  });
});

// renderer-inject.js 现在是「分片源码 + 生成产物」：真正的源码在
// assets/inject/renderer-inject/*.js，产物是拼回去的单体文件，供 assets.rs 的
// include_str! 和本文件的大量按路径断言消费。
// 这组用例防止有人只改产物、不回改分片，让两边悄悄分叉。
describe("renderer inject 分片与产物一致", () => {
  const fragmentDir = new URL("../../../assets/inject/renderer-inject/", import.meta.url);
  const artifactPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  async function assembleFromFragments(): Promise<{
    source: string;
    names: string[];
    fragments: Array<{ name: string; description?: string; lines: number }>;
  }> {
    const manifest = JSON.parse(
      await readFile(new URL("manifest.json", fragmentDir), "utf8"),
    ) as { fragments: Array<{ name: string; description?: string; lines: number }> };
    assert.ok(
      Array.isArray(manifest.fragments) && manifest.fragments.length > 0,
      "manifest.json 必须有 fragments",
    );
    const bodies = await Promise.all(
      manifest.fragments.map(async (fragment) => {
        assert.ok(fragment.name, "分片必须带 name");
        const body = await readFile(new URL(fragment.name, fragmentDir), "utf8");
        // 每片以换行收尾，直接相接才能还原原始行结构；漏了会让两处声明粘连。
        assert.ok(body.endsWith("\n"), `分片 ${fragment.name} 未以换行结尾`);
        return body;
      }),
    );
    return {
      source: bodies.join(""),
      names: manifest.fragments.map((f) => f.name),
      fragments: manifest.fragments,
    };
  }

  it("分片按 manifest 顺序拼接后与产物逐字节一致", async () => {
    const { source, names } = await assembleFromFragments();
    const artifact = await readFile(artifactPath, "utf8");
    assert.equal(
      source,
      artifact,
      `产物与分片不一致（分片 ${names.length} 个）。` +
        "改分片后请跑 node scripts/assemble-renderer-inject.mjs 重新组装。",
    );
  });

  it("拼接结果是完整可解析的单个 IIFE", async () => {
    const { source } = await assembleFromFragments();
    assert.ok(source.startsWith("(() => {\n"), "必须以 IIFE 开头");
    assert.ok(source.includes("\n})();\n"), "必须包含主 IIFE 的收尾");
    // 语法解析（不执行）能抓出分片切坏造成的括号不匹配。
    assert.doesNotThrow(() => new Function(source));
  });

  it("manifest 的行数与分片内容保持一致且没有重复文件", async () => {
    const { source, fragments } = await assembleFromFragments();
    const names = fragments.map((fragment) => fragment.name);
    assert.equal(new Set(names).size, names.length, "manifest 不得重复引用同一分片");
    assert.ok(fragments.every((fragment) => Number.isInteger(fragment.lines) && fragment.lines > 0));
    const manifestLines = fragments.reduce((total, fragment) => total + fragment.lines, 0);
    const artifactLines = source.endsWith("\n") ? source.slice(0, -1).split("\n").length : source.split("\n").length;
    assert.equal(manifestLines, artifactLines, "manifest 总行数必须覆盖完整产物");
    for (const fragment of fragments) {
      const body = await readFile(new URL(fragment.name, fragmentDir), "utf8");
      const lineCount = body.endsWith("\n") ? body.slice(0, -1).split("\n").length : body.split("\n").length;
      assert.equal(lineCount, fragment.lines, fragment.name);
    }
  });

  it("测试辅助依赖的锚点仍落在同一个分片里且顺序不变", async () => {
    // installRendererStyle() 用 indexOf 划区间，靠这两个标记定位。
    // 它们一旦被拆到不同分片、或前后顺序反转，helper 会静默取到空区间。
    const { source } = await assembleFromFragments();
    const start = source.indexOf("  function installStyle()");
    const end = source.indexOf("\n  function defaultCodexPlusSettings", start);
    assert.ok(start >= 0, "找不到 installStyle 锚点");
    assert.ok(end > start, "defaultCodexPlusSettings 必须排在 installStyle 之后");
  });

});

/**
 * 拓展接口层的契约测试。
 *
 * 这些测试把 01-registry.js 与 91-extension-api.js 的定义抽出来单独执行，
 * 不依赖真实 DOM——注册中心本身刻意不读 DOM，正是为了让它可以这样被验证。
 */
describe("拓展注册中心", () => {
  const rendererPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  interface RegistryHarness {
    registry: { rowActions: Map<string, unknown>; navEntries: Map<string, unknown>; pages: Map<string, unknown>; menuItems: Map<string, unknown> };
    register: (kind: string, reg: Map<string, unknown>, id: string, def: unknown, key: string) => () => void;
    registerSelector: (selector: string) => boolean;
    extensionSelector: () => string;
    isExtensionNode: (node: unknown) => boolean;
    items: (reg: Map<string, unknown>) => Array<Record<string, unknown>>;
    runCallback: (key: string, label: string, cb: () => unknown) => { ok: boolean; value?: unknown; error?: string };
    failures: () => Array<{ script_key: string; message: string }>;
    registryLog: () => unknown[];
  }

  async function registryRuntime(): Promise<RegistryHarness> {
    // 直接读注册中心分片本身：它刻意不读 DOM、不依赖 prelude 常量，所以能独立执行。
    // 不要从产物里 indexOf 切片——注册中心与接口层之间隔着十来个分片，区间会失控。
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/01-registry.js", import.meta.url),
      "utf8",
    );

    const windowValue: Record<string, unknown> = {};
    const documentValue = {
      // registerCodexPlusExtensionSelector 用空 fragment 验证选择器语法，
      // 非法选择器会抛错，模拟这个方法就足以覆盖合法性判定。
      createDocumentFragment: () => ({
        querySelector: (selector: string) => {
          if (/[<>]/.test(selector)) throw new Error("invalid selector");
          return null;
        },
      }),
    };
    const factory = new Function(
      "window",
      "document",
      `${source}
return { codexPlusRegistry, registerCodexPlusExtension, registerCodexPlusExtensionSelector,
  codexPlusExtensionSelector, isCodexPlusExtensionNode, codexPlusExtensionItems,
  runCodexPlusExtensionCallback };`,
    );
    const api = factory(windowValue, documentValue) as Record<string, unknown>;
    return {
      registry: api.codexPlusRegistry as RegistryHarness["registry"],
      register: api.registerCodexPlusExtension as RegistryHarness["register"],
      registerSelector: api.registerCodexPlusExtensionSelector as RegistryHarness["registerSelector"],
      extensionSelector: api.codexPlusExtensionSelector as RegistryHarness["extensionSelector"],
      isExtensionNode: api.isCodexPlusExtensionNode as RegistryHarness["isExtensionNode"],
      items: api.codexPlusExtensionItems as RegistryHarness["items"],
      runCallback: api.runCodexPlusExtensionCallback as RegistryHarness["runCallback"],
      failures: () => (windowValue.__codexPlusExtensionFailures || []) as Array<{ script_key: string; message: string }>,
      registryLog: () => (windowValue.__codexPlusRegistryLog || []) as unknown[],
    };
  }

  it("第三方项从 1000 起排，不会插到内置项前面", async () => {
    const runtime = await registryRuntime();
    runtime.register("rowAction", runtime.registry.rowActions, "builtin:a", { order: 10, onActivate() {} }, "builtin");
    runtime.register("rowAction", runtime.registry.rowActions, "ext:b", { order: 5, onActivate() {} }, "user:x.js");
    const items = runtime.items(runtime.registry.rowActions);
    // 传入的 5 被抬到 1000：内置项永远排在拓展项之前。
    assert.deepEqual(items.map((item) => item.id), ["builtin:a", "ext:b"]);
    assert.equal(items[1].order, 1000);
    // 内置拓展（scriptKey 为 builtin:*）经公开接口注册时可以用 0~999，排在第三方前面。
    runtime.register("rowAction", runtime.registry.rowActions, "builtin:session-delete:rowAction:x", { order: 10, onActivate() {} }, "builtin:session-delete");
    const ordered = runtime.items(runtime.registry.rowActions);
    assert.equal(ordered[0].id, "builtin:session-delete:rowAction:x");
    assert.equal(ordered[0].order, 10);
  });

  it("按脚本配额限制注册数量，超出时抛错", async () => {
    const runtime = await registryRuntime();
    for (let index = 0; index < 16; index += 1) {
      runtime.register("navEntry", runtime.registry.navEntries, `ext:${index}`, { onActivate() {} }, "user:noisy.js");
    }
    assert.throws(
      () => runtime.register("navEntry", runtime.registry.navEntries, "ext:overflow", { onActivate() {} }, "user:noisy.js"),
      /最多注册 16 项/,
    );
    // 另一个脚本不受影响。
    assert.doesNotThrow(
      () => runtime.register("navEntry", runtime.registry.navEntries, "ext:other", { onActivate() {} }, "user:other.js"),
    );
  });

  it("拒绝重复 id 与缺少回调的定义", async () => {
    const runtime = await registryRuntime();
    runtime.register("page", runtime.registry.pages, "ext:p", { render() {} }, "user:x.js");
    assert.throws(
      () => runtime.register("page", runtime.registry.pages, "ext:p", { render() {} }, "user:x.js"),
      /已被占用/,
    );
    assert.throws(
      () => runtime.register("page", runtime.registry.pages, "ext:empty", {}, "user:x.js"),
      /必须提供 render \/ onActivate/,
    );
  });

  it("菜单项的开关形态（只给 onChange）不被校验误拒", async () => {
    const runtime = await registryRuntime();
    // 开关形态没有 render / onActivate，早期实现会把它当成非法定义拒掉。
    assert.doesNotThrow(
      () => runtime.register("menuItem", runtime.registry.menuItems, "ext:toggle", { onChange() {} }, "user:x.js"),
    );
    assert.doesNotThrow(
      () => runtime.register("page", runtime.registry.pages, "ext:cleanup-only", { onCleanup() {} }, "user:x.js"),
    );
  });

  it("dispose 只移除自己注册的那一项", async () => {
    const runtime = await registryRuntime();
    const dispose = runtime.register("page", runtime.registry.pages, "ext:first", { render() {} }, "user:x.js");
    runtime.register("page", runtime.registry.pages, "ext:second", { render() {} }, "user:y.js");
    dispose();
    assert.deepEqual([...runtime.registry.pages.keys()], ["ext:second"]);
    // 重复 dispose 不应误删后来者。
    dispose();
    assert.deepEqual([...runtime.registry.pages.keys()], ["ext:second"]);
  });

  it("选择器登记拒绝非法语法，避免 closest() 在每次 mutation 上抛错", async () => {
    const runtime = await registryRuntime();
    assert.equal(runtime.registerSelector('[data-codex-plus-ext="a"]'), true);
    assert.match(runtime.extensionSelector(), /data-codex-plus-ext/);
    assert.equal(runtime.registerSelector("div << p"), false);
    assert.equal(runtime.registerSelector(""), false);
  });

  it("回调抛错时记进该脚本的失败通道，不向调用方抛出", async () => {
    const runtime = await registryRuntime();
    const outcome = runtime.runCallback("user:broken.js", "rowAction.onActivate", () => {
      throw new Error("boom");
    });
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /boom/);
    assert.equal(runtime.failures().length, 1);
    assert.equal(runtime.failures()[0].script_key, "user:broken.js");
  });
});

/**
 * 对外接口层的护栏测试。
 *
 * 接口层挂在 window.codexPlus 上、面向第三方脚本，所以「哪些能力被开放」必须
 * 有测试守着——新增路由时默认不开放，漏网才是 bug。
 */
describe("拓展接口层", () => {
  const apiFragmentPath = new URL(
    "../../../assets/inject/renderer-inject/91-extension-api.js",
    import.meta.url,
  );
  const artifactPath = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);

  async function readRouteWhitelist(): Promise<string[]> {
    const source = await readFile(apiFragmentPath, "utf8");
    const start = source.indexOf("const codexPlusExtensionRoutes = new Set([");
    const end = source.indexOf("]);", start);
    assert.ok(start >= 0 && end > start, "找不到路由白名单");
    const body = source.slice(start, end);
    return Array.from(body.matchAll(/"([^"]+)"/g), ([, route]) => route);
  }

  it("路由白名单不含设置写入与远端控制，CDP 注入需显式开放", async () => {
    const routes = await readRouteWhitelist();
    assert.ok(routes.length > 0, "白名单不能为空");
    // 这些路由一旦开放，第三方脚本就能改用户配置或操作远端，必须显式决策后才能加。
    for (const forbidden of ["/settings/set", "/settings/get", "/delete", "/undo", "/share/create"]) {
      assert.ok(!routes.includes(forbidden), `${forbidden} 不应默认开放给拓展`);
    }
    assert.ok(routes.includes("/diagnostics/log"), "诊断上报应保持开放");
    assert.ok(routes.includes("/cdp/targets"), "CDP 页面列表应开放给拓展");
    assert.ok(routes.includes("/cdp/evaluate"), "CDP evaluate 应开放给拓展");
    assert.ok(!routes.includes("/request-log/recent"));
    assert.ok(!routes.includes("/proxy-status"));
    for (const route of ["/thread-usage-live", "/backend/status", "/settings/public", "/model-catalog/public"]) {
      assert.ok(routes.includes(route), `只读的 ${route} 应开放给拓展`);
    }
    // 原始模型目录带供应商地址与本机路径，拓展只能拿 /model-catalog/public 的脱敏版本。
    for (const forbidden of ["/codex-model-catalog", "/codex-config-model"]) {
      assert.ok(!routes.includes(forbidden), `${forbidden} 不应开放给拓展`);
    }
  });

  it("接口对象在 IIFE 收尾前挂载", async () => {
    const renderer = await readFile(artifactPath, "utf8");
    const mount = renderer.indexOf("window.codexPlus = buildCodexPlusExtensionApi();");
    const tail = renderer.indexOf("\n})();\n");
    assert.ok(mount >= 0, "找不到 window.codexPlus 的挂载点");
    // 挂载必须在主 IIFE 结束之前，否则闭包里的函数已经不可达。
    assert.ok(mount < tail, "挂载点必须位于 IIFE 收尾之前");
  });
});

/**
 * 菜单项的接入方式护栏。
 *
 * 菜单的接入点是「在 home 面板模板末尾追加一块」，不是把内置的一百多行模板
 * 拆成数据结构——后者会动到内置 UI 主干。这些断言守住这个决定，以及点击
 * 委托的分支顺序。
 */
describe("拓展菜单项", () => {
  const settingsPath = new URL(
    "../../../assets/inject/renderer-inject/40-backend-settings.js",
    import.meta.url,
  );
  const hostPath = new URL(
    "../../../assets/inject/renderer-inject/92-extension-host.js",
    import.meta.url,
  );

  it("内置菜单模板保持原样，只追加一个拓展挂载点", async () => {
    const source = await readFile(settingsPath, "utf8");
    // 挂载点在 home 面板里，且位于「提出问题」之后（即内置项末尾）。
    const openIdx = source.indexOf("overlay.innerHTML = `");
    const mountIdx = source.indexOf("${renderCodexPlusExtensionMenuRows()}");
    const issueIdx = source.indexOf("提出问题");
    assert.ok(mountIdx > 0, "找不到拓展菜单挂载点");
    assert.ok(mountIdx > issueIdx, "挂载点应位于内置项之后");
    // 关键：内置的行仍然是内联模板，没有被拆成数组。
    assert.ok(
      source.slice(openIdx, mountIdx).includes('class="codex-plus-row"'),
      "内置菜单行应当仍是内联模板",
    );
    assert.ok(
      !/const codexPlusBuiltinMenuRows\s*=/.test(source),
      "不应把内置菜单行抽成数组",
    );
  });

  it("点击委托里拓展分支排在内置分支之前", async () => {
    const source = await readFile(settingsPath, "utf8");
    const handler = source.indexOf('overlay.addEventListener("click"');
    assert.ok(handler > 0, "找不到点击委托");
    const end = source.indexOf("document.body.appendChild(overlay)", handler);
    assert.ok(end > handler, "找不到点击委托之后的弹窗挂载点");
    const body = source.slice(handler, end);
    const extIdx = body.indexOf("handleCodexPlusExtensionMenuClick(target)");
    const devtoolsIdx = body.indexOf("data-codex-open-devtools");
    assert.ok(extIdx > 0, "点击委托应当调用拓展菜单处理器");
    assert.ok(devtoolsIdx > 0, "点击委托应当包含内置 DevTools 分支");
    assert.ok(extIdx < devtoolsIdx, "拓展分支应排在内置分支之前");
  });

  it("开关与按钮分别渲染成不同的控件", async () => {
    const source = await readFile(hostPath, "utf8");
    const start = source.indexOf("function renderCodexPlusExtensionMenuRows()");
    const end = source.indexOf("function handleCodexPlusExtensionMenuClick(", start);
    assert.ok(start > 0 && end > start, "找不到菜单渲染函数");
    const body = source.slice(start, end);
    assert.match(body, /data-codex-plus-ext-setting/, "开关应有自己的 data 属性");
    assert.match(body, /data-codex-plus-ext-action/, "按钮应有自己的 data 属性");
    // 是追加到 home 面板，不是替换它。
    assert.ok(!/panel\.innerHTML\s*=/.test(body), "不应整体替换面板内容");
  });

  it("菜单项失败经由脚本状态上报，不向调用方抛出", async () => {
    const source = await readFile(hostPath, "utf8");
    const start = source.indexOf("function handleCodexPlusExtensionMenuClick(");
    const body = source.slice(start, start + 1400);
    assert.match(body, /runCodexPlusExtensionCallback/, "回调必须经失败隔离包装");
    assert.ok(!/try\s*{[\s\S]*item\.onActivate\(/.test(body), "不应裸调 onActivate");
  });
});

describe("Codex Pilot 设置页按设置项清单生成", () => {
  type CatalogItem = {
    key: string; group: string; control: string; title: string; description: string; descriptionWhenEnhancementsOn?: string;
    surfaces: string[]; platforms?: string[]; codexInputs?: Array<{ id: string; label: string; hint?: string }>;
    builtin?: string; parent?: string; restart?: boolean;
  };
  type BuiltinEntry = { id: string; group: string; title: string; description: string; setting?: string };
  type Catalog = { groups: Array<{ id: string; title: string; description?: string }>; items: CatalogItem[]; builtins: BuiltinEntry[] };
  /** 设置页一组里的行序：不属于内置拓展的设置在前，然后每个内置拓展一行、子选项紧跟其后。 */
  const groupOrder = (catalog: Catalog, groupId: string, visible: (item: CatalogItem) => boolean) => {
    const params = (id: string) => catalog.items.filter((item) => item.parent === id && visible(item));
    const inGroup = catalog.items.filter((item) => item.group === groupId && visible(item));
    return [
      ...inGroup.filter((item) => !item.builtin && !item.parent),
      ...inGroup.filter((item) => item.builtin).flatMap((item) => [item, ...params(item.builtin!)]),
      ...catalog.builtins.filter((entry) => entry.group === groupId).flatMap((entry) => params(entry.id)),
    ];
  };
  const fragmentDir = new URL("../../../assets/inject/renderer-inject/", import.meta.url);
  const readCatalog = async (): Promise<Catalog> => JSON.parse(await readFile(settingsCatalogUrl, "utf8"));
  const visibleOn = (platform: string) => (item: CatalogItem) => item.surfaces.includes("codex")
    && (!item.platforms || item.platforms.includes(platform));

  it("注入分片里不再写死任何设置项标题、说明或分组名", async () => {
    const catalog = await readCatalog();
    const settingsPage = await readFile(new URL("40-backend-settings.js", fragmentDir), "utf8");
    for (const group of catalog.groups) {
      assert.ok(!settingsPage.includes(`aria-label="${group.title}"`), `分组「${group.title}」不应写死在设置页模板里`);
      assert.ok(!settingsPage.includes(`>${group.title}</h2>`), `分组「${group.title}」不应写死在设置页模板里`);
    }
    for (const item of catalog.items) {
      assert.ok(!settingsPage.includes(item.title), `「${item.title}」的标题应来自清单`);
      assert.ok(!settingsPage.includes(item.description), `「${item.title}」的说明应来自清单`);
    }
    // 说明文案足够长、足够独特：任何分片里出现都意味着又多了一份副本。
    const manifest = JSON.parse(await readFile(new URL("manifest.json", fragmentDir), "utf8"));
    for (const fragment of manifest.fragments as Array<{ name: string }>) {
      const source = await readFile(new URL(fragment.name, fragmentDir), "utf8");
      for (const item of catalog.items) assert.ok(!source.includes(item.description), `${fragment.name} 里有「${item.title}」说明的副本`);
    }
  });

  it("每个在 Codex 显示的设置项生成一行，文案与绑定都取自清单", async () => {
    const catalog = await readCatalog();
    const page = await settingsCatalogRuntime(async (path) => {
      assert.equal(path, "/settings/catalog");
      return catalog;
    });
    await page.load();
    assert.equal(page.status().status, "ok");
    const html = page.sections();
    const sections = parseSettingsSections(html);
    const rows = sections.flatMap((section) => section.rows.filter((row) => row.key));
    const expected = catalog.groups.flatMap((group) => groupOrder(catalog, group.id, visibleOn("macos")));
    assert.deepEqual(rows.map((row) => row.key), expected.map((item) => item.key));
    // 子选项缩进挂在所属内置拓展下面；内置拓展行带 id。
    for (const item of expected.filter((candidate) => candidate.parent)) {
      assert.match(html, new RegExp(`data-codex-plus-setting-row="${item.key}"[^>]*data-codex-plus-builtin-param="true"`), `${item.key} 是子选项`);
    }
    for (const item of expected.filter((candidate) => candidate.builtin)) {
      assert.match(html, new RegExp(`data-codex-plus-setting-row="${item.key}" data-codex-plus-builtin="${item.builtin}"`));
    }
    // 清单顶层的内置拓展各一行：本页认识的顶层设置照常绑定，其余经用户脚本配置启停。
    for (const entry of catalog.builtins) {
      const row = html.match(new RegExp(`<div class="codex-plus-row" data-codex-plus-builtin="${entry.id}">[\\s\\S]*?</button>`))?.[0];
      assert.ok(row, `${entry.id} 缺一行`);
      assert.ok(row.includes(`aria-label="${entry.title}"`));
      if (!entry.setting || entry.setting.includes(".")) assert.match(row, new RegExp(`data-codex-builtin-extension="${entry.id}"`));
      else assert.doesNotMatch(row, /data-codex-builtin-extension=/);
    }
    for (const item of expected) {
      const row = rows.find((candidate) => candidate.key === item.key)!;
      const section = sections.find((candidate) => candidate.rows.includes(row))!;
      assert.equal(section.title, catalog.groups.find((group) => group.id === item.group)!.title);
      // 与管理器一致：「（实验）」改成小标签，说明里要求重启的加「需重启」。
      const experimental = /\s*(?:（实验性?）|\(experimental\))$/i;
      const needsRestart = item.restart === true || /重启 ?Codex|重新启动 ?Codex|下次启动 ?Codex|restart(?:ing)? Codex|relaunch/i.test(item.descriptionWhenEnhancementsOn ?? item.description);
      assert.equal(row.title, item.title.replace(experimental, ""));
      assert.deepEqual(row.tags, [...(experimental.test(item.title) ? ["实验"] : []), ...(needsRestart ? ["需重启"] : [])], `${item.key} 标签`);
      assert.equal(row.description, item.descriptionWhenEnhancementsOn ?? item.description);
      if (item.control === "bool") {
        assert.ok(row.control.includes(`role="switch" aria-checked="false" aria-label="${item.title}"`), `${item.key} 开关缺少读屏标签`);
        assert.match(row.control, /data-codex-plus-setting="[^"]+"|data-codex-backend-setting="[^"]+"/);
      }
      for (const input of item.codexInputs ?? []) {
        assert.ok(row.control.includes(`aria-label="${input.label}"`), `${item.key} 缺少行内输入框 ${input.id}`);
      }
    }
    // 第一组最前面固定是后端连接状态，它不是设置项。
    assert.match(sections[0].rows[0].control, /data-codex-backend-status="true"/);
    // 能映射到本页 key 的走 setCodexPlusSetting，其余直接写后端字段。
    assert.doesNotMatch(html, /data-codex-plus-setting="answerOutline"/);
    assert.doesNotMatch(html, /data-codex-plus-setting="markdownExport"/);
    assert.doesNotMatch(html, /data-codex-plus-capacity-retry-/);
    assert.doesNotMatch(html, /data-codex-plus-conversation-view-width=/);
    // 管理器专属项不出现在 Codex 设置页。
    for (const item of catalog.items.filter((candidate) => !candidate.surfaces.includes("codex"))) {
      assert.ok(!html.includes(item.title), `${item.key} 只在管理器显示`);
    }
  });

  it("按清单的平台限制过滤设置项", async () => {
    const catalog = await readCatalog();
    const limited = catalog.items;
    for (const [platform, flags] of [["windows", { windows: true, mac: false }], ["macos", { windows: false, mac: true }], ["linux", { windows: false, mac: false }]] as const) {
      const page = await settingsCatalogRuntime(async () => catalog, flags);
      await page.load();
      const html = page.sections();
      for (const item of limited) {
        assert.equal(html.includes(`data-codex-plus-setting-row="${item.key}"`), item.surfaces.includes("codex") && (!item.platforms || item.platforms.includes(platform)), `${item.key} on ${platform}`);
      }
    }
  });

  it("读不到清单时给出原因和重试，不退回写死的副本", async () => {
    const catalog = await readCatalog();
    let response: unknown = { status: "failed", message: "Unknown bridge path" };
    const page = await settingsCatalogRuntime(async () => response);
    const loading = page.sections();
    assert.match(loading, /data-codex-plus-settings-catalog-state="loading"/);
    assert.match(loading, /data-codex-backend-status="true"/);
    await page.load();
    assert.equal(page.status().status, "failed");
    const failed = page.sections();
    assert.match(failed, /data-codex-plus-settings-catalog-state="failed" role="alert"/);
    assert.match(failed, /Unknown bridge path/);
    assert.match(failed, /data-codex-plus-settings-catalog-retry="true"/);
    assert.match(failed, /data-codex-backend-status="true"/, "后端连接状态在失败时也要能看到");
    for (const item of catalog.items) assert.ok(!failed.includes(item.title), "失败时不能显示任何兜底的设置副本");
    assert.deepEqual(page.diagnostics.map((entry) => entry.name), ["settings_catalog_load_failed"]);
    assert.ok(page.refreshes() >= 1);

    response = { groups: "broken" };
    await page.load();
    assert.equal(page.status().status, "failed");
    assert.match(page.sections(), /格式不正确/);

    response = catalog;
    await page.load();
    assert.equal(page.status().status, "ok");
    assert.match(page.sections(), /data-codex-plus-setting-row="enhancementsEnabled"/);

    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    assert.match(renderer, /if \(target\?\.closest\("\[data-codex-plus-settings-catalog-retry\]"\)\) \{\s*void loadCodexPlusSettingsCatalog\(\);/);
  });

  it("清单路由只读且不开放给拓展", async () => {
    const api = await readFile(new URL("91-extension-api.js", fragmentDir), "utf8");
    const start = api.indexOf("const codexPlusExtensionRoutes = new Set([");
    const whitelist = api.slice(start, api.indexOf("]);", start));
    assert.ok(whitelist.length > 0);
    assert.doesNotMatch(whitelist, /\/settings\/catalog/);
    const settingsPage = await readFile(new URL("40-backend-settings.js", fragmentDir), "utf8");
    assert.match(settingsPage, /postJson\("\/settings\/catalog", \{\}\)/);
  });
});

/**
 * 插件运行时内核（91-extension-runtime.js）。
 *
 * 内核承诺「ctx 上的注册随实例卸载自动撤销」，这是热重载不残留旧实例的前提；
 * waterfall 的短路、出错跳过语义是宿主后续挂协议中间件的基础，都要守住。
 */
describe("拓展运行时内核", () => {
  async function kernel(options: { scriptKey?: string; manifest?: unknown; initializing?: boolean } = {}) {
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/91-extension-runtime.js", import.meta.url), "utf8",
    );
    const scriptKey = options.scriptKey ?? "user:demo";
    const cleanups: Array<() => void> = [];
    const failures: Array<{ scriptKey: string; message: string }> = [];
    const registered: Array<{ kind: string; scriptKey: string; disposed: boolean }> = [];
    const calls: string[] = [];
    const toasts: string[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const window = {
      __codexPlusUserScripts: {
        currentKey: options.initializing === false ? null : scriptKey,
        scripts: { [scriptKey]: { manifest: options.manifest ?? null } },
        registerCleanup: (fn: () => void) => cleanups.push(fn),
      },
      setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; },
      clearInterval: (id: number) => timers.delete(id),
    };
    const register = (kind: string, itemOptions: { scriptKey: string }) => {
      const item = { kind, scriptKey: itemOptions.scriptKey, disposed: false };
      registered.push(item);
      return () => { item.disposed = true; };
    };
    const store = new Map<string, string>();
    const localStorage = {
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    };
    const api = new Function(
      "window", "runCodexPlusExtensionCallback", "codexPlusMarkExtensionFailure", "codexPlusCurrentExtensionScriptKey",
      "codexPlusRegisterExtensionItem", "codexPlusRegisterExtensionPage", "codexPlusRegisterExtensionSidePanel", "codexPlusRegisterExtensionSlot", "codexPlusRegistry", "codexPlusExtensionCall", "showToast", "localStorage",
      `${source}\nreturn { create: codexPlusCreateExtension, waterfall: codexPlusRunWaterfall, emit: codexPlusEmitExtensionEvent, instances: codexPlusExtensionInstances, bridge: installCodexExtensionEventBridge, requestMiddleware: codexPlusApplyExtensionRequestMiddleware, services: codexPlusServices, installBuiltins: installCodexPlusBuiltinServices, sessionItem: codexPlusSessionItem, sessionsCall: codexPlusSessionsCall };`,
    )(
      window,
      (key: string, label: string, callback: () => unknown) => {
        try {
          return { ok: true, value: callback() };
        } catch (error) {
          failures.push({ scriptKey: key, message: `${label}: ${(error as Error).message}` });
          return { ok: false, error: String(error) };
        }
      },
      (key: string, message: string) => failures.push({ scriptKey: key, message }),
      (itemOptions?: { scriptKey?: string }) => itemOptions?.scriptKey || window.__codexPlusUserScripts.currentKey || "",
      (kind: string, _registry: unknown, _definition: unknown, itemOptions: { scriptKey: string }) => register(kind, itemOptions),
      (_definition: unknown, itemOptions: { scriptKey: string }) => register("page", itemOptions),
      (_definition: unknown, itemOptions: { scriptKey: string }) => {
        const dispose = register("sidePanel", itemOptions) as (() => void) & { open?: () => boolean; close?: () => boolean; toggle?: () => boolean };
        dispose.open = () => { calls.push("sidePanel.open"); return true; };
        dispose.close = () => { calls.push("sidePanel.close"); return true; };
        dispose.toggle = () => true;
        return dispose;
      },
      (_definition: unknown, itemOptions: { scriptKey: string }) => {
        const dispose = register("slot", itemOptions) as (() => void) & { refresh?: () => void };
        dispose.refresh = () => { calls.push("slot.refresh"); };
        return dispose;
      },
      { rowActions: new Map(), navEntries: new Map(), menuItems: new Map(), composerActions: new Map() },
      (route: string) => { calls.push(route); return Promise.resolve({ status: "ok" }); },
      (message: string) => toasts.push(message),
      localStorage,
    ) as { create: (...args: any[]) => any; waterfall: (name: string, value: unknown) => any; emit: (event: string, args: unknown[]) => void; instances: Set<unknown>;
      bridge: (dispatcher: unknown) => boolean; requestMiddleware: (method: string, params: unknown) => any;
      services: Map<string, { value: unknown; owner: string }>; installBuiltins: () => void;
      sessionItem: (entry: unknown) => any; sessionsCall: (name: string, params?: unknown) => Promise<unknown> };
    return { ...api, window, cleanups, failures, registered, calls, toasts, timers, store };
  }

  it("卸载时按注册逆序撤销全部副作用，归属绑定到当前脚本", async () => {
    const k = await kernel();
    const order: string[] = [];
    const listeners: string[] = [];
    const target = {
      addEventListener: (type: string) => listeners.push(`+${type}`),
      removeEventListener: (type: string) => listeners.push(`-${type}`),
    };
    const ctx = k.create((ctx: any) => {
      ctx.effect(() => () => order.push("first"));
      ctx.registerPage({ title: "页" });
      ctx.registerRowAction({ onActivate() {} });
      ctx.listen(target, "focus", () => {});
      ctx.setInterval(() => {}, 1000);
      ctx.effect(() => () => order.push("last"));
    });
    assert.equal(ctx.id, "user:demo");
    assert.deepEqual(k.registered.map((item) => [item.kind, item.scriptKey]), [["page", "user:demo"], ["rowAction", "user:demo"]]);
    assert.equal(k.timers.size, 1);
    // 同步初始化期间创建：已登记到用户脚本运行时，热重载时整体卸载。
    assert.equal(k.cleanups.length, 1);
    k.cleanups[0]();
    assert.deepEqual(order, ["last", "first"]);
    assert.ok(k.registered.every((item) => item.disposed));
    assert.deepEqual(listeners, ["+focus", "-focus"]);
    assert.equal(k.timers.size, 0);
    assert.equal(ctx.disposed, true);
    assert.equal(k.instances.size, 0);
    ctx.dispose();
    assert.deepEqual(order, ["last", "first"], "重复卸载不再执行撤销");
    // 卸载后的注册立刻撤销，不会泄漏。
    let late = false;
    ctx.effect(() => () => { late = true; });
    assert.equal(late, true);
  });

  it("ctx.onScan 把扫描步骤登记在拓展名下，run() 立即跑一次，抛错只记在拓展名下，卸载时撤销", async () => {
    const k = await kernel();
    const steps = new Map<number, { owner: string; step: () => void; phase?: string }>();
    let seq = 0;
    (globalThis as any).registerCodexPlusScanStep = (owner: string, step: () => void, phase?: string) => {
      const id = ++seq;
      steps.set(id, { owner, step, phase });
      return () => steps.delete(id);
    };
    try {
      let runs = 0;
      let handle: any;
      const ctx = k.create((ctx: any) => {
        handle = ctx.onScan(() => { runs += 1; }, { phase: "light" });
        ctx.onScan(() => { throw new Error("坏步骤"); });
      });
      assert.deepEqual([...steps.values()].map((entry) => [entry.owner, entry.phase]), [["user:demo", "light"], ["user:demo", undefined]]);
      handle.run();
      assert.equal(runs, 1);
      for (const entry of steps.values()) entry.step();
      assert.equal(runs, 2);
      assert.ok(k.failures.some((failure) => failure.scriptKey === "user:demo" && /onScan: 坏步骤/.test(failure.message)));
      assert.throws(() => ctx.onScan("不是函数"), /onScan 需要一个函数/);
      ctx.dispose();
      assert.equal(steps.size, 0, "卸载时扫描步骤撤掉");
      handle.run();
      assert.equal(runs, 2, "卸载后 run() 不再执行");
    } finally {
      delete (globalThis as any).registerCodexPlusScanStep;
    }
  });

  it("提前撤销只撤销那一项；撤销抛错不中断其余撤销", async () => {
    const k = await kernel();
    const order: string[] = [];
    const ctx = k.create((ctx: any) => {
      ctx.effect(() => () => order.push("a"));
      const revoke = ctx.effect(() => () => order.push("b"));
      ctx.effect(() => () => { throw new Error("坏撤销"); });
      revoke();
    });
    assert.deepEqual(order, ["b"]);
    ctx.dispose();
    assert.deepEqual(order, ["b", "a"]);
    assert.match(k.failures[0].message, /坏撤销/);
  });

  it("await 之后创建的实例不登记热重载清理", async () => {
    const k = await kernel({ initializing: false });
    const ctx = k.create({ id: "late", apply() {} }, { scriptKey: "user:demo" });
    assert.equal(ctx.id, "late");
    assert.equal(k.cleanups.length, 0);
  });

  it("事件总线：处理器互相隔离，卸载后不再收到；广播生命周期事件", async () => {
    const k = await kernel();
    const seen: string[] = [];
    const lifecycle: string[] = [];
    k.create((ctx: any) => {
      ctx.on("extension/apply", (info: { id: string }) => lifecycle.push(`apply:${info.id}`));
      ctx.on("extension/dispose", (info: { id: string }) => lifecycle.push(`dispose:${info.id}`));
    }, { id: "observer" });
    const emitter = k.create((ctx: any) => {
      ctx.on("ping", () => { throw new Error("坏处理器"); });
      ctx.on("ping", (value: string) => seen.push(value));
    }, { id: "emitter" });
    emitter.emit("ping", "1");
    assert.deepEqual(seen, ["1"]);
    assert.equal(k.failures.length, 1);
    emitter.dispose();
    k.emit("ping", ["2"]);
    assert.deepEqual(seen, ["1"]);
    // apply 事件在 apply 返回后广播，拓展自己也能收到。
    assert.deepEqual(lifecycle, ["apply:observer", "apply:emitter", "dispose:emitter"]);
  });

  it("waterfall：按 order 串联、可短路、出错跳过且下游只执行一次", async () => {
    const k = await kernel();
    assert.equal(k.waterfall("greet", "hi"), "hi", "没有中间件时原样返回");
    let downstreamRuns = 0;
    const ctx = k.create((ctx: any) => {
      ctx.intercept("greet", (value: string, next: (v: string) => string) => next(`${value}!`), { order: 10 });
      ctx.intercept("greet", (value: string, next: (v: string) => string) => next(`<${value}>`), { order: -1 });
      ctx.intercept("greet", (value: string) => { downstreamRuns++; return `${value}#`; }, { order: 20 });
    });
    assert.equal(ctx.waterfall("greet", "hi"), "<hi>!#");
    const short = k.create((ctx: any) => ctx.intercept("greet", () => "stop", { order: -5 }));
    assert.equal(k.waterfall("greet", "hi"), "stop");
    short.dispose();
    const broken = k.create((ctx: any) => {
      ctx.intercept("greet", () => { throw new Error("前置出错"); }, { order: -9 });
      ctx.intercept("greet", (value: string, next: (v: string) => string) => { next(value); throw new Error("后置出错"); }, { order: 15 });
    });
    downstreamRuns = 0;
    assert.equal(k.waterfall("greet", "hi"), "<hi>!#");
    assert.equal(downstreamRuns, 1, "已调过 next 的中间件出错时沿用下游结果");
    assert.equal(k.failures.length, 2);
    broken.dispose();
    ctx.dispose();
    assert.equal(k.waterfall("greet", "hi"), "hi");
  });

  it("waterfall：异步中间件 reject 时跳过它", async () => {
    const k = await kernel();
    k.create((ctx: any) => {
      ctx.intercept("load", async () => { throw new Error("异步出错"); });
      ctx.intercept("load", async (value: number, next: (v: number) => unknown) => next(value + 1), { order: 5 });
    });
    assert.equal(await k.waterfall("load", 1), 2);
    assert.match(k.failures[0].message, /异步出错/);
  });

  it("拓展包只能调清单声明的路由，单文件脚本沿用全局白名单", async () => {
    const k = await kernel({ manifest: { id: "pkg", permissions: { routes: ["/diagnostics/log"] } } });
    const ctx = k.create(() => {});
    assert.equal(ctx.id, "pkg");
    assert.equal(ctx.manifest.id, "pkg");
    await ctx.call("/diagnostics/log", {});
    await assert.rejects(ctx.call("/thread-usage-history", {}), /未在 codexpp\.json 声明路由权限/);
    assert.deepEqual(k.calls, ["/diagnostics/log"]);
    const script = await kernel();
    await script.create(() => {}).call("/thread-usage-history", {});
    assert.deepEqual(script.calls, ["/thread-usage-history"]);
  });

  it("apply 同步抛错时回滚已做的注册并抛给调用方；异步失败也回滚", async () => {
    const k = await kernel();
    assert.throws(() => k.create((ctx: any) => {
      ctx.registerPage({ title: "半成品" });
      throw new Error("初始化失败");
    }), /初始化失败/);
    assert.equal(k.registered[0].disposed, true);
    assert.equal(k.instances.size, 0);
    const ctx = k.create(async (ctx: any) => {
      ctx.registerMenuItem({ onActivate() {} });
      await Promise.resolve();
      throw new Error("异步初始化失败");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.disposed, true);
    assert.equal(k.registered[1].disposed, true);
    assert.match(k.failures.at(-1)!.message, /异步初始化失败/);
  });

  it("codex/request 中间件：没挂时原样返回同一对象；能改 params；异步或抛错时放行", async () => {
    const k = await kernel();
    const params = { input: [{ type: "text", text: "你好" }] };
    assert.equal(k.requestMiddleware("turn/start", params), params, "没有中间件时必须是同一个对象");
    const ctx = k.create((ctx: any) => ctx.intercept("codex/request", (value: any, next: (v: any) => any) =>
      next(value.method === "turn/start" ? { ...value, method: "evil", params: { ...value.params, prefixed: true } } : value)));
    const changed = k.requestMiddleware("turn/start", params);
    assert.notEqual(changed, params);
    assert.equal(changed.prefixed, true);
    assert.equal(k.requestMiddleware("thread/start", params), params, "其它请求不受影响");
    ctx.dispose();
    k.create((ctx: any) => ctx.intercept("codex/request", async (value: any) => value));
    assert.equal(k.requestMiddleware("turn/start", params), params, "异步中间件被放行");
    assert.equal(k.requestMiddleware("x", undefined), undefined);
  });

  it("会话事件桥：订阅固定通知并转成 codex/<method>，换分发器时退订旧的", async () => {
    const k = await kernel();
    const makeDispatcher = () => {
      const handlers = new Map<string, (params: unknown) => void>();
      let unsubscribed = 0;
      return { handlers, unsubscribed: () => unsubscribed,
        subscribe: (method: string, handler: (params: unknown) => void) => { handlers.set(method, handler); return () => { unsubscribed++; }; } };
    };
    const first = makeDispatcher();
    assert.equal(k.bridge(first), true);
    assert.equal(k.bridge(first), true, "同一个分发器幂等");
    assert.ok(first.handlers.has("turn/completed") && first.handlers.has("item/completed"));
    const seen: unknown[] = [];
    k.create((ctx: any) => ctx.on("codex/turn/completed", (params: unknown, meta: unknown) => seen.push([params, meta])));
    first.handlers.get("turn/completed")!({ turn: { status: "completed" } });
    assert.deepEqual(seen, [[{ turn: { status: "completed" } }, { method: "turn/completed" }]]);
    const second = makeDispatcher();
    k.bridge(second);
    assert.equal(first.unsubscribed(), first.handlers.size, "旧分发器的订阅全部退掉");
    assert.equal(k.bridge(null), false);
  });

  it("ctx.storage 按拓展 id 隔离，值按 JSON 存取", async () => {
    const k = await kernel({ manifest: { id: "pkg-a" } });
    const ctx = k.create(() => {});
    ctx.storage.set("count", 3);
    ctx.storage.set("list", [1, 2]);
    assert.equal(ctx.storage.get("count"), 3);
    assert.deepEqual(ctx.storage.get("list"), [1, 2]);
    assert.equal(ctx.storage.get("missing", "fallback"), "fallback");
    assert.deepEqual([...k.store.keys()], ["codexpp:ext:pkg-a:count", "codexpp:ext:pkg-a:list"]);
    assert.deepEqual(ctx.storage.keys().sort(), ["count", "list"]);
    ctx.storage.remove("count");
    assert.equal(ctx.storage.get("count"), null);
  });

  it("ctx.backend：call 走桥接带上本脚本 key，on 长轮询分发事件，卸载后停止", async () => {
    const k = await kernel({ scriptKey: "user:pkg-b" });
    const requests: Array<[string, any]> = [];
    let eventsServed = 0;
    let release: (() => void) | null = null;
    (k.window as any).__codexSessionDeleteBridge = (path: string, payload: any) => {
      requests.push([path, payload]);
      if (path === "/extensions/backend/call") {
        return Promise.resolve(payload.method === "boom" ? { status: "failed", message: "后台坏了" } : { status: "ok", result: { echo: payload.params } });
      }
      eventsServed++;
      if (eventsServed === 1) return Promise.resolve({ status: "ok", running: true, next: 2, events: [{ seq: 2, event: "tick", payload: { n: 1 } }] });
      return new Promise((resolve) => { release = () => resolve({ status: "ok", running: true, next: 2, events: [] }); });
    };
    const seen: unknown[] = [];
    const ctx = k.create(() => {});
    assert.deepEqual(await ctx.backend.call("add", { x: 1 }, { timeout: 5000 }), { echo: { x: 1 } });
    const instance = requests[0][1].instance;
    assert.match(instance, /^[a-z0-9]+-[a-z0-9]+$/);
    assert.deepEqual(requests[0], ["/extensions/backend/call", { key: "user:pkg-b", instance, method: "add", params: { x: 1 }, timeoutMs: 5000 }]);
    await assert.rejects(ctx.backend.call("boom"), /后台坏了/);
    ctx.backend.on("tick", (payload: unknown, meta: unknown) => seen.push(["tick", payload, meta]));
    ctx.backend.on("*", (payload: unknown) => seen.push(["*", payload]));
    for (let i = 0; i < 5 && eventsServed < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [["tick", { n: 1 }, { event: "tick" }], ["*", { n: 1 }]]);
    const polls = requests.filter(([path]) => path === "/extensions/backend/events");
    assert.equal(polls.length, 2, "两个订阅共用一条轮询");
    assert.deepEqual(polls[1][1], { key: "user:pkg-b", instance, since: 2, waitMs: 20000 });
    ctx.dispose();
    release!();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.filter(([path]) => path === "/extensions/backend/events").length, 2, "卸载后不再轮询");
    assert.deepEqual(requests.filter(([path]) => path === "/extensions/backend/stop"), [["/extensions/backend/stop", { key: "user:pkg-b", instance }]], "用过后台的实例卸载时通知停止");
  });

  it("消息按钮、消息装饰、侧边面板随实例卸载撤销；面板句柄带 open / close", async () => {
    const k = await kernel();
    let panel: any;
    const ctx = k.create((ctx: any) => {
      ctx.registerMessageAction({ label: "朗读", onActivate() {} });
      ctx.registerMessageDecoration({ roles: ["assistant"], render() {} });
      panel = ctx.registerSidePanel({ title: "笔记", render() {} });
    });
    assert.deepEqual(k.registered.map((item) => item.kind), ["messageAction", "messageDecoration", "sidePanel"]);
    assert.ok(k.registered.every((item) => item.scriptKey === "user:demo"));
    assert.equal(panel.open(), true);
    assert.equal(panel.close(), true);
    assert.deepEqual(k.calls, ["sidePanel.open", "sidePanel.close"]);
    ctx.dispose();
    assert.ok(k.registered.every((item) => item.disposed), "卸载时三项都撤销");
  });

  it("ctx.registerSlot 随实例卸载撤销，句柄带 refresh；未知位置报错", async () => {
    const k = await kernel();
    let slot: any;
    const ctx = k.create((ctx: any) => { slot = ctx.registerSlot({ slot: "composer.above", render() {} }); });
    assert.equal(k.registered.at(-1)?.kind, "slot");
    slot.refresh();
    assert.deepEqual(k.calls, ["slot.refresh"]);
    ctx.dispose();
    assert.equal(k.registered.at(-1)?.disposed, true);
    const source = await readFile(new URL("../../../assets/inject/renderer-inject/92-extension-slots.js", import.meta.url), "utf8");
    assert.match(source, /未知的插槽位置/);
    for (const name of ["composer.above", "thread.top", "thread.bottom", "sidebar.top", "sidebar.bottom", "titlebar"]) {
      assert.ok(source.includes(`"${name}"`), name);
    }
  });

  it("插槽节点都带拓展标记，消息观察器排除自己的写入，扫描每轮补齐插槽", async () => {
    const slots = await readFile(new URL("../../../assets/inject/renderer-inject/92-extension-slots.js", import.meta.url), "utf8");
    const scan = await readFile(new URL("../../../assets/inject/renderer-inject/95-conversation-view.js", import.meta.url), "utf8");
    for (const created of slots.matchAll(/const (\w+) = document\.createElement\("(?:span|div|button|aside|style)"\);/g)) {
      assert.match(slots, new RegExp(`markCodexPlusExtensionNode\\(${created[1]},`), `${created[1]} 没有拓展标记，会触发扫描自喂`);
    }
    assert.match(slots, /function codexPlusMutationIsOurs/);
    assert.match(slots, /if \(mutations\.some\(\(mutation\) => !codexPlusMutationIsOurs\(mutation\)\)\)/);
    assert.match(scan, /refreshCodexPlusMessageSlots\(\);\n\s+refreshCodexPlusSidePanels\(\);/);
  });

  it("服务：inject 的拓展等依赖齐全才应用，提供者卸载即卸载、换提供者后重新应用", async () => {
    const k = await kernel();
    const seen: string[] = [];
    const consumer = k.create({
      inject: ["metrics"],
      apply(ctx: any) {
        seen.push(`apply:${ctx.metrics.name}`);
        ctx.effect(() => () => seen.push("dispose"));
      },
    });
    assert.equal(consumer.state, "pending", "依赖没到时挂起，不报错");
    assert.deepEqual(seen, []);
    const first = k.create((ctx: any) => { ctx.provide("metrics", { name: "一号" }); });
    assert.equal(consumer.state, "active");
    assert.deepEqual(seen, ["apply:一号"]);
    assert.equal(k.services.get("metrics")?.owner, "user:demo");
    assert.throws(() => k.create((ctx: any) => ctx.provide("metrics", {})), /已由 user:demo 提供/);
    first.dispose();
    assert.equal(consumer.state, "pending");
    assert.deepEqual(seen, ["apply:一号", "dispose"], "提供者卸载，依赖方随之卸载");
    k.create((ctx: any) => { ctx.provide("metrics", { name: "二号" }); });
    assert.deepEqual(seen, ["apply:一号", "dispose", "apply:二号"], "提供者回来后自动重新应用");
    consumer.dispose();
    assert.equal(consumer.state, "disposed");
    assert.deepEqual(seen.at(-1), "dispose");
  });

  it("服务：ctx.get 做可选依赖，ctx.inject 开子作用域，apply 里提供服务不会重复应用", async () => {
    const k = await kernel();
    let child = 0;
    const ctx = k.create((ctx: any) => {
      assert.equal(ctx.get("cache"), undefined, "可选依赖不存在时为 undefined");
      ctx.inject(["cache"], (sub: any) => { child += 1; assert.equal(sub.cache.size, 0); });
    });
    assert.equal(child, 0);
    // 依赖方自己在 apply 里提供另一个服务：触发复查也只应用一次。
    let applied = 0;
    k.create({ inject: ["cache"], apply(sub: any) { applied += 1; sub.provide("derived", 1); } });
    k.create((provider: any) => provider.provide("cache", new Map()));
    assert.equal(child, 1);
    assert.equal(applied, 1, "重入时不重复应用");
    assert.equal(ctx.get("derived"), 1);
    assert.throws(() => ctx.provide("bad name", 1), /服务名不合法/);
  });

  it("服务：inject 对象写法的 required:false 是可选依赖，缺了也应用、提供方出现时重新应用", async () => {
    const k = await kernel();
    const seen: string[] = [];
    const consumer = k.create({
      inject: { metrics: { required: false }, store: true },
      apply(ctx: any) { seen.push(`apply:${ctx.metrics?.name ?? "无"}`); },
    });
    assert.equal(consumer.state, "pending", "必需依赖 store 没到");
    k.create((ctx: any) => ctx.provide("store", {}));
    assert.deepEqual(seen, ["apply:无"], "可选依赖缺了照样应用");
    const provider = k.create((ctx: any) => ctx.provide("metrics", { name: "一号" }));
    assert.deepEqual(seen, ["apply:无", "apply:一号"], "可选依赖出现时重新应用");
    provider.dispose();
    assert.deepEqual(seen.at(-1), "apply:无", "可选依赖消失时退回无依赖的应用");
    assert.equal(consumer.state, "active");
  });

  it("ready 在 apply（含异步部分）完成后调用，extension/apply 随后广播；异步 effect 卸载时也撤销", async () => {
    const k = await kernel();
    const seen: string[] = [];
    k.create((ctx: any) => ctx.on("extension/apply", ({ id }: any) => id === "late" && seen.push("broadcast")));
    let release: () => void = () => {};
    const ctx = k.create({
      id: "late",
      async apply(ctx: any) {
        ctx.on("ready", () => seen.push("ready"));
        ctx.on("dispose", () => seen.push("dispose-event"));
        ctx.effect(async () => () => seen.push("async-dispose"));
        await new Promise<void>((done) => { release = done; });
        seen.push("applied");
      },
    });
    assert.deepEqual(seen, [], "apply 没完成前不算应用好");
    release();
    await new Promise((done) => setTimeout(done, 0));
    assert.deepEqual(seen, ["applied", "broadcast", "ready"]);
    let late = 0;
    ctx.on("ready", () => { late += 1; });
    await Promise.resolve();
    assert.equal(late, 1, "已经 ready 时注册的监听器立即调用");
    ctx.dispose();
    const after: string[] = seen;
    assert.ok(after.includes("async-dispose") && after.includes("dispose-event"), after.join(","));
  });

  it("清单声明 instances 时按实例各应用一次：配置叠上实例配置，id 与注册项都带实例", async () => {
    const k = await kernel({ manifest: { id: "multi", config: { label: "默认", size: 1 }, instances: [{ id: "work", name: "工作", config: { label: "工作区" } }, { id: "home", name: "home", config: {} }] } });
    const seen: string[] = [];
    k.create((ctx: any) => {
      seen.push(`${ctx.id}|${ctx.instance?.id}|${ctx.config.label}|${ctx.config.size}`);
      ctx.registerPage({ title: ctx.config.label, render() {} }, { id: "main" });
    });
    assert.deepEqual(seen, ["multi#work|work|工作区|1", "multi#home|home|默认|1"]);
    assert.equal(k.registered.filter((item: any) => item.kind === "page" && !item.disposed).length, 2, "两份的页面互不顶掉");
  });

  it("配置原地更新：实例都用 onConfigUpdate 接住时不重载，任何一个没接就整体热重载", async () => {
    const k = await kernel({ manifest: { id: "cfg", config: { size: 1 } } });
    const seen: string[] = [];
    const ctx = k.create((ctx: any) => {
      ctx.onConfigUpdate((next: any, prev: any) => { seen.push(`${prev.size}->${next.size}`); return true; });
    });
    const update = (k.window as any).__codexPlusUserScripts.updateConfig;
    assert.equal(update("user:demo", { size: 2 }), "applied");
    assert.equal(ctx.config.size, 2, "ctx.config 换成新值");
    assert.deepEqual(seen, ["1->2"]);
    assert.equal((k.window as any).__codexPlusUserScripts.scripts["user:demo"].manifest.config.size, 2, "之后新建的实例也读到新配置");
    k.create(() => {});
    assert.equal(update("user:demo", { size: 3 }), "reload", "有实例没接就整体热重载");
    assert.equal(update("user:nobody", { size: 3 }), "reload");
  });

  it("内置 sessionQuery 服务：方法名对齐会话查询，参数经桥接转给 /extensions/history", async () => {
    const k = await kernel();
    const requests: Array<[string, any]> = [];
    (k.window as any).__codexSessionDeleteBridge = (path: string, payload: any) => {
      requests.push([path, payload]);
      return Promise.resolve(payload.method === "readTitle" ? { status: "failed", message: "没有找到会话" } : { status: "ok", result: [payload.method] });
    };
    k.installBuiltins();
    assert.equal(k.services.get("sessionQuery")?.owner, "builtin");
    let query: any;
    k.create({ inject: ["sessionQuery"], apply(ctx: any) { query = ctx.sessionQuery; } });
    assert.deepEqual(await query.listSessions({ limit: 5 }), ["listSessions"]);
    await query.listEvents("t-1", { types: ["user/message"] });
    await query.searchSessions({ query: "bug" });
    await assert.rejects(query.readTitle("x"), /没有找到会话/);
    assert.deepEqual(requests.map(([path, payload]) => [path, payload.method, payload.params]), [
      ["/extensions/history", "listSessions", { limit: 5 }],
      ["/extensions/history", "listEvents", { id: "t-1", options: { types: ["user/message"] } }],
      ["/extensions/history", "searchSessions", { query: "bug" }],
      ["/extensions/history", "readTitle", { id: "x" }],
    ]);
    assert.ok(Object.isFrozen(query));
  });

  it("sessionQuery.project 折叠事件；observeSession 从末尾开始增量推送，撤销后停止", async () => {
    const k = await kernel();
    const log = [{ type: "user/message", seq: 0, data: { text: "a" } }, { type: "assistant/message", seq: 1, data: { text: "bb" } }];
    const calls: string[] = [];
    (k.window as any).__codexSessionDeleteBridge = (_path: string, payload: any) => {
      calls.push(payload.method);
      if (payload.method === "readSession") return Promise.resolve({ status: "ok", result: { session: {}, events: log } });
      if (payload.method === "listEvents") return Promise.resolve({ status: "ok", result: [log.at(-1)] });
      if (payload.method === "readEventsSince") return Promise.resolve({ status: "ok", result: log.filter((event) => event.seq >= payload.params.seq) });
      return Promise.resolve({ status: "ok", result: null });
    };
    k.installBuiltins();
    const query: any = k.services.get("sessionQuery")!.value;
    const total = await query.project("t-1", { init: () => ({ chars: 0 }), apply: (state: any, event: any) => ({ chars: state.chars + event.data.text.length }) });
    assert.deepEqual(total, { chars: 3 });
    await assert.rejects(query.project("t-1", {}), /apply/);

    const seen: number[] = [];
    const stop = query.observeSession("t-1", (event: any) => seen.push(event.seq), { intervalMs: 500 });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    assert.deepEqual(seen, [], "默认从末尾开始，不回放历史");
    log.push({ type: "user/message", seq: 2, data: { text: "ccc" } });
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.deepEqual(seen, [2], "新事件增量推送");
    stop();
    log.push({ type: "assistant/message", seq: 3, data: { text: "d" } });
    await new Promise((resolve) => setTimeout(resolve, 560));
    assert.deepEqual(seen, [2], "撤销后不再推送");
  });

  it("后台服务：注入包下发的清单登记成页面服务，方法经桥接调用，清单变化时增删", async () => {
    const k = await kernel();
    const requests: any[] = [];
    (k.window as any).__codexSessionDeleteBridge = (path: string, payload: any) => {
      requests.push([path, payload]);
      return Promise.resolve(payload.method === "fail" ? { status: "failed", message: "后台报错" } : { status: "ok", result: payload.args.length });
    };
    (k.window as any).__codexPlusBackendServices = [{ name: "metrics", key: "user:stats" }, { name: "bad name", key: "user:x" }];
    k.installBuiltins();
    assert.equal(k.services.get("metrics")?.owner, "backend:user:stats");
    assert.equal(k.services.has("bad name"), false);
    let metrics: any;
    const fiber = k.create({ inject: ["metrics"], apply(ctx: any) { metrics = ctx.metrics; } });
    assert.equal(fiber.state, "active");
    assert.equal(await metrics.record("a", 1), 2);
    assert.deepEqual(requests[0], ["/extensions/services/call", { name: "metrics", method: "record", args: ["a", 1] }]);
    await assert.rejects(metrics.fail(), /后台报错/);
    assert.equal(metrics.then, undefined, "代理不是 thenable，可以直接 await 拿到");
    (k.window as any).__codexPlusBackendServices = [];
    (k.window as any).__codexPlusSyncBackendServices();
    assert.equal(k.services.has("metrics"), false);
    assert.equal(fiber.state, "pending", "提供方撤掉，依赖方回到挂起");
  });

  it("codex/request 中间件挂在 createRequest 上：turn/start 绕过 sendRequest 也经过，且每个请求只跑一次", async () => {
    const source = await readFile(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
    const patch = source.match(/proto\.createRequest = function codexPlusPatchedCreateRequest\(method, params, \.\.\.rest\) \{[\s\S]*?\n      \};/);
    assert.ok(patch, "createRequest 补丁不在");
    assert.match(patch![0], /codexPlusApplyExtensionRequestMiddleware\(String\(method \|\| ""\), params\)/);
    assert.match(patch![0], /originalCreateRequest\.call\(this, method, nextParams, \.\.\.rest\)/);
    const send = source.match(/proto\.sendRequest = async function codexPlusModelPatchedSendRequest[\s\S]*?\n    \};/);
    assert.ok(send);
    assert.doesNotMatch(send![0], /codexPlusApplyExtensionRequestMiddleware/, "sendRequest 里不能再跑一次");
  });

  it("内置 sessions 服务：append 条目规整成 ResponseItem，只开放新建 / 分叉 / 改名 / 追加 / 发起 / 插话 / 中断 / 压缩 / 列表", async () => {
    const k = await kernel();
    k.installBuiltins();
    const sessions: any = k.services.get("sessions")?.value;
    assert.equal(k.services.get("sessions")?.owner, "builtin");
    assert.deepEqual(Object.keys(sessions).sort(), ["append", "compact", "create", "fork", "interrupt", "list", "rename", "startTurn", "steer"]);
    assert.ok(Object.isFrozen(sessions));
    assert.deepEqual(k.sessionItem("你好"), { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] });
    assert.deepEqual(k.sessionItem({ role: "assistant", text: "好的" }), { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] });
    assert.deepEqual(k.sessionItem({ role: "system", text: "x" }).role, "user", "未知角色按用户消息处理");
    const raw = { type: "function_call_output", call_id: "c1", output: "ok" };
    assert.equal(k.sessionItem(raw), raw, "已经是 ResponseItem 的原样保留");
    await assert.rejects(k.sessionsCall("delete", { id: "x" }), /没有方法 delete/);
  });

  it("ctx.locale：按命名空间登记词条，按语言链回退到 en、common、key，包内 locale 自动登记", async () => {
    const k = await kernel({ manifest: { id: "greeter", locales: { en: { meta: { title: "Greeter" }, hi: "Hello {name}" }, fr: { hi: "Bonjour {name}" } } } });
    const ctx = k.create(() => {});
    // 测试环境的语言是 Node 的 navigator.language（en-US）：zh 词条不会被选中。
    assert.match(ctx.locale.current, /^en/);
    assert.equal(ctx.locale.t("hi", { name: "Ada" }), "Hello Ada", "包内 locale 登记在拓展 id 命名空间");
    assert.equal(ctx.locale.t("meta.title"), "Greeter", "点号路径取嵌套词条");
    const dispose = ctx.locale.register("menu", { zh: { open: "打开" }, en: { open: "Open {what}", nested: { deep: "Deep" } } });
    const t = ctx.locale.bind("menu");
    assert.equal(t("open", { what: "file" }), "Open file");
    assert.equal(t("open"), "Open {what}", "缺参数时保留占位符");
    assert.equal(t("nested.deep"), "Deep");
    assert.equal(t("missing.key"), "missing.key", "都没有就返回 key");
    ctx.locale.register("common", "en", { cancel: "Cancel" });
    assert.equal(t("cancel"), "Cancel", "回退到 common 命名空间");
    dispose();
    assert.equal(t("open"), "open", "撤销登记后词条消失");
    assert.equal(ctx.locale.resolve({ zh: "你好", en: "Hello" }), "Hello");
    assert.equal(ctx.locale.resolve("原样"), "原样");
    ctx.dispose();
    assert.equal(k.create(() => {}).locale.t("hi"), "Hello {name}", "新实例重新登记包内词条");
  });

  it("内置 locale 服务：写成 inject: [\"locale\"] 的拓展也能用", async () => {
    const k = await kernel();
    k.installBuiltins();
    let t: any;
    const fiber = k.create({ inject: ["locale"], apply(ctx: any) {
      ctx.locale.register("demo", { en: { ok: "OK" }, zh: { ok: "好" } });
      t = ctx.locale.bind("demo");
    } });
    assert.equal(fiber.state, "active");
    assert.equal(t("ok"), "OK");
    assert.equal(k.services.get("locale")?.owner, "builtin");
  });

  it("ctx.asset：按包内路径取资源的 data URL，可省略 assets/ 前缀，找不到返回空串", async () => {
    const k = await kernel({ manifest: { id: "pet", assets: { "assets/pet.png": "data:image/png;base64,AAAA" } } });
    const ctx = k.create(() => {});
    assert.equal(ctx.asset("assets/pet.png"), "data:image/png;base64,AAAA");
    assert.equal(ctx.asset("./assets/pet.png"), "data:image/png;base64,AAAA");
    assert.equal(ctx.asset("pet.png"), "data:image/png;base64,AAAA");
    assert.equal(ctx.asset("assets/missing.png"), "");
    assert.equal((await kernel()).create(() => {}).asset("assets/pet.png"), "", "单文件脚本没有资源");
  });

  it("一次性定时器触发后自行注销，不留在撤销列表里", async () => {
    const k = await kernel();
    let fired = 0;
    const ctx = k.create((ctx: any) => ctx.setTimeout(() => { fired++; }, 10));
    const [[id, run]] = [...k.timers.entries()];
    k.timers.delete(id);
    run();
    assert.equal(fired, 1);
    ctx.dispose();
    assert.equal(fired, 1);
  });

  it("对外接口挂出 extension 入口并把清单放进 script", async () => {
    const api = await readFile(new URL("../../../assets/inject/renderer-inject/91-extension-api.js", import.meta.url), "utf8");
    assert.match(api, /extension: codexPlusCreateExtension,/);
    // 早期名称保留为别名，已有拓展不受影响。
    assert.match(api, /plugin: codexPlusCreateExtension,/);
    assert.match(api, /return \{ key, manifest: codexPlusExtensionManifest\(key\) \};/);
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    assert.ok(renderer.indexOf("function codexPlusCreateExtension(") < renderer.indexOf("window.codexPlus = buildCodexPlusExtensionApi();"));
  });
});

describe("功能页与原生弹出层的层级", () => {
  it("页面打开时连同弹出层的直接父容器一起提升，原生 tooltip 不被页面盖住", async () => {
    const style = await readFile(new URL("../../../assets/inject/renderer-inject/10-style.js", import.meta.url), "utf8");
    // 新版 Codex 把 tooltip 挂在 z-60 的固定视口容器里，只提升子节点逃不出该堆叠上下文（实测复现过）。
    assert.match(style, /html\[data-codex-plus-page-open\] div:has\(> \[data-radix-popper-content-wrapper\], > \[role="tooltip"\], > \[role="menu"\]\):not\(\.\$\{codexPlusPageClass\} \*\),/);
    const page = Number(/z-index: (\d+);\s*display: block;\s*background: var\(--codex-plus-bg-primary/.exec(style)?.[1]);
    const lifted = Number(/\.app-header-tint \{\s*z-index: (\d+) !important;/.exec(style)?.[1]);
    assert.ok(page > 0 && lifted > page, "提升后的弹出层必须高于功能页");
  });
});

describe("图标栏按钮的悬浮提示", () => {
  async function source() {
    return readFile(new URL("../../../assets/inject/renderer-inject/40-backend-settings.js", import.meta.url), "utf8");
  }
  async function finder() {
    const text = await source();
    const start = text.indexOf("  let codexPlusNativeTooltipClassCache;");
    const end = text.indexOf("  function hideCodexPlusRailTooltip()");
    assert.ok(start >= 0 && end > start, "找不到原生提示样式类的查找函数");
    return new Function("document", `${text.slice(start, end)}\nreturn codexPlusNativeTooltipClass;`)({ styleSheets: [] }) as (sheets: unknown[]) => string;
  }

  it("按独有的变体规则找出原生提示样式类，规则嵌在分组里也能找到", async () => {
    const find = await finder();
    const sheets = [
      { get cssRules(): never { throw new Error("跨域样式表不可读"); } },
      { cssRules: [{ selectorText: "._Tooltip_453y_1" }, { cssRules: [
        { selectorText: "._Tooltip_11i4f_2" },
        { selectorText: '._Tooltip_11i4f_2[data-side="bottom"][data-default-side-offset="true"]' },
      ] }] },
    ];
    assert.equal(find(sheets), "_Tooltip_11i4f_2");
  });

  it("找不到时返回空串（走兜底样式），且不缓存失败结果", async () => {
    const find = await finder();
    assert.equal(find([{ cssRules: [{ selectorText: "._Tooltip_453y_1" }] }]), "");
    assert.equal(find([{ cssRules: [{ selectorText: '._Tooltip_ab_9[data-side="bottom"][data-default-side-offset="true"]' }] }]), "_Tooltip_ab_9");
    // 找到后缓存，之后样式表变化不再重扫。
    assert.equal(find([]), "_Tooltip_ab_9");
  });

  it("按钮不用 title（会弹系统提示），改挂自绘提示；兜底样式与提升层级齐全", async () => {
    const text = await source();
    const create = text.slice(text.indexOf("  function createCodexPlusRailButton("), text.indexOf("  const codexPlusRailTooltipDelayMs"));
    assert.doesNotMatch(create, /setAttribute\("title"/);
    assert.match(create, /button\.removeAttribute\("title"\);\s*attachCodexPlusRailTooltip\(button, label\);/);
    assert.match(text, /markCodexPlusExtensionNode\(wrapper, "builtin-rail-tooltip"\)/, "提示节点必须带拓展标记，否则触发扫描自喂循环");
    const style = await readFile(new URL("../../../assets/inject/renderer-inject/10-style.js", import.meta.url), "utf8");
    assert.match(style, /\.codex-plus-rail-tooltip-fallback \{/);
  });
});

describe("extension rpc frame interception", () => {
  type Frame = unknown[];
  type Handler = (...args: any[]) => any;

  async function runtime() {
    const rpc = await readFile(
      new URL("../../../assets/inject/renderer-inject/91-extension-rpc.js", import.meta.url), "utf8",
    );
    const kernel = await readFile(
      new URL("../../../assets/inject/renderer-inject/91-extension-runtime.js", import.meta.url), "utf8",
    );
    // 用真实的 codex/request 链实现，保证两边语义一致。
    const waterfall = kernel.slice(kernel.indexOf("  function codexPlusIsThenable(value)"),
      kernel.indexOf("  /** 通知所有监听者"))
      + kernel.slice(kernel.indexOf("  function codexPlusRunWaterfall(name, value)"),
        kernel.indexOf("  /**\n   * Codex 会话事件"));
    assert.ok(waterfall.includes("function codexPlusRunWaterfall"));
    const sent: Frame[] = [];
    const toasts: string[] = [];
    const failures: string[] = [];
    class MessagePort {}
    (MessagePort.prototype as any).postMessage = function (message: Frame) { sent.push(message); };
    const window: Record<string, unknown> = { MessagePort };
    const listeners = new Map<string, Set<{ handler: Handler; scriptKey: string }>>();
    const interceptors = new Map<string, Array<{ handler: Handler; scriptKey: string; order: number; seq: number }>>();
    const api = new Function("window", "codexPlusExtensionListeners", "codexPlusExtensionInterceptors",
      "runCodexPlusExtensionCallback", "codexPlusMarkExtensionFailure", "showToast",
      `${waterfall}\n${rpc}\nreturn { codexPlusRpcDecode, codexPlusRpcEncode };`,
    )(
      window, listeners, interceptors,
      (_key: string, label: string, callback: () => unknown) => {
        try {
          return { ok: true, value: callback() };
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`);
          return { ok: false, error };
        }
      },
      (_key: string, message: string) => failures.push(message),
      (message: string) => toasts.push(message),
    );
    let seq = 0;
    const on = (name: string, handler: Handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add({ handler, scriptKey: "probe" });
    };
    const intercept = (name: string, handler: Handler) => {
      interceptors.set(name, [...(interceptors.get(name) || []), { handler, scriptKey: "probe", order: 0, seq: ++seq }]);
    };
    const port = new MessagePort() as { postMessage: (frame: Frame) => void };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { api, window, sent, toasts, failures, on, intercept, port, settle };
  }

  const settings = { model: "jojocodemax/gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null };
  const userText = { type: "text", text: "REQTEST hi\n", text_elements: [[{ start: 0, end: 7 }]] };
  // 宿主发起轮次前回调页面要参数：start.request 即 turn/start 参数，steer 是会话忙时的候选。
  function turnResolve(exportId: number, messageId = "m-1"): Frame {
    return ["resolve", exportId, {
      conversationId: "thread-1",
      resume: { conversationId: "thread-1", model: null, collaborationMode: { mode: "default", settings: { ...settings } } },
      steer: { input: [[{ ...userText }]], clientUserMessageId: messageId, restoreMessage: { text: "REQTEST hi" } },
      start: {
        request: {
          threadId: "thread-1", clientUserMessageId: messageId, input: [[{ ...userText }]], model: null, effort: null,
          collaborationMode: { mode: "default", settings: { ...settings } },
        },
        context: { onRequestDispatched: ["export", -799] },
      },
    }];
  }

  it("passes frames through synchronously when no extension listens", async () => {
    const env = await runtime();
    const frame = turnResolve(7);
    env.port.postMessage(frame);
    assert.equal(env.sent.length, 1);
    assert.equal(env.sent[0], frame, "the original frame object goes out untouched");
  });

  it("round-trips capnweb values and keeps tagged values opaque", async () => {
    const env = await runtime();
    const encoded = { list: [["a", [["b"]]]], cb: ["export", -3], empty: [[]], n: null };
    const decoded = env.api.codexPlusRpcDecode(encoded);
    assert.deepEqual(decoded.list, ["a", ["b"]]);
    assert.deepEqual(decoded.empty, []);
    assert.deepEqual(Object.keys(decoded.cb), [], "tagged tuples are not exposed as plain data");
    assert.deepEqual(env.api.codexPlusRpcEncode(decoded), encoded);
  });

  it("runs dsh agent/pre-step once per user message and rewrites both turn candidates", async () => {
    const env = await runtime();
    const seen: Array<{ method: string; text: string }> = [];
    let preSteps = 0;
    env.on("agent/pre-step", async ({ agent, step, messages }: any, next: () => Promise<any>) => {
      preSteps += 1;
      assert.equal(agent.session.id, "thread-1");
      assert.equal(step, 1);
      assert.equal(messages[0].role, "user");
      assert.equal(messages[0].content[0].text, "REQTEST hi\n");
      const decision = await next();
      return { ...decision, messages: [...decision.messages, { role: "user", content: [{ type: "text", text: "[time]" }] }] };
    });
    env.intercept("codex/request", (value: any, next: (v: unknown) => unknown) => {
      seen.push({ method: value.method, text: value.params.input.map((item: any) => item.text).join("|") });
      return next(value);
    });
    env.port.postMessage(turnResolve(7));
    const later: Frame = ["push", ["pipeline", -4, ["markRead"], ["thread-1"]]];
    env.port.postMessage(later);
    assert.equal(env.sent.length, 0, "frames after a pending rewrite wait for it");
    await env.settle();
    assert.equal(env.sent.length, 2);
    assert.equal(env.sent[1], later, "queued frames keep their order");
    const value = (env.sent[0] as any)[2];
    assert.equal(env.sent[0][0], "resolve");
    assert.equal(env.sent[0][1], 7);
    for (const input of [value.start.request.input, value.steer.input]) {
      assert.equal(input.length, 1, "arrays stay capnweb-encoded");
      assert.deepEqual(input[0][0], userText, "unchanged text keeps its text_elements");
      assert.deepEqual(input[0][1], { type: "text", text: "[time]", text_elements: [[]] });
    }
    assert.deepEqual(value.start.context.onRequestDispatched, ["export", -799]);
    assert.deepEqual(seen, [
      { method: "turn/start", text: "REQTEST hi\n|[time]" },
      { method: "turn/steer", text: "REQTEST hi\n|[time]" },
    ]);

    // 同一条消息的另一份候选帧复用上面的决定，不再跑 pre-step。
    env.port.postMessage(turnResolve(8));
    await env.settle();
    assert.equal(preSteps, 1);
    assert.equal((env.sent[2] as any)[2].start.request.input[0].length, 2);
  });

  it("applies dsh agent/request model and effort to every settings holder", async () => {
    const env = await runtime();
    env.on("agent/request", async (_params: unknown, next: () => Promise<any>) => {
      const config = await next();
      assert.deepEqual(config, { provider: "jojocodemax", model: "jojocodemax/gpt-6.1-sol", reasoningEffort: "high" });
      return { ...config, model: "other/gpt-5", reasoningEffort: "low" };
    });
    env.port.postMessage(turnResolve(9));
    await env.settle();
    const value = (env.sent[0] as any)[2];
    for (const holder of [value.start.request, value.resume]) {
      assert.equal(holder.collaborationMode.settings.model, "other/gpt-5");
      assert.equal(holder.collaborationMode.settings.reasoning_effort, "low");
    }
    assert.equal(value.start.request.model, null, "explicit null overrides stay null");
  });

  it("reads model settings from resume when the host first asks for the steer candidate only", async () => {
    const env = await runtime();
    const configs: unknown[] = [];
    env.on("agent/request", async (_params: unknown, next: () => Promise<any>) => {
      const config = await next();
      configs.push(config);
      return { ...config, reasoningEffort: "low" };
    });
    const steerOnly = turnResolve(12, "m-3") as any;
    delete steerOnly[2].start;
    env.port.postMessage(steerOnly);
    env.port.postMessage(turnResolve(13, "m-3"));
    await env.settle();
    assert.deepEqual(configs, [{ provider: "jojocodemax", model: "jojocodemax/gpt-6.1-sol", reasoningEffort: "high" }]);
    assert.equal((env.sent[0] as any)[2].resume.collaborationMode.settings.reasoning_effort, "low");
    assert.equal((env.sent[1] as any)[2].start.request.collaborationMode.settings.reasoning_effort, "low");
  });

  it("turns a pre-step rejection into a capnweb reject frame", async () => {
    const env = await runtime();
    env.on("agent/pre-step", () => ({ kind: "reject", reason: "blocked by policy" }));
    env.port.postMessage(turnResolve(10));
    await env.settle();
    assert.deepEqual(env.sent[0], ["reject", 10, ["error", "Error", "blocked by policy"]]);
    assert.deepEqual(env.toasts, ["blocked by policy"]);
  });

  it("treats the first turn of a new conversation as turn/start", async () => {
    const env = await runtime();
    env.intercept("codex/request", (value: any, next: (v: unknown) => unknown) => {
      if (value.method !== "turn/start") return next(value);
      return next({ ...value, params: { ...value.params, input: [{ type: "text", text: "（中文）" }, ...value.params.input] } });
    });
    const callbacks = { onSettled: ["export", -688] };
    env.port.postMessage(["push", ["pipeline", -188, ["startConversation"], [{
      input: [[{ ...userText }]], clientUserMessageId: "m-2", collaborationMode: { mode: "default", settings: { ...settings } },
    }, callbacks]]]);
    await env.settle();
    const [, expr] = env.sent[0] as [string, any[]];
    assert.deepEqual(expr.slice(0, 3), ["pipeline", -188, ["startConversation"]]);
    assert.deepEqual(expr[3][0].input, [[{ type: "text", text: "（中文）" }, userText]]);
    assert.equal(expr[3][1], callbacks, "exported callbacks are forwarded as-is");
  });

  it("keeps the push id sequence when a new conversation is rejected", async () => {
    const env = await runtime();
    env.on("agent/pre-step", async () => ({ kind: "reject" }));
    env.port.postMessage(["push", ["pipeline", -188, ["startConversation"], [{ input: [[{ ...userText }]] }, {}]]]);
    await env.settle();
    assert.deepEqual(env.sent[0], ["push", ["pipeline", -188, ["__codexPlusRejectedByExtension"], []]]);
  });

  it("routes manager sendRequest calls through codex/request", async () => {
    const env = await runtime();
    env.intercept("codex/request", (value: any, next: (v: unknown) => unknown) =>
      next(value.method === "hooks/list" ? { ...value, params: { cwds: [...value.params.cwds, "/extra"] } } : value));
    const untouched: Frame = ["push", ["pipeline", -188, ["sendRequest"], ["config/read", { cwd: null }, { priority: "critical" }]]];
    env.port.postMessage(["push", ["pipeline", -188, ["sendRequest"], ["hooks/list", { cwds: [["/a"]] }]]]);
    env.port.postMessage(untouched);
    await env.settle();
    assert.deepEqual(env.sent[0], ["push", ["pipeline", -188, ["sendRequest"], ["hooks/list", { cwds: [["/a", "/extra"]] }]]]);
    assert.equal(env.sent[1], untouched, "a request the chain did not change goes out as the same object");
  });

  it("skips a throwing listener instead of blocking the turn", async () => {
    const env = await runtime();
    env.on("agent/pre-step", () => { throw new Error("boom"); });
    const frame = turnResolve(11);
    env.port.postMessage(frame);
    await env.settle();
    assert.equal(env.sent.length, 1);
    assert.deepEqual((env.sent[0] as any)[2].start.request.input, (frame as any)[2].start.request.input);
    assert.ok(env.failures.some((message) => message.includes("boom")));
  });
});

describe("拓展输入触发、快捷键与主题", () => {
  async function extras(platform = "MacIntel") {
    const source = await readFile(
      new URL("../../../assets/inject/renderer-inject/92-extension-extras.js", import.meta.url), "utf8",
    );
    const registry = { inputTriggers: new Map(), shortcuts: new Map(), themes: new Map() };
    const emitted: unknown[] = [];
    const styles = new Map<string, { id: string; textContent: string; remove: () => void }>();
    const rootAttributes = new Map<string, string>();
    const document = {
      getElementById: (id: string) => styles.get(id) ?? null,
      createElement: () => {
        const node = { id: "", textContent: "", remove: () => styles.delete(node.id) };
        return node;
      },
      head: { append: (node: { id: string; textContent: string; remove: () => void }) => styles.set(node.id, node) },
      documentElement: {
        setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
        removeAttribute: (name: string) => rootAttributes.delete(name),
      },
      addEventListener: () => {},
    };
    const store = new Map<string, string>();
    const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) };
    const api = new Function(
      "document", "localStorage", "navigator", "window", "codexPlusRegistry", "codexPlusExtensionItems", "codexPlusRegisterExtensionItem",
      "markCodexPlusExtensionNode", "codexPlusEmitExtensionEvent", "codexPlusResolveText", "installCodexPlusCommandHandlers",
      `${source}\nreturn { parse: codexPlusParseShortcut, matches: codexPlusShortcutMatches, match: codexPlusMatchInputTrigger, registerTheme: codexPlusRegisterTheme, themes: codexPlusThemesService(), registerTrigger: codexPlusRegisterInputTrigger };`,
    )(
      document, localStorage, { platform }, {},
      registry,
      (map: Map<string, unknown>) => [...map.values()],
      (kind: string, map: Map<string, unknown>, definition: Record<string, unknown>, options: { id?: string }) => {
        const id = `user:demo:${kind}:${options.id ?? map.size}`;
        map.set(id, { ...definition, id, scriptKey: "user:demo" });
        return () => map.delete(id);
      },
      () => {},
      (event: string, args: unknown[]) => emitted.push([event, ...args]),
      (value: unknown) => value,
      () => {},
    );
    return { api, registry, styles, rootAttributes, store, emitted };
  }

  it("快捷键：Mod 在 macOS 是 ⌘，要求带修饰键", async () => {
    const { api } = await extras("MacIntel");
    const spec = api.parse("Mod+Shift+K");
    assert.deepEqual(spec, { ctrl: false, meta: true, shift: true, alt: false, key: "k" });
    assert.equal(api.matches(spec, { key: "K", code: "KeyK", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }), true);
    assert.equal(api.matches(spec, { key: "k", code: "KeyK", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }), false);
    assert.throws(() => api.parse("K"), /需要带 Mod/);
    assert.throws(() => api.parse("Mod+K+J"), /只能有一个主键/);
    assert.ok(api.parse("F5"), "功能键可以不带修饰键");
    const { api: windows } = await extras("Win32");
    assert.equal(windows.parse("Mod+K").ctrl, true);
  });

  it("输入触发：取光标前最近的触发符，查询词里有空白就不算", async () => {
    const { api, registry } = await extras();
    api.registerTrigger({ trigger: "%", items: () => [] });
    api.registerTrigger({ trigger: "#", items: () => [] });
    assert.equal(api.match("请看 %rea").query, "rea");
    assert.equal(api.match("请看 %rea").item.trigger, "%");
    assert.equal(api.match("a%b"), null, "触发符前要是开头或空白");
    assert.equal(api.match("%foo bar"), null, "已经输完一个词");
    assert.equal(api.match("%x #iss").item.trigger, "#");
    assert.equal(registry.inputTriggers.size, 2);
    assert.throws(() => api.registerTrigger({ trigger: "abc", items: () => [] }), /符号开头/);
    for (const reserved of ["@", "$", "/", "@me"]) {
      assert.throws(() => api.registerTrigger({ trigger: reserved, items: () => [] }), /Codex 自己在用/, reserved);
    }
  });

  it("主题：选中的主题生效并记住，拓展卸下后撤掉样式、回来自动恢复", async () => {
    const { api, styles, rootAttributes, store, emitted } = await extras();
    const dispose = api.registerTheme({ id: "sepia", name: "复古", variables: { "--color-token-main-surface-primary": "#f4ecd8", "bad name": "x" }, css: "body{letter-spacing:.01em}" });
    assert.deepEqual(api.themes.list().map((theme: { id: string }) => theme.id), ["sepia"]);
    assert.equal(api.themes.current, null);
    api.themes.apply("sepia");
    assert.equal(store.get("codexPlusExtensionTheme"), "sepia");
    const css = styles.get("codex-plus-extension-theme")!.textContent;
    assert.match(css, /:root\{--color-token-main-surface-primary:#f4ecd8\}/);
    assert.doesNotMatch(css, /bad name/);
    assert.equal(rootAttributes.get("data-codex-plus-theme"), "sepia");
    assert.deepEqual(emitted.at(-1), ["theme/change", { id: "sepia" }]);
    dispose();
    assert.equal(styles.has("codex-plus-extension-theme"), false);
    assert.equal(store.get("codexPlusExtensionTheme"), "sepia", "选择保留");
    api.registerTheme({ id: "sepia", css: "body{}" });
    assert.equal(rootAttributes.get("data-codex-plus-theme"), "sepia");
    assert.throws(() => api.themes.apply("missing"), /没有主题/);
    api.themes.apply(null);
    assert.equal(styles.has("codex-plus-extension-theme"), false);
  });
});

describe("跨项目会话列表标题", () => {
  const fragment = new URL("../../../assets/inject/renderer-inject/62-conversation-list.js", import.meta.url);

  it("优先用会话名，超长首条消息折叠空白并截断", async () => {
    const source = await readFile(fragment, "utf8");
    const match = source.match(/  function cleanTitle\(value\) \{[\s\S]*?\n  \}/);
    assert.ok(match, "分片里要有 cleanTitle 防御旧后端数据");
    const cleanTitle = new Function(`${match![0]}\nreturn cleanTitle;`)() as (value: unknown) => string;
    assert.equal(cleanTitle("  重构\n登录页  "), "重构 登录页");
    assert.equal(cleanTitle(""), "");
    assert.equal(cleanTitle(null), "");
    assert.equal(cleanTitle("x".repeat(500)).length, 201, "200 字 + 省略号");
    assert.match(source, /cleanTitle\(session\.displayTitle \|\| session\.name \|\| session\.title\)/);
    assert.doesNotMatch(source, /const title = String\(session\.title/);
  });
});

describe("跨项目会话列表时间分区", () => {
  const fragment = new URL("../../../assets/inject/renderer-inject/62-conversation-list.js", import.meta.url);

  async function group() {
    const source = await readFile(fragment, "utf8");
    const match = source.match(/  function cplConversationGroup\([\s\S]*?\n  \}/);
    assert.ok(match, "分片里要有自包含的 cplConversationGroup");
    return new Function(`${match![0]}\nreturn cplConversationGroup;`)() as (
      updatedAt: unknown, now: Date, strings: Record<string, string>, lang: string,
    ) => { key: string; label: string };
  }

  const zh = { today: "今天", yesterday: "昨天", earlier: "更早" };
  const en = { today: "Today", yesterday: "Yesterday", earlier: "Earlier" };
  // 2026-11-12 是周四。
  const now = new Date(2026, 10, 12, 10, 30);
  const seconds = (year: number, month: number, day: number) =>
    Math.floor(new Date(year, month - 1, day, 9, 0).getTime() / 1000);

  it("今天/昨天/本周星期几/本周之前日期，周一为一周起点", async () => {
    const fn = await group();
    assert.equal(fn(seconds(2026, 11, 12), now, zh, "zh").label, "今天");
    assert.equal(fn(seconds(2026, 11, 11), now, zh, "zh").label, "昨天");
    assert.equal(fn(seconds(2026, 11, 10), now, zh, "zh").label, "周二");
    assert.equal(fn(seconds(2026, 11, 9), now, zh, "zh").label, "周一");
    assert.equal(fn(seconds(2026, 11, 8), now, zh, "zh").label, "11月8日", "周日算上一周");
    assert.equal(fn(seconds(2026, 11, 7), now, zh, "zh").label, "11月7日");
  });

  it("跨年补年份，秒与毫秒时间戳都认，无效时间归到更早", async () => {
    const fn = await group();
    assert.equal(fn(seconds(2025, 12, 25), now, zh, "zh").label, "2025年12月25日");
    assert.equal(fn(new Date(2026, 10, 8, 9, 0).getTime(), now, zh, "zh").label, "11月8日", "毫秒时间戳");
    for (const bad of [0, null, undefined, NaN, "abc"]) {
      assert.equal(fn(bad, now, zh, "zh").label, "更早");
      assert.equal(fn(bad, now, zh, "zh").key, "unknown");
    }
    assert.equal(fn(seconds(2026, 11, 13), now, zh, "zh").label, "今天", "时钟回拨不单独开组");
  });

  it("英文文案，同一天共用一个分区", async () => {
    const fn = await group();
    assert.equal(fn(seconds(2026, 11, 12), now, en, "en").label, "Today");
    assert.equal(fn(seconds(2026, 11, 11), now, en, "en").label, "Yesterday");
    assert.equal(fn(seconds(2026, 11, 10), now, en, "en").label, "Tuesday");
    assert.equal(fn(seconds(2026, 11, 8), now, en, "en").label, "Nov 8");
    assert.equal(fn(seconds(2025, 12, 25), now, en, "en").label, "Dec 25, 2025");
    const morning = fn(seconds(2026, 11, 12), now, en, "en");
    const evening = fn(Math.floor(new Date(2026, 10, 12, 23, 0).getTime() / 1000), now, en, "en");
    assert.equal(morning.key, evening.key);
    assert.notEqual(morning.key, fn(seconds(2026, 11, 11), now, en, "en").key);
  });

  it("分区标题插入列表并吸顶，分页时按 key 复用节点", async () => {
    const source = await readFile(fragment, "utf8");
    // sticky 以滚动容器的 padding box 为基准，容器有上内边距时 top:0 只钉在 padding 下沿，
    // 上面那条缝会露出滚上来的会话文字；必须实测 padding-top 后用负 top 顶到视口上缘。
    assert.match(source, /position: sticky; top: var\(--cpl-pin-top, 0px\)/);
    assert.match(source, /getComputedStyle\(scroller\)\.paddingTop/, "实测滚动容器上内边距");
    assert.match(source, /setProperty\('--cpl-pin-top', nextTop\)/, "把负的吸顶偏移写进变量");
    assert.match(source, /background: var\(--cpl-surface-bg/, "底色取实测的列表背景");
    assert.match(source, /function syncSurface\(\)/, "运行时探测侧栏真实背景色");
    // 侧栏底色是 oklab() / color(srgb …)，只认 rgb 会一路落回 <html> 的 #f5f5f5，
    // 又变回一条灰带；必须交给浏览器解析。
    assert.match(source, /const layer = value && value !== 'transparent' \? parseColor\(value\) : null/);
    assert.match(source, /getContext\('2d'/, "用 canvas 解析 oklab / color(srgb …)");
    assert.match(source, /function exactAlpha\(value, fallback\)/, "alpha 取原始精度，避免分层合成偏差");
    assert.match(source, /\.cpl-group \{[^}]*border-radius: 0/, "不吃原生圆角样式");
    assert.doesNotMatch(source, /\.cpl-group \{[^}]*(?:opacity|backdrop-filter|rgba\()/, "不用半透明灰块");
    assert.match(source, /cplConversationGroup\(session\.updatedAt, now, str, langKey\)/);
    assert.match(source, /wantedGroups\.add\(bucket\.group\.key\)/);
    assert.match(source, /if \(group\.key !== lastKey\)/);
    // 标题必须和组内会话同处一个 section：平铺时多个 sticky 会一起钉在 top:0 叠住，
    // 表现就是上一个分组被下一个盖掉、只露出半截文字。
    assert.match(source, /\.cpl-section \{ display: block; \}/);
    assert.match(source, /const box = el\('div', 'cpl-section'\)/);
    assert.match(source, /g\.box\.append\(g\.item, \.\.\.bucket\.items\)/);
    // 高度必须落在整数像素上：默认 line-height:1.5 会算出 16.5 / 19.5，
    // 条目高度带 .5px，滚动时每帧的取整结果来回跳，视觉上就是抖动/发虚。
    assert.match(source, /\.cpl-group \{[^}]*line-height: 16px/, "分组标题行高取整");
    assert.match(source, /\.cpl-label \{[^}]*line-height: 20px/, "会话标题行高取整");
    assert.match(source, /\.cpl-project-name \{[^}]*line-height: 16px/, "项目行行高取整");
    // 顺序没变就不要 append：搬节点会触发重排 + 滚动锚定，滚动中会抖。
    assert.match(source, /const kids = g\.box\.children/);
    assert.match(source, /if \(!same\) g\.box\.append/, "顺序未变时跳过 DOM 搬动");
    assert.match(source, /\.cpl-list \{[^}]*overflow-anchor: none/, "关掉滚动锚定");
    // 首组不能有单独的内边距：sticky 的吸附点由容器 padding-top 决定，列表再留上内边距
    // 会让首组标题的正常流位置比吸附点低几像素，向下滚动时它要先滑一段才钉住；顺带
    // 首组高度也会比其它组矮一截、文字不居中。上下 padding 必须相等才能垂直居中。
    assert.match(source, /\.cpl-list \{[^}]*margin-top: var\(--cpl-pin-top, 0px\)/, "列表用负上边距对齐吸附线");
    assert.match(source, /\.cpl-list \{[^}]*padding: 0 4px 2px/, "列表不留上内边距");
    assert.doesNotMatch(source, /\.cpl-section:first-child > \.cpl-group/, "首组不设特殊内边距");
    assert.match(source, /\.cpl-group \{[^}]*padding: 7px 8px;/, "分组标题上下内边距相等");
  });
});

describe("跨项目会话列表选中态", () => {
  const fragment = new URL("../../../assets/inject/renderer-inject/62-conversation-list.js", import.meta.url);

  it("从原生行同步当前会话，点击时先乐观高亮", async () => {
    const source = await readFile(fragment, "utf8");
    // 原生侧栏行是带「当前会话」标识的地方之一，隐藏后 React 仍在维护这些属性。
    assert.match(source, /\[data-app-action-sidebar-thread-selected="true"\]/);
    assert.match(source, /getAttribute\('data-app-action-sidebar-thread-id'\)/);
    // 行 id 可能是 local:<uuid> 或 local:client-new-thread:<uuid>，取最后一段再校验 UUID。
    assert.match(source, /\.split\(':'\)\.pop\(\)/, "取行 id 最后一段与 session.id 比");
    // 读不到时保留已有的高亮，不能清掉。
    assert.match(source, /if \(fromRow == null\) return false/);
    // 点完列表项到原生重渲染之间有延迟，这段窗口里必须用点击结果顶住。
    assert.match(source, /selectedId = id;\s*\n\s*selectionLockUntil = Date\.now\(\) \+ 1200;/);
    assert.match(source, /if \(Date\.now\(\) < selectionLockUntil\) return false/);
    // 只改属性，不重建节点：每秒都会重算一次。
    assert.match(source, /n\.item\.setAttribute\('data-cpl-selected', 'true'\)/);
    assert.match(source, /n\.open\.setAttribute\('aria-current', 'page'\)/);
    assert.match(source, /\.cpl-item\[data-cpl-selected="true"\] \{ background: rgba\(127,127,127,\.14\)/, "选中底色略重于 hover");
    assert.match(source, /\.cpl-item\[data-cpl-selected="true"\]:hover \{ background: rgba\(127,127,127,\.18\)/, "悬停选中项不会变浅");
    assert.match(source, /selectionWatch\?\.disconnect\(\); selectionWatch = null/, "dispose 时要断开观察");
  });

  it("当前会话以 React 路由为准，标签栏切换也能跟上", async () => {
    const source = await readFile(fragment, "utf8");
    // 从标签栏 / 命令面板 / 前进后退切会话时原生行的 selected 不会翻（实测全为 false），
    // 只有当前页面容器的 React 路由是稳定信号；标签栏分片也是这么判的。
    assert.match(source, /function currentThreadRoute\(\)/, "必须从路由读当前会话");
    assert.match(source, /__reactFiber\$/, "沿 fiber 找路由 context");
    assert.match(source, /memoizedProps\?\.value/);
    assert.match(source, /routeKind === 'client-local-thread'\) return \{ known: false/, "临时新会话不清空高亮");
    assert.match(source, /const route = currentThreadRoute\(\);/, "选中来源优先路由");
    assert.match(source, /if \(route\.known\) \{\s*\n\s*next = route\.id;/, "路由可用时直接用它");
    // 页面切换只会翻 data-app-shell-active-page，不盯它就只能在主扫描时才跟上。
    assert.match(source, /attributeFilter: \['data-app-action-sidebar-thread-selected', 'data-app-shell-active-page'\]/, "页面切换要立刻同步");
  });
});
