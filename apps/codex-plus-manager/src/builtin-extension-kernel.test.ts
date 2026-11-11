import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 内置拓展挂在拓展内核上：扫描步骤由拓展登记、卸下即撤。
// 用量状态栏、请求状态条的数据服务改由官方拓展包提供，见 status-bar-packages.test.ts。
const read = (name: string) => readFileSync(new URL(`../../../assets/inject/renderer-inject/${name}`, import.meta.url), "utf8");
const builtins = read("96-builtin-extensions.js");
const scan = read("95-conversation-view.js");
const extract = (source: string, name: string) => {
  const body = source.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "m"))?.[0];
  assert.ok(body, name);
  return body;
};

function harness(windowState: Record<string, unknown> = {}) {
  const calls: string[] = [];
  // 拓展内核的事件、中间件、DOM 监听：按内核语义登记，卸载时撤销。
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const interceptors = new Map<string, Array<(value: any, next: (value?: any) => any) => any>>();
  const domListeners: Array<{ target: unknown; type: string }> = [];
  const services = new Map<string, { value: any; owner: string }>();
  const handles: Array<{ id: string; dispose(): void }> = [];
  const known: Record<string, unknown> = {
    window: { __codexPlusBuiltinExtensionState: { disabled: [], replacedBy: {} }, ...windowState },
    document: { id: "document", documentElement: { removeAttribute() {} }, getElementById() { return null; } },
    codexPlusServices: services,
    codexPlusProvideService: (name: string, value: unknown, owner: string) => services.set(name, { value, owner }),
    codexPlusMarkExtensionFailure: (key: string, message: string) => calls.push(`fail:${key}:${message}`),
    codexPlusCreateExtension(definition: any) {
      const disposers: Array<() => void> = [];
      const track = (dispose: () => void) => { disposers.push(dispose); return dispose; };
      const ctx = {
        id: definition.id,
        effect: (fn: () => () => void) => { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose); return dispose; },
        on(event: string, handler: (...args: any[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
          return track(() => listeners.get(event)!.delete(handler));
        },
        intercept(name: string, handler: (value: any, next: (value?: any) => any) => any) {
          interceptors.set(name, [...(interceptors.get(name) || []), handler]);
          return track(() => interceptors.set(name, interceptors.get(name)!.filter((item) => item !== handler)));
        },
        listen(target: unknown, type: string) {
          const entry = { target, type };
          domListeners.push(entry);
          return track(() => domListeners.splice(domListeners.indexOf(entry), 1));
        },
        registerSlot: () => () => {},
        setTimeout: () => () => {},
        // 公开的 ctx.onScan：登记到扫描步骤登记处（owner 为拓展 id），卸载时撤销。
        onScan(handler: () => void, options: { phase?: string } = {}) {
          return track((known.registerScanStep as any)(definition.id, handler, options.phase));
        },
      };
      definition.apply(ctx);
      const handle = { id: definition.id, dispose: () => disposers.reverse().forEach((dispose) => dispose()) };
      handles.push(handle);
      return handle;
    },
  };
  // 其余被引用的功能函数一律当作无副作用的桩。
  const scope = new Proxy(known, {
    has: (_target, key) => typeof key === "string" && !["globalThis", "Map", "Set", "Object", "Array", "String", "Error", "Promise"].includes(key),
    get: (target, key) => (key in target ? target[key as string] : key === Symbol.unscopables ? undefined : () => undefined),
  });
  const source = [
    extract(scan, "codexPlusScanSteps"), extract(scan, "registerCodexPlusScanStep"), extract(scan, "runCodexPlusScanSteps"), extract(scan, "runScanStep"),
    builtins,
  ].join("\n");
  const api = new Function("scope", `with (scope) { ${source}\n return { sync: syncCodexPlusBuiltinExtensions, runSteps: runCodexPlusScanSteps, steps: codexPlusScanSteps, register: registerCodexPlusScanStep }; }`)(scope);
  known.registerScanStep = api.register;
  /** 登记了扫描步骤的拓展 → 它们的 phase。 */
  const stepOwners = () => {
    const owners = new Map<string, string[]>();
    for (const entry of api.steps().values()) owners.set(entry.owner, [...(owners.get(entry.owner) || []), entry.phase]);
    return owners;
  };
  const emit = (event: string, ...args: unknown[]) => [...(listeners.get(event) || [])].forEach((handler) => handler(...args));
  const chain = (name: string, value: any) => {
    const items = interceptors.get(name) || [];
    const step = (index: number, current: any): any => (index >= items.length ? current : items[index](current, (next = current) => step(index + 1, next)));
    return step(0, value);
  };
  return { api, calls, services, known, listeners, interceptors, domListeners, emit, chain, stepOwners };
}

test("重注入会还原退役的模型分组并释放旧定时器", () => {
  const calls: string[] = [];
  const env = harness({
    __codexPlusModelPickerGroupsRuntime: {
      releaseDom: () => calls.push("restore"),
      dispose: () => calls.push("dispose"),
    },
  });
  // 必须先还原菜单再销毁运行时，否则旧实例会丢失需要还原的列表引用。
  assert.deepEqual(calls, ["restore", "dispose"]);
  assert.equal((env.known.window as Record<string, unknown>).__codexPlusModelPickerGroupsRuntime, undefined);
});

test("热注入结束旧大纲运行时并卸下旧内置拓展", () => {
  const calls: string[] = [];
  const env = harness({
    __codexPlusBuiltinExtensionHandles: new Map([["answer-outline", { dispose: () => calls.push("dispose") }]]),
    __codexStepwisePanel: { destroy: () => calls.push("destroy") },
  });
  assert.deepEqual(calls, ["dispose", "destroy"]);
  assert.equal((env.known.window as any).__codexStepwisePanel, undefined);
});

test("热注入移除旧分类的界面并让旧额度包装回传真实数据", () => {
  const calls: string[] = [];
  const raw = { rate_limit: { allowed: false, limit_reached: true } };
  const previous = { rate_limit: { allowed: true, limit_reached: false } };
  const runtime = { rawPayloads: new WeakMap([[previous, raw]]), rewrite: (_value: unknown): unknown => previous };
  const env = harness({
    __codexPlusBuiltinExtensionHandles: new Map([["instance-identity", { dispose: () => calls.push("dispose") }]]),
    __codexPlusOfficialUsageWindowCleanup: () => calls.push("restore"),
    __codexPlusNativeQuotaBootstrap: { dispose: () => calls.push("quota:stop") },
    __codexPlusOfficialUsageRuntime: runtime,
  });
  assert.deepEqual(calls, ["dispose", "restore", "quota:stop"]);
  assert.equal(runtime.rewrite(previous), raw);
  assert.equal(runtime.rewrite(raw), raw);
  env.api.sync();
  assert.equal(env.domListeners.length, 0, "退役分类不再安装 DOM 监听");
});
