  function installStyle() {
    const existingStyle = document.getElementById(styleId);
    if (existingStyle?.dataset.codexDeleteStyleVersion === codexDeleteStyleVersion) return;
    existingStyle?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.dataset.codexDeleteStyleVersion = codexDeleteStyleVersion;
    style.textContent = `
      .${actionGroupClass} {
        position: absolute;
        right: var(--codex-session-actions-right, 28px);
        top: 50%;
        transform: translateY(-50%);
        z-index: 20;
        opacity: 0;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: transparent;
      }
      .${actionButtonClass} {
        flex: 0 0 auto;
        -webkit-app-region: no-drag;
      }
      /* 外观优先套用同一行原生「置顶 / 归档」按钮的类名与 data-* 属性（见
         90-action-groups.js 的 syncNativeSessionActionStyle），套上后带
         data-codex-native-style，下面这组兜底规则就不再生效。兜底按 Codex 原生
         secondary / transparent / 3xs 图标按钮复刻：20px 方形、14px 图标、
         默认三级文字色，悬停只提亮颜色、不铺底色。 */
      .${actionButtonClass}:not([data-codex-native-style]) {
        position: relative;
        width: var(--control-size-4xs, 20px);
        height: var(--control-size-4xs, 20px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: var(--control-radius-sm, var(--radius-sm, 6px));
        background: transparent;
        color: var(--color-text-secondary-ghost, var(--color-text-tertiary, var(--color-token-text-tertiary, var(--codex-plus-text-tertiary, rgba(255,255,255,.5)))));
        font: inherit;
        padding: 0;
        cursor: default;
        text-align: center;
        transition: color var(--transition-duration-basic, .15s) var(--transition-ease-basic, ease);
      }
      .${actionButtonClass}:not([data-codex-native-style]) svg {
        display: block;
        width: var(--control-icon-size-xs, 14px);
        height: var(--control-icon-size-xs, 14px);
      }
      .codex-session-action-inner {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .${actionButtonClass}:not([data-codex-native-style]):hover,
      .${actionButtonClass}:not([data-codex-native-style]):focus-visible,
      .${actionButtonClass}:not([data-codex-native-style])[aria-expanded="true"] {
        background: transparent;
        color: var(--color-text-secondary-ghost-hover, var(--color-text, var(--color-token-text-primary, #f4f4f5)));
        outline: none;
      }
      .${moreMenuClass} {
        position: fixed;
        z-index: 2147483201;
        min-width: 104px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        padding: 4px;
      }
      .${moreMenuClass}[hidden] { display: none !important; }
      .${moreMenuClass}.codex-session-more-menu-open-up {
        transform: translateY(calc(-100% - 34px));
      }
      .codex-session-more-menu-item {
        width: 100%;
        border: 0;
        border-radius: var(--border-radius-sm, 6px);
        background: transparent;
        color: inherit;
        cursor: default;
        display: flex;
        align-items: center;
        gap: 8px;
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 6px 8px;
        text-align: left;
      }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible {
        background: var(--codex-plus-bg-hover);
        outline: none;
      }
      .codex-session-more-menu-icon {
        width: 16px;
        text-align: center;
      }
      .codex-archive-row-button {
        border: 1px solid var(--color-token-border-light, var(--color-token-border-default, rgba(0,0,0,.12)));
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-token-bg-secondary, transparent);
        color: var(--color-token-text-secondary, inherit);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      [data-codex-delete-row="true"]:hover .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
      }
      [data-codex-delete-row="true"]:hover ${selectors.threadTitle},
      [data-codex-delete-row="true"]:focus-within ${selectors.threadTitle},
      [data-codex-delete-row="true"].codex-session-more-open ${selectors.threadTitle} {
        flex: 0 1 auto;
        width: var(--codex-session-title-max-width, auto);
        max-width: var(--codex-session-title-max-width, 100%);
        overflow: hidden;
      }
      [data-codex-delete-row="true"].codex-session-more-open .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
        z-index: 2147483201;
      }
      [data-codex-delete-row="true"].codex-archive-confirm-visible .${actionGroupClass} {
        right: max(66px, var(--codex-session-actions-right, 28px));
      }
      .${actionTooltipClass} {
        position: fixed;
        z-index: 2147483201;
        max-width: min(220px, calc(100vw - 32px));
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
        pointer-events: none;
        white-space: nowrap;
      }
      .codex-archive-delete-all {
        border: 1px solid var(--color-border-danger, #dc2626);
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-background-danger-soft, rgba(220,38,38,.1));
        color: var(--color-text-danger, #dc2626);
        font: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      .codex-archive-action-bar {
        position: fixed;
        right: 28px;
        top: 86px;
        z-index: 2147482999;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
      }
      .codex-delete-toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        padding: 10px 12px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        pointer-events: none;
      }
      .codex-delete-toast button { margin-left: 10px; pointer-events: auto; }
      /* 拓展与内置提示共用的类型配色。不传 type 时保持上面的默认外观。 */
      .codex-delete-toast[data-toast-type="success"] { border-color: var(--codex-plus-success, #2f9e63); }
      .codex-delete-toast[data-toast-type="warn"] { border-color: var(--codex-plus-warn, #b7791f); }
      .codex-delete-toast[data-toast-type="error"] { border-color: var(--codex-plus-error, #c53030); }
      .codex-plus-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        /*
         * overlay 自身带 zoom（见 applyCodexPlusZoom），而它的 inset: 0 与 100vw
         * 都按未缩放的视口算，再乘 zoom 就溢出（实测 zoom=1.2 时 100vw 得到 2072px，
         * 视口只有 1727px）。用 calc(100vw / var(--codex-plus-zoom)) 抵消；zoom 缺失
         * 时分母回落到 1，行为与改造前一致。
         * 内部子元素用百分比即可——它们在缩放空间里，百分比本来就对。
         * 注意：本段在 JS 模板字符串里，注释中不能出现反引号，否则会提前闭合。
         */
        width: calc(100vw / var(--codex-plus-zoom, 1));
        height: calc(100vh / var(--codex-plus-zoom, 1));
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--modal-backdrop-dim-shadow, rgba(0,0,0,.32));
        backdrop-filter: blur(1px);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-content {
        width: min(520px, calc(100% - 48px));
        max-height: min(680px, calc(100% - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 14px;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px 8px;
        flex: 0 0 auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; }
      .codex-plus-backend-indicator { width: 8px; height: 8px; border-radius: 999px; background: var(--codex-plus-text-tertiary); display: inline-block; }
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      .codex-plus-backend-indicator[data-status="degraded"] { background: var(--codex-plus-warning); }
      /*
       * 用户拓展添加的导航图标栏入口：原生按钮只放图标，
       * 这里对齐它的尺寸。
       *
       * 用 [data-codex-plus-rail] 而不是逐个列 id——早先按 id 写，加第三个入口时
       * 漏掉了对应的选择器，那个图标容器就没有 20px 约束、撑成整个按钮宽，
       * 表现为图标偏左不居中。
       */
      [data-codex-plus-rail] {
        position: relative;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      [data-codex-plus-rail] > button {
        position: relative;
      }
      [data-codex-plus-rail] .codex-plus-rail-icon {
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      [data-codex-plus-rail] .codex-plus-rail-icon svg {
        width: 19px;
        height: 19px;
        display: block;
      }
      /*
       * 我们的页面是叠加在 Codex 之上的，Codex 并不知道，所以它自己那个
       * destination 的选中态会一直留着，看起来像 rail 上同时亮两个。
       * 页面打开时给根节点打标记，用 CSS 把原生选中项压成未选中；
       * 关掉页面即移除标记，原生状态自动恢复——比改它的按钮属性稳，
       * 不会和 React 的重渲染打架。
       * 颜色取自当前主题下真实未选中项（见 syncCodexPlusRailNativeSelection），
       * 主题切换时下次同步会重算。
       */
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"] {
        color: var(--codex-plus-rail-dim, var(--codex-plus-text-tertiary, currentColor)) !important;
      }
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"]::before {
        opacity: 0 !important;
      }
      html[data-codex-plus-page-open] nav[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"] * {
        color: var(--codex-plus-rail-dim, var(--codex-plus-text-tertiary, currentColor)) !important;
      }
      /*
       * 页面 overlay 的 left 由 positionCodexPlusPage 按图标栏右边界算好写进来。
       *
       * 关键：写进来的必须是**布局坐标**（视觉值 / zoom），因为 overlay 自己在缩放
       * 空间里布局，宽度也要用同一个空间的量。width 的 calc(100vw / zoom - left - right)
       * 把右边贴到原生内容区的右边缘；三个量都除过 zoom，缩放后才正好补齐。
       * 注意：本段在 JS 模板字符串里，注释里不能出现反引号，否则会提前闭合。
       *
       * 右/下各留一圈槽（原生是 4px）并给四角加圆角，对齐官方面板的观感：
       * 官方页面面板 [_PageSurface_] 的 rect 与我们这块 overlay 完全相同（都是
       * [52, 44, 1663, 940]），四角 12px；它外面套了一个 padding: 0 4px 4px 0 的槽，
       * 右、下能看到底色。我们原先 right/bottom 贴 0 且无圆角，于是方角并且比官方
       * 多占 4px，用户反馈「少一个圆角」就是这个。
       * 圆角值由 positionCodexPlusPage 量官方面板写入，四个角一起用，不做左右区分。
       * overflow: hidden 让圆角真正裁到内容；内容都在 .codex-plus-modal-content 内，
       * 没有依赖溢出显示的全屏浮层，切掉是安全的。
       */
      .${codexPlusPageClass} {
        position: fixed;
        top: var(--codex-plus-page-top, 0px);
        right: var(--codex-plus-page-right, 0px);
        bottom: var(--codex-plus-page-bottom, 0px);
        left: var(--codex-plus-page-left, 0px);
        width: calc(100vw / var(--codex-plus-zoom, 1) - var(--codex-plus-page-left, 0px) - var(--codex-plus-page-right, 0px));
        height: calc(100vh / var(--codex-plus-zoom, 1) - var(--codex-plus-page-top, 0px) - var(--codex-plus-page-bottom, 0px));
        border-radius: var(--codex-plus-page-radius, 0px);
        overflow: hidden;
        /*
         * 功能页是覆盖在 Codex 内容区上的基础层，不能压过原生侧栏/顶部栏
         * 的 tooltip 和 menu；原生弹出层在页面打开时由下方规则提升。
         */
        z-index: 2147482000;
        display: block;
        background: var(--codex-plus-bg-primary, #fff);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      /* 图标栏按钮提示的兜底外观：找不到原生提示样式类时使用，数值量自原生提示。 */
      .codex-plus-rail-tooltip-fallback {
        max-width: 320px;
        padding: 5px 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 20px;
        background: rgb(45, 45, 45);
        box-shadow: rgba(15, 23, 42, 0.2) 0 8px 18px 0;
        color: #fff;
        font-size: 13px;
        font-weight: 430;
        line-height: 18px;
        letter-spacing: -0.15px;
        white-space: nowrap;
      }
      /*
       * 提升定位包装层，避免只改 tooltip/menu 子节点仍被父级堆叠上下文困住。
       * 新版 Codex 还把弹出层挂在一个 z-60 的固定视口容器里（zoom-adjusted-viewport），
       * 只提升里面的节点逃不出这个堆叠上下文，所以直接父容器也一起提升。
       */
      html[data-codex-plus-page-open] div:has(> [data-radix-popper-content-wrapper], > [role="tooltip"], > [role="menu"]):not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [data-radix-popper-content-wrapper]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [role="tooltip"]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [role="menu"]:not(.${codexPlusPageClass} *),
      html[data-codex-plus-page-open] [class*="ApplicationMenuTopBar"],
      html[data-codex-plus-page-open] .app-header-tint {
        z-index: 2147483645 !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content {
        width: auto;
        height: 100%;
        max-height: none;
        border: 0;
        border-radius: 0;
        background: var(--codex-plus-bg-primary, #fff);
        box-shadow: none;
      }
      .${codexPlusPageClass} .codex-plus-modal-header {
        width: 100%;
        margin: 0;
        padding: 16px 24px 10px;
      }
      .${codexPlusPageClass} .codex-plus-modal-body {
        width: 100%;
        margin: 0;
        padding: 4px 32px 32px;
      }
      .codex-plus-modal-close {
        border: 0;
        background: transparent;
        color: #d1d5db;
        font-size: 20px;
        cursor: pointer;
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 4px 20px 16px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,.28) transparent;
      }
      .codex-plus-modal-body::-webkit-scrollbar { width: 10px; }
      .codex-plus-modal-body::-webkit-scrollbar-track { background: transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255,255,255,.28);
        background-clip: padding-box;
      }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.38); background-clip: padding-box; }
      .codex-plus-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid rgba(255,255,255,.1);
      }
      .codex-plus-row:first-child { border-top: 0; }
      .codex-plus-row-title { font-weight: 550; line-height: 1.35; }
      .codex-plus-row-description { margin-top: 2px; color: #a1a1aa; font-size: 13px; line-height: 1.4; }
      .codex-plus-row-description[data-codex-plus-native-fast-status][data-failed="true"] { color: #f59e0b; }
      .codex-plus-model-compat-warning { margin-top: 6px; color: #fbbf24; font-size: 13px; line-height: 1.45; }
      .codex-plus-toggle {
        width: 42px;
        height: 24px;
        border: 0;
        border-radius: 999px;
        background: #52525b;
        padding: 2px;
      }
      .codex-plus-toggle span {
        display: block;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: white;
        transition: transform .12s ease;
      }
      .codex-plus-toggle,
      .codex-plus-action-button,
      .codex-plus-issue-button,
      .codex-plus-backend-status {
        flex-shrink: 0;
        align-self: center;
      }
      .codex-plus-toggle[data-enabled="true"] { background: #10a37f; }
      .codex-plus-toggle[data-enabled="true"] span { transform: translateX(18px); }
      .codex-plus-toggle[data-pending="true"],
      .codex-plus-toggle:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-width-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 176px; align-self: center; }
      .codex-plus-width-input {
        width: 78px;
        height: 26px;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.08);
        color: #f3f4f6;
        font-size: 13px;
        font-family: inherit;
        padding: 0 8px;
      }
      .codex-plus-width-input:disabled { opacity: .55; cursor: not-allowed; }
      .codex-plus-about { color: #a1a1aa; line-height: 1.5; }
      .codex-plus-panel[hidden] { display: none; }
      .codex-plus-action-button,
      .codex-plus-issue-button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #3f3f46; color: #f3f4f6; font-size: 13px;
        font-family: inherit; padding: 6px 8px; }
      .codex-plus-form-field {
        display: grid;
        gap: 4px;
        margin-top: 10px;
        /* issue #2359：原来是写死的 #d4d4d8，浅色主题下对比度只有 1.38:1（≈看不见）。
           标签文字改跟主题走。 */
        color: var(--codex-plus-text-secondary);
        font-size: 13px;
        font-family: inherit;
        text-align: left;
      }
      .codex-plus-form-field input {
        width: min(520px, 72vw);
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        background: #18181b;
        color: #f4f4f5;
        padding: 8px 10px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .codex-plus-form-message {
        min-height: 18px;
        margin-top: 10px;
        color: #a1a1aa;
        font-size: 13px;
        font-family: inherit;
        text-align: left;
      }
      .codex-plus-form-message[data-status="ok"] { color: #34d399; }
      .codex-plus-form-message[data-status="failed"] { color: #f87171; }
      .codex-plus-form-message[data-status="loading"] { color: #fbbf24; }
      .codex-plus-backend-status { display: grid; gap: 4px; min-width: 132px; justify-items: end; }
      .codex-plus-backend-label { color: #a1a1aa; font-size: 13px; }
      .codex-plus-backend-label[data-status="ok"] { color: #34d399; }
      .codex-plus-backend-label[data-status="failed"] { color: #f87171; }
      .codex-plus-backend-label[data-status="degraded"] { color: #fbbf24; }
      /*
       * 注入面板的语义色板：前景/背景必须取自同一套 token，且都要能被主题切换带走。
       *
       * issue #2359（Windows 浅色主题下黑底黑字）：旧写法在中间塞了一整层
       * --token-* 回退名（--token-bg-primary / --token-text-primary /
       * --token-border / --token-list-hover-background / --token-text-default /
       * --token-bg-fog / --token-text-tertiary …）。实测 Codex 客户端（26.9xx）
       * 的产物里这些名字**一个都不存在**——真正在用的一套是 --color-token-*。
       * 于是三级回退链的中间那级永远落空，浅色主题下只靠最后一级写死的深色值
       * 兜底，前景与背景各自独立兜底时明度撞在一起，就成了黑底黑字。
       * 这里把死名删掉，直接接到确实存在、且**由 Codex 自己按主题重算**的
       * --color-token-* 上；末级兜底仅作最后保险，不再承担主题判断。
       */
      :root {
        --codex-plus-bg-primary: var(--color-token-bg-primary, var(--color-token-main-surface-primary, #fff));
        --codex-plus-bg-secondary: var(--color-token-bg-secondary, var(--codex-plus-bg-primary));
        --codex-plus-bg-elevated: var(--color-token-dropdown-background, var(--color-token-bg-secondary, var(--codex-plus-bg-primary)));
        --codex-plus-bg-hover: var(--color-token-interactive-bg-secondary-hover, var(--color-token-list-hover-background, rgba(0,0,0,.06)));
        --codex-plus-bg-selected: var(--color-token-interactive-bg-secondary-selected, var(--codex-plus-bg-hover));
        --codex-plus-text: var(--color-token-text-primary, var(--color-token-foreground, #171717));
        --codex-plus-text-secondary: var(--color-token-text-secondary, var(--codex-plus-text));
        --codex-plus-text-tertiary: var(--color-token-text-tertiary, var(--codex-plus-text-secondary));
        --codex-plus-border: var(--color-token-border-light, var(--color-token-border, var(--color-token-border-default, rgba(0,0,0,.12))));
        --codex-plus-border-subtle: var(--codex-plus-border);
        --codex-plus-focus: var(--color-token-focus-border, var(--color-border-focus, currentColor));
        --codex-plus-danger: var(--color-text-danger, #dc2626);
        --codex-plus-danger-bg: var(--color-background-danger-soft, rgba(220,38,38,.1));
        --codex-plus-success: var(--color-text-success, #15803d);
        --codex-plus-warning: var(--color-text-warning, #a16207);
      }
      :where(.${moreMenuClass}, .${actionTooltipClass}, .codex-delete-toast, .codex-plus-modal-overlay, .${codexPlusPageClass}) {
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .${moreMenuClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
      }
      .codex-session-more-menu-item { border-radius: var(--border-radius-sm, 6px); font-family: inherit; }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible { background: var(--codex-plus-bg-hover); }
      .${actionTooltipClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font-family: inherit;
        font-size: 13px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
      }
      .codex-plus-modal-overlay { background: var(--color-background-surface-under, rgba(0,0,0,.32)); backdrop-filter: blur(1px); }
      .codex-plus-modal-content {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font-family: inherit;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
      }
      .codex-plus-row-description,
      .codex-plus-about,
      .codex-plus-backend-label,
      .codex-plus-form-message,
      .codex-plus-action-button,
      .codex-plus-issue-button {
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 5px 10px;
      }
      .codex-plus-action-button:hover,
      .codex-plus-action-button:focus-visible,
      .codex-plus-issue-button:hover,
      .codex-plus-issue-button:focus-visible {
        border-color: var(--color-border-danger, #dc2626);
        background: var(--color-background-danger-solid, #dc2626);
        color: var(--color-text-danger-solid, #fff);
      }
      .codex-plus-modal-close { border-color: var(--codex-plus-border); color: var(--codex-plus-text-secondary); border-radius: var(--border-radius-lg, 8px); }
      .codex-plus-modal-close:hover,
      .codex-plus-modal-close:focus-visible { background: var(--codex-plus-bg-hover); color: var(--codex-plus-text); outline: none; }
      .${codexPlusPageClass},
      .${codexPlusPageClass} .codex-plus-modal-content {
        background: var(--codex-plus-bg-primary) !important;
        color: var(--codex-plus-text) !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content { border-color: transparent; }
      .codex-plus-modal-body { scrollbar-color: var(--codex-plus-text-tertiary) transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--codex-plus-text-tertiary) 45%, transparent); background-clip: padding-box; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: var(--codex-plus-text-tertiary); background-clip: padding-box; }
      .codex-plus-row { border-top-color: var(--codex-plus-border-subtle); }
      .codex-plus-toggle { background: var(--color-background-secondary-solid, var(--codex-plus-text-tertiary)); }
      .codex-plus-toggle span { background: var(--color-token-bg-primary, #fff); box-shadow: var(--switch-thumb-shadow, 0 1px 2px rgba(0,0,0,.16)); }
      .codex-plus-toggle[data-enabled="true"] { background: var(--color-background-primary-solid, var(--color-background-success-solid, #10a37f)); }
      .codex-plus-width-input,
      .codex-plus-form-field input {
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .codex-plus-width-input:focus,
      .codex-plus-form-field input:focus { border-color: var(--codex-plus-focus); outline: 2px solid color-mix(in srgb, var(--codex-plus-focus) 25%, transparent); outline-offset: 0; }
      .codex-plus-backend-indicator { box-shadow: none; }
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      .codex-plus-backend-indicator[data-status="degraded"] { background: var(--codex-plus-warning); }
      .codex-plus-form-message[data-status="ok"], .codex-plus-backend-label[data-status="ok"] { color: var(--codex-plus-success); }
      .codex-plus-form-message[data-status="failed"], .codex-plus-backend-label[data-status="failed"] { color: var(--codex-plus-danger); }
      .codex-plus-backend-label[data-status="degraded"] { color: var(--codex-plus-warning); }
      .codex-plus-form-message[data-status="loading"], .codex-plus-model-compat-warning { color: var(--codex-plus-warning); }
      /* Codex Pilot 设置主页：对齐原生设置页，保持其它页面与弹窗的布局独立。 */
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] {
        background: var(--codex-plus-settings-page-bg, var(--codex-plus-bg-primary)) !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body {
        box-sizing: border-box;
        padding: 72px 32px 64px;
      }
      .codex-plus-settings {
        width: 100%;
        max-width: 740px;
        min-width: 0;
        margin: 0 auto;
        container: codex-plus-settings / inline-size;
      }
      .codex-plus-settings > .codex-plus-modal-header {
        width: 100%;
        box-sizing: border-box;
        padding: 0;
        margin: 0 0 48px;
        gap: 16px;
      }
      .codex-plus-settings .codex-plus-modal-title {
        min-width: 0;
        font-size: 28px;
        font-weight: 600;
        line-height: 36px;
        letter-spacing: -.02em;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings-section { margin: 0 0 48px; }
      .codex-plus-settings-section:last-child { margin-bottom: 0; }
      .codex-plus-settings-section-title {
        margin: 0 0 16px;
        color: var(--codex-plus-text);
        font-size: 14px;
        font-weight: 550;
        line-height: 20px;
      }
      .codex-plus-settings-card,
      .codex-plus-settings > [data-codex-plus-ext-menu] {
        box-sizing: border-box;
        min-width: 0;
        padding: 0 16px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 16px;
        background: var(--codex-plus-settings-card-bg, var(--codex-plus-bg-secondary));
      }
      .codex-plus-settings > [data-codex-plus-ext-menu] { margin-top: 48px; }
      .codex-plus-settings .codex-plus-row {
        box-sizing: border-box;
        min-height: 60px;
        align-items: center;
        gap: 24px;
        padding: 10px 0;
        font-size: 14px;
        line-height: 20px;
      }
      .codex-plus-settings .codex-plus-row[hidden] { display: none; }
      /* 内置拓展的子选项缩进挂在所属拓展下面；被顶替时的小字用警示色。 */
      .codex-plus-settings .codex-plus-row[data-codex-plus-builtin-param] { padding-left: 20px; }
      .codex-plus-settings .codex-plus-row-description[data-codex-builtin-replaced]::after {
        content: " · " attr(data-codex-builtin-replaced);
        color: var(--color-token-text-warning, #d97706);
      }
      .codex-plus-settings .codex-plus-row > :first-child {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings .codex-plus-row > :not(:first-child) { max-width: 48%; }
      .codex-plus-settings .codex-plus-row-title { font-weight: 500; line-height: 20px; }
      /* 设置项标题旁的小标签：实验 / 需重启，与管理器增强页一致。 */
      .codex-plus-settings .codex-plus-feature-tag {
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        padding: 0 5px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 4px;
        color: var(--codex-plus-text-secondary);
        font-size: 10.5px;
        font-style: normal;
        font-weight: 500;
        line-height: 16px;
        vertical-align: 1px;
      }
      .codex-plus-settings .codex-plus-feature-tag[data-tone="experimental"] {
        border-color: color-mix(in srgb, var(--codex-plus-warning) 40%, transparent);
        color: var(--codex-plus-warning);
      }
      .codex-plus-settings .codex-plus-row-description,
      .codex-plus-settings .codex-plus-about {
        margin-top: 2px;
        color: var(--codex-plus-text-secondary);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
      }
      .codex-plus-settings .codex-plus-toggle {
        flex: 0 0 32px;
        width: 32px;
        height: 20px;
        min-height: 20px;
        box-sizing: border-box;
        padding: 2px;
        background: var(--codex-plus-switch-off, #3a3a3a);
        cursor: pointer;
      }
      .codex-plus-settings .codex-plus-toggle span {
        width: 16px;
        height: 16px;
        background: var(--codex-plus-switch-thumb, #fff);
      }
      .codex-plus-settings .codex-plus-toggle[data-enabled="true"] { background: var(--codex-plus-switch-on, #3485ff); }
      .codex-plus-settings .codex-plus-toggle[data-enabled="true"] span { transform: translateX(12px); }
      .codex-plus-settings .codex-plus-toggle[data-pending="true"],
      .codex-plus-settings .codex-plus-toggle:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-settings .codex-plus-width-control {
        flex: 0 1 auto;
        min-width: 0;
        flex-wrap: wrap;
        gap: 8px;
      }
      .codex-plus-settings .codex-plus-backend-status { overflow-wrap: anywhere; text-align: right; }
      .codex-plus-settings .codex-plus-action-button,
      .codex-plus-settings .codex-plus-issue-button,
      .codex-plus-settings .codex-plus-width-input {
        box-sizing: border-box;
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: 8px;
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font-family: inherit;
        font-size: 13px;
        line-height: 18px;
      }
      .codex-plus-settings .codex-plus-width-input { height: 32px; width: 72px; min-width: 48px; }
      .codex-plus-settings .codex-plus-width-input.codex-plus-model-input { width: 220px; min-width: 0; padding: 0 10px; }
      .codex-plus-settings .codex-plus-model-input:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-settings .codex-plus-action-button,
      .codex-plus-settings .codex-plus-issue-button { white-space: normal; overflow-wrap: anywhere; }
      .codex-plus-settings .codex-plus-action-button:hover,
      .codex-plus-settings .codex-plus-action-button:focus-visible,
      .codex-plus-settings .codex-plus-issue-button:hover,
      .codex-plus-settings .codex-plus-issue-button:focus-visible {
        border-color: var(--codex-plus-border);
        background: var(--codex-plus-bg-hover);
        color: var(--codex-plus-text);
      }
      .codex-plus-settings button:focus-visible,
      .codex-plus-settings input:focus-visible,
      .codex-plus-settings select:focus-visible {
        outline: 2px solid var(--codex-plus-switch-on, #3485ff);
        outline-offset: 3px;
      }
      .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] { container: codex-plus-settings-page / inline-size; }
      @container codex-plus-settings-page (max-width: 800px) {
        .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body { padding: 48px 24px; }
      }
      @container codex-plus-settings-page (max-width: 480px) {
        .${codexPlusPageClass} .codex-plus-modal-content[data-codex-plus-active-tab="home"] .codex-plus-modal-body { padding: 32px 16px; }
      }
      @container codex-plus-settings (max-width: 560px) {
        .codex-plus-settings .codex-plus-row { gap: 16px; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function defaultCodexPlusSettings() {
    return { nativeMenuPlacement: true, nativeFastUnlock: false };
  }

  const codexPlusBackendSettingMap = {
    nativeMenuPlacement: "codexAppNativeMenuPlacement",
    nativeFastUnlock: "codexAppNativeFastUnlock",
  };
  const codexPlusBackendMappedSettings = new Set(Object.keys(codexPlusBackendSettingMap));

  function backendCodexPlusSettings() {
    const settings = {};
    Object.entries(codexPlusBackendSettingMap).forEach(([localKey, backendKey]) => {
      const value = codexPlusBackendSettings[backendKey];
      if (typeof value === "boolean" || typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value))) {
        settings[localKey] = value;
      }
    });
    return settings;
  }

  /**
   * 功能侧读到的设置：设置项开着、且对应的内置拓展在用（没停用、没被顶替）才算开。
   * 设置页的开关要显示 / 切换用户自己存的值，传 { ignoreBuiltins: true }。
   * 映射写在函数里：多个测试把本函数单独切片到沙箱里执行。
   */
  function codexPlusSettings(options) {
    const withBuiltins = (settings) => {
      const inactive = globalThis.__codexPlusBuiltinInactive;
      if (options?.ignoreBuiltins || !inactive?.size) return settings;
      const builtinSettings = { nativeFastUnlock: "native-fast-unlock" };
      Object.entries(builtinSettings).forEach(([key, id]) => {
        if (inactive.has(id)) settings[key] = false;
      });
      return settings;
    };
    if (codexPlusBackendSettings.enhancementsEnabled === false) {
      return {
        nativeMenuPlacement: false,
        nativeFastUnlock: false,
      };
    }
    try {
      const defaults = defaultCodexPlusSettings();
      const stored = JSON.parse(localStorage.getItem(codexPlusSettingsKey) || "{}");
      // 只读取当前支持的选项，旧缓存中的退役开关与参数不能重新激活功能。
      const settings = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter((key) => typeof stored?.[key] === "boolean").map((key) => [key, stored[key]])), ...backendCodexPlusSettings() };
      return withBuiltins(settings);
    } catch {
      const settings = { ...defaultCodexPlusSettings(), ...backendCodexPlusSettings() };
      return withBuiltins(settings);
    }
  }

  function setCodexPlusSetting(key, value) {
    const backendKey = codexPlusBackendSettingMap[key];
    if (backendKey) {
      // 跟着开关走的功能由各自的内置拓展订阅 setBackendSetting 发的 settings/changed，这里不点名。
      void setBackendSetting(backendKey, value).catch(() => {
        void loadBackendSettings();
      });
      return;
    }
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(codexPlusSettingsKey) || "{}");
    } catch {
      stored = {};
    }
    const next = { ...stored, [key]: value };
    localStorage.setItem(codexPlusSettingsKey, JSON.stringify(next));
    if (typeof emitCodexPlusSettingsChanged === "function") emitCodexPlusSettingsChanged(key, value, true);
    renderCodexPlusMenu();
    scan();
  }
