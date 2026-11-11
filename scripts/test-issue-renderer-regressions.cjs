const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const shard = name => fs.readFileSync(path.join(root, 'assets/inject/renderer-inject', name), 'utf8');
function extract(source, name) {
  const result = source.match(new RegExp(`^  (?:async )?function ${name}\\([^]*?^  \\}`, 'm'));
  assert.ok(result, name);
  return result[0];
}

async function diagnostics() {
  const source = shard('60-session-runtime.js');
  for (const mode of ['success', 'rejected', 'failed-status', 'throw', 'absent']) {
    const calls = { bridge: 0, beacon: 0, fetch: 0 };
    const scope = {
      JSON,
      codexPlusDiagnosticPayload: (event, detail) => ({ event, detail }),
      navigator: { sendBeacon: () => { calls.beacon++; return true; } },
      fetch: async () => { calls.fetch++; return {}; }, window: {},
    };
    if (mode !== 'absent') scope.window.__codexSessionDeleteBridge = () => {
      calls.bridge++;
      if (mode === 'throw') throw new Error('fixture');
      if (mode === 'rejected') return Promise.reject(new Error('fixture'));
      return Promise.resolve({ status: mode === 'success' ? 'ok' : 'failed' });
    };
    vm.createContext(scope);
    vm.runInContext(extract(source, 'sendCodexPlusDiagnostic'), scope);
    await scope.sendCodexPlusDiagnostic('fixture', {});
    assert.equal(calls.beacon, 0, mode);
    assert.equal(calls.fetch, 0, mode);
    assert.equal(calls.bridge, mode === 'absent' ? 0 : 1, mode);
  }
  console.log('diagnostic CDP-only transport: 5 cases passed');
}

async function backendStatus() {
  const source = shard('60-session-runtime.js');
  for (const mode of ['success', 'failed-status', 'timeout', 'throw', 'absent']) {
    const calls = { failures: 0, successes: 0, attempts: 0, http: 0 };
    const scope = {
      window: {},
      fetch: () => { calls.http++; throw new Error('HTTP helper must not be used'); },
      recordCodexPlusBridgeFailure: () => calls.failures++,
      recordCodexPlusBridgeSuccess: () => calls.successes++,
      recordCodexPlusBridgeAttempt: () => calls.attempts++,
      sendCodexPlusDiagnostic: () => {},
      withBackendTimeout: async request => mode === 'timeout' ? { status: 'failed', timeout: true } : await request,
    };
    if (mode !== 'absent') scope.window.__codexSessionDeleteBridge = async () => {
      if (mode === 'throw') throw new Error('fixture');
      return { status: mode === 'failed-status' ? 'failed' : 'ok' };
    };
    vm.createContext(scope);
    vm.runInContext(extract(source, 'postJson'), scope);
    const result = await scope.postJson('/backend/status', {});
    assert.equal(result.status, mode === 'success' ? 'ok' : 'failed', mode);
    assert.equal(calls.http, 0, mode);
    assert.equal(calls.successes, mode === 'success' ? 1 : 0, mode);
    assert.equal(calls.failures, mode === 'success' ? 0 : 1, mode);
    assert.equal(calls.attempts, mode === 'timeout' ? 1 : 0, mode);
  }
  console.log('backend status without HTTP fallback: 5 cases passed');
}

(async () => {
  await diagnostics();
  await backendStatus();
})().catch(error => { console.error(error); process.exit(1); });
