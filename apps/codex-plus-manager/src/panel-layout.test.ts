import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

const source = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

function functionSource(name: string) {
  const matches = Array.from(source.matchAll(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "gm")));
  assert.ok(matches.length, `missing ${name}`);
  return matches.at(-1)![0];
}

function styleNode() {
  const values = new Map<string, string>();
  return {
    left: "", top: "",
    setProperty(name: string, value: string) { values.set(name, value); },
    removeProperty(name: string) { values.delete(name); },
    values,
  };
}

function layoutHarness(zoom = 1) {
  const nodes: Record<string, { rect: Record<string, number>; getBoundingClientRect(): Record<string, number> }> = {};
  const rectangles: Record<string, Record<string, number>> = {
    main: { left: 320, top: 40, width: 960, height: 760, right: 1280 },
    "aside.app-shell-left-panel": { left: 0, top: 40, width: 320, height: 760, right: 320 },
    "nav[data-app-navigation-rail]": { left: 0, top: 40, width: 62, height: 760, right: 62 },
    "[data-app-shell-workspace-row]": { left: 0, top: 40, width: 962, height: 740, right: 962, bottom: 780 },
  };
  for (const [selector, rect] of Object.entries(rectangles)) {
    nodes[selector] = { rect, getBoundingClientRect() { return this.rect; } };
  }
  const style = styleNode();
  const overlay = { style, isConnected: true, classList: { contains: (name: string) => name === "codex-plus-page-overlay" } };
  const listeners = new Set<() => void>();
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<unknown>();
    disconnects = 0;
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
    observe(node: unknown) { this.targets.add(node); }
    disconnect() { this.disconnects++; this.targets.clear(); }
  }
  const window: Record<string, unknown> = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(_event: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_event: string, listener: () => void) { listeners.delete(listener); },
  };
  const document = {
    querySelector: (selector: string) => nodes[selector] ?? null,
    querySelectorAll: () => overlay.isConnected ? [{ remove() { overlay.isConnected = false; } }] : [],
  };
  const runtime = new Function("document", "window", "ResizeObserver", "codexPlusWindowZoom", `
    const codexPlusPageClass = "codex-plus-page-overlay";
    const codexPlusRailSelector = "nav[data-app-navigation-rail]";
    function syncCodexPlusRailNativeSelection() {}
    // 返回按钮行为由 page-back-navigation.test.ts 验证，此处只隔离布局生命周期。
    function syncCodexPlusPageBackButton() {}
    function restoreCodexPlusPageBackButton() {}
    ${functionSource("positionCodexPlusPage")}
    ${functionSource("observeCodexPlusPageLayout")}
    ${functionSource("closeCodexPlusPage")}
    return { position: positionCodexPlusPage, attach: observeCodexPlusPageLayout, close: closeCodexPlusPage };
  `)(document, window, Observer, () => zoom) as {
    position(node: typeof overlay): void; attach(node: typeof overlay): void; close(): void;
  };
  return { ...runtime, overlay, nodes, listeners, observers, window, document };
}

it("keeps panel edges in layout coordinates without rewriting zoom during positioning", () => {
  for (const zoom of [0.8, 1, 1.25]) {
    const h = layoutHarness(zoom);
    h.position(h.overlay);
    assert.equal(h.overlay.style.left, `${62 / zoom}px`);
    assert.equal(h.overlay.style.top, `${40 / zoom}px`);
    assert.equal(h.overlay.style.values.get("--codex-plus-page-top"), `${40 / zoom}px`);
    assert.equal(h.overlay.style.values.get("--codex-plus-page-right"), `${38 / zoom}px`);
    assert.equal(h.overlay.style.values.get("--codex-plus-page-bottom"), `${20 / zoom}px`);
    assert.equal(h.overlay.style.values.get("--codex-plus-zoom"), undefined);
    assert.equal(h.overlay.style.values.get("zoom"), undefined);
    delete h.nodes["nav[data-app-navigation-rail]"];
    h.position(h.overlay);
    assert.equal(h.overlay.style.left, `${320 / zoom}px`, "legacy sidebar boundary is unchanged");
    h.nodes.main.rect.height = 0;
    h.nodes["aside.app-shell-left-panel"].rect.top = 24;
    h.position(h.overlay);
    assert.equal(h.overlay.style.top, `${24 / zoom}px`);
    delete h.nodes.main;
    delete h.nodes["aside.app-shell-left-panel"];
    h.position(h.overlay);
    assert.equal(h.overlay.style.top, "0px");
    assert.equal(h.overlay.style.left, "0px");
  }
});

it("retargets the layout observer when the host replaces its main or rail", () => {
  const h = layoutHarness();
  h.attach(h.overlay);
  const observer = h.observers[0];
  assert.equal(observer.targets.size, 3);
  const oldRail = h.nodes["nav[data-app-navigation-rail]"];
  h.nodes["nav[data-app-navigation-rail]"] = {
    rect: { ...oldRail.rect, top: 60 },
    getBoundingClientRect() { return this.rect; },
  };
  h.position(h.overlay);
  assert.equal(observer.targets.has(oldRail), false);
  assert.equal(observer.targets.has(h.nodes["nav[data-app-navigation-rail]"]), true);
  assert.equal(h.overlay.style.top, "60px");
  const disconnects = observer.disconnects;
  h.position(h.overlay);
  assert.equal(observer.disconnects, disconnects, "unchanged hosts do not resubscribe");
});

it("closes and reopens pages without retaining observers, resize handlers or queued layout writes", () => {
  const h = layoutHarness();
  let cleanupCalls = 0;
  for (let i = 0; i < 50; i++) {
    h.overlay.isConnected = true;
    h.attach(h.overlay);
    assert.equal(h.listeners.size, 1);
    h.window.__codexPlusExtensionPageCleanup = () => { cleanupCalls++; };
    const observer = h.observers.at(-1)!;
    h.close();
    h.close();
    assert.equal(cleanupCalls, i + 1, "extension cleanup executes exactly once");
    assert.equal(h.listeners.size, 0);
    assert.equal(observer.targets.size, 0);
    assert.equal(h.window.__codexPlusPageResizeHandler, null);
    assert.equal(h.window.__codexPlusPageLayoutObserver, null);
    assert.equal(h.window.__codexPlusPageLayoutTargets, null);
    const top = h.overlay.style.top;
    h.nodes.main.rect.top += 1;
    observer.callback();
    assert.equal(h.overlay.style.top, top, "a queued callback cannot reposition a removed page");
  }
});

it("runs old extension cleanup before replacing a page with either a built-in page or a modal", () => {
  for (const page of [true, false]) {
    const h = layoutHarness();
    h.attach(h.overlay);
    let cleanups = 0;
    h.window.__codexPlusExtensionPageCleanup = () => { cleanups++; };
    const stop = new Error("stop before building the new DOM");
    const document = { ...h.document, createElement() { throw stop; } };
    const open = new Function("document", "closeCodexPlusPage", "codexPlusModalTab", `
      const codexPlusPageClass = "codex-plus-page-overlay";
      ${functionSource("openCodexPlusModal")}
      return openCodexPlusModal;
    `)(document, h.close, (tab: string) => tab);
    assert.throws(() => open({ page }), (error: unknown) => error === stop);
    assert.equal(cleanups, 1);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.observers[0].targets.size, 0);
  }
});

it("cleans up the previous extension before opening another extension page", () => {
  const h = layoutHarness();
  h.attach(h.overlay);
  let cleanups = 0;
  h.window.__codexPlusExtensionPageCleanup = () => { cleanups++; };
  const stop = new Error("stop before building the next extension DOM");
  const open = new Function("document", "closeCodexPlusPage", `
    const codexPlusPageClass = "codex-plus-page-overlay";
    ${functionSource("openCodexPlusModalForExtension")}
    return openCodexPlusModalForExtension;
  `)({ ...h.document, createElement() { throw stop; } }, h.close);
  assert.throws(() => open("next", {}), (error: unknown) => error === stop);
  assert.equal(cleanups, 1);
  assert.equal(h.listeners.size, 0);
});

it("renders only registered extension entries without fixed navigation anchors", () => {
  const state = { entries: [] as any[], pages: new Map() };
  const children: any[] = [];
  const created: any[] = [];
  let activated = 0;
  const rail = {
    get firstElementChild() { return children[0] ?? null; },
    insertBefore(node: any, anchor: any) {
      const previous = children.indexOf(node);
      if (previous >= 0) children.splice(previous, 1);
      const index = anchor ? children.indexOf(anchor) : children.length;
      children.splice(index, 0, node);
      node.parentElement = rail;
    },
    appendChild(node: any) { this.insertBefore(node, null); },
  };
  const document = {
    querySelector: () => rail,
    querySelectorAll: () => [...children],
    getElementById: (id: string) => children.find(node => node.id === id),
  };
  const create = (spec: any) => {
    created.push(spec);
    const attributes = new Map();
    const node = {
      id: spec.id, generation: 2, parentElement: null as any, firstElementChild: null,
      get nextSibling() { return children[children.indexOf(node) + 1] ?? null; },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name),
      remove() {
        const index = children.indexOf(node);
        if (index >= 0) children.splice(index, 1);
        node.parentElement = null;
      },
    };
    return node;
  };
  const refresh = new Function("document", "state", "createCodexPlusRailButton", `
    const codexPlusRailSelector = "nav[data-app-navigation-rail]";
    const codexPlusExtensionRailAttribute = "data-codex-plus-ext-rail";
    const codexPlusRegistry = state;
    const codexPlusExtensionItems = () => state.entries;
    const codexPlusRailPrimaryAnchor = () => null;
    const codexPlusRailTemplateButton = () => null;
    const codexPlusNavEntryReusable = node => node.generation === 2;
    const codexPlusExtensionIconMarkup = () => "icon";
    const markCodexPlusExtensionNode = () => {};
    const runCodexPlusExtensionCallback = (_key, _event, callback) => callback();
    ${functionSource("codexPlusExtensionRailElementId")}
    ${functionSource("refreshCodexPlusRailNavigation")}
    return refreshCodexPlusRailNavigation;
  `)(document, state, create);

  assert.equal(refresh(), false);
  assert.equal(created.length, 0, "no fixed entries are created when the registry is empty");
  state.entries = [{ id: "notes", scriptKey: "user:notes", label: "笔记", onActivate() { activated++; } }];
  assert.equal(refresh(), true);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, "codex-plus-ext-rail-notes");
  created[0].onActivate();
  assert.equal(activated, 1);
  refresh();
  assert.equal(created.length, 1, "repeated scans reuse current extension entries");
  children[0].generation = 1;
  refresh();
  assert.equal(created.length, 2, "reinjection replaces old extension callbacks");
  assert.equal(children.length, 1);
  state.entries = [];
  assert.equal(refresh(), false);
  assert.equal(children.length, 0, "unregistered extensions leave no navigation button");
});

it("replaces version 31 styles with bounded panel geometry and keeps reinjection idempotent", () => {
  const styleSource = functionSource("installStyle");
  const names = new Set([
    "styleId", "codexDeleteStyleVersion",
    ...Array.from(styleSource.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)/g), match => match[1]),
  ]);
  const declarations = [...names].map(name => {
    const match = source.match(new RegExp(`^  const ${name} = .+;$`, "m"))
      ?? source.match(new RegExp(`^  const ${name} = [\\s\\S]*?^  };$`, "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  let existing: { dataset: Record<string, string>; textContent?: string; remove(): void } | null = {
    dataset: { codexDeleteStyleVersion: "31" },
    remove() { existing = null; },
  };
  let appended = 0;
  const document = {
    getElementById: () => existing,
    createElement: () => ({ dataset: {}, remove() { existing = null; } }),
    documentElement: { appendChild(node: NonNullable<typeof existing>) { existing = node; appended++; } },
  };
  const install = new Function("document", `${declarations}\n${styleSource}\nreturn installStyle;`)(document);
  install();
  assert.ok(Number(existing?.dataset.codexDeleteStyleVersion) >= 32);
  const pageRules = existing!.textContent!.match(/\.codex-plus-page-overlay\s*\{([^}]+)\}/)![1];
  assert.match(pageRules, /right: var\(--codex-plus-page-right, 0px\)/);
  assert.match(pageRules, /bottom: var\(--codex-plus-page-bottom, 0px\)/);
  assert.match(pageRules, /border-radius: var\(--codex-plus-page-radius, 0px\)/);
  assert.match(pageRules, /height: calc\(100vh \/ var\(--codex-plus-zoom, 1\) - var\(--codex-plus-page-top, 0px\) - var\(--codex-plus-page-bottom, 0px\)\)/);
  const modalRules = existing!.textContent!.match(/\.codex-plus-modal-overlay\s*\{([^}]+)\}/)![1];
  assert.match(modalRules, /height: calc\(100vh \/ var\(--codex-plus-zoom, 1\)\)/);
  install();
  assert.equal(appended, 1);
});
