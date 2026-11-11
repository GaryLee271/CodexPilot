const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// 以下夹具是按原生压缩结构手写的最小片段，不包含官方 bundle 正文。
const availability = function availabilityAtom(W,V,e_,Cr,N,mi){let E3s;E3s=W(V,({get:e})=>e(e_,`4290031608`)&&Cr(e,N().enabled)&&mi.cumberbatch!=null);return E3s}.toString();
const catchUp = function catchUpQuery(_t,c,s,Rt,wp,Qr,tn){let l=_t.cumberbatch,u;u=[`cumberbatch`,c];let d;d=c==null||l==null?null:e=>{let{signal:t}=e,n={...c,generationTrigger:`catch_up`};s.seen=c.latestTurnId;let r=new Rt(e=>{wp({scope:s,target:n,ineligibility:e})});return Qr(tn(l.requestUserMessagePrediction(n,r)),t)};return d}.toString();
const live = async function livePrediction(e,t,n,r){let i=H?.cumberbatch;if(i!=null&&!R(n.hostId)&&r()&&Kl(e,`4290031608`))try{let o=await t.getCachedConversationMetadata(n.conversationId);if(!r()||!Kl(e,`4290031608`)||o?.streamRole?.role!==`owner`||o.latestTurnId!==n.turnId)return;let s={hostId:n.hostId,threadId:n.conversationId,latestTurnId:n.turnId,generationTrigger:`live`},c=new pt(t=>{r()&&ol({scope:e,target:s,ineligibility:t})}),l=await kt(i.requestUserMessagePrediction(s,c));l!=null&&r()&&Bc({scope:e,target:s,prediction:l})}catch(e){Bc({error:e})}}.toString();
const settingsRow = function predictionsRow(Et,he,L,Xn,En,g,n,T,i,Ct,z,Je){let s=Et(`4290031608`),c=he.cumberbatch,l=L(Xn),u=L(En),d;d=[`cumberbatch-availability`,l,u];let f;f=s&&c!=null?async e=>c!=null&&c.isEnabledByRemoteConfig():Je;let{data:m,isError:h}=g({queryKey:d,queryFn:f});if(!s||m!==!0||h)return null;let _=z({id:`settings.general.messagePredictions.label`});return{label:_,control:{onChange:e=>{T(n,i,e),Ct({scope:n,globallyEnabled:e})}}}}.toString();

const fixtures = {
  "app-initial": availability,
  "composer-content": catchUp,
  "initialize-app-host-services": live,
  "general-settings": settingsRow,
};
// 新打包器的最小手写夹具，保留模块导出调用、空值判断与资源释放包装。
const currentFixtures = {
  "app-initial": function availability(A,B,C,D,E,F){let h=(0,A.atom)(B.scope,({get:e})=>e(C.flag,"4290031608")&&(0,D.preference)(e,(0,E.definition)().enabled)&&null!=F.appServices.cumberbatch);return h}.toString(),
  "composer-content": function catchUp(A,S,j,R,U,V,W,C){let M=A.appServices.cumberbatch,x,t,n; t=["cumberbatch",j];n=null==j||null==M?R.disabled:async e=>{let{signal:t}=e,delay=1;await Promise.resolve(delay);let o={...j,generationTrigger:"catch_up"},a=new U.Callback(e=>{(0,C.ineligible)({scope:S,target:o,ineligibility:e})});return await (0,V.abort)((0,W.unwrap)(M.requestUserMessagePrediction(o,a)),t).then(e=>(null!=e&&(0,C.store)({scope:S,target:o,prediction:e}),e))};return n}.toString(),
  "initialize-app-host-services": async function(e,t,n,a){let s=H.appServices?.cumberbatch;if(!(null==s||null!=n.automationKind||(0,I.remote)(n.hostId))&&a()&&(0,J.check)(e,"4290031608"))try{let i={};try{let o=(0,R.resource)(i,await t.getCachedConversationMetadata(n.conversationId),!1);if(!a()||!(0,J.check)(e,"4290031608")||o?.streamRole?.role!=="owner"||o.ephemeral||o.latestTurnId!==n.turnId)return;let l={hostId:n.hostId,threadId:n.conversationId,latestTurnId:n.turnId},u=e.get("account"),d=e.get("user"),c={...l,generationTrigger:"live"},p=(0,R.resource)(i,new T.Callback(t=>{a()&&(0,C.ineligible)({scope:e,target:c,ineligibility:t})}),!1),h=0,f=await (0,U.unwrap)(s.requestUserMessagePrediction(c,p));null!=f&&a()&&(0,C.store)({scope:e,target:c,prediction:f})}finally{R.dispose(i)}}catch(error){C.error(error)}}.toString(),
  "general-settings": function settings(F,H,G,N,D,C){let f=(0,F.check)("4290031608"),m=H.appServices.cumberbatch,b=1,y=2,t,a;t=["cumberbatch-availability",b,y];a=f?async e=>{let{signal:t}=e;if(null!=m)return m.isEnabledByRemoteConfig();return false}:D.disabled;let data=true;return!f||!data?null:({label:"settings.general.messagePredictions.label",query:a,onChange:e=>{(0,G.write)(N,D,e),(0,C.preference)({scope:N,globallyEnabled:e})}})}.toString(),
};
const urls = {
  "app-initial": "app://-/assets/app-initial-fixture.js",
  "composer-content": "app://-/assets/composer-content-fixture.js",
  "initialize-app-host-services": "app://-/assets/initialize-app-host-services-fixture.js",
  "general-settings": "app://-/assets/general-settings-fixture.js",
};
const helper = fs.readFileSync(require.resolve("./native-predictions.js"), "utf8");
const channel = fs.readFileSync(require.resolve("./native-fast-unlock.js"), "utf8");
const enabled = { enhancementsEnabled: true, codexAppNativePredictions: true, nativePredictionsLocalApiConfigured: true };

function harness({ provider = "custom-relay", respond = true } = {}) {
  const listeners = [];
  const sent = [];
  const timers = new Map();
  let nextTimer = 0;
  let uuid = 0;
  const window = {
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
    setTimeout(callback, delay) { const timer = ++nextTimer; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    electronBridge: {
      sendMessageFromView(message) {
        sent.push(JSON.parse(JSON.stringify(message)));
        if (respond && message.type === "mcp-request" && message.request.method === "thread/read") {
          queueMicrotask(() => deliver({ type: "mcp-response", hostId: "local", message: { id: message.request.id, result: { thread: { id: message.request.params.threadId, modelProvider: provider, model: "relay-model" } } } }));
        }
        return Promise.resolve();
      },
    },
  };
  const deliver = (data) => { for (const listener of [...listeners]) listener({ data }); };
  const context = vm.createContext({ module: { exports: {} }, window, queueMicrotask, Symbol, URL });
  vm.runInContext(helper, context);
  const api = window.__codexPlusNativePredictions;
  api.runtime.update(enabled);
  const samples = () => sent.filter((message) => message.type === "mcp-request" && message.request.method === "thread/sample");
  const cancels = () => sent.filter((message) => message.type === "mcp-request" && message.request.method === "thread/sample/cancel");
  const respondSample = (message, result) => deliver({ type: "mcp-response", hostId: "local", message: { id: message.request.id, ...result } });
  const runTimers = (delay) => {
    for (const [timer, entry] of [...timers]) {
      if (delay == null || entry.delay === delay) { timers.delete(timer); entry.callback(); }
    }
  };
  return { api, window, sent, samples, cancels, deliver, respondSample, runTimers, timers, context };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const target = (turn = "turn-1", trigger = "live", threadId = "thread-1", hostId = "local") => ({ hostId, threadId, latestTurnId: turn, generationTrigger: trigger });

function runRewriterTests() {
  const { api } = harness();
  for (const [name, source] of Object.entries(fixtures)) {
    const result = api.plan(source, urls[name], name);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(api.transform(result.ok ? api.transform(source, urls[name], name).patchedSource : source, urls[name], name).ok, false, `${name}: 补丁后的源码不会被再次改写`);
    for (const replacement of result.replacements) assert.ok(!/[\r\n]/.test(replacement.text));
    // 压缩局部名整体换名后仍按引用关系定位。
    const renamed = source.replace(/(?<![.\w$`])\b(e|t|n|r|i|s|c|l|u|d|f|m|h|o|_)\b(?![`])/g, (local) => `${local}_r`);
    assert.equal(api.plan(renamed, urls[name], name).ok, true, `${name}: 局部绑定改名`);
    const missing = api.transform(`${source.slice(0, 20)}`, urls[name], name);
    assert.equal(missing.ok, false);
    assert.equal(missing.patchedSource, source.slice(0, 20), "结构缺失时块保持原样");
    const duplicated = `${source}\n${source}`;
    const duplicate = api.transform(duplicated, urls[name], name);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.diagnostics.reason, "ambiguous-structure");
    assert.equal(duplicate.patchedSource, duplicated);
  }
  assert.equal(api.plan(catchUp.replace("let r=new Rt", "let n=new Rt").replace("(n,r)),t)", "(n,n)),t)"), urls["composer-content"], "composer-content").ok, false, "绑定冲突时放弃");
  assert.equal(api.plan(live.replace("generationTrigger:`live`", "generationTrigger:`other`"), urls["initialize-app-host-services"], "initialize-app-host-services").diagnostics.reason, "incomplete-structure");
  assert.equal(api.plan(availability, urls["app-initial"], "unknown").ok, false);
  assert.equal(api.plan("", urls["app-initial"], "app-initial").diagnostics.reason, "invalid-input");
  for (const [name, source] of Object.entries(currentFixtures)) {
    const result = api.transform(source, urls[name], name);
    assert.equal(result.ok, true, `${name}: Rspack ${JSON.stringify(result.diagnostics)}`);
    new vm.Script(`(${result.patchedSource})`);
    assert.equal(api.plan(result.patchedSource, urls[name], name).ok, false);
    assert.equal(api.plan(`${source}\n${source}`, urls[name], name).diagnostics.reason, "ambiguous-structure");
    assert.equal(api.plan(`${source}\n${fixtures[name]}`, urls[name], name).diagnostics.reason, "ambiguous-structure", "新旧结构同时存在时不可任选");
  }
}

function patchedFixture(name, runtimePresent = true) {
  const { api, window, context } = harness();
  const result = api.transform(fixtures[name], urls[name], name);
  assert.equal(result.ok, true);
  if (!runtimePresent) delete window.__codexPlusNativePredictions;
  return { api, window, context, source: result.patchedSource };
}

async function runGateTests() {
  // 可用性：原生门控通过时原样；只为本机自定义 API 放宽，并记录原生 Show predictions 偏好。
  for (const runtimePresent of [true, false]) {
    const { api, context, source } = patchedFixture("app-initial", runtimePresent);
    const atom = vm.runInContext(`(${source})`, context);
    const evaluate = (gate, preference) => atom((_, read) => read({ get: () => gate }), null, "gate", (_, value) => value === "enabled" && preference, () => ({ enabled: "enabled" }), { cumberbatch: {} });
    assert.equal(evaluate(true, true), true);
    assert.equal(evaluate(false, true), runtimePresent, "放宽仅在运行时存在且开启时发生");
    assert.equal(evaluate(false, false), false, "原生偏好关闭时不可用");
    if (runtimePresent) {
      assert.equal(api.state.preference, false);
      api.runtime.update({ ...enabled, nativePredictionsLocalApiConfigured: false });
      assert.equal(evaluate(false, true), false, "当前配置不是自定义 API 时不放宽");
      api.runtime.update({ ...enabled, codexAppNativePredictions: false });
      assert.equal(evaluate(false, true), false, "功能开关关闭时恢复原生门控");
      api.runtime.update({ ...enabled, enhancementsEnabled: false });
      assert.equal(evaluate(false, true), false, "增强总开关关闭时恢复原生门控");
    }
  }
  const { api } = harness();
  assert.equal(api.gate(false, "remote-host", "live"), false, "远端主机不放宽");
  assert.equal(api.gate(false, "local", "live"), false, "可用性门控未打补丁时后台路径不放宽");
  assert.equal(api.gate(false, "local", "availability"), true);
  assert.equal(api.gate(false, "local", "live"), true);
  assert.equal(api.gate(false, "ssh:host", "live"), false);
  assert.equal(api.gate(true, "ssh:host", "live"), true, "官方门控结果原样保留");
  assert.equal(api.state.officialGate, true);
  for (const value of [1, "true", null, undefined]) assert.equal(api.gate(value, "local", "availability"), true, "非布尔视为未通过但仍可放宽");
  api.runtime.update(null);
  assert.equal(api.gate(false, "local", "availability"), false);

  // 设置行：只有放宽成立时声明 remote config 可用；偏好切换会同步给运行时。
  {
    const { api, context, source } = patchedFixture("general-settings");
    const row = vm.runInContext(`(${source})`, context);
    let query = null;
    const writes = [];
    const render = (gate, official) => row(() => gate, { cumberbatch: { isEnabledByRemoteConfig: async () => official } }, (v) => v, "x", "y",
      (options) => { query = options; return { data: true, isError: false }; }, "scope", (...args) => writes.push(args), "definition", () => {}, (v) => v, "disabled");
    const rendered = render(false, false);
    assert.ok(rendered, "自定义 API 下显示原生 Show predictions 行");
    assert.equal(await query.queryFn(), true);
    rendered.control.onChange(false);
    assert.equal(api.state.preference, false);
    assert.deepEqual(writes[0], ["scope", "definition", false], "原生设置写入保持不变");
    api.runtime.update({ ...enabled, codexAppNativePredictions: false });
    assert.equal(render(false, true), null, "关闭后恢复原生隐藏");
    assert.equal(await render(true, false).control && await query.queryFn(), false, "官方门控通过时仍由 remote config 决定");
  }
}

async function runSamplingTests() {
  // 关闭：完全交还原调用。
  {
    const { api, sent } = harness();
    api.runtime.update({ ...enabled, codexAppNativePredictions: false });
    assert.equal(api.request({}, target(), null, null, null), undefined);
    assert.equal(sent.length, 0);
  }
  // 远端对话：原生门控通过时走原生，否则保持无预测，不发任何请求。
  {
    const { api, sent } = harness();
    api.state.officialGate = false;
    assert.equal(await api.request({ requestUserMessagePrediction: () => assert.fail("不应调用") }, target("t", "live", "thread", "remote"), null, null, null), null);
    api.state.officialGate = true;
    assert.equal(api.request({ requestUserMessagePrediction() {} }, target("t", "live", "thread", "remote"), null, null, null), undefined);
    assert.equal(sent.length, 0);
  }
  // 官方 openai 供应商的本机对话：不接管；原生门控通过时委托原生控制器并释放句柄。
  {
    const { api, samples } = harness({ provider: "openai" });
    api.observePreference(true);
    api.state.officialGate = false;
    assert.equal(await api.request({ requestUserMessagePrediction: () => assert.fail("不应调用") }, target(), null, null, null), null);
    api.state.officialGate = true;
    let disposed = 0;
    const official = { requestUserMessagePrediction: (value, callback) => Object.assign(Promise.resolve({ text: "official", value, callback }), { [Symbol.dispose]: () => { disposed++; } }) };
    const result = await api.request(official, target("turn-2"), "callback", null, null);
    assert.equal(result.text, "official");
    assert.equal(result.callback, "callback");
    assert.equal(disposed, 1);
    assert.equal(samples().length, 0, "ChatGPT/官方对话不走 thread/sample");
  }
  // 自定义 API：thread/sample 继承源对话，结果交给原生灰字。
  {
    const { api, sent, samples, respondSample } = harness();
    api.observePreference(true);
    const pending = api.request({}, target("turn-1", "live"), null, null, () => true);
    await flush();
    assert.equal(samples().length, 1);
    const [message] = samples();
    assert.equal(message.hostId, "local");
    assert.equal(message.coalesce, false);
    assert.match(message.request.id, /^thread\/sample:codex-plus-/);
    assert.deepEqual(Object.keys(message.request.params).sort(), ["disableMcp", "expectedTurnId", "prompt", "threadId", "turnTrigger"]);
    assert.equal(message.request.params.threadId, "thread-1");
    assert.equal(message.request.params.expectedTurnId, "turn-1");
    assert.equal(message.request.params.disableMcp, true);
    assert.equal(message.request.params.turnTrigger, "composer_predictions");
    assert.match(message.request.params.prompt, /Return only JSON matching this schema/);
    // 同一源回合的 catch-up 请求复用进行中的采样。
    const second = api.request({}, target("turn-1", "catch_up"), null, null, null);
    await flush();
    assert.equal(samples().length, 1, "同一源回合只采样一次");
    respondSample(message, { result: { text: "{\"suggestion\":\"  继续把测试补上 \"}", responseId: "resp_1", inputTokens: "12", cachedInputTokens: 4 } });
    const prediction = await pending;
    assert.equal(prediction.text, "继续把测试补上");
    assert.equal(prediction.responseId, "resp_1");
    assert.equal(prediction.sourceTurnId, "turn-1");
    assert.equal(prediction.sourceThreadId, "thread-1");
    assert.equal(prediction.generationTrigger, "live");
    assert.equal(prediction.hostKind, "local");
    assert.equal(prediction.model, "relay-model");
    assert.equal(prediction.inputTokens, 12);
    assert.equal(prediction.cachedInputTokens, 4);
    assert.deepEqual(await second, prediction);
    assert.deepEqual(await api.request({}, target("turn-1", "catch_up"), null, null, null), prediction, "完成后命中缓存");
    assert.equal(samples().length, 1);
    const methods = new Set(sent.filter((item) => item.type === "mcp-request").map((item) => item.request.method));
    assert.deepEqual([...methods].sort(), ["thread/read", "thread/sample"], "不回退到 fork / turn");
  }
  // 原生偏好关闭：不采样。
  {
    const { api, samples } = harness();
    api.observePreference(false);
    assert.equal(await api.request({}, target(), null, null, null), null);
    api.state.preference = null;
    assert.equal(await api.request({}, target("turn-2"), null, null, null), null, "偏好未知时不消耗额度");
    assert.equal(samples().length, 0);
  }
  // 期限：45 秒未回包就取消，迟到回包被丢弃，同回合不再重复采样。
  {
    const { api, samples, cancels, sent, respondSample, runTimers } = harness();
    api.observePreference(true);
    const pending = api.request({}, target(), null, null, null);
    await flush();
    const [message] = samples();
    assert.equal(api.deadlineMs, 45000);
    runTimers(45000);
    assert.equal(await pending, null);
    const abandonIndex = sent.findIndex((item) => item.type === "mcp-request-abandon");
    const cancelIndex = sent.findIndex((item) => item.request?.method === "thread/sample/cancel");
    assert.ok(abandonIndex >= 0 && cancelIndex > abandonIndex, "先清理排队请求再取消");
    assert.equal(sent[abandonIndex].requestId, message.request.id);
    assert.equal(cancels()[0].request.params.requestId, message.request.id, "用原始 JSON-RPC ID 取消");
    assert.match(cancels()[0].request.id, /^thread\/sample\/cancel:codex-plus-/);
    respondSample(message, { result: { text: "{\"suggestion\":\"late\"}" } });
    respondSample(cancels()[0], { result: {} });
    respondSample(message, { error: { code: -32603, message: "sample canceled" } });
    assert.equal(await api.request({}, target(), null, null, null), null);
    assert.equal(samples().length, 1, "超时的回合不重复消耗额度");
  }
  // 放弃：所有等待方都 abort 才取消；后台等待方仍在时继续。
  {
    const { api, samples, cancels, respondSample } = harness();
    api.observePreference(true);
    const controller = new AbortController();
    const catchUpOnly = api.request({}, target("turn-1", "catch_up"), null, controller.signal, null);
    await flush();
    controller.abort();
    assert.equal(await catchUpOnly, null);
    assert.equal(cancels().length, 1);
    assert.equal(cancels()[0].request.params.requestId, samples()[0].request.id);
    const again = api.request({}, target("turn-1", "catch_up"), null, null, null);
    await flush();
    assert.equal(samples().length, 2, "被放弃的采样之后可以重新请求");
    const liveController = new AbortController();
    const withSignal = api.request({}, target("turn-1", "catch_up"), null, liveController.signal, null);
    liveController.abort();
    await flush();
    assert.equal(cancels().length, 1, "仍有后台等待方时不取消");
    respondSample(samples()[1], { result: { text: "{\"suggestion\":null}", responseId: "resp_2" } });
    assert.equal((await again).text, null, "模型放弃预测时返回空文本");
    assert.equal((await withSignal).text, null);
  }
  // 新回合开始或同一对话出现更新的回合：取消旧采样。
  {
    const { api, samples, cancels, deliver } = harness();
    api.observePreference(true);
    const first = api.request({}, target("turn-1"), null, null, null);
    await flush();
    const second = api.request({}, target("turn-2"), null, null, null);
    await flush();
    assert.equal(await first, null);
    assert.equal(cancels()[0].request.params.requestId, samples()[0].request.id);
    deliver({ type: "mcp-notification", hostId: "remote", method: "turn/started", params: { threadId: "thread-1" } });
    assert.equal(cancels().length, 1, "其它主机的通知不影响本机采样");
    deliver({ type: "mcp-notification", hostId: "local", method: "turn/started", params: { threadId: "thread-1" } });
    assert.equal(await second, null);
    assert.equal(cancels()[1].request.params.requestId, samples()[1].request.id);
  }
  // app-server 不支持 thread/sample：给出诊断并停用，不回退普通 fork/turn。
  {
    const { api, sent, samples, respondSample } = harness();
    api.observePreference(true);
    const pending = api.request({}, target(), null, null, null);
    await flush();
    respondSample(samples()[0], { error: { code: -32601, message: "Method not found" } });
    assert.equal(await pending, null);
    assert.equal(api.runtime.status().unsupported, true);
    assert.equal(api.runtime.relax("local"), false);
    assert.equal(await api.request({}, target("turn-9"), null, null, null), null);
    assert.equal(samples().length, 1);
    assert.ok(!sent.some((item) => /thread\/fork|thread\/start|turn\/start/.test(item.request?.method ?? "")));
    assert.ok(api.state.diagnostics.some((item) => item.event === "sample_unsupported"));
  }
  // 关闭开关时取消进行中的采样；无法解析的输出不显示。
  {
    const { api, samples, cancels, respondSample } = harness();
    api.observePreference(true);
    const pending = api.request({}, target(), null, null, null);
    await flush();
    api.runtime.update({ ...enabled, codexAppNativePredictions: false });
    assert.equal(await pending, null);
    assert.equal(cancels().length, 1);
    api.runtime.update(enabled);
    const next = api.request({}, target("turn-2"), null, null, null);
    await flush();
    respondSample(samples()[1], { result: { text: "not json" } });
    assert.equal(await next, null);
  }
  const { api } = harness();
  const parsed = (text) => JSON.stringify(api.parseSuggestion(text));
  assert.equal(parsed("```json\n{\"suggestion\":\"ok\"}\n```"), JSON.stringify({ ok: true, suggestion: "ok" }));
  assert.equal(parsed("Sure: {\"suggestion\":\"ok\"}"), JSON.stringify({ ok: true, suggestion: "ok" }));
  assert.equal(parsed("{\"suggestion\":\"   \"}"), JSON.stringify({ ok: true, suggestion: null }));
  assert.equal(api.parseSuggestion("{\"suggestion\":1}").ok, false);
  assert.equal(api.parseSuggestion(null).ok, false);
  assert.equal(api.parseSuggestion(`{"suggestion":"${"x".repeat(900)}"}`).suggestion.length, 600);
}

function selectedModelHarness({ latestTurnId = "turn-1", completed = true, holdHistory = false } = {}) {
  const h = harness();
  const calls = [];
  const history = [];
  const input = [
    { id: "turn-0", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "较早的提问" }] }, { type: "agentMessage", text: "较早的回答" }] },
    { id: latestTurnId, status: completed ? "completed" : "inProgress", items: [
      { type: "userMessage", content: [{ type: "text", text: "现在的问题" }, { type: "image", url: "private-image" }] },
      { type: "commandExecution", aggregatedOutput: "private-tool-output" },
      { type: "agentMessage", text: "现在的回答" },
    ] },
  ];
  const base = h.window.electronBridge.sendMessageFromView;
  h.window.electronBridge.sendMessageFromView = (message) => {
    const result = base(message);
    if (message.request?.method === "thread/turns/list") {
      const respond = () => h.deliver({ type: "mcp-response", hostId: "local", message: { id: message.request.id, result: { data: [...input].reverse() } } });
      history.push(respond);
      if (!holdHistory) queueMicrotask(respond);
    }
    return result;
  };
  h.window.__codexSessionDeleteBridge = (route, payload) => {
    if (route === "/diagnostics/log") return Promise.resolve({});
    if (route.endsWith("/cancel")) { calls.push({ route, payload }); return Promise.resolve({}); }
    return new Promise((resolve, reject) => calls.push({ route, payload, resolve, reject }));
  };
  h.api.runtime.update({ ...enabled, codexAppNativePredictionsModel: "  small-predictor  " });
  h.api.observePreference(true);
  return { ...h, calls, history, input };
}

async function runSelectedModelTests() {
  {
    const h = selectedModelHarness();
    const first = h.api.request({}, target(), null, null, () => true);
    const second = h.api.request({}, target(), null, null, null);
    await flush();
    assert.equal(h.calls.length, 1, "同一模型与源回合只生成一次");
    const call = h.calls[0];
    assert.equal(call.route, "/native-predictions/sample");
    assert.equal(call.payload.model, "small-predictor");
    assert.equal(call.payload.modelProvider, "custom-relay");
    assert.deepEqual(JSON.parse(JSON.stringify(call.payload.input)), [
      { role: "user", content: "较早的提问" }, { role: "assistant", content: "较早的回答" },
      { role: "user", content: "现在的问题" }, { role: "assistant", content: "现在的回答" },
    ]);
    assert.equal(h.samples().length, 0, "手动模型不能给thread/sample添加无效参数");
    assert.ok(!h.sent.some((item) => /thread\/(fork|start)|turn\/start/.test(item.request?.method ?? "")));
    call.resolve({ text: '{"suggestion":"继续补测试"}', model: "small-predictor-snapshot", inputTokens: 123 });
    const result = await first;
    assert.equal(result.model, "small-predictor-snapshot");
    assert.equal(result.text, "继续补测试");
    assert.equal(result.inputTokens, 123);
    assert.deepEqual(await second, result);
    assert.deepEqual(await h.api.request({}, target(), null, null, null), result);
    assert.equal(h.calls.length, 1);
    h.api.runtime.update(enabled);
    const defaultRequest = h.api.request({}, target(), null, null, null);
    await flush();
    assert.equal(h.samples().length, 1, "恢复跟随时清理旧模型缓存");
    h.respondSample(h.samples()[0], { result: { text: '{"suggestion":null}' } });
    assert.equal((await defaultRequest).model, "relay-model");
  }
  for (const reason of ["model", "disable", "identity", "turn", "abort", "deadline"]) {
    const h = selectedModelHarness();
    const controller = new AbortController();
    const pending = h.api.request({}, target(), null, controller.signal, null);
    await flush();
    const call = h.calls[0];
    if (reason === "model") h.api.runtime.update({ ...enabled, codexAppNativePredictionsModel: "different-predictor" });
    if (reason === "disable") h.api.runtime.update({ ...enabled, codexAppNativePredictions: false, codexAppNativePredictionsModel: "small-predictor" });
    if (reason === "identity") h.api.runtime.update({ ...enabled, nativePredictionsLocalApiConfigured: false, codexAppNativePredictionsModel: "small-predictor" });
    if (reason === "turn") h.deliver({ type: "mcp-notification", hostId: "local", method: "turn/started", params: { threadId: "thread-1" } });
    if (reason === "abort") controller.abort();
    if (reason === "deadline") h.runTimers(45000);
    assert.equal(await pending, null, reason);
    assert.equal(h.calls[1]?.route, "/native-predictions/cancel", reason);
    assert.equal(h.calls[1]?.payload.requestId, call.payload.requestId);
    call.resolve({ text: '{"suggestion":"迟到结果"}' });
    await flush();
    if (reason === "model") {
      const next = h.api.request({}, target(), null, null, null);
      await flush();
      assert.equal(h.calls[2].payload.model, "different-predictor");
      h.calls[2].resolve({ text: '{"suggestion":"新模型"}' });
      assert.equal((await next).model, "different-predictor");
    }
    if (reason === "deadline") {
      assert.equal(await h.api.request({}, target(), null, null, null), null);
      assert.equal(h.calls.length, 2, "同回合超时后不重复付费");
    }
  }
  {
    const h = selectedModelHarness({ holdHistory: true });
    const pending = h.api.request({}, target(), null, null, null);
    await flush();
    h.api.runtime.update(enabled);
    assert.equal(await pending, null);
    h.history[0]();
    await flush();
    assert.equal(h.calls.length, 0, "上下文读取后切换模型不得再发旧请求");
  }
  for (const options of [{ latestTurnId: "newer-turn" }, { completed: false }]) {
    const h = selectedModelHarness(options);
    assert.equal(await h.api.request({}, target(), null, null, null), null);
    assert.equal(h.calls.length, 0, "回合已变化或未完成时不生成");
  }
  {
    const h = selectedModelHarness();
    h.input[1].items[2].text = "文".repeat(20000);
    const pending = h.api.request({}, target(), null, null, null);
    await flush();
    assert.ok(h.calls[0].payload.input.reduce((sum, item) => sum + item.content.length, 0) <= 12000);
    h.calls[0].reject(new Error("unsupported model"));
    assert.equal(await pending, null);
    assert.equal(h.samples().length, 0, "错误不得静默回退到源模型");
  }
  {
    const h = selectedModelHarness();
    h.input[1].items[2].text = "😀" + "x".repeat(11999);
    const pending = h.api.request({}, target(), null, null, null);
    await flush();
    const input = h.calls[0].payload.input;
    assert.ok(input.every((item) => item.content.isWellFormed()), "UTF-16截断不得产生孤立代理项");
    assert.equal(input.at(-1).content, "x".repeat(11999));
    h.calls[0].resolve({ text: '{"suggestion":null}' });
    assert.equal((await pending).text, null);
  }
  {
    const h = selectedModelHarness();
    h.api.state.unsupported = true;
    assert.equal(h.api.runtime.relax("local"), true, "原生sample不支持不阻断独立路径");
    let current = true;
    const pending = h.api.request({}, target(), null, null, () => current);
    await flush();
    current = false;
    h.calls[0].resolve({ text: '{"suggestion":"过期目标"}' });
    assert.equal(await pending, null);
  }
}

async function runPatchedCallSiteTests() {
  // 后台完成回合：打补丁后的原生函数对自定义 API 走 thread/sample，并照常写入原生预测状态。
  const { api, window, context, source, } = patchedFixture("initialize-app-host-services");
  const sent = [];
  const stored = [];
  let respond;
  window.electronBridge.sendMessageFromView = (message) => {
    sent.push(message);
    if (message.request?.method === "thread/read") {
      queueMicrotask(() => window.__codexPlusNativePredictions.state.pending.get(message.request.id)?.({ result: { thread: { modelProvider: "custom" } } }));
    }
    if (message.request?.method === "thread/sample") respond = (text) => window.__codexPlusNativePredictions.state.pending.get(message.request.id)?.({ result: { text, responseId: "resp_live" } });
    return Promise.resolve();
  };
  Object.assign(context, {
    H: { cumberbatch: { requestUserMessagePrediction: () => assert.fail("自定义 API 不调用原生控制器") } },
    R: (host) => host !== "local", Kl: () => false, pt: class { constructor(fn) { this.fn = fn; } },
    ol: () => {}, kt: (value) => value, Bc: (value) => stored.push(value),
  });
  const fn = vm.runInContext(`(${source})`, context);
  api.observePreference(true);
  const client = { getCachedConversationMetadata: async () => ({ streamRole: { role: "owner" }, latestTurnId: "turn-1" }) };
  const event = { hostId: "local", conversationId: "thread-1", turnId: "turn-1" };
  await fn("scope", client, event, () => true);
  assert.equal(stored.length, 0, "可用性门控未加载时不在后台采样");
  api.gate(false, "local", "availability");
  const running = fn("scope", client, event, () => true);
  for (let index = 0; index < 20 && !respond; index++) await Promise.resolve();
  respond("{\"suggestion\":\"下一步\"}");
  await running;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].prediction.text, "下一步");
  assert.equal(stored[0].target.generationTrigger, "live");
  // 远端主机：完全维持原生判断。
  stored.length = 0;
  await fn("scope", client, { ...event, hostId: "ssh" }, () => true);
  assert.equal(stored.length, 0);
}

async function runCurrentCallSiteTests() {
  const { api, window, context } = harness();
  const calls = [];
  window.__codexPlusNativePredictions.request = (...args) => { calls.push(args); return Promise.resolve({ text: "继续", sourceTurnId: "turn-1" }); };
  const service = { requestUserMessagePrediction: () => assert.fail("不能同时请求原生服务") };
  const available = vm.runInContext(`(${api.transform(currentFixtures["app-initial"], urls["app-initial"], "app-initial").patchedSource})`, context);
  const evaluate = (official, preference) => available({ atom: (_, read) => read({ get: () => official }) }, { scope: {} }, { flag: {} }, { preference: () => preference }, { definition: () => ({ enabled: true }) }, { appServices: { cumberbatch: service } });
  assert.equal(evaluate(false, true), true);
  assert.equal(evaluate(false, false), false, "新版仍尊重原生预测开关");
  const catchUp = vm.runInContext(`(${api.transform(currentFixtures["composer-content"], urls["composer-content"], "composer-content").patchedSource})`, context);
  const controller = new AbortController();
  const stored = [];
  const query = catchUp({ appServices: { cumberbatch: service } }, "scope", target(), {}, { Callback: class {} }, { abort: (value) => value }, { unwrap: (value) => value }, { store: (value) => stored.push(value) });
  assert.equal((await query({ signal: controller.signal })).text, "继续");
  assert.equal(calls[0][0], service);
  assert.equal(calls[0][1].generationTrigger, "catch_up");
  assert.equal(calls[0][3], controller.signal);
  assert.equal(stored.length, 1, "新版继续通过原生缓存显示结果");
  const scope = { get: () => null };
  Object.assign(context, { H: { appServices: { cumberbatch: service } }, I: { remote: (host) => host !== "local" }, J: { check: () => false }, R: { resource: (_, value) => value, dispose: () => {} }, T: { Callback: class {} }, U: { unwrap: (value) => value }, C: { store: (value) => stored.push(value), error: (error) => { throw error; } } });
  const live = vm.runInContext(`(${api.transform(currentFixtures["initialize-app-host-services"], urls["initialize-app-host-services"], "initialize-app-host-services").patchedSource})`, context);
  const client = { getCachedConversationMetadata: async () => ({ streamRole: { role: "owner" }, latestTurnId: "turn-1" }) };
  const current = () => true;
  const event = { hostId: "local", conversationId: "thread-1", turnId: "turn-1" };
  await live(scope, client, event, current);
  assert.equal(calls[1][0], service);
  assert.equal(calls[1][1].generationTrigger, "live");
  assert.equal(calls[1][4], current);
  assert.equal(stored.length, 2);
  await live(scope, client, { ...event, hostId: "ssh:remote" }, current);
  await live(scope, client, { ...event, automationKind: "scheduled" }, current);
  assert.equal(calls.length, 2, "保留远端与自动化回合的原生过滤");
  const settings = vm.runInContext(`(${api.transform(currentFixtures["general-settings"], urls["general-settings"], "general-settings").patchedSource})`, context);
  const writes = [];
  const render = () => settings({ check: () => false }, { appServices: { cumberbatch: service } }, { write: (...args) => writes.push(args) }, scope, {}, { preference() {} });
  const row = render();
  assert.ok(row, "新版原生设置项在自定义 API 下可见");
  assert.equal(await row.query({ signal: controller.signal }), true);
  row.onChange(false);
  assert.equal(api.state.preference, false);
  assert.equal(writes[0][2], false);
  api.runtime.update({ ...enabled, codexAppNativePredictions: false });
  assert.equal(render(), null, "关闭功能后恢复新版原生设置门控");
}

function channelHarness(settings = enabled, fastSettings = null) {
  const storage = new Map();
  const events = [];
  let reloads = 0;
  const document = {
    readyState: "loading", documentElement: null,
    addEventListener() {}, removeEventListener() {},
    createElement(tag) {
      const node = { tag, parentNode: null, children: [], relList: { supports: () => true } };
      node.appendChild = (child) => { node.children.push(child); child.parentNode = node; events.push([tag, child]); return child; };
      return node;
    },
    appendChild(node) { this.documentElement = node; node.parentNode = this; return node; },
    removeChild(node) { this.documentElement = null; node.parentNode = null; return node; },
  };
  let blobs = 0;
  const window = {
    document, location: { href: "app://-/index.html", protocol: "app:", host: "-", origin: "app://-", reload: () => { reloads++; } },
    URL: class extends URL { static createObjectURL() { return `blob:app://-/module-${++blobs}`; } },
    Blob, HTMLScriptElement: { supports: () => true },
    setTimeout: () => 1, clearTimeout() {},
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  };
  const context = vm.createContext({ module: { exports: {} }, window, URL, Blob });
  vm.runInContext(channel, context);
  vm.runInContext(helper, context);
  window.__codexPlusNativeFastUnlock.runtime.update(fastSettings ?? { enhancementsEnabled: true, codexAppNativeFastUnlock: false });
  window.__codexPlusNativePredictions.runtime.update(settings);
  return { channel: window.__codexPlusNativeFastUnlock, predictions: window.__codexPlusNativePredictions, window, events, reloads: () => reloads };
}

function moduleList(overrides = {}) {
  return Object.entries(fixtures).map(([name, source]) => ({ url: urls[name], source: overrides[name] ?? source }));
}

async function runChannelTests() {
  // 数字 chunk 只读候选由后端提供，JS 仍须逐块校验并保持整体失败回退。
  {
    const { channel } = channelHarness();
    const chunks = Object.entries(currentFixtures).map(([name, source], index) => ({
      url: `app://-/assets/async/${index + 1}.abc123.js`,
      source: name === "app-initial" ? `${source};const accepted="cumberbatch-has-accepted-prediction-1";` : source,
    }));
    const options = { location: { protocol: "app:", host: "-" }, document: { scripts: [{ src: "app://-/assets/123.abc123.js" }] } };
    assert.equal((await channel.prepareDocumentModules(options)).diagnostics.reason, "rspack-assets-required");
    const fetched = [];
    const prepared = await channel.prepareDocumentModules({ ...options, assetUrls: chunks.map((item) => item.url), fetchText: async (url) => { fetched.push(url); return chunks.find((item) => item.url === url)?.source; } });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.diagnostics.rewriters.predictions, "patched");
    assert.equal(prepared.modules.length, 4);
    assert.equal(fetched.length, 4, "不遍历成千上万个 Rspack 依赖");
    assert.equal(prepared.modules[0].url, chunks[0].url);
    for (const item of prepared.modules) assert.equal(prepared.diagnostics.discovery[`predictions:${Object.keys(currentFixtures)[chunks.findIndex((chunk) => chunk.url === item.url)]}`], "content");
    const missing = await channel.prepareDocumentModules({ ...options, assetUrls: chunks.slice(1).map((item) => item.url), fetchText: async (url) => chunks.find((item) => item.url === url)?.source });
    assert.equal(missing.ok, false);
    assert.equal(missing.modules.length, 0);
    for (const url of ["https://example.com/assets/async/1.abc123.js", "app://-/assets/async/1.abc123.js?key=secret", "app://-/assets/async/../../other.js"]) {
      assert.equal((await channel.prepareDocumentModules({ ...options, assetUrls: [url], fetchText: () => assert.fail("非法 URL 不读取") })).diagnostics.reason, "invalid-asset-urls");
    }
  }
  {
    const { channel } = channelHarness();
    const prepared = channel.prepareModules(moduleList());
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.diagnostics.rewriters.predictions, "patched");
    assert.equal(prepared.diagnostics.rewriters.fast, undefined, "Fast 未开启时不参与");
    assert.equal(prepared.modules.length, 4);
    assert.equal(prepared.modules[0].url, urls["app-initial"], "入口排在第一位");
    assert.ok(prepared.modules[0].patchedSource.includes('window.__codexPlusNativeFastCompiled="v1";'));
    assert.ok(prepared.modules.slice(1).every((item) => !item.patchedSource.includes("__codexPlusNativeFastCompiled") && item.patchedSource.endsWith(`//# sourceURL=${item.url}\n`)));
    assert.ok(prepared.modules.every((item) => item.patchedSource.includes("window.__codexPlusNativePredictions")));
  }
  // 任一目标块不符：整体放弃预测改写，不留半套补丁。
  for (const name of Object.keys(fixtures)) {
    const { channel } = channelHarness();
    const prepared = channel.prepareModules(moduleList({ [name]: "export const changed = 1;" }));
    assert.equal(prepared.ok, false, name);
    assert.equal(prepared.diagnostics.rewriters.predictions, `${name}:incomplete-structure`);
    assert.equal(prepared.modules.length, 0);
  }
  {
    const { channel } = channelHarness();
    const missing = channel.prepareModules(moduleList().filter((item) => !item.url.includes("general-settings")));
    assert.equal(missing.diagnostics.rewriters.predictions, "missing-general-settings");
    // 同前缀的另一块只要部分命中就视为结构变化。
    const extra = { url: "app://-/assets/composer-content-other.js", source: `${catchUp}\n${catchUp}` };
    assert.equal(channel.prepareModules([...moduleList(), extra]).diagnostics.rewriters.predictions, "ambiguous-composer-content");
    const unrelated = { url: "app://-/assets/composer-content-other.js", source: "export const other = 1;" };
    assert.equal(channel.prepareModules([...moduleList(), unrelated]).ok, true, "不含目标结构的同前缀块被忽略");
    const twoEntries = { url: "app://-/assets/app-initial-other.js", source: availability };
    assert.equal(channel.prepareModules([...moduleList(), twoEntries]).diagnostics.rewriters.predictions, "ambiguous-app-initial");
  }
  // 两个改写器共用入口块：各自全有或全无，互不拖累。
  {
    const fast = fs.readFileSync(require.resolve("./native-fast-unlock.test.cjs"), "utf8");
    assert.ok(fast.includes("function Mxo"));
    const { channel } = channelHarness(enabled, { enhancementsEnabled: true, codexAppNativeFastUnlock: true });
    const prepared = channel.prepareModules(moduleList());
    assert.equal(prepared.ok, true);
    assert.equal(prepared.diagnostics.rewriters.fast, "ui-access:missing-gate", "Fast 结构缺失只放弃 Fast");
    assert.equal(prepared.diagnostics.rewriters.predictions, "patched");
    const disabled = channelHarness({ ...enabled, codexAppNativePredictions: false }, { enhancementsEnabled: true, codexAppNativeFastUnlock: false });
    assert.equal(disabled.channel.prepareModules(moduleList()).diagnostics.reason, "disabled");
    const transformed = channel.transformModule(catchUp, urls["composer-content"]);
    assert.equal(transformed.ok, true);
    assert.deepEqual([...transformed.applied], ["predictions"]);
    const untouched = channel.transformModule("export const x = 1;", "app://-/assets/composer-content-other.js");
    assert.equal(untouched.ok, false);
    assert.equal(untouched.patchedSource, "export const x = 1;");
  }
  // 从入口沿依赖表发现目标块，同前缀多候选按内容区分。
  {
    const { channel } = channelHarness();
    const files = {
      "app://-/assets/index-a.js": 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./app-main-a.js","./app-initial-fixture.js","./rpc-a.js"])))=>i.map(i=>d[i]);',
      "app://-/assets/app-main-a.js": 'import("./initialize-app-host-services-fixture.js");import("./settings-lazy-routes-a.js");import("./unrelated-a.js");',
      "app://-/assets/settings-lazy-routes-a.js": 'import("./general-settings-fixture.js");import("./general-settings-other.js");',
      "app://-/assets/general-settings-other.js": "export const other = 1;",
      "app://-/assets/app-initial-fixture.js": `${availability}\nimport("./composer-content-fixture.js");`,
      "app://-/assets/composer-content-fixture.js": catchUp,
      "app://-/assets/initialize-app-host-services-fixture.js": live,
      "app://-/assets/general-settings-fixture.js": settingsRow,
    };
    const fetched = [];
    const prepared = await channel.prepareDocumentModules({
      location: { protocol: "app:", host: "-", origin: "app://-" },
      document: { scripts: [{ src: "app://-/assets/index-a.js" }, { src: "https://example.com/assets/index-b.js" }] },
      fetchText: async (url) => { fetched.push(url); return files[url] ?? null; },
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.modules.length, 4);
    assert.ok(!fetched.some((url) => /rpc-a|unrelated-a|example\.com/.test(url)), "只沿声明的前缀发现");
    assert.equal((await channel.prepareDocumentModules({ location: { protocol: "file:", host: "" } })).ok, false);
  }
  // 26.1027 统一客户端把实时预测迁到 renderer-app-server-managers，
  // 输入框及设置页则经过 app-runtime 和中间块懒加载；夹具只表达依赖形状，不复制官方 bundle。
  {
    const { channel } = channelHarness();
    const liveUrl = "app://-/assets/renderer-app-server-managers-current.js";
    const files = {
      "app://-/assets/index-a.js": 'import("./app-main-a.js");',
      "app://-/assets/app-main-a.js": 'import("./app-initial-fixture.js");import("./app-runtime-a.js");',
      "app://-/assets/app-initial-fixture.js": availability,
      "app://-/assets/app-runtime-a.js": 'import("./renderer-app-server-managers-current.js");import("./asb-conversation-page-a.js");import("./settings-lazy-routes-a.js");import("./unrelated-a.js");',
      [liveUrl]: live,
      "app://-/assets/asb-conversation-page-a.js": 'import("./composer-content-fixture.js");',
      "app://-/assets/composer-content-fixture.js": catchUp,
      "app://-/assets/settings-lazy-routes-a.js": 'import("./general-settings-shell.js");',
      "app://-/assets/general-settings-shell.js": 'export { settings } from "./general-settings-fixture.js";',
      "app://-/assets/general-settings-fixture.js": settingsRow,
    };
    const fetched = [];
    const prepared = await channel.prepareDocumentModules({
      location: { protocol: "app:", host: "-" },
      document: { scripts: [{ src: "app://-/assets/index-a.js" }] },
      fetchText: async (url) => { fetched.push(url); return files[url] ?? null; },
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.diagnostics.rewriters.predictions, "patched");
    assert.equal(prepared.modules.length, 4);
    assert.ok(prepared.modules.some((item) => item.url === liveUrl), "迁移后的实时预测块参与原子补丁");
    assert.ok(!fetched.some((url) => url.includes("unrelated-a")), "增加依赖路径不会扫描无关资源");
    const transformed = channel.transformModule(live, liveUrl);
    assert.equal(transformed.ok, true, "Fetch 路径同样识别迁移后的实时预测块");
    assert.ok(transformed.patchedSource.includes("window.__codexPlusNativePredictions"));
    const duplicate = channel.prepareModules([...moduleList(), { url: liveUrl, source: live }]);
    assert.equal(duplicate.ok, false, "旧块与迁移块同时完整匹配时不能任选一个");
    assert.equal(duplicate.diagnostics.rewriters.predictions, "ambiguous-initialize-app-host-services");
    assert.equal(duplicate.modules.length, 0, "歧义时不能安装半套预测补丁");
  }
  // 多模块安装：一份 import map + 每块预加载；懒加载块预加载失败也回退一次。
  {
    const { channel, events, window, reloads } = channelHarness();
    const prepared = channel.prepareModules(moduleList());
    const installed = channel.installModules(prepared.modules, { rewriters: prepared.diagnostics.rewriters });
    assert.equal(installed.ok, true, JSON.stringify(installed.diagnostics));
    const nodes = events.filter(([kind]) => kind === "html").map(([, node]) => node);
    assert.deepEqual(nodes.map((node) => node.tag), ["script", "link", "link", "link", "link"]);
    assert.deepEqual(Object.keys(JSON.parse(nodes[0].textContent).imports).sort(), Object.values(urls).sort());
    assert.equal(window.__codexPlusNativeFastModuleDiagnostics.rewriters.predictions, "patched");
    window.__codexPlusNativeFastCompiled = "v1";
    nodes[3].onerror();
    assert.equal(reloads(), 1);
    assert.equal(channel.installModules(prepared.modules.slice(1)).ok, false, "缺少入口时不安装");
  }
}

async function runRealBundleCheck() {
  // 本机可选核对：指向已解包 Codex 的 webview/assets 目录，验证全部目标结构都能命中。
  const directory = process.env.CODEX_NATIVE_PREDICTIONS_ASSETS_DIR;
  const archive = process.env.CODEX_NATIVE_PREDICTIONS_ASAR;
  if (!directory && !archive) return null;
  if (archive) {
    const fd = fs.openSync(archive, "r");
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      const header = Buffer.alloc(head.readUInt32LE(12));
      fs.readSync(fd, header, 0, header.length, 16);
      const root = JSON.parse(header.toString());
      const files = root.files.webview.files.assets.files.async.files;
      const candidates = new Map();
      for (const [name, entry] of Object.entries(files)) {
        if (!/^\d+\.[a-f0-9]+\.js$/.test(name)) continue;
        const bytes = Buffer.alloc(entry.size);
        fs.readSync(fd, bytes, 0, bytes.length, 8 + head.readUInt32LE(4) + Number(entry.offset));
        const source = bytes.toString();
        if (source.includes("requestUserMessagePrediction") || source.includes("cumberbatch-has-accepted-prediction-1") && source.includes("4290031608") || source.includes("cumberbatch-availability") && source.includes("settings.general.messagePredictions.label")) candidates.set(`app://-/assets/async/${name}`, source);
      }
      const { channel } = channelHarness();
      const prepared = await channel.prepareDocumentModules({ location: { protocol: "app:", host: "-" }, assetUrls: [...candidates.keys()], fetchText: async (url) => candidates.get(url) });
      assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
      assert.equal(prepared.diagnostics.rewriters.predictions, "patched");
      const parser = createRequire(path.resolve(__dirname, "../../apps/codex-plus-manager/package.json"))("@babel/parser");
      for (const item of prepared.modules) parser.parse(item.patchedSource, { sourceType: "module" });
      return { rewriters: prepared.diagnostics.rewriters, modules: prepared.modules.map((item) => path.basename(item.url)), parsed: true };
    } finally { fs.closeSync(fd); }
  }
  const { channel } = channelHarness(enabled, { enhancementsEnabled: true, codexAppNativeFastUnlock: true });
  const html = fs.readFileSync(path.join(directory, "..", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="\.\/assets\/(index-[\w-]+\.js)"/g)].map((match) => ({ src: `app://-/assets/${match[1]}` }));
  const prepared = await channel.prepareDocumentModules({
    location: { protocol: "app:", host: "-", origin: "app://-" },
    document: { scripts },
    fetchText: async (url) => {
      const file = path.join(directory, path.basename(new URL(url).pathname));
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.diagnostics.rewriters.predictions, "patched", JSON.stringify(prepared.diagnostics));
  let parser = null;
  try { parser = createRequire(path.resolve(__dirname, "../../apps/codex-plus-manager/package.json"))("@babel/parser"); } catch { parser = null; }
  if (parser) {
    for (const item of prepared.modules) parser.parse(item.patchedSource, { sourceType: "module" });
  }
  return { rewriters: prepared.diagnostics.rewriters, modules: prepared.modules.map((item) => path.basename(item.url)), parsed: !!parser };
}

async function runNativePredictionsTests() {
  runRewriterTests();
  await runGateTests();
  await runSamplingTests();
  await runSelectedModelTests();
  await runPatchedCallSiteTests();
  await runCurrentCallSiteTests();
  await runChannelTests();
  const real = await runRealBundleCheck();
  return `Native predictions rewriter, gates, thread/sample adapter, cancel/dedupe/deadline and module channel passed${real ? `; real bundle ${JSON.stringify(real)}` : ""}`;
}

module.exports = runNativePredictionsTests;
if (require.main === module) {
  runNativePredictionsTests().then((message) => console.log(message)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
