import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
test("概览检查不会阻塞设置加载，也不再请求工具列表", () => {
  assert.match(text, /Promise.all\(\[refreshOverview\(true\), handledNavigation \? Promise.resolve\(\) : refreshSettings\(true\)\]\)/);
  assert.doesNotMatch(text, /list_tools|setToolEntries/);
});
