import assert from "node:assert/strict";
import test from "node:test";
import { codexEnhanced, codexState, parseTrayRequest, TRAY_ROUTES } from "./tray-panel-model.ts";

test("托盘识别 Codex 运行状态与增强连接", () => {
  assert.equal(codexState(null), "unknown");
  assert.equal(codexState({codex_app: {status: "missing", path: null}}), "missing");
  assert.equal(codexState({runtime_health: {codex_app: {status: "stopped"}}}), "stopped");
  const running = {runtime_health: {codex_app: {status: "running"}, debugger: {status: "connected"}}};
  assert.equal(codexState(running), "running");
  assert.equal(codexEnhanced(running), true);
  assert.equal(codexEnhanced({runtime_health: {codex_app: {status: "running"}}}), false);
});

test("托盘仅接受 Codex 操作与增强页面请求", () => {
  for (const route of TRAY_ROUTES) assert.deepEqual(parseTrayRequest({id: "r", kind: "navigate", route}), {id: "r", kind: "navigate", route});
  for (const route of ["gateway", "sessions", "usage", "providers", "tools", "context", "skills"]) assert.equal(parseTrayRequest({id: "r", kind: "navigate", route}), null);
  for (const kind of ["launch", "restart", "stop"]) assert.deepEqual(parseTrayRequest({id: "r", kind}), {id: "r", kind});
  for (const request of [null, {}, {id: "", kind: "stop"}, {id: "r", kind: "switchRelay"}]) assert.equal(parseTrayRequest(request), null);
});
