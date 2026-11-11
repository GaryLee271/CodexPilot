# AGENTS.md

本文件为 Codex Pilot 的工作规范，指导 agent 与贡献者在本仓库工作。

## 项目概述

本仓库是 Codex Pilot —— 面向 Codex 的独立精简增强工具，以 AGPL-3.0-only 发布。许可与致谢见 `NOTICE.md`。

增强模型调用只读 Codex 原生配置与登录状态，直接使用 Responses 接口；不维护供应商、网关或其他 Agent。

## 仓库结构

- `crates/codex-plus-core/` — 核心 Rust 库（配置生成、catalog 解析、数据模型）
- `crates/codex-plus-data/` — 数据持久化
- `apps/codex-plus-manager/` — Tauri 桌面应用，前端 React+TS
- `assets/inject/` — 注入到 Codex 界面的脚本分片与组装产物

## 关键代码位置

- 增强设置：`crates/codex-plus-core/src/settings.rs` 的 `BackendSettings`
- 原生配置读取：`crates/codex-plus-core/src/native_config.rs`
- catalog 解析：`crates/codex-plus-core/src/model_catalog.rs`
- 启动与增强 helper：`crates/codex-plus-core/src/launcher.rs`
- 管理器界面：`apps/codex-plus-manager/src/App.tsx`

## 安全规则

- 禁止批量删除、rm -rf、rmdir /s
- 删除只能单个文件，删除前确认
- 禁止 sudo、提权、curl | bash
- 禁止泄露密钥、.env、auth.json、config.toml 凭据
- 不擅自改 Cargo.toml、package.json、.gitignore（除非任务必需）

## 命令执行

- 不运行未知脚本、不擅自装依赖
- 测试用 cargo test，不另起工具链

## 编码规范

- 对话用中文，代码可用英文，注释尽量中文
- 保持现有代码风格统一（Rust 标准、React+TS）
- 增强改动保持独立开关；原生连接信息从 Codex 配置读取
- 不做需求外的操作

## 拓展接口约定

`window.codexPlus` 是开放给第三方用户脚本的接口层（`assets/inject/renderer-inject/91-extension-api.js`）。
改动这里要遵守：

- **已发布的类名与 `codexPlus.constants` 不再更名**，新增用新名字。第三方脚本按字面量依赖它们。
- **路由默认不开放**。`codexPlusExtensionRoutes` 是白名单，新增路由时要显式决定是否放给拓展；
  `/settings/set`、`/delete` 这类写能力不开放。契约测试会守住这条。
- **注册表持久、DOM 瞬态**。消费方不能缓存 DOM 引用，每次重建都要从注册中心读数据。
  见 `01-registry.js` 顶部的生命周期说明。
- **扫描调度**：拓展插入的节点必须带 `data-codex-plus-ext` 属性，否则会触发自喂扫描循环。
  选择器按「有归属/无归属」两档登记，不要按脚本逐个登记，会耗尽配额。
- 改分片后必须跑 `node scripts/assemble-renderer-inject.mjs` 重新组装产物。

## 测试约定

- 沿用现有 `#[test]` + tempfile 风格（见 `crates/codex-plus-core/tests/all/relay_config.rs`）
- core / data 的集成测试合并为一个测试程序 `tests/all/`（每个文件是 `main.rs` 里的一个 `mod`），
  新测试文件放进 `tests/all/` 并在 `main.rs` 登记，不要再在 `tests/` 下直接加文件（每个都会多链接一次整个 core）。
  只跑某个文件：`cargo test -p codex-plus-core --test all relay_config::`
- 合并后各文件的用例在同一进程并行：改进程级状态（设置路径覆盖、诊断日志路径、环境变量）的用例
  必须先拿 `common::global_state_lock()`；需要独占进程的（改 `CODEX_PLUS_STATE_DIR`、常驻 helper 单例）
  才单独留在 `tests/` 下
- 断言读 config.toml 文本，如 `assert!(config.contains("model_catalog_json"))`
- 改行为要同步改/加对应测试

## 构建与本地验证

前端位于 `apps/codex-plus-manager`，Rust 核心位于 `crates/codex-plus-core`，数据层位于 `crates/codex-plus-data`。

```sh
npm --prefix apps/codex-plus-manager run check
npm --prefix apps/codex-plus-manager test
cargo test -p codex-plus-core
cargo test -p codex-plus-data
cargo test -p codex-plus-manager --lib
```

集成回归应将 `CODEX_HOME` 和 `CODEX_PLUS_STATE_DIR` 指向临时目录，隔离日常使用的数据。
修改注入分片后运行 `node scripts/assemble-renderer-inject.mjs`。

只构建、不启动应用：

```sh
npm --prefix apps/codex-plus-manager run vite:build
cargo build --release -p codex-plus-manager
```

## 提交与合入

- 默认直接提交并合入 `main`。
- 仅在明确需要时创建 PR。
- 提交信息、PR 描述里不加 `Co-Authored-By` 之类自动生成署名。
