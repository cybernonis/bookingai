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

    #bw-lang-picker {
      flex: 1; display: none; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 28px 24px; gap: 10px;
    }
    .bw-lang-title { font-size: 0.95rem; font-weight: 700; color: #1a1a2e; text-align: center; margin-bottom: 4px; }
    .bw-lang-sub   { font-size: 0.78rem; color: #888; text-align: center; margin-bottom: 10px; }
    .bw-lang-btn {
      width: 100%; padding: 11px 16px; border-radius: 10px;
      border: 1.5px solid #e0e0e0; background: #f8f9fa;
      font-size: 0.9rem; cursor: pointer; text-align: left;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
      display: flex; align-items: center; gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .bw-lang-btn:hover { border-color: var(--bw-accent,#1a1a2e); background: var(--bw-accent,#1a1a2e); color: #fff; }

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
    <div id="bw-lang-picker"></div>
    <div id="bw-messages"></div>
    <div id="bw-quick-replies"></div>
    <div id="bw-input-area">
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

  const langPickerEl   = panel.querySelector('#bw-lang-picker');
  const messagesEl     = panel.querySelector('#bw-messages');
  const quickRepliesEl = panel.querySelector('#bw-quick-replies');
  const inputAreaEl    = panel.querySelector('#bw-input-area');
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
    } catch {
      // keep defaults
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
    el: { flag: '🇬🇷', name: 'Ελληνικά' },
    en: { flag: '🇬🇧', name: 'English' },
    fr: { flag: '🇫🇷', name: 'Français' },
    de: { flag: '🇩🇪', name: 'Deutsch' },
    it: { flag: '🇮🇹', name: 'Italiano' },
    es: { flag: '🇪🇸', name: 'Español' },
    ru: { flag: '🇷🇺', name: 'Русский' },
  };

  function showLangPicker() {
    const langs = widgetLangConfig?.langs?.length ? widgetLangConfig.langs : ['el', 'en'];
    langPickerEl.innerHTML =
      `<div class="bw-lang-title">🌍 Select language</div>` +
      `<div class="bw-lang-sub">Επιλέξτε γλώσσα / Choose your language</div>` +
      langs.map(l => {
        const { flag, name } = LANG_INFO[l] || { flag: '🌐', name: l };
        return `<button class="bw-lang-btn" data-lang="${l}">${flag} ${name}</button>`;
      }).join('');
    langPickerEl.querySelectorAll('.bw-lang-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        selectedLang = btn.getAttribute('data-lang');
        hideLangPicker();
        greet();
        setTimeout(() => inputEl.focus(), 250);
      })
    );
    langPickerEl.style.display = 'flex';
    messagesEl.style.display   = 'none';
    quickRepliesEl.style.display = 'none';
    inputAreaEl.style.display  = 'none';
  }

  function hideLangPicker() {
    langPickerEl.style.display   = 'none';
    messagesEl.style.display     = '';
    quickRepliesEl.style.display = '';
    inputAreaEl.style.display    = '';
  }

  async function sendMessage(text) {
    if (!text.trim()) return;

    quickRepliesEl.innerHTML = '';
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

  // ── Events ────────────────────────────────────────────────────────────────

  bubble.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('bw-open', isOpen);
    bubble.setAttribute('aria-expanded', isOpen);
    if (isOpen) {
      if (widgetLangConfig?.mode === 'multi' && !selectedLang && !greeted) {
        showLangPicker();
      } else {
        greet();
        setTimeout(() => inputEl.focus(), 250);
      }
    }
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
