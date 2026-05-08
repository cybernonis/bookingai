(function () {
  const script     = document.currentScript;
  const API_URL    = (script && script.getAttribute('data-api-url')) ||
                     (script && script.src.replace(/\/booking-widget\.js.*$/, '')) ||
                     'http://localhost:3000';
  const BUSINESS_ID = (script && script.getAttribute('data-business-id')) || 'eclat';

  // ── Styles ────────────────────────────────────────────────────────────────

  const css = `
    #bw-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 56px; height: 56px; border-radius: 50%;
      background: var(--bw-accent, #1a1a2e); color: #fff; border: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #bw-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.32); }
    #bw-bubble svg { width: 26px; height: 26px; }

    #bw-panel {
      position: fixed; bottom: 92px; right: 24px; z-index: 99998;
      width: 360px; height: 540px; max-height: calc(100vh - 110px);
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; overflow: hidden;
      transform: scale(0.92) translateY(16px); opacity: 0;
      transform-origin: bottom right;
      transition: transform 0.22s cubic-bezier(.4,0,.2,1), opacity 0.22s;
      pointer-events: none;
    }
    #bw-panel.bw-open {
      transform: scale(1) translateY(0); opacity: 1; pointer-events: all;
    }

    #bw-header {
      background: var(--bw-accent, #1a1a2e); color: #fff;
      padding: 14px 18px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    #bw-header-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.15);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
    }
    #bw-header-text { flex: 1; min-width: 0; }
    #bw-header-text strong { display: block; font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #bw-header-text span { font-size: 0.72rem; opacity: 0.65; }
    #bw-close {
      background: none; border: none; color: #fff; opacity: 0.7;
      cursor: pointer; padding: 4px; border-radius: 6px; line-height: 1;
      font-size: 20px; transition: opacity 0.15s; flex-shrink: 0;
    }
    #bw-close:hover { opacity: 1; }

    #bw-messages {
      flex: 1; overflow-y: auto; padding: 16px; display: flex;
      flex-direction: column; gap: 10px;
    }
    #bw-messages::-webkit-scrollbar { width: 4px; }
    #bw-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 4px; }

    .bw-msg {
      max-width: 82%; padding: 10px 14px; border-radius: 16px;
      font-size: 0.875rem; line-height: 1.5; white-space: pre-wrap;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .bw-msg-user {
      align-self: flex-end; background: var(--bw-accent, #1a1a2e); color: #fff;
      border-bottom-right-radius: 4px;
    }
    .bw-msg-assistant {
      align-self: flex-start; background: #f0f2f5; color: #1a1a2e;
      border-bottom-left-radius: 4px;
    }
    .bw-msg-typing {
      align-self: flex-start; background: #f0f2f5;
      border-bottom-left-radius: 4px; display: flex; gap: 5px;
      align-items: center; padding: 12px 16px;
    }
    .bw-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #aaa;
      animation: bw-bounce 1.2s infinite;
    }
    .bw-dot:nth-child(2) { animation-delay: 0.2s; }
    .bw-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bw-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }

    @keyframes bw-anim-bounce {
      0%, 100% { transform: translateY(0) scale(1); }
      30% { transform: translateY(-8px) scale(1.04); }
      60% { transform: translateY(-2px) scale(1); }
    }
    @keyframes bw-anim-pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 4px 16px rgba(0,0,0,0.25); }
      50% { transform: scale(1.1); box-shadow: 0 6px 24px rgba(0,0,0,0.3); }
    }
    @keyframes bw-anim-shake {
      0%, 100% { transform: rotate(0deg); }
      20% { transform: rotate(-10deg); }
      40% { transform: rotate(10deg); }
      60% { transform: rotate(-8deg); }
      80% { transform: rotate(8deg); }
    }
    #bw-bubble.bw-anim-bounce { animation: bw-anim-bounce 2s ease-in-out 1s infinite; }
    #bw-bubble.bw-anim-pulse  { animation: bw-anim-pulse  2s ease-in-out 1s infinite; }
    #bw-bubble.bw-anim-shake  { animation: bw-anim-shake  0.6s ease-in-out 1.5s 3; }

    #bw-cta {
      position: fixed; z-index: 99997;
      background: #fff; border: 1.5px solid #e0e0e0;
      border-radius: 12px; padding: 9px 14px;
      font-size: 0.82rem; line-height: 1.4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,0.13);
      white-space: nowrap; pointer-events: none;
      opacity: 0; transform: translateY(6px);
      transition: opacity 0.3s, transform 0.3s;
    }
    #bw-cta.bw-cta-visible { opacity: 1; transform: translateY(0); }

    #bw-input-area {
      display: flex; gap: 8px; padding: 12px 14px;
      border-top: 1px solid #ebebeb; flex-shrink: 0;
    }
    #bw-input {
      flex: 1; padding: 9px 14px; border: 1.5px solid #e0e0e0;
      border-radius: 20px; font-size: 0.875rem; outline: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: border-color 0.2s;
    }
    #bw-input:focus { border-color: var(--bw-accent, #1a1a2e); }
    #bw-send {
      width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
      background: var(--bw-accent, #1a1a2e); color: #fff; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.2s;
    }
    #bw-send:hover { opacity: 0.85; }
    #bw-send:disabled { opacity: 0.35; cursor: not-allowed; }
    #bw-send svg { width: 16px; height: 16px; }

    #bw-powered {
      text-align: center; font-size: 0.7rem; color: #bbb; padding: 6px 0 8px;
      font-family: -apple-system, sans-serif; flex-shrink: 0;
    }

    #bw-quick-replies {
      display: flex; gap: 7px; flex-wrap: wrap;
      padding: 0 14px 10px; flex-shrink: 0;
    }
    #bw-quick-replies:empty { display: none; }
    .bw-quick-reply {
      background: #f0f2f5; border: 1.5px solid #e0e0e0;
      border-radius: 16px; padding: 6px 14px;
      font-size: 0.8rem; color: #1a1a2e; cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      white-space: nowrap; flex-shrink: 0;
    }
    .bw-quick-reply:hover {
      background: var(--bw-accent, #1a1a2e);
      border-color: var(--bw-accent, #1a1a2e);
      color: #fff;
    }

    #bw-input-area { position: relative; }
    #bw-autocomplete {
      display: none;
      position: absolute; bottom: calc(100% + 4px); left: 0; right: 0;
      background: #fff; border: 1.5px solid #e0e0e0; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12); overflow: hidden; z-index: 10;
    }
    .bw-ac-item {
      padding: 9px 14px; font-size: 0.82rem; color: #1a1a2e; cursor: pointer;
      line-height: 1.4; border-bottom: 1px solid #f0f0f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: background 0.12s; display: flex; align-items: center; gap: 8px;
    }
    .bw-ac-item:last-child { border-bottom: none; }
    .bw-ac-item:hover { background: var(--bw-ac-hover, #f0f4ff); }
    .bw-ac-pin { font-size: 14px; flex-shrink: 0; }

    @media (max-width: 420px) {
      #bw-panel { width: calc(100vw - 16px); right: 8px; bottom: 80px; }
      #bw-bubble { right: 16px; bottom: 16px; }
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── HTML ──────────────────────────────────────────────────────────────────

  const bubble = document.createElement('button');
  bubble.id = 'bw-bubble';
  bubble.setAttribute('aria-label', 'Open booking assistant');
  bubble.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  const panel = document.createElement('div');
  panel.id = 'bw-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Booking assistant');
  panel.innerHTML = `
    <div id="bw-header">
      <div id="bw-header-avatar">📅</div>
      <div id="bw-header-text">
        <strong id="bw-business-name">Booking Assistant</strong>
        <span id="bw-business-sub">Κλείστε ραντεβού εύκολα</span>
      </div>
      <button id="bw-close" aria-label="Close">✕</button>
    </div>
    <div id="bw-messages"></div>
    <div id="bw-quick-replies"></div>
    <div id="bw-input-area">
      <div id="bw-autocomplete"></div>
      <input id="bw-input" type="text" placeholder="Γράψε μήνυμα..." autocomplete="off" />
      <button id="bw-send" aria-label="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div id="bw-powered">Powered by BookingAI</div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // ── State ─────────────────────────────────────────────────────────────────

  let history = [];
  let isOpen = false;
  let greeted = false;
  let widgetLangConfig = null;
  let selectedLang     = null;
  let widgetConfig     = {};

  const messagesEl     = panel.querySelector('#bw-messages');
  const quickRepliesEl = panel.querySelector('#bw-quick-replies');
  const inputEl        = panel.querySelector('#bw-input');
  const sendBtn        = panel.querySelector('#bw-send');

  // ── Business info ─────────────────────────────────────────────────────────

  function applyTheme(color) {
    const root = document.documentElement;
    root.style.setProperty('--bw-accent', color);
  }

  async function loadBusinessInfo() {
    try {
      const res = await fetch(`${API_URL}/api/business/${BUSINESS_ID}`);
      if (!res.ok) return;
      const biz = await res.json();
      panel.querySelector('#bw-business-name').textContent = biz.name;
      if (biz.theme_color) applyTheme(biz.theme_color);
      if (biz.config?.widget_lang) widgetLangConfig = biz.config.widget_lang;
      if (biz.config?.widget) {
        widgetConfig = biz.config.widget;
        applyWidgetConfig(widgetConfig);
      }
    } catch {
      // keep defaults
    }
  }

  function applyWidgetConfig(w) {
    if (!w) return;

    // ── Page visibility ──────────────────────────────────────────────────────
    if (w.page_visibility && w.page_visibility !== 'all' && w.page_urls?.length) {
      const url = window.location.href;
      const matches = w.page_urls.some(p => url.includes(p));
      if ((w.page_visibility === 'include' && !matches) ||
          (w.page_visibility === 'exclude' &&  matches)) {
        bubble.style.display = 'none';
        panel.style.display  = 'none';
        return;
      }
    }

    // ── Bubble icon ──────────────────────────────────────────────────────────
    if (w.icon) {
      bubble.innerHTML = `<span style="font-size:22px;line-height:1;">${w.icon}</span>`;
    }

    // ── Powered by ───────────────────────────────────────────────────────────
    const poweredEl = panel.querySelector('#bw-powered');
    if (poweredEl) poweredEl.style.display = w.powered_by === false ? 'none' : '';

    // ── Position ─────────────────────────────────────────────────────────────
    const ex = (w.edge_x ?? 24) + 'px';
    const ey = (w.edge_y ?? 24) + 'px';
    const panelBottom = ((w.edge_y ?? 24) + 68) + 'px';
    if (w.position === 'bottom-left') {
      bubble.style.right = 'auto'; bubble.style.left = ex;
      panel.style.right  = 'auto'; panel.style.left  = ex;
      panel.style.transformOrigin = 'bottom left';
    } else {
      bubble.style.left  = 'auto'; bubble.style.right = ex;
      panel.style.left   = 'auto'; panel.style.right  = ex;
      panel.style.transformOrigin = 'bottom right';
    }
    bubble.style.bottom = ey;
    panel.style.bottom  = panelBottom;

    // ── Animation ────────────────────────────────────────────────────────────
    bubble.classList.remove('bw-anim-bounce', 'bw-anim-pulse', 'bw-anim-shake');
    if (w.animation && w.animation !== 'none') {
      bubble.classList.add(`bw-anim-${w.animation}`);
    }

    // ── CTA tooltip ──────────────────────────────────────────────────────────
    if (w.cta_enabled && w.cta_text) {
      const cta = document.createElement('div');
      cta.id = 'bw-cta';
      cta.textContent = w.cta_text;
      // Position near bubble
      const ex2 = (w.edge_x ?? 24) + 56 + 10; // bubble width + gap
      const ey2 = (w.edge_y ?? 24) + 8;
      if (w.position === 'bottom-left') {
        cta.style.left   = (w.edge_x ?? 24) + 66 + 'px';
        cta.style.right  = 'auto';
      } else {
        cta.style.right  = ex2 + 'px';
        cta.style.left   = 'auto';
      }
      cta.style.bottom = ey2 + 'px';
      document.body.appendChild(cta);
      setTimeout(() => cta.classList.add('bw-cta-visible'), 800);
      const removeCta = () => { cta.classList.remove('bw-cta-visible'); setTimeout(() => cta.remove(), 300); };
      setTimeout(removeCta, 8000);
      bubble.addEventListener('click', removeCta, { once: true });
    }

    // ── Inline mode ──────────────────────────────────────────────────────────
    if (w.mode === 'inline' && w.inline_target) {
      const target = document.querySelector(w.inline_target);
      if (target) {
        bubble.style.display = 'none';
        panel.style.cssText  = 'position:static;transform:none;opacity:1;pointer-events:all;width:100%;height:100%;max-height:none;border-radius:0;box-shadow:none;display:flex;';
        panel.classList.add('bw-open');
        target.appendChild(panel);
        isOpen = true;
        greet();
        return; // skip auto-open (already open)
      }
    }

    // ── Auto-open ────────────────────────────────────────────────────────────
    if (w.auto_open) {
      const delay  = (w.auto_open_delay ?? 3) * 1000;
      const device = w.auto_open_device || 'both';
      const mobile = window.innerWidth <= 768;
      const ok = device === 'both' || (device === 'mobile' && mobile) || (device === 'desktop' && !mobile);
      if (ok) {
        setTimeout(() => {
          if (!isOpen) {
            isOpen = true;
            panel.classList.add('bw-open');
            bubble.setAttribute('aria-expanded', 'true');
            greet();
            setTimeout(() => inputEl.focus(), 250);
          }
        }, delay);
      }
    }
  }

  loadBusinessInfo();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `bw-msg bw-msg-${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'bw-msg bw-msg-typing';
    el.innerHTML = '<div class="bw-dot"></div><div class="bw-dot"></div><div class="bw-dot"></div>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function extractQuickReplies(text) {
    const clean = text.replace(/\*\*/g, '');
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

    // Numbered list: "1. Economy" / "1) Van"
    const numbered = lines.filter(l => /^\d+[.)]\s+\S/.test(l));
    if (numbered.length >= 2 && numbered.length <= 6) {
      const labels = numbered.map(l =>
        l.replace(/^\d+[.)]\s+/, '').split(/\s*\(/)[0].trim()
      ).filter(l => l.length > 0 && l.length <= 50);
      if (labels.length >= 2) return labels;
    }

    // Bullet list: "• Option" / "- Option"
    const bulleted = lines.filter(l => /^[•\-\*]\s+\S/.test(l));
    if (bulleted.length >= 2 && bulleted.length <= 6) {
      const labels = bulleted.map(l =>
        l.replace(/^[•\-\*]\s+/, '').split(/\s*[\(+]/)[0].trim()
      ).filter(l => l.length > 0 && l.length <= 50);
      if (labels.length >= 2) return labels;
    }

    // Ναι / Όχι patterns
    if (/\(Ναι\s*\/\s*Όχι\)/i.test(clean) || /\bΝαι\b\s*\/\s*\bΌχι\b/i.test(clean)) {
      return ['Ναι', 'Όχι'];
    }

    return [];
  }

  function showQuickReplies(options) {
    quickRepliesEl.innerHTML = '';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'bw-quick-reply';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        quickRepliesEl.innerHTML = '';
        sendMessage(opt);
      });
      quickRepliesEl.appendChild(btn);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const LANG_INFO = {
    en: { flag: '🇬🇧', name: 'English' },
    el: { flag: '🇬🇷', name: 'Ελληνικά' },
    de: { flag: '🇩🇪', name: 'Deutsch' },
    fr: { flag: '🇫🇷', name: 'Français' },
    it: { flag: '🇮🇹', name: 'Italiano' },
    es: { flag: '🇪🇸', name: 'Español' },
    ru: { flag: '🇷🇺', name: 'Русский' },
  };

  function showLangSelection() {
    const langs = widgetLangConfig?.langs?.length
      ? widgetLangConfig.langs
      : Object.keys(LANG_INFO);
    addMessage('assistant', '🌍 Select language / Επιλέξτε γλώσσα:');
    quickRepliesEl.innerHTML = '';
    langs.forEach(l => {
      const { flag, name } = LANG_INFO[l] || { flag: '🌐', name: l };
      const btn = document.createElement('button');
      btn.className = 'bw-quick-reply';
      btn.textContent = `${flag} ${name}`;
      btn.addEventListener('click', () => {
        selectedLang = l;
        quickRepliesEl.innerHTML = '';
        greet();
        setTimeout(() => inputEl.focus(), 250);
      });
      quickRepliesEl.appendChild(btn);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage(text) {
    if (!text.trim()) return;

    quickRepliesEl.innerHTML = '';
    hideAc();
    inputEl.value = '';
    inputEl.disabled = true;
    sendBtn.disabled = true;

    addMessage('user', text);
    const typing = addTyping();

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, businessId: BUSINESS_ID, lang: selectedLang }),
      });
      const data = await res.json();
      typing.remove();

      if (!res.ok) {
        addMessage('assistant', `Σφάλμα: ${data.error}`);
      } else {
        history = data.history;
        addMessage('assistant', data.reply);
        const replies = extractQuickReplies(data.reply);
        if (replies.length) showQuickReplies(replies);
      }
    } catch {
      typing.remove();
      addMessage('assistant', 'Δεν ήταν δυνατή η σύνδεση. Δοκίμασε ξανά.');
    } finally {
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  async function greet() {
    if (greeted) return;

    // Multi-mode: show language buttons in the first message before greeting
    if (widgetLangConfig?.mode === 'multi' && !selectedLang) {
      showLangSelection();
      return;
    }

    greeted = true;
    const typing = addTyping();
    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '__init__', history: [], businessId: BUSINESS_ID, lang: selectedLang }),
      });
      const data = await res.json();
      typing.remove();
      if (res.ok) {
        history = data.history;
        addMessage('assistant', data.reply);
        const replies = extractQuickReplies(data.reply);
        if (replies.length) showQuickReplies(replies);
      }
    } catch {
      typing.remove();
      addMessage('assistant', 'Γεια! Πώς μπορώ να σε βοηθήσω με την κράτησή σου;');
    }
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────

  const acEl = panel.querySelector('#bw-autocomplete');
  let acTimer = null;

  function isLocationQuestion() {
    const msgs = messagesEl.querySelectorAll('.bw-msg-assistant');
    if (!msgs.length) return false;
    const last = msgs[msgs.length - 1].textContent.toLowerCase();
    return /pick.?up|where.*pick|destination|where.*go|address|location|starting point|drop.?off|pickup|from where|to where|where would|αναχώρηση|προορισμός|πού θα/i.test(last);
  }

  function looksLikeAddress(text) {
    if (text.length < 3) return false;
    // Starts with a digit → time (14:00), date (17 May), passengers (2), price (€38)
    if (/^\d/.test(text)) return false;
    // Common non-address words: days, months, yes/no, time words
    if (/^(yes|no|ok|ναι|όχι|αύριο|σήμερα|αυρ|σήμ|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|δευτ|τρίτ|τετά|πέμπ|παρα|σάββ|κυρι|ιανου|φεβρ|μαρτ|απρίλ|μαΐου|ιουν|ιουλ|αύγ|σεπτ|οκτ|νοε|δεκ|tonight|tomorrow|today|now|skip|ναί|nai)/i.test(text)) return false;
    // Looks like HH:MM time
    if (/^\d{1,2}:\d{2}$/.test(text)) return false;
    return true;
  }

  function hideAc() {
    acEl.style.display = 'none';
    acEl.innerHTML = '';
  }

  function showAc(suggestions) {
    acEl.innerHTML = '';
    if (!suggestions.length) { acEl.style.display = 'none'; return; }
    suggestions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'bw-ac-item';
      item.innerHTML = `<span class="bw-ac-pin">📍</span>${s.text}`;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        inputEl.value = s.text;
        hideAc();
        inputEl.focus();
      });
      acEl.appendChild(item);
    });
    acEl.style.display = 'block';
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(acTimer);
    const val = inputEl.value.trim();
    if (!isLocationQuestion() || !looksLikeAddress(val)) { hideAc(); return; }
    acTimer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/api/places/autocomplete?input=${encodeURIComponent(val)}`);
        const data = await res.json();
        showAc(data.suggestions || []);
      } catch { hideAc(); }
    }, 300);
  });

  inputEl.addEventListener('blur', () => setTimeout(hideAc, 150));

  // ── Events ────────────────────────────────────────────────────────────────

  bubble.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('bw-open', isOpen);
    bubble.setAttribute('aria-expanded', isOpen);
    if (isOpen) { greet(); setTimeout(() => inputEl.focus(), 250); }
  });

  panel.querySelector('#bw-close').addEventListener('click', () => {
    isOpen = false;
    panel.classList.remove('bw-open');
    bubble.setAttribute('aria-expanded', 'false');
  });

  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(inputEl.value); }
  });
})();
