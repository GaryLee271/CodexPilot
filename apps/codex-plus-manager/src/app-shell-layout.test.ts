/** 外壳布局：可调侧栏双页导航、底部运行控制、右下角提示卡。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// 源码契约与 checkout 行尾无关，统一后仍保留全部结构与空白断言。
function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const text = readSource("./App.tsx");
const styles = readSource("./styles.css");
const app = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function functionSource(name: string) {
  const declaration = app.statements.find(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `${name} should exist`);
  return declaration.getText(app);
}

test("提示卡按语气分色、悬停暂停、不显示进度条，失败可复制详情", () => {
  const notice = functionSource("NoticeDialog");
  assert.match(notice, /noticeTone\(notice\.status\)/);
  assert.match(notice, /onMouseEnter=\{\(\) => setPaused\(true\)\}/);
  assert.match(notice, /tone === "error" && notice\.message/);
  assert.doesNotMatch(notice, /toast-progress/);
  assert.doesNotMatch(styles, /\.toast-progress\b|@keyframes toast-progress/);
});

test("紧凑密度层：清理退役管理页样式，保留带 .shell 前缀的菜单覆盖", () => {
  const layer = styles.slice(styles.indexOf("/* ── Graphite · 紧凑密度"), styles.indexOf("/* ── 精简管理器："));
  assert.doesNotMatch(styles, /\.mg-(?:page|skill|matrix|drawer|session)/);
  assert.match(layer, /\.shell \.mg-icon-button \{\n  width: 28px;\n  height: 28px;/);
  assert.match(layer, /\.shell \.topbar \{\n  min-height: 44px;/);
  // 层内每条规则都以 .shell 开头
  const selectors = [...layer.matchAll(/^([^\s/@}][^{]*)\{$/gm)].map((match) => match[1]);
  assert.ok(selectors.length > 20);
  for (const selector of selectors) assert.match(selector, /^\.shell /, selector);
});

test("管理器移除推荐内容页面、广告横幅和加载入口", () => {
  assert.doesNotMatch(text, /"recommendations"|RecommendationsScreen|SponsorBoard|load_ads|refreshAds/);
  assert.doesNotMatch(readSource("../src-tauri/src/lib.rs"), /commands::load_ads/);
  assert.doesNotMatch(readSource("../src-tauri/src/commands.rs"), /AdsPayload|load_ads|ads_payload/);
  assert.doesNotMatch(readSource("../web-preview/tauri-web-shim.ts"), /load_ads|demoAds|demoBanner/);
});

test("可调侧栏保留双页导航，运行控制仅在底部呈现，增强列表不再渲染分类目录", () => {
  assert.doesNotMatch(text, /AppSidebar|PageSectionNav|sectioned-page/);
  assert.match(text, /shell compact-shell/);
  const sidebar = functionSource("CompactSidebar");
  assert.match(sidebar, /aria-label=\{t\("主导航"\)\}/);
  assert.match(sidebar, /routes\.map/);
  assert.match(sidebar, /<item\.icon/);
  assert.match(sidebar, /<footer className="compact-sidebar-footer"/);
  assert.match(sidebar, /<CodexLaunchButton/);
  assert.equal([...text.matchAll(/<CodexLaunchButton\b/g)].length, 1);
  assert.doesNotMatch(text, /compact-version|onOpenUpdate|updateVersion/);
  assert.match(styles, /\.shell\.compact-shell \{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/);
  assert.match(styles, /\.compact-sidebar-footer \{[^}]*margin-top:\s*auto/);
  assert.match(styles, /\.compact-sidebar-footer \.codex-launch \{[^}]*flex-direction:\s*column/);
  assert.doesNotMatch(functionSource("AppHeader"), /<nav|compact-brand/);
  const toggle = functionSource("FeatureToggle");
  assert.match(toggle, /EXPERIMENTAL_TITLE\.test\(title\)/);
  assert.match(toggle, /restartRequired \|\| RESTART_HINT\.test\(detail\)/);
});

test("侧栏宽度限制保留正文空间，记住偏好，损坏或不可读的偏好回到默认宽度", () => {
  const constants = app.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node))
    .filter((node) => node.declarationList.declarations.some((declaration) => declaration.name.getText(app).startsWith("SIDEBAR_")))
    .map((node) => node.getText(app));
  let stored: string | null = null;
  let blocked = false;
  const context = vm.createContext({ window: { innerWidth: 1000, localStorage: {
    getItem: () => { if (blocked) throw new Error("Storage blocked"); return stored; },
  } } });
  vm.runInContext(ts.transpileModule([
    ...constants, functionSource("clampSidebarWidth"), functionSource("loadSidebarWidth"),
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(context.loadSidebarWidth(), 192);
  for (const [requested, available, expected] of [[80, 1000, 160], [500, 1000, 320], [300, 700, 220], [260, 820, 260], [205.6, 1000, 206], [NaN, 1000, 192]]) {
    assert.equal(context.clampSidebarWidth(requested, available), expected);
  }
  stored = "256";
  assert.equal(context.loadSidebarWidth(), 256);
  context.window.innerWidth = 700;
  assert.equal(context.loadSidebarWidth(), 220);
  context.window.innerWidth = 1000;
  for (const value of ["invalid", "", "Infinity"]) {
    stored = value;
    assert.equal(context.loadSidebarWidth(), 192);
  }
  blocked = true;
  assert.equal(context.loadSidebarWidth(), 192);
});

test("侧栏分隔条支持指针捕获、取消、键盘和恢复默认，不与窗口拖动混用", () => {
  const sidebar = functionSource("CompactSidebar");
  assert.match(sidebar, /role="separator"/);
  assert.match(sidebar, /aria-orientation="vertical"/);
  assert.match(sidebar, /setPointerCapture\(event.pointerId\)/);
  assert.match(sidebar, /releasePointerCapture\(event.pointerId\)/);
  assert.match(sidebar, /onPointerCancel=|onLostPointerCapture=/);
  assert.match(sidebar, /onDoubleClick=\{\(\) => resize\(SIDEBAR_DEFAULT_WIDTH\)\}/);
  assert.match(sidebar, /"ArrowLeft"|"ArrowRight"/);
  assert.match(sidebar, /window.localStorage.setItem\(SIDEBAR_WIDTH_STORAGE_KEY, String\(width\)\)/);
});

test("设置页「版本与更新」：已是最新时不显示旧版本的安装包和说明；有新版本时说明收进可展开区", () => {
  const update = functionSource("UpdateSettingsScreen");
  assert.match(update, /update\?\.updateAvailable && update\.assetName \?/);
  assert.match(update, /\{update\?\.updateAvailable && update\.releaseSummary \? \(\n\s*<details className="app-update-notes">/);
  assert.doesNotMatch(update, /<Metric label=\{t\("状态"\)\}/);
});

test("移除搜索入口及快捷键后，侧栏仍保留两个页面的选中状态", () => {
  assert.doesNotMatch(text, /CommandPalette|paletteOpen|paletteShortcut|setPaletteOpen|onOpenPalette|event\.key\.toLowerCase\(\) === "k"/);
  assert.doesNotMatch(styles, /\.palette(?:\b|-)/);
  const sidebar = functionSource("CompactSidebar");
  assert.match(sidebar, /aria-current=\{route === item.id \? "page" : undefined\}/);
  assert.match(sidebar, /onNavigate\("enhance"\)/);
  assert.match(functionSource("loadInitialRoute"), /return "enhance"/);
});

test("macOS 主窗口移除独立标题栏，保留原生按钮和网页拖动授权", () => {
  const config = JSON.parse(readSource("../src-tauri/tauri.conf.json"));
  const main = config.app.windows.find((window: { label: string }) => window.label === "main");
  assert.equal(main.titleBarStyle, "Overlay");
  assert.equal(main.hiddenTitle, true);
  assert.notEqual(main.decorations, false);
  // main 设置为 create:false，必须同时核对真正创建窗口的 Rust 路径。
  const backend = readSource("../src-tauri/src/lib.rs");
  const builder = backend.slice(backend.indexOf("fn build_main_window"), backend.indexOf("fn register_main_window_events"));
  assert.match(builder, /title_bar_style\(tauri::TitleBarStyle::Overlay\)/);
  assert.match(builder, /hidden_title\(true\)/);
  assert.match(functionSource("AppHeader"), /data-tauri-drag-region/);
  assert.match(functionSource("CompactSidebar"), /compact-sidebar-drag" data-tauri-drag-region/);
  const capability = JSON.parse(readSource("../src-tauri/capabilities/default.json"));
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});

test("Codex 在它自己的窗口里退出后，侧栏 / 顶栏的运行状态能跟上（#2778）", () => {
  const entry = functionSource("App");
  assert.match(entry, /invoke<boolean \| null>\("codex_app_running"\)/);
  assert.match(entry, /if \(document\.visibilityState !== "visible"\) return;/);
  assert.match(entry, /running !== codexAppRunning\) void refreshOverview\(true\)/);
  assert.match(text, /const codexRunningPollMs = 5_000;/);
});

test("托盘不再重复提供停止和重启按钮，主界面仍只服务 Codex", () => {
  const tray = readSource("./TrayPanel.tsx");
  assert.doesNotMatch(tray, /t\("(?:停止|重启) Codex"\)/);
  assert.match(tray, /requestLaunch\(\)/);
  assert.match(text, /onNavigate\("enhance"\)/);
  assert.doesNotMatch(text, /GatewayPage|AgentFocusDialog|SessionPage/);
});
