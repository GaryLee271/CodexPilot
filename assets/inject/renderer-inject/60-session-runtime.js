  // 会话引用、桥接和诊断供第三方拓展及保留的增强功能共用。
  let cachedSessionRows = [];
  let cachedSessionRowsAt = 0;

  function sessionRows(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now - cachedSessionRowsAt < 150) {
      cachedSessionRows = cachedSessionRows.filter((row) => row.isConnected);
      if (cachedSessionRows.length > 0) return cachedSessionRows;
    }

    cachedSessionRows = Array.from(document.querySelectorAll(selectors.sidebarThread));
    cachedSessionRowsAt = now;
    return cachedSessionRows;
  }

  function archivePageHintVisible() {
    if (window.location.href.includes("archive")) return true;
    if (document.querySelector('[data-codex-archive-page-row="true"], [data-codex-archive-delete-all]')) return true;
    const archiveNav = document.querySelector(selectors.archiveNav);
    if (archiveNav?.className?.includes?.("bg-token-list-hover-background")) return true;
    return !!Array.from(document.querySelectorAll("h1, h2, h3")).find((element) => (element.textContent || "").trim() === "已归档对话");
  }

  function archiveRowFromUnarchiveButton(button) {
    return button.closest('[data-codex-archive-page-row="true"]')
      || button.closest('[role="listitem"], [role="row"]')
      || button.closest(".flex.w-full.items-center.justify-between")
      || button.parentElement;
  }

  function archivedPageRows() {
    if (!archivePageHintVisible()) return [];
    const rows = Array.from(document.querySelectorAll("button")).filter((button) => (button.textContent || "").trim() === "取消归档").map(archiveRowFromUnarchiveButton).filter(Boolean);
    rows.forEach((row) => {
      row.dataset.codexArchivePageRow = "true";
      row.setAttribute("data-codex-archive-page-row", "true");
    });
    return rows;
  }

  function archivedSessionRows() {
    if (!archivePageHintVisible()) return [];
    return sessionRows().filter((row) => row.querySelector('button[aria-label="取消归档对话"]') || row.outerHTML.includes("取消归档") || row.outerHTML.includes("unarchive"));
  }

  function archivedRows() {
    if (!archivePageHintVisible()) return [];
    return [...archivedSessionRows(), ...archivedPageRows()];
  }

  function archivedPageVisible() {
    return archivePageHintVisible() && archivedRows().length > 0;
  }

  function isClientNewThreadId(value) {
    return /^(?:local:)?client-new-thread:/i.test(String(value || "").trim());
  }

  function normalizedCodexThreadUuid(value) {
    const id = String(value || "").trim().replace(/^local:/i, "");
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
  }

  function reactConversationIdFromRow(row) {
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let fiberDepth = 0; fiber && fiberDepth < 16; fiberDepth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
        const directId = normalizedCodexThreadUuid(props?.conversationId);
        if (directId) return directId;
        const childId = normalizedCodexThreadUuid(
          props?.children?.props?.conversationId,
        );
        if (childId) return childId;
      }
    }
    return "";
  }

  function sessionRefFromRow(row) {
    const href = row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
    const idMatch = href.match(/(?:session|conversation|thread)[=/:-]([A-Za-z0-9_.-]+)/i) || href.match(/([A-Za-z0-9_-]{8,})$/);
    const codexThreadId = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const scopedThread = codexThreadId.match(/^(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const fallbackId = row.getAttribute("data-session-id") || row.getAttribute("data-testid") || "";
    const placeholderThreadId = isClientNewThreadId(codexThreadId);
    const hrefId = idMatch && idMatch[1];
    const canonicalHrefId = normalizedCodexThreadUuid(hrefId);
    const hrefIsTemporary = isClientNewThreadId(href)
      || isClientNewThreadId(hrefId)
      || /(?:^|[=/])(?:local:)?client-new-thread:/i.test(href);
    const sessionId = placeholderThreadId
      ? canonicalHrefId || (!hrefIsTemporary ? reactConversationIdFromRow(row) : "")
      : normalizedCodexThreadUuid(codexThreadId)
        || (scopedThread ? scopedThread[2] : "")
        || canonicalHrefId
        || codexThreadId
        || hrefId
        || fallbackId;
    const titleNode = row.querySelector(`${selectors.threadTitle}, .truncate.select-none, .truncate.text-base`);
    const rawTitle = (titleNode?.textContent || (titleNode ? "" : (row.textContent || "Untitled session")));
    const title = (titleNode ? rawTitle : rawTitle.replace(/\s*(导出|删除|移动|移出项目)(\s*(导出|删除|移动|移出项目))*$/g, "")).trim().slice(0, 160);
    return { session_id: sessionId, title, host_id: sessionHostIdFromRow(row, sessionId, scopedThread?.[1]) };
  }

  function sessionHostIdFromRow(row, sessionId, scopedHost) {
    return sessionHostEvidenceFromRow(row, sessionId, scopedHost).hostId;
  }

  function sessionHostEvidenceFromRow(row, sessionId, scopedHost) {
    const hosts = new Set();
    let matchingMetadata = 0;
    let identityConflict = false;
    const add = (value) => {
      if (typeof value === "string" && value.trim()) hosts.add(value.trim());
    };
    const identity = (value) => {
      if (typeof value !== "string" || !value.trim()) return null;
      const raw = value.trim();
      const scoped = raw.match(/^(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const id = normalizedCodexThreadUuid(raw) || scoped?.[2];
      return id ? { id: id.toLowerCase(), host: scoped?.[1] } : raw === sessionId ? { id: raw, host: null } : null;
    };
    const canonicalWanted = normalizedCodexThreadUuid(sessionId);
    const wanted = canonicalWanted ? canonicalWanted.toLowerCase() : sessionId || "";
    const identities = (record) => [record?.conversationId, record?.threadId, record?.id].map(identity).filter(Boolean);
    const collect = (record) => {
      if (!record || typeof record !== "object") return;
      const ownIds = identities(record);
      const matched = ownIds.some((candidate) => candidate.id === wanted);
      const nested = [record.threadSummary, record.thread, record.target].filter((value) => value && typeof value === "object");
      const allIds = [...ownIds, ...nested.flatMap(identities)];
      if (allIds.some((candidate) => candidate.id === wanted) && allIds.some((candidate) => candidate.id !== wanted)) {
        identityConflict = true;
        return;
      }
      if (matched) {
        matchingMetadata += 1;
        add(record.hostId);
        ownIds.forEach((candidate) => add(candidate.host));
        // 26.930 原生 sidebar 行的 {conversationId,hostId,threadSummary}：
        // hostId ?? threadSummary?.hostId。summary 没有自己的 id 时仍属于这条会话。
        if (record.threadSummary && !["conversationId", "threadId", "id"].some((key) => typeof record.threadSummary[key] === "string" && record.threadSummary[key].trim())) add(record.threadSummary.hostId);
      }
      for (const child of nested) {
        const childIds = identities(child);
        if (!childIds.some((candidate) => candidate.id === wanted)) continue;
        matchingMetadata += 1;
        add(child.hostId);
        childIds.forEach((candidate) => add(candidate.host));
      }
    };
    add(row.getAttribute("data-app-action-sidebar-thread-host-id"));
    const rowIdentity = identity(row.getAttribute("data-app-action-sidebar-thread-id"));
    if (rowIdentity?.id === wanted) add(scopedHost || rowIdentity.host);
    // 只接受同一条会话的成对身份。原生 locator 为 {hostId,threadId}，
    // sidebarThreadRow 为 {hostId,id}；bare UUID 或不相关祖先的 hostId 都不说明归属。
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 16; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps, fiber.pendingProps?.children?.props, fiber.memoizedProps?.children?.props]) {
        collect(props);
      }
    }
    const conflict = identityConflict || hosts.size > 1;
    return {
      hostId: !conflict && hosts.size === 1 ? [...hosts][0] : null,
      reason: conflict ? "conflicting" : hosts.size === 1 ? "resolved" : "unknown",
      hostCount: hosts.size,
      matchingMetadata,
    };
  }

  if (window.__CODEX_PLUS_TEST_SESSION_REF__) {
    window.__codexPlusSessionRefTest = {
      fromRow: sessionRefFromRow,
    };
  }

  function codexPlusDiagnosticPayload(event, detail) {
    return {
      event,
      detail: detail || {},
      hasBridge: !!window.__codexSessionDeleteBridge,
      location: window.location?.href || "",
      userAgent: navigator.userAgent || "",
      timestamp: new Date().toISOString(),
    };
  }

  async function sendCodexPlusDiagnostic(event, detail) {
    const payload = codexPlusDiagnosticPayload(event, detail);
    if (window.__CODEX_PLUS_TEST_SERVICE_TIER__) {
      window.__codexPlusServiceTierTestDiagnostics = window.__codexPlusServiceTierTestDiagnostics || [];
      window.__codexPlusServiceTierTestDiagnostics.push(payload);
      return;
    }
    if (window.__codexSessionDeleteBridge) {
      try {
        const response = await window.__codexSessionDeleteBridge("/diagnostics/log", payload);
        if (response?.status === "ok") return;
      } catch (_) {}
    }
    // 诊断只复用 CDP 桥接；桥接尚未就绪时放弃本条日志，不再请求本机 HTTP 端口。
  }

  sendCodexPlusDiagnostic("script_loaded", {
    version: codexPlusVersion,
    build: codexPlusBuild,
  });

  function locationThreadId() {
    const source = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function currentSessionRef() {
    const rows = sessionRows();
    for (const row of rows) {
      const ref = sessionRefFromRow(row);
      if (ref.session_id && isCurrentSessionRow(row, ref)) return ref;
    }
    return { session_id: locationThreadId(), title: "" };
  }

  async function postJson(path, payload) {
    const bridge = window.__codexSessionDeleteBridge;
    if (typeof bridge !== "function") {
      recordCodexPlusBridgeFailure();
      return { status: "failed", message: "桥接不可用，请重启启动器" };
    }
    try {
      // 状态心跳仍有超时与尝试时间记录，供看门狗区分页面忙碌和真正断连。
      const request = bridge(path, payload);
      const result = path === "/backend/status" ? await withBackendTimeout(request) : await request;
      if (path === "/backend/status" && result?.status !== "ok") {
        recordCodexPlusBridgeFailure();
        if (result?.timeout) {
          recordCodexPlusBridgeAttempt();
          sendCodexPlusDiagnostic("backend_bridge_timeout", { path });
        }
        return result;
      }
      recordCodexPlusBridgeSuccess();
      return result;
    } catch (error) {
      recordCodexPlusBridgeFailure();
      sendCodexPlusDiagnostic("bridge_call_failed", {
        path,
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
      if (path === "/backend/status") {
        return { status: "failed", message: error?.message || "未连接" };
      }
      throw error;
    }
  }
