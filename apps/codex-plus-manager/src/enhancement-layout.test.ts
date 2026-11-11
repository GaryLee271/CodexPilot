import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../../../crates/codex-plus-core/assets/enhancement-settings.json", import.meta.url), "utf8")) as {
  groups: Array<{ id: string; title: string }>;
  items: Array<{ key: string; group: string }>;
};

/// 取顶格书写的选择器规则体，空白按 \s+ 容忍，避免误匹配组合选择器。
function ruleBody(selector: string) {
  const pattern = selector
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = styles.match(new RegExp(`^${pattern}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `missing top-level rule ${selector}`);
  return match[1];
}

test("feature switch cards keep their own height and expanded blocks take a full row", () => {
  // 默认 align-items: stretch 会把同一行的卡片拉到行高，details 一展开左侧卡就被撑大。
  assert.match(ruleBody(".feature-switch-grid"), /align-items:\s*start/);

  // 「API 余额（可选）」这类可展开配置块整行独占，展开只往下长。
  assert.match(
    ruleBody(".enhance-feature-groups .feature-switch-grid > .settings-block"),
    /grid-column:\s*1\s*\/\s*-1/,
  );

  assert.ok(!catalog.groups.some((group) => ["pet", "appearance", "standalone"].includes(group.id)));
  const enhance = app.slice(app.indexOf("function EnhanceScreen("), app.indexOf("function BuiltinExtensionCardView("));
  assert.doesNotMatch(enhance, /Codex 用量挂件|WhaleBalanceSettingsFields|StandaloneModeGroup/);
});
