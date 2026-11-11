  function syncActionGroupsLayout(force = false) {
    syncActionGroupLayouts(sessionRows().map(row => ({
      row, group: actionGroupFromRow(row),
    })), force);
  }

  function removeActionGroups(row) {
    document.querySelectorAll(`.${moreMenuClass}`).forEach((menu) => {
      if (menu.__codexSessionMoreRow === row) disposeSessionMoreMenu(menu);
    });
    row.querySelectorAll(`.${actionGroupClass}`).forEach((group) => group.remove());
  }

  function closeSessionMoreMenu(menu) {
    menu.hidden = true;
    const row = menu.__codexSessionMoreRow || menu.closest?.("[data-codex-delete-row]");
    row?.classList?.remove("codex-session-more-open");
    menu.__codexSessionMoreGroup?.querySelector?.(`.${moreButtonClass}`)?.setAttribute("aria-expanded", "false");
  }

  function disposeSessionMoreMenu(menu) {
    closeSessionMoreMenu(menu);
    menu.__codexSessionMoreCleanup?.();
    // 拓展用 render 自己画的菜单项（例如 dsh 前端插件的 React 组件）：菜单拆掉时一并卸载。
    menu.querySelectorAll?.("[data-codex-plus-extension-item]").forEach((item) => {
      const cleanup = item.__codexPlusRowActionCleanup;
      item.__codexPlusRowActionCleanup = null;
      if (typeof cleanup === "function") {
        try { cleanup(); } catch {}
      }
    });
    const group = menu.__codexSessionMoreGroup;
    if (group?.__codexSessionMoreMenu === menu) group.__codexSessionMoreMenu = null;
    menu.__codexSessionMoreCleanup = null;
    menu.__codexSessionMoreRow = null;
    menu.__codexSessionMoreGroup = null;
    menu.remove();
  }

  /** 按钮组记下的行内操作有没有缺（React 重建、克隆替换时可能丢）。 */
  function sessionInlineActionsMissing(group) {
    return String(group.dataset?.codexInlineActionKey || "").split("|").filter(Boolean)
      .some((id) => !group.querySelector(`[data-codex-plus-row-action="${id}"]`));
  }

  function pruneSessionMoreMenus(removedMenus = []) {
    let needsScan = false;
    // 菜单挂在 body 下，不会随 React 会话行一起卸载；复用现有观察器及时释放。
    const menus = new Set([...document.querySelectorAll(`.${moreMenuClass}`), ...removedMenus]);
    menus.forEach((menu) => {
      const row = menu.__codexSessionMoreRow;
      const group = menu.__codexSessionMoreGroup;
      if (!menu.isConnected || !row?.isConnected || !group?.isConnected || !row.contains(group)
          || !group.querySelector(`.${moreButtonClass}`)
          || sessionInlineActionsMissing(group)) {
        if (row?.isConnected) needsScan = true;
        disposeSessionMoreMenu(menu);
      }
    });
    return needsScan;
  }

  function pruneRemovedSessionActions(mutations) {
    let relevantRemoval = false;
    const removedMenus = new Set();
    const menuSelector = `.${moreMenuClass}`;
    const actionSelector = `.${actionGroupClass}, .${moreButtonClass}, [data-codex-plus-row-action], ${menuSelector}`;
    for (const mutation of mutations || []) {
      for (const node of mutation.removedNodes) {
        if (node.nodeType !== 1 || (!node.matches(actionSelector) && !node.querySelector(actionSelector))) continue;
        relevantRemoval = true;
        if (node.matches(menuSelector)) removedMenus.add(node);
        node.querySelectorAll(menuSelector).forEach((menu) => removedMenus.add(menu));
      }
    }
    // 同步移动和按钮克隆替换在观察器回调前已完成，只依据最终连接状态判断。
    return relevantRemoval && pruneSessionMoreMenus(removedMenus);
  }

  function stopActionButtonEvent(row, button, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    button.blur();
  }

  function installActionButtonEvents(row, button, onActivate) {
    ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => stopActionButtonEvent(row, button, event), true);
    });
    button.addEventListener("pointerenter", () => showActionButtonTooltip(button));
    button.addEventListener("pointerleave", hideActionButtonTooltip);
    button.addEventListener("focus", () => showActionButtonTooltip(button));
    button.addEventListener("blur", hideActionButtonTooltip);
    button.addEventListener("click", (event) => {
      hideActionButtonTooltip();
      onActivate(event);
    }, true);
  }

  function installMoreButtonEvents(row, button, onActivate) {
    ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => stopActionButtonEvent(row, button, event), true);
    });
    button.addEventListener("pointerup", onActivate, true);
    button.addEventListener("click", (event) => {
      hideActionButtonTooltip();
      stopActionButtonEvent(row, button, event);
    }, true);
  }

  function hideActionButtonTooltip() {
    document.querySelectorAll(`.${actionTooltipClass}`).forEach((node) => node.remove());
  }

  function closeSessionMoreMenus(exceptMenu = null) {
    document.querySelectorAll(`.${moreMenuClass}`).forEach((menu) => {
      if (menu !== exceptMenu) {
        closeSessionMoreMenu(menu);
      }
    });
  }

  function toggleSessionMoreMenu(row, button, menu) {
    const nextHidden = !menu.hidden;
    closeSessionMoreMenus(menu);
    menu.hidden = nextHidden;
    row.classList.toggle("codex-session-more-open", !menu.hidden);
    button.setAttribute("aria-expanded", String(!menu.hidden));
  }

  function installSessionMoreMenuAutoClose(row, menu) {
    const group = menu.__codexSessionMoreGroup || menu.closest?.(`.${actionGroupClass}`);
    let closeTimer = null;
    const closeIfOutside = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        if (menu.hidden) return;
        const active = document.activeElement;
        if (group?.matches?.(":hover") || menu.matches?.(":hover") || menu.contains(active)) return;
        closeSessionMoreMenu(menu);
      }, 80);
    };
    group?.addEventListener("pointerleave", closeIfOutside, true);
    menu.addEventListener("pointerleave", closeIfOutside, true);
    menu.addEventListener("focusout", closeIfOutside, true);
    menu.__codexSessionMoreCleanup = () => {
      window.clearTimeout(closeTimer);
      closeTimer = null;
      group?.removeEventListener("pointerleave", closeIfOutside, true);
      menu.removeEventListener("pointerleave", closeIfOutside, true);
      menu.removeEventListener("focusout", closeIfOutside, true);
    };
  }

  function updateSessionMoreMenuDirection(button, menu) {
    menu.classList.remove("codex-session-more-menu-open-up");
    const buttonRect = button.getBoundingClientRect();
    const estimatedMenuHeight = Math.max(80, menu.getBoundingClientRect().height || 76);
    if (buttonRect.bottom + 30 + estimatedMenuHeight > window.innerHeight - 8) {
      menu.classList.add("codex-session-more-menu-open-up");
    }
  }

  function positionSessionMoreMenu(button, menu) {
    const rect = button.getBoundingClientRect();
    const menuWidth = Math.max(104, menu.getBoundingClientRect().width || 104);
    const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.right - menuWidth));
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, rect.bottom + 4)}px`;
  }

  function createSessionMoreMenuItem(label, icon, onActivate) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "codex-session-more-menu-item";
    item.innerHTML = `<span class="codex-session-more-menu-icon">${icon}</span><span>${label}</span>`;
    item.addEventListener("click", onActivate, true);
    return item;
  }

  function showActionButtonTooltip(button) {
    const label = button.dataset.codexActionLabel || button.getAttribute("aria-label") || "";
    if (!label) return;
    hideActionButtonTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = actionTooltipClass;
    tooltip.textContent = label;
    document.body.appendChild(tooltip);
    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 8,
      Math.max(8, buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2),
    );
    const top = Math.min(
      window.innerHeight - tooltipRect.height - 8,
      buttonRect.bottom + gap,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function refreshActionButton(originalButton, row, onActivate) {
    if (!originalButton.isConnected) return;
    const replacement = originalButton.cloneNode(true);
    installActionButtonEvents(row, replacement, onActivate);
    originalButton.replaceWith(replacement);
    return replacement;
  }

  // 会话行图标按钮的线性图标统一画在 16 栅格上，线宽 1.05、圆角端点：与 Codex
  // 原生「置顶 / 归档」所用 light-16 图标的笔画粗细和墨迹范围一致。原生如果换成
  // 描边图标，syncNativeSessionActionStyle 会按它的 stroke-width 换算后覆盖。
  const sessionActionIconStrokeWidth = "1.05";

  function sessionActionStrokeIconSvg(paths) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="${sessionActionIconStrokeWidth}" stroke-linecap="round" stroke-linejoin="round" data-codex-session-action-icon="stroke">${paths}</svg>`;
  }


  function ellipsisIconSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" data-codex-session-action-icon="fill"><circle cx="3.5" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12.5" cy="8" r="1.1"></circle></svg>';
  }

  function configureSvgActionButton(button, label, svg) {
    button.setAttribute("aria-label", label);
    button.dataset.codexActionLabel = label;
    button.removeAttribute("title");
    // 原生按钮的图标包在一层 inner span 里（负责居中），这里保持同样结构，
    // 套用原生类名时 inner span 也一并换成原生的 inner 类名。
    button.innerHTML = `<span class="codex-session-action-inner">${svg}</span>`;
  }

  // Codex 原生按钮的外观由 CSS module 类名 + data-color / data-variant / data-size
  // 等属性共同决定，只抄 className 不够，这些属性要一起带上。
  const nativeSessionActionStyleAttributes = [
    "data-color", "data-variant", "data-size", "data-uniform", "data-pill",
    "data-squircle", "data-icon-size", "data-gutter-size",
  ];
  // 最近一次从原生按钮读到的样式快照；新建的按钮直接套用，不必等悬停。
  let nativeSessionActionStyle = null;

  function nativeSessionIconButtonFromRow(row) {
    for (const button of row?.querySelectorAll?.("button") || []) {
      if (button.closest(`.${actionGroupClass}, [data-codex-plus-ext]`)) continue;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
      if (!/(pin|archive|置顶|归档)/i.test(label)) continue;
      // 只认纯图标按钮：归档二次确认的「确认」是带文字的危险色按钮，不能当样板。
      // 原生图标也可能不是内联 svg，等宽（data-uniform）的图标按钮同样可以当样板。
      if ((button.textContent || "").trim()) continue;
      if (!button.querySelector("svg") && !button.hasAttribute("data-uniform")) continue;
      if (button.getAttribute("data-color") === "danger") continue;
      return button;
    }
    return null;
  }

  function nativeSessionIconStrokeWidth(svg) {
    const stroked = svg?.matches?.("[stroke-width]") ? svg : svg?.querySelector?.("[stroke-width]");
    const width = Number.parseFloat(stroked?.getAttribute("stroke-width") || "");
    const viewBoxWidth = Number.parseFloat((svg?.getAttribute("viewBox") || "").trim().split(/[\s,]+/)[2] || "");
    if (!(width > 0) || !(viewBoxWidth > 0)) return "";
    return String(Math.round((width * 16 / viewBoxWidth) * 100) / 100);
  }

  function readNativeSessionActionStyle(button) {
    const className = typeof button?.className === "string" ? button.className.trim() : "";
    if (!className) return null;
    const attributes = {};
    nativeSessionActionStyleAttributes.forEach((name) => {
      if (button.hasAttribute(name)) attributes[name] = button.getAttribute(name);
    });
    const inner = Array.from(button.children).find((child) => child.tagName === "SPAN" && child.querySelector("svg"));
    const innerClassName = typeof inner?.className === "string" ? inner.className.trim() : "";
    const strokeWidth = nativeSessionIconStrokeWidth(button.querySelector("svg"));
    return {
      className, attributes, innerClassName, strokeWidth,
      key: JSON.stringify([className, attributes, innerClassName, strokeWidth]),
    };
  }

  function applyNativeSessionActionStyle(button, style = nativeSessionActionStyle) {
    if (!(button instanceof HTMLElement)) return;
    // 自己的类名（删除 / 更多的识别类）记在 dataset 上，换原生类名时始终保留。
    if (!button.dataset.codexActionClasses) button.dataset.codexActionClasses = button.className;
    if (!style || button.__codexNativeStyleKey === style.key) return;
    button.className = `${style.className} ${button.dataset.codexActionClasses}`;
    nativeSessionActionStyleAttributes.forEach((name) => button.removeAttribute(name));
    Object.entries(style.attributes).forEach(([name, value]) => button.setAttribute(name, value));
    const inner = button.querySelector(".codex-session-action-inner");
    if (inner) inner.className = `codex-session-action-inner ${style.innerClassName}`.trim();
    button.querySelectorAll('svg[data-codex-session-action-icon="stroke"]').forEach((svg) => {
      svg.setAttribute("stroke-width", style.strokeWidth || sessionActionIconStrokeWidth);
    });
    button.setAttribute("data-codex-native-style", "true");
    button.__codexNativeStyleKey = style.key;
  }

  function syncNativeSessionActionStyle(row) {
    const native = nativeSessionIconButtonFromRow(row);
    const style = native ? readNativeSessionActionStyle(native) : null;
    const changed = !!style && style.key !== nativeSessionActionStyle?.key;
    if (changed) nativeSessionActionStyle = style;
    if (!nativeSessionActionStyle) return;
    // 原生样式变了（Codex 改版或首次读到）就刷新所有行，否则只补当前行。
    const scope = changed ? document : actionGroupFromRow(row);
    scope?.querySelectorAll?.(`.${actionButtonClass}`)
      .forEach((button) => applyNativeSessionActionStyle(button));
  }

  function installNativeSessionActionStyleSync(row) {
    if (row.__codexNativeActionStyleSync) return;
    row.__codexNativeActionStyleSync = true;
    // 原生置顶 / 归档按钮多数只在悬停时挂载，当帧还没渲染出来，等下一帧再读。
    row.addEventListener("pointerenter", () => {
      window.requestAnimationFrame(() => {
        if (row.isConnected) syncNativeSessionActionStyle(row);
      });
    }, { passive: true });
  }

  /**
   * 会话行操作（ctx.registerRowAction / codexPlus.registerRowAction）：placement 为 "inline" 的画成行上常驻的图标按钮，
   * 其余进「…」菜单；surfaces 默认只在侧栏，含 "archived" 的也画在归档页的行上。内置的删除、导出也是这样注册的
   * （见 96-builtin-extensions.js），这里只是宿主。增强总开关关闭时都不显示。
   */
  function sessionRowActionItems(surface = "sidebar") {
    if (codexPlusBackendSettings.enhancementsEnabled === false) return [];
    return codexPlusExtensionItems(codexPlusRegistry.rowActions)
      .filter((item) => (Array.isArray(item.surfaces) && item.surfaces.length ? item.surfaces : ["sidebar"]).includes(surface));
  }

  /** 行内按钮的图标：SVG 原样用，其余当文字字形。 */
  function sessionRowActionIconMarkup(icon) {
    const text = String(icon ?? "").trim();
    if (/^<svg[\s>]/i.test(text)) return text;
    const glyph = (text || "◇").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
    return `<span class="codex-session-action-glyph">${glyph}</span>`;
  }

  /** 拓展行操作的回调参数。归档页的行未必读得到会话 id，resolve() 必要时问 Codex Pilot 按标题找。 */
  function sessionRowActionContext(row, extra = {}) {
    const archived = extra.archived === true;
    const ref = archived ? archivedRefFromRow(row) : sessionRefFromRow(row);
    return {
      row,
      session_id: ref.session_id,
      title: ref.title || row.getAttribute?.("data-app-action-sidebar-thread-title") || "",
      archived,
      resolve: () => (archived ? resolveArchivedThread(row) : Promise.resolve(sessionRefFromRow(row))),
      close: () => closeSessionMoreMenus(),
      ...extra,
    };
  }

  function attachButton(row) {
    const items = sessionRowActionItems();
    const inlineItems = items.filter((item) => item.placement === "inline");
    // 菜单指纹：项变了（拓展注册 / 注销）就整组重建；空串表示没有菜单项，不渲染「…」按钮。
    const moreMenuKey = items.filter((item) => item.placement !== "inline").map((item) => `ext:${item.id}`).join("|");
    const inlineKey = inlineItems.map((item) => item.id).join("|");
    const needsMoreMenu = !!moreMenuKey;
    if (!inlineItems.length && !needsMoreMenu) {
      removeActionGroups(row);
      row.dataset.codexDeleteRow = "false";
      return;
    }
    const existingGroup = actionGroupFromRow(row);
    const existingMoreButton = existingGroup?.querySelector(`.${moreButtonClass}`);
    const groupReady = existingGroup?.dataset.codexActionGroupVersion === codexActionGroupVersion;
    const inlineReady = existingGroup?.dataset.codexInlineActionKey === inlineKey && !sessionInlineActionsMissing(existingGroup);
    const existingMenu = existingGroup?.__codexSessionMoreMenu;
    const menuReady = !needsMoreMenu || (existingMenu?.isConnected
      && existingMenu.__codexSessionMoreRow === row && existingMenu.__codexSessionMoreGroup === existingGroup
      && existingGroup.dataset.codexMoreMenuKey === moreMenuKey);
    if (groupReady && inlineReady && menuReady && needsMoreMenu === !!existingMoreButton) {
      return;
    }
    removeActionGroups(row);
    row.dataset.codexDeleteRow = "false";
    const ref = sessionRefFromRow(row);
    if (!ref.session_id) return;
    row.dataset.codexDeleteRow = "true";
    const group = document.createElement("div");
    group.className = actionGroupClass;
    group.setAttribute("data-codex-plus-ext", "session-actions");
    group.dataset.codexActionGroupVersion = codexActionGroupVersion;
    group.dataset.codexMoreMenuKey = moreMenuKey;
    group.dataset.codexInlineActionKey = inlineKey;
    if (needsMoreMenu) {
      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = `${actionButtonClass} ${moreButtonClass}`;
      moreButton.setAttribute("aria-haspopup", "menu");
      moreButton.setAttribute("aria-expanded", "false");
      configureSvgActionButton(moreButton, "更多操作", ellipsisIconSvg());
      applyNativeSessionActionStyle(moreButton);
      const moreMenu = document.createElement("div");
      moreMenu.className = moreMenuClass;
      moreMenu.setAttribute("data-codex-plus-ext", "session-more-menu");
      moreMenu.setAttribute("role", "menu");
      moreMenu.hidden = true;
      // 会话行操作按注册顺序（order）追加。注册 / 注销会改变 moreMenuKey，
      // 触发整组重建并重新走一遍这里，所以拓展项不会因为重建而丢失。
      appendCodexPlusExtensionRowActions(moreMenu, row, moreButton);
      const openMoreMenu = (event) => {
        stopActionButtonEvent(row, moreButton, event);
        hideActionButtonTooltip();
        toggleSessionMoreMenu(row, moreButton, moreMenu);
        if (!moreMenu.hidden) {
          positionSessionMoreMenu(moreButton, moreMenu);
          updateSessionMoreMenuDirection(moreButton, moreMenu);
        }
      };
      installMoreButtonEvents(row, moreButton, openMoreMenu);
      group.appendChild(moreButton);
      moreMenu.__codexSessionMoreRow = row;
      moreMenu.__codexSessionMoreGroup = group;
      group.__codexSessionMoreMenu = moreMenu;
      document.body.appendChild(moreMenu);
      installSessionMoreMenuAutoClose(row, moreMenu);
    }
    inlineItems.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      // 拓展自己的类名在套原生样式之前加上，换原生类名时一并保留。
      button.className = [actionButtonClass, ...String(item.className || "").split(/\s+/).filter(Boolean)].join(" ");
      button.setAttribute("data-codex-plus-row-action", item.id);
      const label = String(item.label || item.id);
      configureSvgActionButton(button, label, sessionRowActionIconMarkup(item.icon));
      if (typeof item.onMount === "function") {
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onMount", () => item.onMount({ button, row, session_id: ref.session_id }));
      }
      applyNativeSessionActionStyle(button);
      const activate = (event) => {
        stopActionButtonEvent(row, button, event);
        if (typeof item.onActivate !== "function") return;
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onActivate", () =>
          item.onActivate(sessionRowActionContext(row, { button, event })));
      };
      installActionButtonEvents(row, button, activate);
      group.appendChild(button);
      setTimeout(() => refreshActionButton(button, row, activate), 0);
    });
    row.appendChild(group);
    // 先套上原生按钮外观再量布局，避免尺寸在测量后才变化。
    syncNativeSessionActionStyle(row);
    installNativeSessionActionStyleSync(row);
    syncActionGroupLayout(row, group);
  }

  function tryAttachButton(row) {
    try {
      attachButton(row);
    } catch (error) {
      window.__codexSessionDeleteAttachButtonFailures = window.__codexSessionDeleteAttachButtonFailures || [];
      window.__codexSessionDeleteAttachButtonFailures.push(String(error?.stack || error));
    }
  }

  function reactArchivedThreadFromNode(node) {
    const reactKey = Object.keys(node).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
    let fiber = reactKey ? node[reactKey] : null;
    for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      if (props.archivedThread?.id) return props.archivedThread;
      const childThread = props.children?.props?.archivedThread;
      if (childThread?.id) return childThread;
    }
    return null;
  }

  function archivedThreadFromRow(row) {
    for (const node of [row, ...row.querySelectorAll("*")]) {
      const thread = reactArchivedThreadFromNode(node);
      if (thread?.id || thread?.sessionId) return thread;
    }
    return null;
  }

  function archivedRefFromRow(row) {
    const archivedThread = archivedThreadFromRow(row);
    if (archivedThread?.id || archivedThread?.sessionId) {
      return { session_id: archivedThread.id || archivedThread.sessionId, title: archivedThread.title || row.querySelector(".truncate.text-base")?.textContent?.trim() || "Untitled session" };
    }
    const sidebarRef = sessionRefFromRow(row);
    if (sidebarRef.session_id) return sidebarRef;
    const titleNode = row.querySelector(".truncate.text-base, [data-thread-title], a, div");
    const title = ((titleNode || row).textContent || "Untitled session")
      .replace("取消归档", "")
      .replace("删除", "")
      .replace(/\d{4}年\d{1,2}月\d{1,2}日.*$/, "")
      .replace(/\s+·\s+.*$/, "")
      .trim()
      .slice(0, 160);
    return { session_id: "", title };
  }

  async function resolveArchivedThread(row) {
    const ref = archivedRefFromRow(row);
    if (ref.session_id) return ref;
    const resolved = await postJson("/archived-thread", { title: ref.title });
    return resolved?.session_id ? resolved : ref;
  }

  function stopArchivedButtonEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  /** 归档页的行：surfaces 含 "archived" 的会话行操作画成「取消归档」旁的文字按钮。 */
  function attachArchivedPageDeleteButton(row) {
    const items = sessionRowActionItems("archived");
    row.querySelectorAll("[data-codex-archive-row-action]").forEach((button) => button.remove());
    row.dataset.codexArchiveDeleteRow = "false";
    if (!items.length) return;
    const unarchiveButton = Array.from(row.querySelectorAll("button")).find((button) => (button.textContent || "").trim() === "取消归档");
    if (!unarchiveButton) return;
    row.dataset.codexArchiveDeleteRow = "true";
    row.dataset.codexArchiveRowActionsVersion = codexArchiveRowActionsVersion;
    let insertionPoint = unarchiveButton;
    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = ["codex-archive-delete-all", "codex-archive-row-button", ...String(item.className || "").split(/\s+/).filter(Boolean)].join(" ");
      button.dataset.codexArchiveRowAction = item.id;
      button.textContent = String(item.label || item.id);
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopArchivedButtonEvent, true);
      });
      button.addEventListener("click", (event) => {
        stopArchivedButtonEvent(event);
        if (typeof item.onActivate !== "function") return;
        runCodexPlusExtensionCallback(item.scriptKey, "rowAction.onActivate", () =>
          item.onActivate(sessionRowActionContext(row, { archived: true, button, event })));
      }, true);
      insertionPoint.insertAdjacentElement("afterend", button);
      insertionPoint = button;
    });
  }

  function conversationRoot() {
    return document.querySelector(".thread-scroll-container") || document.querySelector("main") || document.querySelector('[role="main"]');
  }

  function nodeOrAncestorLooksLikeCodexUserBubble(node) {
    if (node.nodeType !== 1) return false;
    const className = String(node.className || "");
    if (className.includes("bg-token-foreground/5") && node.parentElement?.classList?.contains("items-end")) return true;
    const bubble = node.closest?.("[class*='bg-token-foreground/5']");
    return !!bubble?.parentElement?.classList?.contains("items-end");
  }

  function nodeLooksLikeCodexUserBubble(node) {
    if (nodeOrAncestorLooksLikeCodexUserBubble(node)) return true;
    return !!node.querySelector?.(".group.flex.w-full.flex-col.items-end.justify-end.gap-1 > [class*='bg-token-foreground/5']");
  }

  function removeLegacyCodexServiceTierBadges() {
    document.querySelectorAll(`[data-codex-service-tier-badge="true"]`).forEach((badge) => badge.remove());
  }
