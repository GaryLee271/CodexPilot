// 校验现存界面、增强目录及后端消息的翻译，自动跟随文件增删。
// node tools/i18n-verify.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectTranslationSources, repoRoot } from "./i18n-sources.mjs";
import { EN_PLAIN, EN_TEMPLATE, EN_BACKEND, EN_BACKEND_PATTERNS } from "../apps/codex-plus-manager/src/i18n-en.ts";

const sources = collectTranslationSources();
let ok = true;
for (const [label, dictionary, required] of [
  ["plain", EN_PLAIN, sources.plain],
  ["template", EN_TEMPLATE, sources.template],
  ["backend", EN_BACKEND, new Set()],
]) {
  const missing = [...required].filter((key) => !dictionary[key]);
  const stale = Object.keys(dictionary).filter((key) => !sources.literals.has(key));
  console.log(`${label}: ${Object.keys(dictionary).length} translated`);
  if (missing.length || stale.length) {
    ok = false;
    console.error(JSON.stringify({ missing, stale }, null, 2));
  }
}
const stalePatterns = EN_BACKEND_PATTERNS.filter(([pattern]) =>
  ![...sources.backendSamples].some((sample) => pattern.test(sample)));
if (stalePatterns.length) {
  ok = false;
  console.error("Stale backend patterns:", stalePatterns.map(([pattern]) => String(pattern)));
}
const keys = JSON.parse(readFileSync(path.join(repoRoot, "tools/i18n-keys.json"), "utf8"));
for (const [name, expected] of [["plain", sources.plain], ["template", sources.template]]) {
  const actual = keys[name];
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    ok = false;
    console.error(`tools/i18n-keys.json ${name} is stale`);
  }
}
if (!ok) process.exit(1);
console.log("Translations match current sources.");
