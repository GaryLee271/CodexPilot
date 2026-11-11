import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { enhancementItem } from "./enhancement-catalog.ts";

test("all full saves require their own revision and conflicts preserve the caller draft", async () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const app = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer = "";
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === "call") initializer = node.initializer?.getText(app) || "";
    ts.forEachChild(node, find);
  };
  find(app);
  assert.ok(initializer);
  let request: any;
  const context = vm.createContext({ invoke: async (_command: string, args: unknown) => { request = args; return { message: "settings_revision_conflict: newer settings exist", status: "failed" }; } });
  vm.runInContext(ts.transpileModule(`const call = ${initializer}; globalThis.callTest = call;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const draft = { revision: "old", model: "draft-model" };
  await assert.rejects(context.callTest("save_settings", { settings: draft }), /settings_revision_conflict/);
  assert.equal(request.expectedRevision, "old");
  assert.deepEqual(draft, { revision: "old", model: "draft-model" });
  await assert.rejects(context.callTest("save_settings", { settings: { model: "unversioned" } }));
  assert.equal(request.expectedRevision, "");
});
