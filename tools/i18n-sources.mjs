// 从现存源码收集词条，兼顾 t()/tf() 字面量和目录、状态、后端消息等动态文案。
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "apps/codex-plus-manager/package.json"));
const ts = require("typescript");

function sourceFiles(dir, extensions) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file, extensions);
    return extensions.includes(path.extname(file)) && !/\.test\./.test(file) ? [file] : [];
  }).sort();
}

export function collectTranslationSources() {
  const plain = new Set();
  const template = new Set();
  const literals = new Set();
  const backendSamples = new Set();
  const addLiteral = (value) => {
    literals.add(value);
    backendSamples.add(value.replace(/\{[^{}]*\}/g, "1"));
  };

  for (const file of sourceFiles(path.join(repoRoot, "apps/codex-plus-manager/src"), [".ts", ".tsx"])) {
    if (file.endsWith("/i18n-en.ts")) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) addLiteral(node.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          if (node.expression.text === "t") plain.add(arg.text);
          if (node.expression.text === "tf") template.add(arg.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const catalog = JSON.parse(readFileSync(path.join(repoRoot,
    "crates/codex-plus-core/assets/enhancement-settings.json"), "utf8"));
  const collectCatalog = (value) => {
    if (typeof value === "string") {
      addLiteral(value);
    } else if (Array.isArray(value)) {
      value.forEach(collectCatalog);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["title", "description", "managerSummary", "descriptionWhenEnhancementsOn", "label", "hint", "placeholder"].includes(key)
            && typeof child === "string") plain.add(child);
        collectCatalog(child);
      }
    }
  };
  collectCatalog(catalog);

  for (const root of ["crates/codex-plus-core/src", "crates/codex-plus-data/src",
    "apps/codex-plus-manager/src-tauri/src", "apps/codex-plus-launcher/src"]) {
    for (const file of sourceFiles(path.join(repoRoot, root), [".rs"])) {
      if (file.endsWith("/tests.rs")) continue;
      // 退役行为的回归用例不应把旧文案重新登记为运行时词条。
      const source = readFileSync(file, "utf8").split("#[cfg(test)]")[0];
      for (const match of source.matchAll(/"(?:\\.|[^"\\])*"/g)) {
        try { addLiteral(JSON.parse(match[0])); } catch { /* Rust 专用转义不是翻译词条。 */ }
      }
    }
  }
  return { plain, template, literals, backendSamples };
}
