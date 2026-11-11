(() => {
  const root = typeof window === "object" ? window : {};
  const id = "[A-Za-z_$][\\w$]*";
  const state = root.__codexPlusNativeProjectSections?.state ?? { settings: null };
  // 这只是原生侧栏存储中的本机命名空间，不是账号身份，也不会发送给账号 / 分区服务。
  const localAccountKey = "codex-plus:local-api-sections:v1";
  const record = (value) => value != null && typeof value === "object" && !Array.isArray(value);
  const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const optionalMap = (value, valid) => value === undefined || (record(value) && Object.values(value).every(valid));
  const apiIdentity = (identity) => identity != null && identity.authLoading !== true
    && identity.authenticatedAccountId == null
    && (identity.authMethod == null || identity.authMethod === "apiKey" || identity.authMethod === "apikey");
  function validSections(value) {
    return record(value) && stringList(value.collapsedSectionIds) && stringList(value.sectionOrder)
      && optionalMap(value.threadHostIds, (entry) => typeof entry === "string")
      && ["appServerLegacySectionIds", "appServerMigratedHostIds", "appServerDeletedSectionIds"].every((key) => value[key] === undefined || stringList(value[key]))
      && Array.isArray(value.sections) && value.sections.every((section) => record(section)
        && typeof section.id === "string" && section.id.length > 0
        && typeof section.name === "string" && section.name.trim().length > 0 && stringList(section.itemKeys)
        && optionalMap(section.hostSectionIds, (entry) => typeof entry === "string")
        && optionalMap(section.pendingDeletionHostIdsByItemKey, stringList))
      && new Set(value.sections.map((section) => section.id)).size === value.sections.length;
  }
  // 原生旧 schema 会清掉未知字段；仅替换明确支持的字段，未来版本的元数据继续保留。
  const accountFields = ["sections", "collapsedSectionIds", "sectionOrder", "threadHostIds", "appServerLegacySectionIds", "appServerMigratedHostIds", "appServerDeletedSectionIds"];
  const sectionFields = ["id", "name", "itemKeys", "hostSectionIds", "pendingDeletionHostIdsByItemKey", "appearance"];
  function preserveUnknown(previous, next, fields) {
    return { ...Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => !fields.includes(key))), ...next };
  }
  const runtime = {
    update(settings) {
      state.settings = {
        enhancementsEnabled: settings?.enhancementsEnabled === true,
        codexAppNativeProjectSections: settings?.codexAppNativeProjectSections === true,
        nativeProjectSectionsLocalApiConfigured: settings?.nativeProjectSectionsLocalApiConfigured === true,
      };
      return runtime.status();
    },
    status() {
      return {
        enabled: state.settings?.enhancementsEnabled === true && state.settings?.codexAppNativeProjectSections === true,
        localApiConfigured: state.settings?.nativeProjectSectionsLocalApiConfigured === true,
      };
    },
    isLocalApi(identity) {
      const status = runtime.status();
      // 只接管后端已核验的本机 API 模式；登录中、订阅账号和其它认证方式保留原有行为。
      return status.enabled && status.localApiConfigured && apiIdentity(identity);
    },
    accountKey(identity) {
      if (!runtime.isLocalApi(identity)) return null;
      // 固定复用已有独立 API 分区；旧版关联设置和登录账号都不能改变存储位置。
      return localAccountKey;
    },
    mergeWrite(identity, raw, proposed, accountId) {
      if (!apiIdentity(identity)) return proposed;
      // 关闭后、重启前 atom 可能仍缓存本地 key，继续保护这些写入；账号登录沿用原生路径。
      // API 分区开启时拒绝其它 key，避免旧账号缓存把整理结果写入账号分区。
      if (accountId !== localAccountKey) return runtime.isLocalApi(identity) ? raw : proposed;
      const active = localAccountKey;
      // 损坏的已有分区保留原值，不能借旧 schema 的缓存重新创建或覆盖。
      if (!record(proposed) || !Object.hasOwn(proposed, active)
        || !validSections(proposed[active]) || (raw != null && !record(raw))) return raw;
      const previous = record(raw) && Object.hasOwn(raw, active) ? raw[active] : undefined;
      if (previous !== undefined && !validSections(previous)) return raw;
      const next = proposed[active];
      const byId = new Map((previous?.sections ?? []).map((section) => [section.id, section]));
      const merged = preserveUnknown(previous, next, accountFields);
      // 只遍历下一版 sections，删除不会复活；appearance 被原生 Xht 强制置空，需从原始值恢复。
      merged.sections = next.sections.map((section) => {
        const before = byId.get(section.id);
        const value = preserveUnknown(before, section, sectionFields);
        if (before && Object.hasOwn(before, "appearance")) value.appearance = before.appearance;
        return value;
      });
      // 只替换独立 API 分区；账号数据始终取最新原值，不接受 schema 清洗后的副本。
      return { ...raw, [active]: merged };
    },
  };

  const apiPath = "window.__codexPlusNativeProjectSections?.runtime";
  const localApi = (identity) => `${apiPath}?.isLocalApi?.(${identity})===true`;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function planRspack(source, failed, diagnostics) {
    const member = `${id}\\.${id}`;
    const call = `\\(0,${member}\\)`;
    // Rspack 的每个工厂都有独立的 import 别名；先记录边界，再核对账号、身份和服务来自同一模块。
    const factories = [...source.matchAll(new RegExp(`(?:^|[,{}])\\s*(?<key>${id}|"[\\w$-]+")\\((?<module>${id}),(?<exports>${id}),(?<require>${id})\\)\\{`, "g"))];
    const factoryAt = (index) => factories.findLast((factory) => factory.index < index);
    const factoryEnd = (factory) => factories[factories.indexOf(factory) + 1]?.index ?? source.length;
    const factoryKey = (factory) => factory.groups.key.replace(/^"|"$/g, "");
    const imported = (factory, expression) => {
      const [alias, property] = expression.split(".");
      const pattern = new RegExp(`(?<![\\w$.])${escape(alias)}=${escape(factory.groups.require)}\\("(?<key>[\\w$./-]+)"\\)`, "g");
      const imports = [...source.slice(factory.index, factoryEnd(factory)).matchAll(pattern)];
      return imports.length === 1 ? { key: imports[0].groups.key, property } : null;
    };
    const accountPattern = [
      `(?<account>${id})=(?<atom>${call})\\((?<scope>${member}),\\(\\{get:(?<get>${id})\\}\\)=>\\{(?<entry>let) (?<first>${id})=\\k<get>\\(${member}\\);`,
      `if\\("allowed"===\\k<first>\\.status&&"accountId"in \\k<first>\\)return \\k<first>\\.accountId;`,
      `let (?<second>${id})=\\k<get>\\(${member}\\);return"allowed"===\\k<second>\\.status&&"accountId"in \\k<second>&&`,
      `null!=\\k<second>\\.accountId&&\\k<second>\\.accountId===\\k<get>\\((?<identity>${member})\\)\\.authenticatedAccountId\\?\\k<second>\\.accountId:null\\}\\),`,
      `(?<available>${id})=\\k<atom>\\(\\k<scope>,\\(\\{get:(?<getAvailable>${id})\\}\\)=>null!=\\k<getAvailable>\\(\\k<account>\\)\\),`,
      `${id}=\\k<atom>\\(\\k<scope>,\\(\\{get:(?<getEnabled>${id})\\}\\)=>\\k<getEnabled>\\(\\k<available>\\)\\)`,
    ].join("");
    const accounts = [...source.matchAll(new RegExp(accountPattern, "gd"))];
    diagnostics.matches.account = accounts.length;
    if (accounts.length !== 1) return failed(accounts.length ? "ambiguous-structure" : "missing-account-gate");
    diagnostics.matched++;
    const account = accounts[0];
    const g = account.groups;
    const accountFactory = factoryAt(account.index);
    if (!accountFactory || new Set([g.get, g.first, g.second]).size !== 3) return failed("conflicting-bindings");
    const identity = imported(accountFactory, g.identity);
    const exported = [...source.slice(account.index + account[0].length, factoryEnd(accountFactory))
      .matchAll(new RegExp(`(?<name>${id}):${escape(g.account)}(?=[,}])`, "g"))];
    if (!identity || exported.length !== 1) return failed("unsupported-module-bindings");
    const accountRef = (factory, expression) => {
      const value = imported(factory, expression);
      return value?.key === factoryKey(accountFactory) && value.property === exported[0].groups.name;
    };
    const [start, end] = account.indices.groups.entry;
    const replacements = [{ start, end, text: `if(${localApi(`${g.get}(${g.identity})`)})return (${apiPath}?.accountKey?.(${g.get}(${g.identity}))??null);let` }];
    // 内层 collapse 的参数、读取回调的 let 都可能叫 n，直接插入 n("Identity") 会命中遮蔽变量。
    // 把身份 atom 的惰性访问器放到工厂作用域，避免提前加载模块或依赖压缩变量名。
    const accessor = "__codexPlusSectionIdentity";
    if (source.includes(accessor)) return failed("conflicting-bindings");
    const initialized = new Set();
    const definitions = [
      { kind: "server-sync", pattern: `${id}=${call}\\(${member},\\(\\{get:(?<get>${id})\\}\\)=>(?<value>\\k<get>\\(${member},"68267662"\\))\\)`, text: (c, local) => `(${local}?false:${c.value})` },
      { kind: "storage-read", pattern: `${id}=${call}\\(${member},\\(\\{get:(?<get>${id}),scope:${id}\\}\\)=>\\{if\\((?<value>(?<bridge>${id})\\.appServices\\?\\.savedCustomSections!=null)\\)return \\k<get>\\([^;]{1,120}\\);let `, text: (c, local) => `(${c.value}&&!(${local}))` },
      { kind: "storage-import", pattern: `\\.watch\\(\\(\\{get:(?<get>${id})\\}\\)=>\\{let (?<accountValue>${id})=\\k<get>\\((?<account>${member})\\);if\\(${id}\\.retireExcept\\(\\k<accountValue>\\),null!=\\k<accountValue>&&(?<value>(?<bridge>${id})\\.appServices\\?\\.savedCustomSections!=null)\\)\\{`, text: (c, local) => `(${c.value}&&!(${local}))` },
      { kind: "storage-write", pattern: `function(?: ${id})?\\((?<scope>${id}),(?<accounts>${id}),(?<hint>${id})\\)\\{let (?<next>${id})=Object\\.fromEntries\\(Object\\.entries\\(\\k<accounts>\\)\\.map\\(\\(\\[(?<key>${id}),(?<item>${id})\\]\\)=>\\[\\k<key>,${call}\\(\\k<item>\\)\\]\\)\\),(?<accountValue>${id})=\\k<scope>\\.get\\((?<account>${member})\\),(?<active>${id})=null==\\k<accountValue>\\?void 0:\\k<next>\\[\\k<accountValue>\\];if\\(null!=\\k<active>\\)\\{(?<body>[\\s\\S]{0,2400}?)\\}\\k<scope>\\.set\\((?<storage>${id}),(?<storageKey>${member}),(?<value>\\k<next>)\\)\\}`, text: (c) => `(${apiPath}?.mergeWrite?${apiPath}.mergeWrite(${c.scope}.get(${accessor}()),${c.scope}.get(${c.storage},${c.storageKey}),${c.value},${c.accountValue}):${c.value})` },
      { kind: "storage-collapse", pattern: `function ${id}\\((?<scope>${id}),(?<section>${id}),(?<collapsed>${id})\\)\\{let (?<service>${id})=(?<value>(?<bridge>${id})\\.appServices\\?\\.savedCustomSections),(?<accountValue>${id})=\\k<scope>\\.get\\((?<account>${member})\\);if\\(null!=\\k<service>&&null!=\\k<accountValue>&&\\k<scope>\\.get\\(${member}\\)\\)\\{`, text: (c, local) => `(${local}?void 0:${c.value})` },
    ];
    let bridgeKey = null;
    let storageFactory = null;
    for (const definition of definitions) {
      const matches = [...source.matchAll(new RegExp(definition.pattern, "gd"))];
      diagnostics.matches[definition.kind] = matches.length;
      if (matches.length !== 1) return failed(matches.length ? "ambiguous-structure" : `missing-${definition.kind}`);
      diagnostics.matched++;
      const candidate = matches[0];
      const c = candidate.groups;
      const factory = factoryAt(candidate.index);
      if (!factory || c.account && !accountRef(factory, c.account)) return failed("conflicting-account-bindings");
      if (c.bridge) {
        const key = imported(factory, `${c.bridge}.appServices`)?.key;
        if (!key || bridgeKey != null && bridgeKey !== key) return failed("conflicting-bridge");
        bridgeKey = key;
      }
      if (definition.kind === "storage-read") storageFactory = factory;
      if (definition.kind === "storage-write" && (factory !== storageFactory
        || !c.body.includes(`${c.active}.threadHostIds=`) || !c.body.includes("Object.keys("))) return failed("unsupported-storage-write");
      if (!initialized.has(factory)) {
        const position = factory.index + factory[0].length;
        replacements.push({ start: position, end: position, text: `const ${accessor}=()=>${factory.groups.require}(${JSON.stringify(identity.key)}).${identity.property};` });
        initialized.add(factory);
      }
      const local = localApi(`${c.get ?? `${c.scope}.get`}(${accessor}())`);
      const [start, end] = candidate.indices.groups.value;
      replacements.push({ start, end, text: definition.text(c, local) });
    }
    return { ok: true, replacements, diagnostics };
  }

  function plan(source, url) {
    const diagnostics = { reason: "ready", matched: 0, matches: {} };
    const failed = (reason) => ({ ok: false, replacements: [], diagnostics: { ...diagnostics, reason } });
    if (typeof source !== "string" || !source || typeof url !== "string") return failed("invalid-input");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "app:" || parsed.host !== "-" || !/^\/assets\/(?:[\w-]+\.js|async\/\d+\.[a-f0-9]+\.js)$/.test(parsed.pathname) || parsed.search || parsed.hash) return failed("invalid-url");
    } catch { return failed("invalid-url"); }
    if (source.includes("__codexPlusNativeProjectSections?.runtime")) return failed("already-patched");
    if (source.includes(".appServices?.savedCustomSections")) return planRspack(source, failed, diagnostics);

    // 完整识别“分区账号 → 是否有账号 → 是否显示分区”三联原子，不能改全局登录状态。
    const accountPattern = [
      `(?<account>${id})=(?<atom>${id})\\((?<scope>${id}),\\(\\{get:(?<get>${id})\\}\\)=>\\{(?<entry>let) (?<first>${id})=\\k<get>\\(${id}\\);`,
      `if\\(\\k<first>\\.status===\`allowed\`&&\`accountId\`in \\k<first>\\)return \\k<first>\\.accountId;`,
      `let (?<second>${id})=\\k<get>\\(${id}\\);return \\k<second>\\.status===\`allowed\`&&\`accountId\`in \\k<second>&&`,
      `\\k<second>\\.accountId!=null&&\\k<second>\\.accountId===\\k<get>\\((?<identity>${id})\\)\\.authenticatedAccountId\\?\\k<second>\\.accountId:(?<fallback>null)\\}\\),`,
      `(?<available>${id})=\\k<atom>\\(\\k<scope>,\\(\\{get:(?<getAvailable>${id})\\}\\)=>\\k<getAvailable>\\(\\k<account>\\)!=null\\),`,
      `${id}=\\k<atom>\\(\\k<scope>,\\(\\{get:(?<getEnabled>${id})\\}\\)=>\\k<getEnabled>\\(\\k<available>\\)\\)`,
    ].join("");
    const accounts = [...source.matchAll(new RegExp(accountPattern, "gd"))];
    diagnostics.matches.account = accounts.length;
    if (accounts.length) diagnostics.matched += 1;
    if (accounts.length !== 1) return failed(accounts.length ? "ambiguous-structure" : "missing-account-gate");
    const match = accounts[0];
    const groups = match.groups;
    if (new Set([groups.get, groups.first, groups.second]).size !== 3) return failed("conflicting-bindings");
    const [accountStart, accountEnd] = match.indices.groups.entry;
    // API 身份确认后始终使用独立本地命名空间，不读取或复用账号分区。
    const replacements = [{
      start: accountStart,
      end: accountEnd,
      text: `if(${localApi(`${groups.get}(${groups.identity})`)})return (${apiPath}?.accountKey?.(${groups.get}(${groups.identity}))??null);let`,
    }];

    // 三个持久化入口必须一起切换：读取、旧数据导入和折叠写入。否则会出现入口可见但无法保存。
    const definitions = [
      {
        kind: "server-sync",
        // 仅替换分区同步的专用 gate，不更改账号或其它远程能力。
        pattern: `(?<flag>${id})=${escape(groups.atom)}\\(${escape(groups.scope)},\\(\\{get:(?<get>${id})\\}\\)=>(?<value>\\k<get>\\(${id},\`68267662\`\\))\\)`,
        replacement: (g) => `(${localApi(`${g.get}(${groups.identity})`)}?false:${g.value})`,
        capture: "value",
      },
      {
        kind: "storage-read",
        pattern: `${id}=${escape(groups.atom)}\\(${escape(groups.scope)},\\(\\{get:(?<get>${id}),scope:${id}\\}\\)=>\\{if\\((?<value>(?<bridge>${id})\\?\\.savedCustomSections!=null)\\)return \\k<get>\\(${id}\\);let `,
        replacement: (g) => `(${g.value}&&!(${localApi(`${g.get}(${groups.identity})`)}))`,
        capture: "value",
      },
      {
        kind: "storage-import",
        pattern: `\\.watch\\(\\(\\{get:(?<get>${id})\\}\\)=>\\{let (?<accountValue>${id})=\\k<get>\\(${escape(groups.account)}\\);if\\(${id}\\.retireExcept\\(\\k<accountValue>\\),\\k<accountValue>!=null&&(?<value>(?<bridge>${id})\\?\\.savedCustomSections!=null)\\)\\{`,
        replacement: (g) => `(${g.value}&&!(${localApi(`${g.get}(${groups.identity})`)}))`,
        capture: "value",
      },
      {
        kind: "storage-write",
        // 锚定唯一的本地写入口，并核对线程主机映射。不能只改账号 key，否则会清空账号分区样式。
        pattern: `function ${id}\\((?<scope>${id}),(?<accounts>${id}),(?<hint>${id})\\)\\{let (?<next>${id})=Object\\.fromEntries\\(Object\\.entries\\(\\k<accounts>\\)\\.map\\(\\(\\[(?<key>${id}),(?<item>${id})\\]\\)=>\\[\\k<key>,${id}\\(\\k<item>\\)\\]\\)\\),(?<accountValue>${id})=\\k<scope>\\.get\\(${escape(groups.account)}\\),(?<active>${id})=\\k<accountValue>==null\\?void 0:\\k<next>\\[\\k<accountValue>\\];if\\(\\k<active>!=null\\)\\{(?<body>[\\s\\S]{0,2400}?)\\}\\k<scope>\\.set\\((?<storage>${id}),(?<storageKey>${id}),(?<value>\\k<next>)\\)\\}`,
        replacement: (g) => `(${apiPath}?.mergeWrite?${apiPath}.mergeWrite(${g.scope}.get(${groups.identity}),${g.scope}.get(${g.storage},${g.storageKey}),${g.value},${g.accountValue}):${g.value})`,
        capture: "value",
      },
      {
        kind: "storage-collapse",
        pattern: `function ${id}\\((?<scope>${id}),(?<section>${id}),(?<collapsed>${id})\\)\\{let (?<service>${id})=(?<value>(?<bridge>${id})\\?\\.savedCustomSections),(?<accountValue>${id})=\\k<scope>\\.get\\(${escape(groups.account)}\\);if\\(\\k<service>!=null&&\\k<accountValue>!=null&&\\k<scope>\\.get\\(${id}\\)\\)\\{`,
        replacement: (g) => `(${localApi(`${g.scope}.get(${groups.identity})`)}?void 0:${g.value})`,
        capture: "value",
      },
    ];
    let bridge = null;
    for (const definition of definitions) {
      const matches = [...source.matchAll(new RegExp(definition.pattern, "gd"))];
      diagnostics.matches[definition.kind] = matches.length;
      if (matches.length) diagnostics.matched += 1;
      if (matches.length !== 1) return failed(matches.length ? "ambiguous-structure" : `missing-${definition.kind}`);
      const candidate = matches[0];
      if (definition.kind === "storage-write"
        && (!candidate.groups.body.includes(`${candidate.groups.active}.threadHostIds=`) || !candidate.groups.body.includes("Object.keys("))) return failed("unsupported-storage-write");
      if (candidate.groups.bridge) {
        if (bridge != null && bridge !== candidate.groups.bridge) return failed("conflicting-bridge");
        bridge = candidate.groups.bridge;
      }
      const [start, end] = candidate.indices.groups[definition.capture];
      // 与共享模块通道统一使用 [start, end)；不能使用长度，否则组合改写会截坏模块。
      replacements.push({ start, end, text: definition.replacement(candidate.groups) });
    }
    return { ok: true, replacements, diagnostics };
  }

  function transform(source, url) {
    const result = plan(source, url);
    let patchedSource = source;
    if (result.ok) {
      for (const replacement of [...result.replacements].sort((a, b) => b.start - a.start)) {
        patchedSource = patchedSource.slice(0, replacement.start) + replacement.text + patchedSource.slice(replacement.end);
      }
    }
    return { ...result, patchedSource };
  }

  const rewriter = {
    id: "project-sections",
    enabled: () => runtime.status().enabled,
    targets: [{ name: "app-initial", prefix: "app-initial-", entry: true, anchors: ["sidebar-custom-sections-v3", "savedCustomSections", "authenticatedAccountId"] }],
    plan,
  };
  const api = { runtime, plan, transform, rewriter, state };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "object") {
    window.__codexPlusNativeProjectSections = api;
    window.__codexPlusNativeFastUnlock?.registerRewriter?.(rewriter);
  }
})();
