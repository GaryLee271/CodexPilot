const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");

const script = fs.readFileSync(require.resolve("./native-project-sections.js"), "utf8");
const channel = fs.readFileSync(require.resolve("./native-fast-unlock.js"), "utf8");
const url = "app://-/assets/app-initial-fixture.js";
const enabled = { enhancementsEnabled: true, codexAppNativeProjectSections: true, nativeProjectSectionsLocalApiConfigured: true };
// 按已核验的原生结构手写最小夹具，覆盖账号投影、schema 清洗与原生存储出口，不复制官方 bundle。
const fixture = [
  "function initialize(){",
  "serverSync=atom(Q,({get:e})=>e(flags,`68267662`));",
  "account=atom(Q,({get:e})=>{let t=e(codexAccess);if(t.status===`allowed`&&`accountId`in t)return t.accountId;let n=e(chatAccess);return n.status===`allowed`&&`accountId`in n&&n.accountId!=null&&n.accountId===e(identity).authenticatedAccountId?n.accountId:null}),hasAccount=atom(Q,({get:e})=>e(account)!=null),sectionEnabled=atom(Q,({get:e})=>e(hasAccount));",
  "stored=atom(Q,({get:e,scope:t})=>{if(bridge?.savedCustomSections!=null)return e(serverState);let n=readLocal();return n});}",
  "function watchSections(e){return e.watch(({get:e})=>{let n=e(account);if(controller.retireExcept(n),n!=null&&bridge?.savedCustomSections!=null){importLegacy(n)}})}",
  "function collapse(e,t,n){let r=bridge?.savedCustomSections,i=e.get(account);if(r!=null&&i!=null&&e.get(sectionEnabled)){r.collapse(t,n)}else writeLocal(t,n)}",
  "function writeSections(e,t,n){let r=Object.fromEntries(Object.entries(t).map(([e,t])=>[e,sanitize(t)])),i=e.get(account),a=i==null?void 0:r[i];if(a!=null){let t=a.threadHostIds??{};a.threadHostIds=Object.keys(t).length===0?void 0:t}e.set(rawAtom,storageKey,r)}",
  // 内容发现的锚点来自持久化键，不依赖压缩后的变量名。
  "const storageKey=`sidebar-custom-sections-v3`;",
].join("");

// 按 Rspack 的模块边界重建最小分区链路；模块名、导出名和局部变量都不是补丁契约。
const rspackUrl = "app://-/assets/async/123.abcd.js";
const rspackFixture = `globalThis.sectionFactories={
  Accounts(e,t,n){var r=n("Atoms"),i=n("Identity"),a=n("Access"),s=n("Scope");let o=(0,r.un)(s.u,({get:e})=>{let t=e(i.access);if("allowed"===t.status&&"accountId"in t)return t.accountId;let n=e(a.chat);return"allowed"===n.status&&"accountId"in n&&null!=n.accountId&&n.accountId===e(i.identity).authenticatedAccountId?n.accountId:null}),l=(0,r.un)(s.u,({get:e})=>null!=e(o)),u=(0,r.un)(s.u,({get:e})=>e(l));n.d(t,{},{account:o,enabled:u})},
  Sync(e,t,n){var r=n("Atoms"),i=n("Scope"),a=n("Flags");let s=(0,r.un)(i.u,({get:e})=>e(a.flags,"68267662"));n.d(t,{},{sync:s})},
  Storage(e,t,n){var a=n("Atoms"),b=n("Scope"),d=n("Bridge"),h=n("Accounts"),o=n("Schema"),f=n("Key");let v="rawAtom",E=(0,a.un)(b.u,({get:e,scope:t})=>{if(d.appServices?.savedCustomSections!=null)return e("serverState");let n=e(v,f.key);return n});n.d(t,{},{write:function(e,t,n){let r=Object.fromEntries(Object.entries(t).map(([e,t])=>[e,(0,o.sanitize)(t)])),i=e.get(h.account),a=null==i?void 0:r[i];if(null!=a){let t=a.threadHostIds??{};a.threadHostIds=0===Object.keys(t).length?void 0:t}e.set(v,f.key,r)},stored:E})},
  Watch(e,t,n){var p=n("Accounts"),u=n("Bridge");function watch(e){return e.watch(({get:e})=>{let n=e(p.account);if(controller.retireExcept(n),null!=n&&u.appServices?.savedCustomSections!=null){importLegacy(n)}})}n.d(t,{},{watch})},
  Collapse(e,t,n){var I=n("Accounts"),_=n("Bridge");function collapse(e,t,n){let i=_.appServices?.savedCustomSections,a=e.get(I.account);if(null!=i&&null!=a&&e.get(I.enabled)){i.collapse(t,n)}else writeLocal(t,n)}n.d(t,{},{collapse})}
};const storageKey="sidebar-custom-sections-v3";`;

test("Rspack 数字资源中的分区链路可完整改写，旧版路径继续可用", () => {
  const { api } = harness();
  const result = api.transform(rspackFixture, rspackUrl);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.matched, 6);
  assert.equal(api.plan(fixture, rspackUrl).ok, true);
  assert.equal(api.plan(result.patchedSource, rspackUrl).diagnostics.reason, "already-patched");
  assert.equal(spawnSync(process.execPath, ["--check"], { input: result.patchedSource, encoding: "utf8" }).status, 0);
});

function harness(settings = enabled, options = {}) {
  const calls = [];
  const native = { authenticatedAccountId: null, authLoading: false, authMethod: "apiKey", ...options.identity };
  const memory = options.memory ?? { sections: [{ id: "section-1", name: "工作", itemKeys: ["codex:project:project-1"] }], collapsedSectionIds: [], sectionOrder: ["custom:section-1"] };
  let accounts = options.accounts ?? { "codex-plus:local-api-sections:v1": memory };
  const window = {};
  const context = vm.createContext({ window, module: { exports: {} }, URL, Symbol });
  vm.runInContext(script, context);
  const api = window.__codexPlusNativeProjectSections;
  api.runtime.update(settings);
  const result = api.transform(options.rspack ? rspackFixture : fixture, options.rspack ? rspackUrl : url);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const values = new Map();
  Object.assign(context, {
    Q: {}, atom: (_, reader) => reader,
    flags: "flags", identity: "identity", codexAccess: "codexAccess", chatAccess: "chatAccess", serverState: "serverState",
    rawAtom: "rawAtom",
    bridge: { savedCustomSections: { collapse: (...args) => calls.push(["server-collapse", ...args]) } },
    controller: { retireExcept: () => {} },
    importLegacy: () => calls.push(["server-import"]),
    readLocal: () => accounts[scope.get(context.account)],
    // 模拟旧 schema 丢弃未知字段、Xht 无条件清空 appearance 的真实行为。
    sanitize: (value) => {
      const known = ["sections", "collapsedSectionIds", "sectionOrder", "threadHostIds", "appServerLegacySectionIds", "appServerMigratedHostIds", "appServerDeletedSectionIds"];
      const sectionKnown = ["id", "name", "itemKeys", "hostSectionIds", "pendingDeletionHostIdsByItemKey"];
      const result = Object.fromEntries(Object.entries(value).filter(([key]) => known.includes(key)));
      result.sections = value.sections.map((section) => ({ ...Object.fromEntries(Object.entries(section).filter(([key]) => sectionKnown.includes(key))), appearance: null }));
      return result;
    },
    writeLocal: (section, collapsed) => {
      calls.push(["local-collapse", section, collapsed]);
      memory.collapsedSectionIds = collapsed ? [section] : [];
    },
  });
  values.set("identity", native);
  values.set("flags", true);
  values.set("codexAccess", options.codexAccess ?? { status: "denied" });
  values.set("chatAccess", options.chatAccess ?? { status: "denied" });
  values.set("serverState", "official-state");
  const scope = {
    get(key) { return key === "rawAtom" ? accounts : typeof key === "function" ? key({ get: scope.get, scope }) : values.get(key); },
    set(key, name, value) { assert.equal(key, "rawAtom"); assert.equal(name, "sidebar-custom-sections-v3"); accounts = value; },
    watch(reader) { return reader({ get: scope.get }); },
  };
  if (options.rspack) {
    vm.runInContext(result.patchedSource, context);
    const modules = { Atoms: { un: context.atom }, Scope: { u: context.Q }, Identity: { identity: "identity", access: "codexAccess" }, Access: { chat: "chatAccess" }, Flags: { flags: "flags" }, Bridge: { appServices: context.bridge }, Schema: { sanitize: context.sanitize }, Key: { key: "sidebar-custom-sections-v3" } };
    const requireModule = (name) => {
      if (!Object.hasOwn(modules, name)) {
        modules[name] = {};
        context.sectionFactories[name]({}, modules[name], requireModule);
      }
      return modules[name];
    };
    requireModule.d = (target, unused, exports) => Object.assign(target, exports);
    Object.assign(context, requireModule("Accounts"), requireModule("Sync"), requireModule("Storage"), requireModule("Watch"), requireModule("Collapse"));
    context.sectionEnabled = context.enabled;
    context.serverSync = context.sync;
    context.writeSections = context.write;
    context.watchSections = context.watch;
  } else vm.runInContext(result.patchedSource + ";initialize();", context);
  return { api, context, calls, scope, memory, get accounts() { return accounts; }, read: (name) => {
    const value = scope.get(context[name]);
    return options.rspack && name === "stored" && typeof value === "object" ? value[scope.get(context.account)] : value;
  }, write: (next) => context.writeSections(scope, next) };
}

test("Rspack 实际执行 API 创建、折叠和重载，访问器不受内层 n 参数与 let 遮蔽影响", () => {
  const h = harness(enabled, { rspack: true, accounts: {} });
  assert.equal(h.read("sectionEnabled"), true);
  assert.equal(h.read("serverSync"), false);
  assert.equal(h.read("stored"), undefined);
  const created = { sections: [{ id: "new", name: "新分区", itemKeys: [] }], collapsedSectionIds: [], sectionOrder: ["custom:new"] };
  h.write({ [h.read("account")]: created });
  h.context.watchSections(h.scope);
  assert.equal(h.read("stored").sections[0].name, "新分区");
  const reloaded = harness(enabled, { rspack: true, accounts: h.accounts, memory: h.accounts[h.read("account")] });
  reloaded.context.collapse(reloaded.scope, "new", true);
  assert.deepEqual(reloaded.calls, [["local-collapse", "new", true]]);
  assert.deepEqual(reloaded.read("stored").collapsedSectionIds, ["new"]);
});

test("Rspack 官方账号沿用同步；关闭开关、未知身份和加载中均不放宽", () => {
  const h = harness(enabled, { rspack: true, identity: { authenticatedAccountId: "official", authMethod: "chatgpt" }, codexAccess: { status: "allowed", accountId: "official" } });
  assert.equal(h.read("account"), "official");
  assert.equal(h.read("stored"), "official-state");
  assert.equal(h.read("serverSync"), true);
  h.context.watchSections(h.scope);
  h.context.collapse(h.scope, "s1", true);
  assert.deepEqual(h.calls, [["server-import"], ["server-collapse", "s1", true]]);
  for (const identity of [{ authLoading: true }, { authMethod: "other" }, { authenticatedAccountId: "official" }]) assert.equal(harness(enabled, { rspack: true, identity }).read("account"), null);
  for (const key of ["enhancementsEnabled", "codexAppNativeProjectSections", "nativeProjectSectionsLocalApiConfigured"]) assert.equal(harness({ ...enabled, [key]: false }, { rspack: true }).read("sectionEnabled"), false);
});

test("Rspack 缺失、重复和跨模块绑定不一致时拒绝整体改写，非法资源地址继续拒绝", () => {
  const { api } = harness();
  for (const source of [rspackFixture + rspackFixture, rspackFixture.replace('"68267662"', '"other"'), rspackFixture.replace('u=n("Bridge")', 'u=n("OtherBridge")'), rspackFixture.replace('h=n("Accounts")', 'h=n("OtherAccounts")'), rspackFixture.replace('a.threadHostIds=', 'a.other='), rspackFixture.replace('i=n("Identity")', 'i=n.n(other)')]) {
    const result = api.transform(source, rspackUrl);
    assert.equal(result.ok, false, result.diagnostics.reason);
    assert.equal(result.patchedSource, source);
  }
  for (const bad of [rspackUrl + "?query=1", rspackUrl + "#hash", rspackUrl.replace("app:", "https:"), rspackUrl.replace("123.abcd", "name.hash"), rspackUrl.replace("/async/", "/other/")]) assert.equal(api.plan(rspackFixture, bad).ok, false);
});

test("Rspack 仅启用分区也能通过共享发现通道准备模块", async () => {
  const context = vm.createContext({ window: {}, module: { exports: {} }, URL, Symbol });
  vm.runInContext(channel, context);
  vm.runInContext(script, context);
  context.window.__codexPlusNativeProjectSections.runtime.update(enabled);
  const result = await context.window.__codexPlusNativeFastUnlock.prepareDocumentModules({ location: new URL("app://-/index.html"), assetUrls: [rspackUrl], fetchText: async () => rspackFixture });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.rewriters["project-sections"], "patched");
  assert.equal(result.modules.length, 1);
});

test("当前安装包的分区模块能够完整准备且生成合法 JavaScript", { skip: !process.env.CODEX_NATIVE_PROJECT_SECTIONS_ASAR }, async () => {
  // 可选的只读实包回归：按内容发现数字块，不把官方 bundle 或会变化的 chunk ID 提交到仓库。
  const fd = fs.openSync(process.env.CODEX_NATIVE_PROJECT_SECTIONS_ASAR, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, header, 0, header.length, 16);
    const chunks = JSON.parse(header).files.webview.files.assets.files.async.files;
    const modules = [];
    for (const [name, entry] of Object.entries(chunks)) {
      if (!/^\d+\.[a-f0-9]+\.js$/.test(name)) continue;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, buffer.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
      const source = buffer.toString("utf8");
      if (source.includes("sidebar-custom-sections-v3") && source.includes("savedCustomSections")
        || source.includes("requestUserMessagePrediction")
        || source.includes("4290031608") && source.includes("cumberbatch-has-accepted-prediction-1")
        || source.includes("cumberbatch-availability") && source.includes("settings.general.messagePredictions.label")) modules.push({ url: `app://-/assets/async/${name}`, source });
    }
    assert.equal(modules.filter(({ source }) => source.includes("sidebar-custom-sections-v3") && source.includes("savedCustomSections")).length, 1, "必须唯一发现原生分区模块");
    const context = vm.createContext({ window: {}, module: { exports: {} }, URL, Symbol });
    vm.runInContext(channel, context);
    vm.runInContext(script, context);
    context.window.__codexPlusNativeProjectSections.runtime.update(enabled);
    // 同时覆盖独立开启和与预测共享入口，组合时所有改写器都必须成功，不能被整体 ok 掩盖。
    vm.runInContext(fs.readFileSync(require.resolve("./native-predictions.js"), "utf8"), context);
    for (const predictions of [false, true]) {
      context.window.__codexPlusNativePredictions.runtime.update({ enhancementsEnabled: true, codexAppNativePredictions: predictions, nativePredictionsLocalApiConfigured: true });
      const result = context.window.__codexPlusNativeFastUnlock.prepareModules(modules);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.diagnostics.rewriters["project-sections"], "patched");
      if (predictions) assert.equal(result.diagnostics.rewriters.predictions, "patched");
      for (const module of result.modules) {
        const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: module.patchedSource, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        assert.equal(syntax.status, 0, syntax.stderr.slice(-2000));
      }
    }
  } finally { fs.closeSync(fd); }
});

test("API 模式启用完整分区门控，读取和折叠走本地存储，重载后保留数据", () => {
  const h = harness();
  assert.equal(h.read("sectionEnabled"), true);
  assert.equal(h.read("serverSync"), false);
  assert.equal(h.read("stored"), h.memory);
  h.context.watchSections(h.scope);
  h.context.collapse(h.scope, "section-1", true);
  assert.deepEqual(h.calls, [["local-collapse", "section-1", true]]);
  const reloaded = harness(enabled, { memory: h.memory });
  assert.equal(reloaded.read("account"), h.read("account"), "本机 API 使用稳定且独立的存储命名空间");
  assert.deepEqual(reloaded.read("stored").collapsedSectionIds, ["section-1"]);
  assert.equal(reloaded.read("stored").sections[0].itemKeys[0], "codex:project:project-1");
  const staleAccess = harness(enabled, { codexAccess: { status: "allowed", accountId: "previous-account" } });
  assert.equal(staleAccess.read("account"), h.read("account"), "API 身份不能继承上次账号的分区命名空间");
});

test("官方账号的分区、存储和同步原样保留，不把登录用户映射为本机命名空间", () => {
  const h = harness(enabled, {
    identity: { authenticatedAccountId: "account-1", authMethod: "chatgpt" },
    codexAccess: { status: "allowed", accountId: "account-1" },
  });
  assert.equal(h.read("account"), "account-1");
  assert.equal(h.read("serverSync"), true);
  assert.equal(h.read("stored"), "official-state");
  h.context.watchSections(h.scope);
  h.context.collapse(h.scope, "section-1", true);
  assert.deepEqual(h.calls, [["server-import"], ["server-collapse", "section-1", true]]);
  const chat = harness(enabled, {
    identity: { authenticatedAccountId: "chat-account", authMethod: "chatgpt" },
    chatAccess: { status: "allowed", accountId: "chat-account" },
  });
  assert.equal(chat.read("account"), "chat-account");
});

test("默认关闭、总开关关闭、非本机 API、登录中或未知认证方式均不放宽", () => {
  for (const settings of [null, {}, { ...enabled, enhancementsEnabled: false }, { ...enabled, codexAppNativeProjectSections: false }, { ...enabled, nativeProjectSectionsLocalApiConfigured: false }]) {
    const h = harness(settings);
    assert.equal(h.read("account"), null);
    assert.equal(h.read("sectionEnabled"), false);
    assert.equal(h.read("stored"), "official-state");
  }
  for (const identity of [{ authLoading: true }, { authMethod: "chatgpt" }, { authMethod: "personalAccessToken" }, { authMethod: "other" }, { authenticatedAccountId: "account-2" }]) {
    assert.equal(harness(enabled, { identity }).read("account"), null);
  }
  assert.equal(harness(enabled, { identity: { authMethod: null } }).read("sectionEnabled"), true);
  // 运行时缺失时补丁应恢复原有门控，不能抛错或残留本机分区身份。
  const missingRuntime = harness();
  delete missingRuntime.context.window.__codexPlusNativeProjectSections;
  assert.equal(missingRuntime.read("account"), null);
  assert.equal(missingRuntime.read("sectionEnabled"), false);
});

test("缺少任一存储结构、重复结构、非法资产 URL 或二次改写均整体拒绝", () => {
  const { api } = harness();
  for (const source of [fixture.replace(".savedCustomSections,i=", ".other,i="), fixture + fixture, fixture.replace("68267662", "other"), fixture.replace("Object.fromEntries", "otherConstructor"), fixture.replace("a.threadHostIds=", "a.other=")]) {
    const result = api.transform(source, url);
    assert.equal(result.ok, false);
    assert.equal(result.patchedSource, source);
  }
  for (const bad of ["https://example.test/app-initial.js", "app://remote/assets/app-initial.js", url + "?other=1"]) assert.equal(api.plan(fixture, bad).ok, false);
  const patched = api.transform(fixture, url);
  assert.equal(api.plan(patched.patchedSource, url).diagnostics.reason, "already-patched");
  // 压缩变量改名不会影响门控识别；只改标识符，不改属性、文案或模板字面量。
  const renamed = fixture.replace(/(?<![.\w$`])\b(e|t|n|r|i)\b(?![`])/g, (name) => name + "_renamed");
  assert.equal(api.plan(renamed, url).ok, true);
});

const localKey = "codex-plus:local-api-sections:v1";
// 模拟旧版本残留的关联字段；新版运行时必须忽略这些值。
const legacyLinkedSettings = (id) => ({ ...enabled, codexAppNativeProjectSectionsLinkAccount: true, codexAppNativeProjectSectionsAccountId: id, nativeProjectSectionsLinkedAccountId: id });
function accountState(label) {
  return {
    sections: [
      { id: "s1", name: label, itemKeys: ["codex:project:p1"], appearance: { color: "blue", icon: "star" }, futureSection: { version: 2 }, hostSectionIds: { local: "remote-1" } },
      { id: "s2", name: "归档", itemKeys: [], appearance: { color: "red" } },
    ],
    sectionOrder: ["custom:s1", "custom:s2"], collapsedSectionIds: [],
    threadHostIds: { "thread-1": "local" }, futureAccount: { version: 3 },
  };
}

test("API 分区只更新独立本地数据，保留样式、未知元数据与其它账号原值", () => {
  const original = { "account-a": accountState("工作"), "account-b": accountState("学习"), [localKey]: accountState("API 独立") };
  const untouched = JSON.stringify({ a: original["account-a"], b: original["account-b"] });
  const h = harness(enabled, { accounts: original });
  assert.equal(h.read("account"), localKey);
  assert.equal(h.read("stored"), original[localKey]);
  const next = structuredClone(original);
  const changed = next[localKey];
  changed.sections[0].name = "重命名";
  changed.sections[0].itemKeys = [];
  delete changed.sections[0].hostSectionIds;
  changed.sections[1].itemKeys = ["codex:project:p1"];
  changed.sectionOrder.reverse();
  changed.collapsedSectionIds = ["s1"];
  delete changed.threadHostIds;
  h.write(next);
  const saved = h.accounts[localKey];
  assert.equal(saved.sections[0].name, "重命名");
  assert.deepEqual(Array.from(saved.sections[1].itemKeys), ["codex:project:p1"]);
  assert.equal(JSON.stringify(saved.sections[0].appearance), JSON.stringify(original[localKey].sections[0].appearance));
  assert.equal(JSON.stringify(saved.sections[0].futureSection), '{"version":2}');
  assert.equal(JSON.stringify(saved.futureAccount), '{"version":3}');
  assert.equal(saved.sections[0].hostSectionIds, undefined, "已知可选字段被删除时不能从原值补回");
  assert.equal(saved.threadHostIds, undefined);
  assert.equal(JSON.stringify({ a: h.accounts["account-a"], b: h.accounts["account-b"] }), untouched);
  const reloaded = harness(enabled, { accounts: h.accounts });
  assert.equal(reloaded.read("stored").sections[0].name, "重命名");
  assert.equal(JSON.stringify(reloaded.read("stored").collapsedSectionIds), '["s1"]');
  const deleted = structuredClone(h.accounts);
  deleted[localKey].sections = deleted[localKey].sections.slice(1);
  deleted[localKey].sectionOrder = ["custom:s2"];
  deleted[localKey].collapsedSectionIds = [];
  reloaded.write(deleted);
  assert.equal(reloaded.accounts[localKey].sections.length, 1, "删除的分区不能因元数据合并复活");
  assert.equal(reloaded.accounts[localKey].sections[0].id, "s2");
});

test("旧关联字段和心跳更新都不能将 API 分区切换到账号存储", () => {
  const accounts = { "account-a": accountState("A"), "account-b": accountState("B"), [localKey]: accountState("API") };
  const h = harness(legacyLinkedSettings("account-a"), { accounts });
  assert.equal(h.read("account"), localKey);
  assert.equal(h.read("stored"), accounts[localKey]);
  h.api.runtime.update(legacyLinkedSettings("account-b"));
  assert.equal(h.read("account"), localKey);
  const next = structuredClone(accounts);
  next[localKey].sections[0].name = "修改 API";
  next["account-a"].sections[0].name = "忽略账号副本";
  h.write(next);
  assert.equal(h.accounts[localKey].sections[0].name, "修改 API");
  assert.equal(h.accounts["account-a"], accounts["account-a"]);
  assert.equal(h.accounts["account-b"], accounts["account-b"]);
  assert.equal(harness(legacyLinkedSettings("account-b"), { accounts: h.accounts }).read("account"), localKey);
  for (const invalid of [null, "", "__proto__", "constructor", "codex-plus:other", "bad\naccount"]) {
    assert.equal(harness(legacyLinkedSettings(invalid), { accounts }).read("account"), localKey);
  }
  assert.equal(h.read("serverSync"), false);
  h.context.watchSections(h.scope);
  assert.deepEqual(h.calls, [], "不能导入或同步账号服务中的分区");
});

test("损坏的独立分区和不一致的写入 key 拒绝覆盖，首次使用不复制账号数据", () => {
  for (const previous of [null, { sections: [] }]) {
    const raw = { "account-a": accountState("A"), [localKey]: previous };
    const h = harness(enabled, { accounts: raw });
    const result = h.api.runtime.mergeWrite({ authenticatedAccountId: null, authMethod: "apiKey" }, raw, { [localKey]: accountState("替代") }, localKey);
    assert.equal(result, raw);
  }
  const raw = { "account-a": accountState("A") };
  const h = harness(enabled, { accounts: raw });
  assert.equal(h.read("account"), localKey);
  assert.equal(h.read("stored"), undefined, "无独立分区时不能回退到账号数据");
  h.write({ ...raw, [localKey]: accountState("新的 API") });
  assert.equal(h.accounts["account-a"], raw["account-a"]);
  assert.equal(h.accounts[localKey].sections[0].name, "新的 API");
  assert.equal(h.api.runtime.mergeWrite({ authenticatedAccountId: null }, raw, h.accounts, "account-a"), raw);
});

test("关闭设置但尚未重启时，本地 atom 的写入继续保护元数据；账号身份仍保留原生行为", () => {
  const raw = { "account-a": accountState("A"), [localKey]: accountState("API") };
  const h = harness(enabled, { accounts: raw });
  const cachedKey = h.read("account");
  h.api.runtime.update({ ...enabled, enhancementsEnabled: false, codexAppNativeProjectSections: false });
  const proposed = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, h.context.sanitize(value)]));
  proposed[localKey].sections[0].name = "关闭后未重启的修改";
  const saved = h.api.runtime.mergeWrite({ authenticatedAccountId: null, authMethod: "apiKey" }, raw, proposed, cachedKey);
  assert.equal(saved[localKey].sections[0].name, "关闭后未重启的修改");
  assert.equal(saved[localKey].sections[0].appearance, raw[localKey].sections[0].appearance);
  assert.equal(saved["account-a"], raw["account-a"]);
  assert.equal(h.api.runtime.mergeWrite({ authenticatedAccountId: "account-a", authMethod: "chatgpt" }, raw, proposed, "account-a"), proposed);
});

test("分区可独立准备，也可与 Fast / 预测改写器共享入口模块", () => {
  const window = {};
  const context = vm.createContext({ window, module: { exports: {} }, URL, Symbol });
  vm.runInContext(channel, context);
  vm.runInContext(script, context);
  const api = window.__codexPlusNativeProjectSections;
  api.runtime.update(enabled);
  const result = window.__codexPlusNativeFastUnlock.prepareModules([{ url, source: fixture }]);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.rewriters["project-sections"], "patched");
  assert.equal(result.modules.length, 1);
  assert.match(result.modules[0].patchedSource, /__codexPlusNativeFastCompiled/);
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: result.modules[0].patchedSource, encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
