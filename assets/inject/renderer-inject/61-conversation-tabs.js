  /*
   * 改编自 chatgpt-codex-tabs 的独立 renderer（不包含 CodexHost 或独立启动器）。
   * 来源：https://github.com/yuanruoyu515/chatgpt-codex-tabs
   * MIT License
   *
   * Copyright (c) 2026 yuanruoyu515
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */

  // 热注入先释放旧监听、观察器、计时器和布局；开关关闭后持久化标签继续保留。
  window.__codexPlusConversationTabs?.dispose?.();

  function syncCodexPlusConversationTabs() {
    const enabled = codexPlusBackendSettings.enhancementsEnabled === true
      && codexPlusBackendSettings.codexAppConversationTabs === true;
    const eligible = document.body && !new URL(window.location.href).searchParams.has('initialRoute');
    if (!enabled || !eligible) {
      window.__codexPlusConversationTabs?.dispose?.();
      return;
    }
    if (!window.__codexPlusConversationTabs) createCodexPlusConversationTabs();
  }

  function createCodexPlusConversationTabs() {
    const navigate = (path) => window.electronBridge?.sendMessageFromView?.({ type: 'open-in-main-window', path });



    let store;
    try { store = window.localStorage; } catch { /* 系统禁用本地存储时仍允许临时使用标签。 */ }
    const key = 'codex-plus:conversation-tabs:v1';
    const attr = 'data-app-action-sidebar-thread-';
    const MAX_TABS = 30;
    const STRINGS = {
      en: ['Open threads', 'New chat', 'Close tab (the thread is kept)', 'Close tab: ', 'Untitled thread', 'Close tab', 'Close other tabs', 'Close tabs to the right', 'Thread options…', 'Not in the sidebar'],
      'zh-CN': ['打开的对话', '新建对话', '关闭标签（不会删除对话）', '关闭标签：', '未命名对话', '关闭标签', '关闭其他标签', '关闭右侧标签', '对话选项…', '侧栏里没有这个对话'],
      'zh-TW': ['已開啟的對話', '新增對話', '關閉分頁（不會刪除對話）', '關閉分頁：', '未命名對話', '關閉分頁', '關閉其他分頁', '關閉右側分頁', '對話選項…', '側邊欄裡沒有這個對話'],
      ja: ['開いているスレッド', '新しいチャット', 'タブを閉じる（スレッドは削除されません）', 'タブを閉じる：', '無題のスレッド', 'タブを閉じる', '他のタブを閉じる', '右側のタブを閉じる', 'スレッドのオプション…', 'サイドバーにありません'],
      ko: ['열린 스레드', '새 채팅', '탭 닫기(스레드는 삭제되지 않음)', '탭 닫기: ', '제목 없는 스레드', '탭 닫기', '다른 탭 닫기', '오른쪽 탭 닫기', '스레드 옵션…', '사이드바에 없음'],
      es: ['Conversaciones abiertas', 'Nuevo chat', 'Cerrar pestaña (la conversación no se elimina)', 'Cerrar pestaña: ', 'Conversación sin título', 'Cerrar pestaña', 'Cerrar las demás pestañas', 'Cerrar pestañas a la derecha', 'Opciones de la conversación…', 'No está en la barra lateral'],
      fr: ['Conversations ouvertes', 'Nouveau chat', 'Fermer l’onglet (la conversation est conservée)', 'Fermer l’onglet : ', 'Conversation sans titre', 'Fermer l’onglet', 'Fermer les autres onglets', 'Fermer les onglets à droite', 'Options de la conversation…', 'Absente de la barre latérale'],
      de: ['Geöffnete Threads', 'Neuer Chat', 'Tab schließen (Thread bleibt erhalten)', 'Tab schließen: ', 'Unbenannter Thread', 'Tab schließen', 'Andere Tabs schließen', 'Tabs rechts schließen', 'Thread-Optionen…', 'Nicht in der Seitenleiste'],
      it: ['Conversazioni aperte', 'Nuova chat', 'Chiudi scheda (la conversazione resta)', 'Chiudi scheda: ', 'Conversazione senza titolo', 'Chiudi scheda', 'Chiudi le altre schede', 'Chiudi le schede a destra', 'Opzioni conversazione…', 'Non presente nella barra laterale'],
      pt: ['Conversas abertas', 'Novo chat', 'Fechar aba (a conversa não é excluída)', 'Fechar aba: ', 'Conversa sem título', 'Fechar aba', 'Fechar outras abas', 'Fechar abas à direita', 'Opções da conversa…', 'Não está na barra lateral'],
      'pt-PT': ['Conversas abertas', 'Novo chat', 'Fechar separador (a conversa não é eliminada)', 'Fechar separador: ', 'Conversa sem título', 'Fechar separador', 'Fechar os outros separadores', 'Fechar separadores à direita', 'Opções da conversa…', 'Não está na barra lateral'],
      nl: ['Geopende gesprekken', 'Nieuwe chat', 'Tabblad sluiten (gesprek blijft bewaard)', 'Tabblad sluiten: ', 'Naamloos gesprek', 'Tabblad sluiten', 'Andere tabbladen sluiten', 'Tabbladen rechts sluiten', 'Gespreksopties…', 'Niet in de zijbalk'],
      pl: ['Otwarte wątki', 'Nowy czat', 'Zamknij kartę (wątek pozostaje)', 'Zamknij kartę: ', 'Wątek bez tytułu', 'Zamknij kartę', 'Zamknij pozostałe karty', 'Zamknij karty po prawej', 'Opcje wątku…', 'Brak na pasku bocznym'],
      ru: ['Открытые чаты', 'Новый чат', 'Закрыть вкладку (чат не удаляется)', 'Закрыть вкладку: ', 'Чат без названия', 'Закрыть вкладку', 'Закрыть другие вкладки', 'Закрыть вкладки справа', 'Параметры чата…', 'Нет на боковой панели'],
      uk: ['Відкриті чати', 'Новий чат', 'Закрити вкладку (чат не видаляється)', 'Закрити вкладку: ', 'Чат без назви', 'Закрити вкладку', 'Закрити інші вкладки', 'Закрити вкладки праворуч', 'Параметри чату…', 'Немає на бічній панелі'],
      tr: ['Açık sohbetler', 'Yeni sohbet', 'Sekmeyi kapat (sohbet silinmez)', 'Sekmeyi kapat: ', 'Adsız sohbet', 'Sekmeyi kapat', 'Diğer sekmeleri kapat', 'Sağdaki sekmeleri kapat', 'Sohbet seçenekleri…', 'Kenar çubuğunda yok'],
      vi: ['Cuộc trò chuyện đang mở', 'Cuộc trò chuyện mới', 'Đóng thẻ (không xóa cuộc trò chuyện)', 'Đóng thẻ: ', 'Cuộc trò chuyện chưa đặt tên', 'Đóng thẻ', 'Đóng các thẻ khác', 'Đóng các thẻ bên phải', 'Tùy chọn cuộc trò chuyện…', 'Không có trong thanh bên'],
      id: ['Percakapan terbuka', 'Chat baru', 'Tutup tab (percakapan tidak dihapus)', 'Tutup tab: ', 'Percakapan tanpa judul', 'Tutup tab', 'Tutup tab lain', 'Tutup tab di sebelah kanan', 'Opsi percakapan…', 'Tidak ada di bilah samping'],
      th: ['แชทที่เปิดอยู่', 'แชทใหม่', 'ปิดแท็บ (แชทจะไม่ถูกลบ)', 'ปิดแท็บ: ', 'แชทที่ไม่มีชื่อ', 'ปิดแท็บ', 'ปิดแท็บอื่น', 'ปิดแท็บทางขวา', 'ตัวเลือกแชท…', 'ไม่อยู่ในแถบด้านข้าง'],
    };
    const KEYS = ['bar', 'add', 'closeTip', 'closeLabel', 'untitled', 'close', 'closeOthers', 'closeRight', 'options', 'noRow'];
    const PROJECT_STRINGS = {
      en: ['No project', 'Project unavailable'], 'zh-CN': ['未关联项目', '项目未识别'], 'zh-TW': ['未關聯專案', '無法識別專案'],
      ja: ['プロジェクトなし', 'プロジェクト不明'], ko: ['프로젝트 없음', '프로젝트 확인 불가'],
      es: ['Sin proyecto', 'Proyecto no disponible'], fr: ['Aucun projet', 'Projet indisponible'], de: ['Kein Projekt', 'Projekt nicht verfügbar'],
      it: ['Nessun progetto', 'Progetto non disponibile'], pt: ['Sem projeto', 'Projeto indisponível'], 'pt-PT': ['Sem projeto', 'Projeto indisponível'],
      nl: ['Geen project', 'Project niet beschikbaar'], pl: ['Brak projektu', 'Projekt niedostępny'], ru: ['Без проекта', 'Проект недоступен'],
      uk: ['Без проєкту', 'Проєкт недоступний'], tr: ['Proje yok', 'Proje kullanılamıyor'], vi: ['Không có dự án', 'Không xác định dự án'],
      id: ['Tanpa proyek', 'Proyek tidak tersedia'], th: ['ไม่มีโปรเจกต์', 'ไม่พบโปรเจกต์'],
    };
    const OLD_UNTITLED = new Set(['未命名对话']);
    let str = {}, lang = '';
    function localize() {
      const tag = document.documentElement.lang || navigator.language || 'en';
      if (tag === lang) return false;
      lang = tag;
      const [base, region = ''] = tag.split('-'), r = region.toUpperCase();
      const pick = base === 'zh' ? (/^(TW|HK|MO|HANT)$/.test(r) || /hant/i.test(tag) ? 'zh-TW' : 'zh-CN')
        : base === 'pt' && r === 'PT' ? 'pt-PT' : Object.hasOwn(STRINGS, base) ? base : 'en';
      str = Object.fromEntries(KEYS.map((k, i) => [k, STRINGS[pick][i]]));
      [str.noProject, str.unknownProject] = PROJECT_STRINGS[pick];
      return true;
    }
    localize();
    const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const abort = new AbortController();
    const opts = { signal: abort.signal };
    // active 是乐观选中项；appActive 来自已确认的原生路由/侧栏，pending 等待导航完成。
    let tabs = [], active = '', appActive = '', pending = null, scrolledTo = '';
    let disposed = false, timer = 0, suppressed = '', saved = '';
    let statusApi = null, statusContext = null, statusWatch = null, statusIds = '';
    let statusLoading = false, statusLoadAttempts = 0, statusNextLoadAt = 0;
    let nativeStates = new Map(), nativeProjects = new Map(), statusGeneration = 0;
    // 悬停子菜单和拖动动画的延迟也归运行时所有，关闭开关不能遗留异步回调。
    const delays = new Set();
    function later(callback, ms) {
      const id = setTimeout(() => { delays.delete(id); if (!disposed) callback(); }, ms);
      delays.add(id);
      return id;
    }
    function cancelLater(id) { clearTimeout(id); delays.delete(id); }
    // 只保存本机持久 UUID；损坏缓存、重复项和临时客户端 ID 都不能变成导航目标。
    try {
      const parsed = JSON.parse(store?.getItem(key) || '[]');
      if (Array.isArray(parsed)) tabs = [...new Map(parsed.filter(valid).map(tab => [tab.id.toLowerCase(), stored(tab)])).values()].slice(-MAX_TABS);
    } catch {}
    for (const tab of tabs) if (OLD_UNTITLED.has(tab.title)) tab.title = '';
    function valid(t) { return t && typeof t.id === 'string' && ID.test(t.id) && typeof t.title === 'string'; }
    function stored({ id, title }) { return { id: id.toLowerCase(), title: title.slice(0, 240) }; }
    function visible(el) { return el && !el.closest('[data-app-shell-active-page="false"], [inert]') && el.getBoundingClientRect().width > 0; }
    function isLocal(r) { return r.getAttribute(attr + 'host-id') === 'local' && ['', 'local'].includes(r.getAttribute(attr + 'kind') || ''); }
    function rowId(r) {
      const raw = (r.getAttribute(attr + 'id') || '').replace(/^local:/, '');
      if (ID.test(raw)) return raw.toLowerCase();
      // 新建对话行可能保留 client-new-thread；复用已核验的会话引用，不按重名标题猜 UUID。
      const ref = typeof sessionRefFromRow === 'function' ? sessionRefFromRow(r) : null;
      return ref?.host_id === 'local' && ID.test(ref.session_id) ? ref.session_id.toLowerCase() : '';
    }
    function sidebarRows() { return [...document.querySelectorAll(`[${attr}row]`)].filter(row => !row.closest('[data-codex-plus-ext]')); }
    function rowFor(id, anyRow = false) {
      let fallback = null;
      for (const r of sidebarRows()) {
        if (rowId(r) !== id || !isLocal(r)) continue;
        if (visible(r)) return r;
        fallback ??= r;
      }
      return anyRow ? fallback : null;
    }
    function routeId() {
      const url = new URL(location.href);
      const path = url.searchParams.get('initialRoute') || url.pathname;
      const value = /^\/local\/([\w-]+)(?:[/?#]|$)/.exec(path)?.[1] || '';
      return ID.test(value) ? value.toLowerCase() : '';
    }
    function currentRoute() {
      // 原生地址栏通常停在 index.html；当前页面的路由 context 才是会话身份的稳定来源。
      // retained 页面可能仍在 DOM 中，必须排除隐藏页面及其后代。
      const anchor = [...document.querySelectorAll('[data-app-shell-active-page="true"]')]
        .find(element => !element.closest('[data-app-shell-active-page="false"], [inert]'));
      const key = anchor && Object.getOwnPropertyNames(anchor).find(name => name.startsWith('__reactFiber$'));
      let fiber = anchor?.[key], root = fiber;
      for (let depth = 0; root?.return && depth < 200; depth++) root = root.return;
      // React 会交替提交两棵 fiber；DOM 上的引用可能仍指向旧树，不能拿旧路由覆盖新选中项。
      if (fiber?.alternate && root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber.alternate;
      for (let depth = 0; fiber && depth < 180; fiber = fiber.return, depth++) {
        const route = fiber.memoizedProps?.value;
        if (typeof route?.routeKind !== 'string' || typeof route.pathname !== 'string') continue;
        // 新会话的临时路由仍可由侧栏提供正式 UUID，不能直接当作离开对话页。
        if (route.routeKind === 'client-local-thread' && (route.hostId == null || route.hostId === 'local')) return { known: false, id: '' };
        if (route.routeKind !== 'local-thread' || route.hostId != null && route.hostId !== 'local') return { known: true, id: '' };
        const id = typeof route.conversationId === 'string' && ID.test(route.conversationId)
          ? route.conversationId : /^\/local\/([\w-]+)(?:[/?#]|$)/.exec(route.pathname)?.[1] || '';
        // 临时新会话路由尚未取得正式 UUID 时不判作首页，继续等侧栏的可信引用。
        return { known: ID.test(id), id: ID.test(id) ? id.toLowerCase() : '' };
      }
      return { known: false, id: '' };
    }
    // 仅持久化标签 UUID / 标题 / 顺序；项目归属、图标和状态每次从原生重读，避免移动/改名后残留旧信息。
    function persist() { try { const value = JSON.stringify(tabs.map(stored)); if (value !== saved) { store?.setItem(key, value); saved = value; } } catch {} }
    const icon = {
      close: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
      plus: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      folder: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    };
    const style = document.createElement('style');
    style.textContent = `
      #codex-plus-conversation-tabs,#codex-plus-conversation-tabs-menu{--cpt-fg:var(--color-text-primary-ghost,#1f2328);--cpt-muted:var(--color-text-secondary-ghost,#1f23287e);--cpt-hover:var(--color-background-primary-ghost-hover,#1f23280e);--cpt-line:var(--color-border,#1f232814);--cpt-ring:var(--color-ring,#0969da);--cpt-ease:var(--ease-enter-snappy,cubic-bezier(.23,1,.32,1))}
      #codex-plus-conversation-tabs{position:fixed;z-index:45;display:flex;align-items:center;gap:6px;height:54px;padding:0 10px 0 12px;box-sizing:border-box;border-bottom:1px solid var(--cpt-line);color:var(--cpt-fg);font:430 13px/18px var(--font-sans,-apple-system,BlinkMacSystemFont,sans-serif);-webkit-app-region:no-drag;overflow:hidden;user-select:none;-webkit-user-select:none}
      #codex-plus-conversation-tabs *{-webkit-user-drag:none}
      #codex-plus-conversation-tabs[hidden]{display:none!important}
      #codex-plus-conversation-tabs .cpt-list{position:relative;display:flex;align-items:center;gap:2px;min-width:0;flex:1;height:100%;overflow-x:auto;scrollbar-width:none}
      #codex-plus-conversation-tabs .cpt-list::-webkit-scrollbar{display:none}
      #codex-plus-conversation-tabs .cpt-item{position:relative;display:flex;align-items:center;flex:0 1 200px;min-width:104px;height:44px;padding:0 3px 0 10px;border-radius:var(--radius-md,10px);color:var(--cpt-muted);cursor:default;transition:background-color .15s var(--cpt-ease),color .15s var(--cpt-ease),opacity .15s}
      #codex-plus-conversation-tabs .cpt-item:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-item.cpt-active{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-item:not(.cpt-lifted),#codex-plus-conversation-tabs .cpt-item.cpt-settle{transition:transform .2s var(--cpt-ease),background-color .15s var(--cpt-ease),color .15s var(--cpt-ease)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-item:not(.cpt-lifted):not(.cpt-active){background:transparent}
      #codex-plus-conversation-tabs .cpt-item.cpt-lifted{z-index:1;color:var(--cpt-fg);background:linear-gradient(var(--cpt-hover),var(--cpt-hover)),var(--cpt-bg,Canvas);box-shadow:0 1px 2px rgb(0 0 0/.1),0 4px 14px rgb(0 0 0/.1)}
      #codex-plus-conversation-tabs.cpt-reordering .cpt-close{opacity:0!important}
      #codex-plus-conversation-tabs button{font:inherit;color:inherit;background:transparent;border:0;padding:0;margin:0;cursor:default;-webkit-app-region:no-drag}
      #codex-plus-conversation-tabs button:focus-visible{outline:2px solid var(--cpt-ring);outline-offset:-2px;border-radius:var(--radius-sm,7px)}
      #codex-plus-conversation-tabs .cpt-open{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:1px;overflow:hidden;white-space:nowrap;text-align:start}
      #codex-plus-conversation-tabs .cpt-title-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:20px}
      #codex-plus-conversation-tabs .cpt-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      #codex-plus-conversation-tabs .cpt-project{display:flex;align-items:center;gap:3px;min-width:0;height:12px;font-size:9px;line-height:12px;font-weight:400;color:var(--cpt-muted)}
      #codex-plus-conversation-tabs .cpt-project-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
      /* 保留原生图标的内部规格，在项目行统一缩小文件夹、SVG 和表情图标。 */
      #codex-plus-conversation-tabs .cpt-project-icon,#codex-plus-conversation-tabs .cpt-project-fallback,#codex-plus-conversation-tabs .cpt-project-native-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:10px;height:10px;font-size:10px;line-height:10px}
      #codex-plus-conversation-tabs .cpt-project-icon svg,#codex-plus-conversation-tabs .cpt-project-icon img{max-width:10px;max-height:10px}
      #codex-plus-conversation-tabs .cpt-status{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-status[hidden]{display:none}
      #codex-plus-conversation-tabs .cpt-item:has(.cpt-status[data-state="input"]),#codex-plus-conversation-tabs .cpt-item:has(.cpt-status[data-state="approval"]){min-width:156px}
      #codex-plus-conversation-tabs .cpt-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--color-text-info-ghost-hover,#0169cc)}
      #codex-plus-conversation-tabs .cpt-dot[hidden]{display:none}
      #codex-plus-conversation-tabs .cpt-close{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:6px;color:var(--cpt-muted);opacity:0;transition:opacity .15s,background-color .15s}
      #codex-plus-conversation-tabs .cpt-item:hover .cpt-close,#codex-plus-conversation-tabs .cpt-active .cpt-close,#codex-plus-conversation-tabs .cpt-close:focus-visible{opacity:1}
      #codex-plus-conversation-tabs .cpt-close:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs .cpt-add{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-md,10px);color:var(--cpt-muted);transition:background-color .15s,color .15s}
      #codex-plus-conversation-tabs .cpt-add:hover{background:var(--cpt-hover);color:var(--cpt-fg)}
      #codex-plus-conversation-tabs-menu{position:fixed;z-index:1000;min-width:180px;padding:5px;box-sizing:border-box;border-radius:12px;border:1px solid var(--cpt-line);background:var(--cpt-bg,Canvas);color:var(--cpt-fg);box-shadow:0 8px 28px rgb(0 0 0/.16);font:430 13px/18px var(--font-sans,-apple-system,BlinkMacSystemFont,sans-serif);user-select:none;-webkit-app-region:no-drag}
      #codex-plus-conversation-tabs-menu[hidden]{display:none}
      #codex-plus-conversation-tabs-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:5px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:start;cursor:default}
      #codex-plus-conversation-tabs-menu .cpt-chevron{color:var(--cpt-muted)}
      #codex-plus-conversation-tabs-menu button:is(:hover,:focus-visible,.cpt-expanded):not(:disabled){background:var(--cpt-hover);outline:none}
      #codex-plus-conversation-tabs-menu button:disabled{color:var(--cpt-muted)}
      #codex-plus-conversation-tabs-menu hr{height:1px;margin:4px 6px;border:0;background:var(--cpt-line)}
      html.cpt-dragging,html.cpt-dragging *{-webkit-app-region:no-drag!important}
      [data-codex-plus-tabs-space]{padding-top:54px!important;box-sizing:border-box!important}
      @media(prefers-reduced-motion:reduce){#codex-plus-conversation-tabs *{transition:none!important}}
      @media(forced-colors:active){#codex-plus-conversation-tabs .cpt-active{outline:1px solid Highlight}}
    `;
    const bar = document.createElement('nav');
    bar.id = 'codex-plus-conversation-tabs';
    for (const element of [style, bar]) element.setAttribute('data-codex-plus-ext', 'conversation-tabs');
    const list = document.createElement('div'); list.className = 'cpt-list'; list.setAttribute('role','tablist'); bar.append(list);
    const add = document.createElement('button'); add.className = 'cpt-add'; add.innerHTML = icon.plus;
    add.addEventListener('click', () => navigate('/'), opts); bar.append(add);
    const menu = document.createElement('div'); menu.setAttribute('data-codex-plus-ext', 'conversation-tabs'); menu.id = 'codex-plus-conversation-tabs-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    document.head.append(style); document.body.append(bar, menu);
    function labels() {
      bar.setAttribute('aria-label', str.bar); add.title = str.add; add.setAttribute('aria-label', str.add);
    }
    labels();
    const langWatch = new MutationObserver(() => { if (localize()) { labels(); hideMenu(); render(); } });
    langWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    let spaced, background = '';
    const resized = new ResizeObserver(() => layout());
    // 只占用已识别的 Codex 主内容区；切页、收起侧栏和关闭功能时归还原有留白。
    function layout() {
      if (disposed) return;
      const main = Array.from(document.querySelectorAll('[data-app-shell-main-surface]')).find(visible);
      const titlebar = Array.from(document.querySelectorAll('[data-app-shell-main-titlebar], [data-app-shell-titlebar]')).find(visible);
      const body = main?.querySelector('[data-app-shell-main-content-layout]');
      const rect = (body || main)?.getBoundingClientRect();
      const hide = !rect || main.getAttribute('data-app-shell-main-surface') !== 'default' || /(?:\/|^)settings(?:\/|$)/.test(location.href) || !tabs.length;
      if (bar.hidden !== hide) bar.hidden = hide;
      if (hide) { spaced?.removeAttribute('data-codex-plus-tabs-space'); spaced = null; resized.disconnect(); return; }
      const target = body || main;
      if (spaced !== target) { spaced?.removeAttribute('data-codex-plus-tabs-space'); spaced = target; resized.disconnect(); resized.observe(target); }
      if (!spaced.hasAttribute('data-codex-plus-tabs-space')) spaced.setAttribute('data-codex-plus-tabs-space','');
      const top = Math.max(rect.top, titlebar?.getBoundingClientRect().bottom || 0);
      bar.style.left = `${Math.max(0, rect.left)}px`; bar.style.top = `${top}px`;
      bar.style.width = `${rect.width}px`;
      const bg = getComputedStyle(main).backgroundColor;
      if (bg !== background) { background = bg; bar.style.background = bg; bar.style.setProperty('--cpt-bg', bg); menu.style.setProperty('--cpt-bg', bg); }
    }
    // 有侧栏行时走原生点击；项目折叠后改用官方页面消息，不伪造路由状态。
    function go(id) {
      if (!ID.test(id)) return;
      if (id === appActive && id === active && !pending) return;
      if (id !== active) { pending = { id, at: performance.now() }; active = id; render(); }
      const row = rowFor(id);
      if (row) row.click(); else navigate('/local/' + id);
    }
    // 关闭只影响本地标签；抑制迟到的原生选中态，避免刚关闭的标签立即复活。
    function close(id) {
      const at = tabs.findIndex(t => t.id === id); if (at < 0) return;
      suppressed = id; tabs.splice(at, 1); persist();
      if (id === active) { active = ''; pending = null; if (tabs.length) go(tabs[Math.min(at, tabs.length - 1)].id); else navigate('/'); }
      render(); layout();
    }
    function closeOthers(keep, gone) {
      const ids = new Set(gone.map(t => t.id)); if (!ids.size) return;
      tabs = tabs.filter(t => !ids.has(t.id)); persist();
      if (ids.has(active)) { suppressed = active; active = ''; pending = null; go(keep); }
      render(); layout();
    }
    // DOM 节点只在当前运行时复用；卸载会全部释放，重注入从持久化数据重建。
    const nodes = new Map();
    function node(id) {
      let n = nodes.get(id); if (n) return n;
      const item = document.createElement('div'); item.className = 'cpt-item'; item.dataset.id = id;
      const open = document.createElement('button'); open.className = 'cpt-open'; open.setAttribute('role','tab'); open.dataset.id = id;
      const status = document.createElement('span'); status.className = 'cpt-status'; status.hidden = true;
      const dot = document.createElement('span'); dot.className = 'cpt-dot'; dot.hidden = true;
      const label = document.createElement('span'); label.className = 'cpt-label';
      // 上行只放会话状态/标题，下行固定放项目归属；长名称在各自行内截断。
      const titleRow = document.createElement('span'); titleRow.className = 'cpt-title-row'; titleRow.append(status, dot, label);
      const project = document.createElement('span'); project.className = 'cpt-project';
      const projectIcon = document.createElement('span'); projectIcon.className = 'cpt-project-icon'; projectIcon.setAttribute('aria-hidden', 'true'); projectIcon.innerHTML = icon.folder;
      const projectLabel = document.createElement('span'); projectLabel.className = 'cpt-project-name'; project.append(projectIcon, projectLabel);
      open.append(titleRow, project);
      const x = document.createElement('button'); x.className = 'cpt-close'; x.innerHTML = icon.close;
      item.append(open, x);
      n = { item, open, status, dot, label, projectIcon, projectLabel, x, title: null, lang: '', statusRoot: null, state: null, intl: null,
        projectRoot: null, projectKey: null, projectScope: null, projectIntl: null, projectName: null }; nodes.set(id, n);
      return n;
    }
    const mac = /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    function shortcut(i) { return i < 8 ? `${mac ? '⌘' : 'Ctrl+'}${i + 1}` : i === tabs.length - 1 ? `${mac ? '⌘' : 'Ctrl+'}9` : ''; }
    function render() {
      const ids = new Set(tabs.map(t => t.id));
      const hasActive = ids.has(active);
      for (const [id, n] of nodes) if (!ids.has(id)) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); statusApi?.releaseThreadMenu?.(id); n.item.remove(); nodes.delete(id); }
      tabs.forEach((tab, i) => {
        const n = node(tab.id), title = tab.title || str.untitled, on = tab.id === active;
        if (n.title !== title || n.lang !== lang) {
          n.title = title; n.lang = lang; n.label.textContent = title; n.x.title = str.closeTip;
          n.open.setAttribute('aria-label', title); n.x.setAttribute('aria-label', str.closeLabel + title);
        }
        const state = nativeStates.get(tab.id);
        const native = !!statusContext && state != null;
        n.status.hidden = !native || state === 'idle';
        if (native && (n.state !== state || n.intl !== statusContext.intl.value)) {
          n.statusRoot ??= statusApi.mount(n.status);
          n.statusRoot.render(state, statusContext);
          n.state = state; n.intl = statusContext.intl.value;
        }
        if (n.state != null && !native) { n.statusRoot?.dispose(); n.statusRoot = null; n.state = null; }
        n.status.setAttribute('data-state', native ? state : 'unknown');
        n.dot.hidden = native || !tab.running;
        n.open.setAttribute('aria-busy', String(native ? state === 'active' : !!tab.running));
        const project = nativeProjects.get(tab.id);
        const projectName = project?.name || (project === null ? str.noProject : str.unknownProject);
        if (n.projectName !== projectName) { n.projectName = projectName; n.projectLabel.textContent = projectName; }
        const projectKey = project ? JSON.stringify([project.id, project.kind, project.hostId]) : '';
        if (statusContext && statusApi.mountProject) {
          if (!n.projectRoot || n.projectKey !== projectKey || n.projectScope !== statusContext.appScope?.value || n.projectIntl !== statusContext.intl.value) {
            n.projectRoot ??= statusApi.mountProject(n.projectIcon, icon.folder);
            n.projectRoot.render(project, statusContext);
            n.projectKey = projectKey; n.projectScope = statusContext.appScope?.value; n.projectIntl = statusContext.intl.value;
          }
        } else if (n.projectRoot) { n.projectRoot.dispose(); n.projectRoot = null; n.projectIcon.innerHTML = icon.folder; }
        const description = [native ? statusApi.description(state, statusContext) : '', projectName].filter(Boolean).join(' · ');
        if (description) n.open.setAttribute('aria-description', description); else n.open.removeAttribute('aria-description');
        if (n.item.classList.contains('cpt-active') !== on) {
          n.item.classList.toggle('cpt-active', on);
          n.open.setAttribute('aria-selected', String(on));
          if (on) n.open.setAttribute('aria-current', 'page'); else n.open.removeAttribute('aria-current');
        }
        n.open.tabIndex = on || !hasActive && i === 0 ? 0 : -1;
        n.open.setAttribute('aria-selected', String(on));
        const tip = [title, projectName, project?.path, shortcut(i)].filter(Boolean).join('\n');
        if (n.item.title !== tip) n.item.title = tip;
      });
      let ref = list.firstElementChild;
      for (const tab of tabs) {
        const item = nodes.get(tab.id).item;
        if (item === ref) ref = ref.nextElementSibling; else list.insertBefore(item, ref);
      }
      if (active !== scrolledTo) { scrolledTo = active; reveal(nodes.get(active)?.item); }
    }
    function reveal(item) {
      if (!item) return;
      const left = item.offsetLeft, right = left + item.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left - 4;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 4;
    }
    // 侧栏补充标题和选中项；路由和状态不依赖行是否挂载。
    function discoverStatusApi() {
      if (statusApi || statusLoading || statusLoadAttempts >= 20 || performance.now() < statusNextLoadAt
        || !document.querySelector('[data-app-shell-main-surface]')) return;
      statusLoading = true; statusLoadAttempts++; statusNextLoadAt = performance.now() + 1500;
      // 等原生主界面出现后再读取模块缓存；未就绪时有界重试，不能通过执行工厂来催促启动。
      loadCodexPlusConversationTabStatusApi().then(api => {
        statusLoading = false;
        if (disposed || !api) return;
        statusApi = api; refresh();
      }).catch(() => { statusLoading = false; });
    }
    function syncStatusWatch() {
      if (!statusApi) return;
      const context = statusApi.context();
      const ids = tabs.map(tab => tab.id).sort().join(',');
      if (context?.scope.node === statusContext?.scope.node && context?.scope === statusContext?.scope && ids === statusIds) {
        statusContext = context; return;
      }
      const generation = ++statusGeneration;
      statusWatch?.(); statusWatch = null; statusIds = ids; statusContext = context;
      if (!context) return; // shell 暂时切换时保留最后一次可信快照，不猜测会话已经完成。
      const wanted = new Set(tabs.map(tab => tab.id));
      nativeStates = new Map([...nativeStates].filter(([id]) => wanted.has(id)));
      nativeProjects = new Map([...nativeProjects].filter(([id]) => wanted.has(id)));
      try {
        statusWatch = statusApi.watch(context, [...wanted], snapshot => {
          // 解绑后迟到的旧订阅不能覆盖新 shell 或新标签集合的快照。
          if (disposed || generation !== statusGeneration) return;
          let changed = false;
          for (const [id, state] of snapshot) {
            if (wanted.has(id) && nativeStates.get(id) !== state) { nativeStates.set(id, state); changed = true; }
          }
          if (changed) schedule();
        }, projects => {
          if (disposed || generation !== statusGeneration) return;
          let changed = false;
          for (const [id, project] of projects) {
            if (wanted.has(id) && JSON.stringify(nativeProjects.get(id)) !== JSON.stringify(project)) {
              nativeProjects.set(id, project && { ...project }); changed = true;
            }
          }
          if (changed) schedule();
        });
      } catch { statusContext = null; } // 原生升级失配时降级，不影响标签的切换和关闭。
    }
    // 禁止用标题猜测两个会话是同一条。
    function refresh() {
      clearTimeout(timer); timer = 0;
      if (disposed || document.hidden) return;
      if (drag?.moved) return; // 拖动结束后统一刷新，流式输出不能打乱拖动中的 DOM 顺序。
      const byId = new Map(); let selected = null;
      for (const r of sidebarRows()) {
        if (!isLocal(r)) continue;
        const id = rowId(r);
        if (!id) continue;
        // 侧栏收起后原生行仍可能挂载但宽度为零；身份以当前页面的 active 属性为准。
        if (!selected && r.getAttribute(attr + 'active') === 'true' && !r.closest('[data-app-shell-active-page="false"]')) { selected = r; byId.set(id, r); }
        else if (!byId.has(id)) byId.set(id, r);
      }
      const route = currentRoute();
      const observed = route.known ? route.id : (selected && rowId(selected)) || routeId();
      const confirmed = route.known || !!observed;
      if (confirmed) appActive = observed;
      if (pending && ((confirmed && pending.id === appActive) || performance.now() - pending.at > 1500)) pending = null;
      // “读不到”不等于“没有会话”：只有确认路由离开对话页，才清除当前标签。
      const id = pending ? pending.id : confirmed ? appActive : active;
      active = id; if (confirmed && appActive !== suppressed) suppressed = '';
      for (const t of tabs) {
        let row = byId.get(t.id);
        if (row) t.title = (row.getAttribute(attr+'title') || t.title).slice(0, 240);
        // 原生适配尚未就绪时保留原有加载提示；行不在 DOM 中不能被当作已结束。
        if (row) t.running = !!row.querySelector('[data-loading-indicator]');
      }
      if (id && id !== suppressed && ID.test(id) && !tabs.some(t => t.id === id)) {
        const title = (byId.get(id)?.getAttribute(attr+'title') || '').slice(0, 240);
        tabs.push({ id, title });
        if (tabs.length > MAX_TABS) tabs.shift();
      }
      discoverStatusApi(); syncStatusWatch(); render(); persist(); layout();
    }
    function schedule() { if (!timer) timer = setTimeout(refresh, 80); }
    // 忽略增强自身和聊天正文的高频写入；只节流处理侧栏与原生布局变化。
    const observer = new MutationObserver(ms => {
      for (const m of ms) {
        if (m.target.closest?.('[data-codex-plus-ext]')) continue;
        const changed = [...m.addedNodes || [], ...m.removedNodes || []].filter(node => node.nodeType === 1);
        if (changed.length && changed.every(node => node.matches('[data-codex-plus-ext]'))) continue;
        if (m.type === 'childList' && spaced?.contains(m.target)) continue;
        schedule(); return;
      }
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:[attr+'active',attr+'title',attr+'id',attr+'host-id',attr+'kind','data-app-shell-active-page']});
    window.addEventListener('resize',layout,opts);
    window.addEventListener('popstate',schedule,opts);
    document.addEventListener('visibilitychange',schedule,opts);
    list.addEventListener('click', e => {
      const item = e.target.closest('.cpt-item'); if (!item) return;
      if (e.target.closest('.cpt-close')) { e.stopPropagation(); close(item.dataset.id); }
      else if (e.detail === 0 && e.target.closest('.cpt-open')) go(item.dataset.id);
    }, opts);
    let drag = null;
    // 使用指针捕获拖动，避免 HTML 拖放把会话标题误放进输入框；丢失释放事件也会结束。
    list.addEventListener('pointerdown', e => {
      if (drag) endDrag(true); // 上一次释放事件缺失时，先结束旧拖动。
      if (e.button !== 0 || e.ctrlKey || e.target.closest('.cpt-close')) return;
      const item = e.target.closest('.cpt-item'); if (!item) return;
      go(item.dataset.id);
      drag = { id: item.dataset.id, item, pointerId: e.pointerId, startX: e.clientX, x: e.clientX, moved: false };
      try { list.setPointerCapture(e.pointerId); } catch {}
    }, opts);
    list.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!(e.buttons & 1)) return endDrag(true);
      drag.x = e.clientX;
      if (!drag.moved) { if (Math.abs(drag.x - drag.startX) < 5) return; startDrag(); }
      dragUpdate();
    }, opts);
    list.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, opts);
    list.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) endDrag(false); }, opts);
    list.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, opts);
    window.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); }, { capture: true, signal: abort.signal });
    document.addEventListener('keydown', e => {
      if (drag?.moved && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); endDrag(false); }
    }, { capture: true, signal: abort.signal });
    window.addEventListener('blur', () => drag && endDrag(false), opts);
    // 优先转发给现有原生行；侧栏收起后改用原生组件生成菜单，不把 DOM 卸载当作会话不存在。
    function threadMenu(id, x, y) {
      const row = rowFor(id, true);
      if (!row) return statusApi?.openThreadMenu?.(statusApi.context() || statusContext, id, x, y) || false;
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y, button: 2, buttons: 2 }));
      return true;
    }
    let menuFrom = null;
    // 菜单动作执行时重新读取位置，防止菜单打开期间排序变化后关错标签。
    function tabMenu(id, x, y) {
      if (!tabs.some(t => t.id === id)) return;
      const from = menu.hidden ? document.activeElement : menuFrom?.el;
      menuFrom = { id, el: from };
      const at = tabs.findIndex(t => t.id === id);
      const available = !!rowFor(id, true) || !!statusApi?.canOpenThreadMenu?.(statusContext, id);
      const closeRight = () => { const i = tabs.findIndex(t => t.id === id); if (i >= 0) closeOthers(id, tabs.slice(i + 1)); };
      const closeOther = () => { if (tabs.some(t => t.id === id)) closeOthers(id, tabs.filter(t => t.id !== id)); };
      const entries = [
        [str.close, () => close(id), true],
        [str.closeOthers, closeOther, tabs.length > 1],
        [str.closeRight, closeRight, at < tabs.length - 1],
        null,
        [str.options, available ? b => openThreadMenu(id, b) : null, available, 'sub'],
      ];
      menu.replaceChildren(...entries.map(entry => {
        if (!entry) { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); return hr; }
        const [label, run, enabled, kind] = entry;
        const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; b.disabled = !enabled; b.tabIndex = -1;
        if (kind === 'sub') { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.append(Object.assign(document.createElement('span'), { className: 'cpt-chevron', textContent: '›' })); }
        if (run && kind === 'sub') {
          let hover = 0;
          b.addEventListener('pointermove', () => { if (!hover) hover = later(() => { hover = 0; if (!nativeAt && b.isConnected) run(b); }, 120); });
          b.addEventListener('pointerleave', () => { cancelLater(hover); hover = 0; });
          b.addEventListener('pointerdown', () => { cancelLater(hover); hover = 0; });
          b.addEventListener('click', e => { if (e.detail === 0 && !nativeAt) run(b); });
          b.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { e.preventDefault(); if (!nativeAt) run(b); } });
        }
        else if (run) b.addEventListener('click', () => {
          const back = menu.contains(document.activeElement), from = menuFrom;
          hideMenu(); run(); if (back) { menuFrom = from; restoreFocus(); }
        });
        return b;
      }));
      menu.hidden = false;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    }
    let nativeAt = 0;
    // macOS 在点击后弹原生菜单会强制定位到指针下，因此按子菜单方式悬停打开。
    async function openThreadMenu(id, b) {
      const m = menu.getBoundingClientRect(), r = b.getBoundingClientRect();
      b.setAttribute('aria-expanded', 'true'); b.classList.add('cpt-expanded');
      nativeAt = performance.now();
      // 临时宿主异步挂载失败时收回展开态，避免菜单卡在“已打开”。
      try {
        const opened = await threadMenu(id, m.right + 2, r.top - 5);
        if (!opened && b.isConnected && menuFrom?.id === id) nativeClosed();
      } catch { if (b.isConnected && menuFrom?.id === id) nativeClosed(); }
    }
    function nativeClosed() {
      nativeAt = 0;
      menu.querySelector('.cpt-expanded')?.classList.remove('cpt-expanded');
      menu.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
    }
    document.addEventListener('pointermove', e => {
      if (!nativeAt || performance.now() - nativeAt < 200) return;
      nativeClosed();
      if (!menu.contains(e.target)) hideMenu();
    }, { capture: true, signal: abort.signal });
    // 菜单关闭后优先还焦点到原输入框或标签，键盘用户不会被留在已卸载的菜单内。
    function restoreFocus() {
      const from = menuFrom; menuFrom = null;
      const el = [from?.el, nodes.get(from?.id)?.open, list.querySelector('.cpt-active .cpt-open')]
        .find(e => e?.isConnected && e !== document.body && !menu.contains(e));
      el?.focus({ preventScroll: true });
    }
    function hideMenu(refocus = false) {
      if (menu.hidden) return;
      const back = refocus && menu.contains(document.activeElement);
      // 用户关闭菜单后取消尚未完成的宿主挂载，避免稍后突然弹出原生菜单。
      statusApi?.cancelThreadMenu?.(menuFrom?.id);
      menu.hidden = true; menu.replaceChildren(); nativeAt = 0;
      if (back) restoreFocus(); else menuFrom = null;
    }
    document.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) hideMenu(); }, { capture: true, signal: abort.signal });
    window.addEventListener('blur', () => { if (!nativeAt) hideMenu(); }, opts);
    window.addEventListener('resize', () => hideMenu(), opts);
    menu.addEventListener('mousedown', e => e.preventDefault(), opts);
    menu.addEventListener('focusout', e => { if (!menu.hidden && !nativeAt && !menu.contains(e.relatedTarget)) hideMenu(); }, opts);
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); hideMenu(true); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
      if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items.at(e.key === 'Home' ? 0 : -1)?.focus(); }
    }, opts);
    list.addEventListener('contextmenu', e => {
      const item = e.target.closest('.cpt-item'); if (!item) return;
      e.preventDefault(); e.stopPropagation();
      if (!drag?.moved) tabMenu(item.dataset.id, e.clientX, e.clientY);
    }, opts);
    // 拖动期间临时关闭系统窗口拖动区，保证跨过标题栏时仍能收到 pointerup。
    function startDrag() {
      const d = drag, items = [...list.children];
      d.moved = true; d.items = items; d.from = d.to = items.indexOf(d.item);
      d.lefts = items.map(it => it.offsetLeft); d.widths = items.map(it => it.offsetWidth);
      d.width = d.widths[d.from]; d.end = d.lefts.at(-1) + d.widths.at(-1);
      d.gap = items.length > 1 ? d.lefts[1] - d.lefts[0] - d.widths[0] : 0;
      d.scroll0 = list.scrollLeft;
      document.documentElement.classList.add('cpt-dragging');
      bar.classList.add('cpt-reordering'); d.item.classList.remove('cpt-settle'); d.item.classList.add('cpt-lifted');
      const edge = 36, step = () => {
        if (drag !== d) return;
        const r = list.getBoundingClientRect();
        const v = d.x < r.left + edge ? -(r.left + edge - d.x) : d.x > r.right - edge ? d.x - (r.right - edge) : 0;
        if (v && list.scrollWidth > list.clientWidth) { list.scrollLeft += Math.max(-14, Math.min(14, v / 2.5)); dragUpdate(); }
        d.raf = requestAnimationFrame(step);
      };
      d.raf = requestAnimationFrame(step);
    }
    // 跨过相邻标签中点才换位；边缘自动滚动支持横向溢出的标签。
    function dragUpdate() {
      const d = drag, start = d.lefts[d.from];
      const left = Math.min(Math.max(start + d.x - d.startX + list.scrollLeft - d.scroll0, 0), d.end - d.width);
      d.item.style.transform = `translateX(${left - start}px)`;
      let to = 0;
      d.items.forEach((it, k) => {
        const mid = d.lefts[k] + d.widths[k] / 2;
        if (k < d.from ? left >= mid : k > d.from && left + d.width > mid) to++;
      });
      if (to === d.to) return;
      d.to = to;
      const shift = d.width + d.gap;
      d.items.forEach((it, k) => {
        if (k === d.from) return;
        const s = d.from < k && k <= to ? -shift : to <= k && k < d.from ? shift : 0;
        it.style.transform = s ? `translateX(${s}px)` : '';
      });
    }
    // Escape / 失焦撤销排序；先清状态再释放捕获，避免 lostpointercapture 重入。
    function endDrag(commit) {
      const d = drag; drag = null;
      if (!d) return;
      try { list.releasePointerCapture(d.pointerId); } catch {}
      if (!d.moved) return;
      cancelAnimationFrame(d.raf);
      document.documentElement.classList.remove('cpt-dragging');
      const moved = commit && d.to !== d.from;
      const before = d.item.getBoundingClientRect().left;
      if (moved) {
        const at = tabs.findIndex(t => t.id === d.id);
        if (at >= 0) { const [t] = tabs.splice(at, 1); tabs.splice(d.to, 0, t); persist(); }
      } else {
        d.items.forEach(it => { if (it !== d.item) it.classList.add('cpt-settle'); });
      }
      bar.classList.remove('cpt-reordering');
      d.items.forEach(it => { it.style.transform = ''; });
      render();
      d.item.style.transform = `translateX(${before - d.item.getBoundingClientRect().left}px)`;
      d.item.offsetWidth;
      d.item.classList.add('cpt-settle'); d.item.style.transform = '';
      const done = () => d.items.forEach(it => { if (!(drag?.moved && drag.item === it)) it.classList.remove('cpt-settle', 'cpt-lifted'); });
      later(done, 220);
      refresh();
    }
    list.addEventListener('auxclick', e => {
      const item = e.target.closest('.cpt-item');
      if (item && e.button === 1) { e.preventDefault(); close(item.dataset.id); }
    }, opts);
    list.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
      e.preventDefault(); list.scrollLeft += e.deltaY;
    }, { passive: false, signal: abort.signal });
    document.addEventListener('keydown', e => {
      if (bar.hidden || e.isComposing || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || !/^[1-9]$/.test(e.key)) return;
      const tab = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
      if (tab) { e.preventDefault(); e.stopImmediatePropagation(); go(tab.id); }
    },{capture:true,signal:abort.signal});
    list.addEventListener('keydown', e => {
      const buttons = Array.from(list.querySelectorAll('.cpt-open'));
      const i = buttons.indexOf(document.activeElement); if (i < 0) return;
      let next;
      if (e.key === 'ArrowRight') next = (i+1)%buttons.length;
      if (e.key === 'ArrowLeft') next = (i+buttons.length-1)%buttons.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = buttons.length-1;
      if (next != null) { e.preventDefault(); buttons[next].focus(); }
      if (e.key === 'Delete') { e.preventDefault(); close(buttons[i].dataset.id); }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault(); const r = buttons[i].getBoundingClientRect(); tabMenu(buttons[i].dataset.id, r.left, r.bottom);
      }
    },opts);
    // 原生路由不总是改变地址栏；低频兜底只刷新可见窗口，不读取聊天内容或调用后端。
    const interval = setInterval(refresh, 1500);
    const runtime = { dispose() {
      if (disposed) return;
      if (drag) cancelAnimationFrame(drag.raf);
      drag = null;
      document.documentElement.classList.remove('cpt-dragging');
      disposed = true;
      statusWatch?.(); statusWatch = null;
      for (const [id, n] of nodes) { n.statusRoot?.dispose(); n.projectRoot?.dispose(); statusApi?.releaseThreadMenu?.(id); }
      clearInterval(interval); clearTimeout(timer);
      for (const id of delays) clearTimeout(id);
      delays.clear();
      observer.disconnect(); langWatch.disconnect(); resized.disconnect(); abort.abort();
      spaced?.removeAttribute('data-codex-plus-tabs-space');
      bar.remove(); menu.remove(); style.remove();
      if (window.__codexPlusConversationTabs === runtime) delete window.__codexPlusConversationTabs;
    } };
    window.__codexPlusConversationTabs = runtime;
    refresh();
    return runtime;
  }
