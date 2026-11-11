import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "revealSettingsSection");
assert.ok(declaration);
const script = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("跳转低频设置时先从外到内展开折叠区，再滚到目标", () => {
  const actions: string[] = [];
  const outer = { tagName: "DETAILS", parentElement: null, set open(value: boolean) { if (value) actions.push("outer"); } };
  const middle = { tagName: "DIV", parentElement: outer };
  const target = { tagName: "DETAILS", parentElement: middle, set open(value: boolean) { if (value) actions.push("target"); }, scrollIntoView(options: object) { actions.push("scroll"); assert.equal(JSON.stringify(options), '{"block":"start"}'); } };
  const context = vm.createContext({ document: { getElementById: (id: string) => id === "app-settings-config" ? target : null } });
  vm.runInContext(script, context);
  context.revealSettingsSection("app-settings-config");
  assert.deepEqual(actions, ["outer", "target", "scroll"]);
});

test("跳转普通设置只滚动，不为不存在的分类创建内容", () => {
  let scrolls = 0;
  const target = { tagName: "SECTION", parentElement: null, scrollIntoView() { scrolls++; } };
  const context = vm.createContext({ document: { getElementById: (id: string) => id === "app-settings-update" ? target : null } });
  vm.runInContext(script, context);
  context.revealSettingsSection("app-settings-update");
  context.revealSettingsSection("removed-section");
  assert.equal(scrolls, 1);
  assert.equal(Object.hasOwn(target, "open"), false);
});
