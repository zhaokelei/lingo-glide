/* 本地翻译扩展 - 页面脚本
 * 功能一：输入框三连空格翻译
 * 功能二：划词翻译图标 + 结果气泡
 * 功能三：整页翻译（双语对照 / 仅译文）
 */
(() => {
  if (window.__trfLoaded) return;
  window.__trfLoaded = true;
  document.documentElement.setAttribute('data-trf-ext', '1');

  const DEFAULTS = {
    endpoint: 'http://127.0.0.1:8080/v1',
    model: 'hy-mt2',
    temperature: 0.3,
    timeoutSec: 60,
    directionMode: 'auto',
    tripleSpaceEnabled: true,
    tripleSpaceWindowMs: 800,
    shortcutTranslateEnabled: true,
    inputShortcut: 'Ctrl+Shift+Enter',
    selectionEnabled: true,
    pageMode: 'dual',
    batchChars: 800,
    batchParagraphs: 6,
    concurrency: 1,
    ignoreDomains: '',
    floatButton: true,
    targetLang: 'zh-Hans',
    sourceLang: 'auto',
    autoPromptEnPage: true,
    followSourceLang: false,
    debugFill: false,
    cacheTTL: 30
  };

  const DISCONNECTED_HINT = '本地翻译服务未连接，请先双击桌面『启动翻译模型.command』';
  const TARGETS = [
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'auto', label: '自动判定' }
  ];
  const SOURCE_LANGS = [
    { code: 'auto', label: '自动检测' },
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'ru', label: 'Русский' }
  ];

  function sourceLabelOf(code) {
    const hit = SOURCE_LANGS.find((x) => x.code === code);
    if (hit) return hit.label;
    if (code === 'zh') return '简体中文';
    return code || '原文';
  }
  const LANG_LABELS = {
    zh: '中文', en: '英语', ja: '日本語', ko: '한국어', ru: 'Русский',
    ar: 'العربية', th: 'ไทย', fr: 'Français', de: 'Deutsch', es: 'Español'
  };
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'code', 'pre', 'textarea', 'input',
    'select', 'option', 'button', 'svg', 'canvas', 'iframe', 'math', 'audio', 'video',
    '[contenteditable]:not([contenteditable="false"])',
    '[data-trf]', '[translate="no"]', '.notranslate', '[aria-hidden="true"]'
  ].join(',');

  const state = {
    settings: { ...DEFAULTS },
    busyFields: new WeakSet(),
    seq: 0,
    selection: null,
    site: { disabled: false, neverPrompt: false, alwaysTranslate: false },
    pageLang: null,
    ball: { el: null, cardEl: null, side: 'right', top: 16, dragging: false, moved: false, lastToast: 0 },
    page: {
      active: false,
      stopped: false,
      draining: false,
      hasTranslations: false,
      queue: [],
      total: 0,
      done: 0,
      failed: 0,
      dir: null,
      cached: 0,
      cacheMs: 0,
      inflightIds: new Set(),
      observer: null,
      scanTimer: 0,
      hideTimer: 0
    }
  };

  const DEFAULT_BLOCK_STYLE = {
    display: 'block', margin: '0.45em 0 0 0', padding: '0 0 0 0.62em',
    borderLeft: '2px solid rgba(128,138,168,.55)', fontStyle: 'italic',
    opacity: '0.86', fontSize: '0.95em', lineHeight: '1.6', whiteSpace: 'pre-wrap',
    textIndent: '0', color: 'inherit'
  };

  /* ---------------- 基础工具 ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (got) => {
        if (chrome.runtime.lastError) return;
        state.settings = { ...DEFAULTS, ...got };
        onSettingsChanged();
      });
    } catch (e) { /* 扩展上下文已失效 */ }
  }

  function onSettingsChanged() {
    if (!state.settings.selectionEnabled) hideSelectionIcon();
    if (!state.settings.tripleSpaceEnabled) spaceSeq.length = 0;
    updateFloatButton();
    updateCard();
    if (state.settings.autoPromptEnPage) scheduleAutoPrompt();
  }

  function updateFloatButton() {
    updateBall();
  }

  /* ---------------- 右上角悬浮球 + 语言卡片 ---------------- */

  const BALL_POS_KEY = 'trf:ballPos';
  const SITE_PREFS_KEY = 'trf:sitePrefs';
  const PROMPT_ONCE_KEY = `trf:prompted:${(location.hostname || '').toLowerCase()}`;

  function hostKey() { return (location.hostname || '').toLowerCase(); }

  function ballEnabled() {
    return !!state.settings.floatButton && !state.site.disabled && !domainIgnored();
  }

  function removeBall() {
    const host = ui.hostEl();
    const root = host && host.shadowRoot;
    if (!root) return;
    const b = root.querySelector('.ball');
    if (b) b.remove();
    const c = root.querySelector('.lang-card');
    if (c) c.remove();
    state.ball.el = null;
    state.ball.cardEl = null;
  }

  function updateBall() {
    if (!ballEnabled()) { removeBall(); return; }
    const r = ui.ensure();
    let el = r.querySelector('.ball');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ball';
      el.title = '翻译此页（可拖动）';
      el.textContent = '译';
      el.addEventListener('pointerdown', onBallDown);
      r.appendChild(el);
    }
    state.ball.el = el;
    el.classList.toggle('on', state.page.active || state.page.hasTranslations);
    applyBallPosition();
  }

  function applyBallPosition() {
    const el = state.ball.el;
    if (!el) return;
    const h = el.getBoundingClientRect().height || 34;
    const top = Math.max(8, Math.min(Number(state.ball.top) || 16, window.innerHeight - h - 8));
    state.ball.top = top;
    el.style.top = `${top}px`;
    if (state.ball.side === 'left') { el.style.left = '16px'; el.style.right = 'auto'; }
    else { el.style.right = '16px'; el.style.left = 'auto'; }
    positionCard();
  }

  function saveBallPosition() {
    try {
      chrome.storage.local.set({ [BALL_POS_KEY]: { side: state.ball.side, top: state.ball.top } });
    } catch (e) { /* ignore */ }
  }

  function onBallDown(e) {
    if (typeof e.button === 'number' && e.button !== 0) return;
    const el = state.ball.el;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const offX = startX - rect.left;
    const offY = startY - rect.top;
    const w = rect.width;
    const h = rect.height;
    let lastX = rect.left;
    let lastY = rect.top;
    state.ball.dragging = true;
    state.ball.moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    const onMove = (ev) => {
      if (!state.ball.dragging) return;
      if (!state.ball.moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) state.ball.moved = true;
      if (!state.ball.moved) return;
      ev.preventDefault();
      lastX = Math.min(Math.max(4, ev.clientX - offX), window.innerWidth - w - 4);
      lastY = Math.min(Math.max(4, ev.clientY - offY), window.innerHeight - h - 4);
      el.style.left = `${lastX}px`;
      el.style.right = 'auto';
      el.style.top = `${lastY}px`;
      positionCard();
    };
    const onUp = () => {
      state.ball.dragging = false;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (!state.ball.moved) {
        toggleCard();
        return;
      }
      const center = lastX + w / 2;
      state.ball.side = center < window.innerWidth / 2 ? 'left' : 'right';
      state.ball.top = Math.round(lastY);
      applyBallPosition();
      saveBallPosition();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }

  function targetLabelOf(code) {
    const t = TARGETS.find((x) => x.code === code);
    return t ? t.label : '简体中文';
  }

  function ensureCard() {
    const r = ui.ensure();
    let card = r.querySelector('.lang-card');
    if (card) { state.ball.cardEl = card; return card; }

    card = document.createElement('div');
    card.className = 'lang-card';
    card.innerHTML = `
      <div class="lc-hd">
        <div class="lc-title">翻译 <b class="lc-lang">英语</b> 页面？</div>
        <button class="lc-x" title="关闭">×</button>
      </div>
      <div class="lc-sub">翻译为</div>
      <div class="lc-sel"><select class="lc-lang-sel" aria-label="目标语言"></select></div>
      <div class="lc-go-row"><button class="lc-more">更多⌄</button><button class="lc-go">翻译</button></div>
      <div class="lc-warn"></div>
      <div class="lc-morebox">
        <div class="lc-seg"><button data-mode="dual">双语对照</button><button data-mode="target">仅译文</button></div>
        <button class="lc-toggle">翻译整页</button>
        <label class="lc-chk"><input type="checkbox" class="lc-never"><span>此网站不再提示</span></label>
        <label class="lc-chk"><input type="checkbox" class="lc-always"><span>总是翻译这个网站</span></label>
      </div>
      <div class="lc-prog"><div class="lc-prog-row"><span class="lc-count">已译 0/0 段</span><button class="lc-stop">中止</button></div><div class="lc-note"></div></div>`;

    const sel = card.querySelector('.lc-lang-sel');
    for (const t of TARGETS) {
      const opt = document.createElement('option');
      opt.value = t.code;
      opt.textContent = t.label;
      sel.appendChild(opt);
    }

    card.querySelector('.lc-x').addEventListener('click', (e) => { e.stopPropagation(); closeCard(); });
    sel.addEventListener('change', () => {
      const code = sel.value;
      chrome.storage.sync.set({ targetLang: code });
      state.settings.targetLang = code;
      // 切换语言：先还原已译内容，避免中英混排
      if (state.page.active || state.page.hasTranslations) restorePage({ silent: true });
      updateCard();
    });
    card.querySelector('.lc-more').addEventListener('click', () => {
      card.querySelector('.lc-morebox').classList.toggle('open');
    });
    card.querySelector('.lc-go').addEventListener('click', () => {
      if (state.page.active || state.page.hasTranslations) restorePage();
      else translatePageWithTarget();
    });
    card.querySelector('.lc-toggle').addEventListener('click', () => togglePage());
    card.querySelector('.lc-stop').addEventListener('click', () => stopPageTranslation('已中止'));
    card.querySelectorAll('.lc-seg button').forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.getAttribute('data-mode');
        chrome.storage.sync.set({ pageMode: mode });
        state.settings.pageMode = mode;
        updateCard();
      });
    });
    card.querySelector('.lc-never').addEventListener('change', (e) => {
      saveSitePrefs({ neverPrompt: e.target.checked });
    });
    card.querySelector('.lc-always').addEventListener('change', (e) => {
      saveSitePrefs({ alwaysTranslate: e.target.checked });
      if (e.target.checked && !state.page.active && !state.page.hasTranslations) translatePageWithTarget();
    });

    r.appendChild(card);
    state.ball.cardEl = card;
    return card;
  }

  function updateCard() {
    if (!ballEnabled()) return;
    const card = state.ball.cardEl || ensureCard();
    if (!card) return;
    const info = state.pageLang || pageLangInfo();
    const srcSet = state.settings.sourceLang || 'auto';
    const langLabel = state.page.active && state.page.dir && state.page.dir.srcLabel
      ? state.page.dir.srcLabel
      : (srcSet !== 'auto' ? sourceLabelOf(srcSet) : (info ? info.label : '英语'));
    const langEl = card.querySelector('.lc-lang');
    if (langEl) langEl.textContent = langLabel;
    const sel = card.querySelector('.lc-lang-sel');
    if (sel && sel.value !== (state.settings.targetLang || 'zh-Hans')) sel.value = state.settings.targetLang || 'zh-Hans';
    const translated = state.page.active || state.page.hasTranslations;
    card.querySelector('.lc-go').textContent = translated ? '还原' : '翻译';
    card.querySelector('.lc-toggle').textContent = translated ? '还原' : '翻译整页';
    // 源语言 = 目标语言时禁用「翻译」并提示（自动检测下中文页不拦，简繁转换仍有意义）
    const tgt = state.settings.targetLang || 'zh-Hans';
    let sameLang;
    if (srcSet !== 'auto') sameLang = sameLangOf(srcSet, tgt);
    else if (info && info.code === 'zh') sameLang = false;
    else sameLang = !!(info && info.code && info.code === tgt);
    const goBtn = card.querySelector('.lc-go');
    goBtn.disabled = sameLang && !translated;
    const warn = card.querySelector('.lc-warn');
    if (warn) {
      warn.textContent = sameLang ? '源与目标语言相同，请更换目标语言' : '';
      warn.className = 'lc-warn' + (sameLang ? ' on' : '');
    }
    card.querySelectorAll('.lc-seg button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-mode') === (state.settings.pageMode || 'dual'));
    });
    card.querySelector('.lc-never').checked = !!state.site.neverPrompt;
    card.querySelector('.lc-always').checked = !!state.site.alwaysTranslate;
    updateCardProgress();
  }

  function updateCardProgress(extra = {}) {
    const card = state.ball.cardEl;
    if (!card) return;
    const prog = card.querySelector('.lc-prog');
    const count = card.querySelector('.lc-count');
    const stop = card.querySelector('.lc-stop');
    const note = card.querySelector('.lc-note');
    if (!prog) return;
    const show = state.page.active || !!extra.note;
    prog.classList.toggle('on', !!show);
    const done = state.page.done;
    const total = Math.max(state.page.total, done);
    count.textContent = `已译 ${done}/${total} 段`;
    stop.style.display = state.page.active ? '' : 'none';
    const notes = [];
    if (extra.note) notes.push(extra.note);
    if (state.page.failed) notes.push(`失败 ${state.page.failed} 段（已跳过）`);
    if (state.page.cached && !state.page.active) notes.push(`缓存命中 ${state.page.cached} 段`);
    note.textContent = notes.join(' · ');
    note.className = 'lc-note' + (extra.error ? ' err' : '') + (notes.length ? '' : ' off');
  }

  function positionCard() {
    const card = state.ball.cardEl;
    if (!card || !card.classList.contains('show')) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const box = card.getBoundingClientRect();
    const w = Math.min(box.width || 300, vw - 16);
    const h = box.height || 220;
    const ballEl = state.ball.el;
    const b = ballEl ? ballEl.getBoundingClientRect() : { top: 16, bottom: 50 };
    let top = b.bottom + 10;
    if (top + h > vh - 8) top = Math.max(8, b.top - h - 10);
    top = Math.max(8, Math.min(top, vh - h - 8));
    if (state.ball.side === 'left') {
      card.style.left = '16px';
      card.style.right = 'auto';
    } else {
      card.style.right = '16px';
      card.style.left = 'auto';
    }
    if (vw < 480) {
      card.style.left = '12px';
      card.style.right = '12px';
    }
    card.style.top = `${top}px`;
  }

  function openCard() {
    const card = ensureCard();
    if (!card) return;
    updateCard();
    card.classList.add('show');
    positionCard();
  }

  function closeCard() {
    const card = state.ball.cardEl;
    if (card) card.classList.remove('show');
  }

  function toggleCard() {
    const card = state.ball.cardEl;
    if (card && card.classList.contains('show')) closeCard();
    else openCard();
  }

  function isChineseCode(code) {
    return code === 'zh' || String(code || '').startsWith('zh');
  }

  /** 源与目标是否同一种语言（中文按简繁区分；zh 视为简体） */
  function sameLangOf(src, tgt) {
    if (!src || !tgt || tgt === 'auto') return false;
    if (src === tgt) return true;
    if (src === 'zh') return tgt === 'zh-Hans';
    return false;
  }

  function pageLangInfo() {
    const raw = String(document.documentElement.getAttribute('lang') || '').toLowerCase();
    const primary = raw.split('-')[0];
    let code = LANG_LABELS[primary] ? primary : null;
    if (!code) {
      const det = detectLang(samplePageText(300));
      if (det) code = det.code;
    }
    state.pageLang = code ? { code, label: LANG_LABELS[code] || code } : null;
    return state.pageLang;
  }

  /** 抽取页面正文前 max 字（不标记 data-trf，避免影响后续收集） */
  function samplePageText(max) {
    if (!document.body) return '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let out = '';
    let n;
    while ((n = walker.nextNode())) {
      const parent = n.parentElement;
      if (!isVisible(parent)) continue;
      out += n.nodeValue.trim() + ' ';
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  }

  function shouldAutoPrompt(info) {
    // 只有「英文页面」才自动提示；中文、日文、韩文、法德西俄等一律不弹
    if (!state.settings.autoPromptEnPage) return false;
    if (!info || info.code !== 'en') return false;
    if (!ballEnabled() || state.site.neverPrompt) return false;
    const tgt = state.settings.targetLang || 'zh-Hans';
    if (tgt === 'en') return false; // 源与目标相同，无意义
    return true;
  }

  let promptTimer = 0;
  function scheduleAutoPrompt() {
    clearTimeout(promptTimer);
    if (!ballEnabled()) return;
    promptTimer = setTimeout(() => {
      if (!ballEnabled()) return;
      let prompted = false;
      try { prompted = !!sessionStorage.getItem(PROMPT_ONCE_KEY); } catch (e) { prompted = false; }
      if (prompted) return;
      const info = pageLangInfo();
      if (!shouldAutoPrompt(info)) return;
      try { sessionStorage.setItem(PROMPT_ONCE_KEY, '1'); } catch (e) { /* ignore */ }
      openCard();
    }, 1500);
  }

  function saveSitePrefs(patch) {
    state.site = { ...state.site, ...patch };
    const host = hostKey();
    if (host) {
      try {
        chrome.storage.local.get(SITE_PREFS_KEY, (got) => {
          const all = (got && got[SITE_PREFS_KEY]) || {};
          all[host] = { ...(all[host] || {}), ...patch };
          chrome.storage.local.set({ [SITE_PREFS_KEY]: all });
        });
      } catch (e) { /* ignore */ }
    }
    if (state.site.disabled) {
      removeBall();
      closeCard();
      hideSelectionIcon();
    } else {
      updateBall();
    }
    const card = state.ball.cardEl;
    if (card) {
      const never = card.querySelector('.lc-never');
      const always = card.querySelector('.lc-always');
      if (never) never.checked = !!state.site.neverPrompt;
      if (always) always.checked = !!state.site.alwaysTranslate;
    }
  }

  function loadSitePrefsAndBall() {
    const host = hostKey();
    const finish = () => {
      updateBall();
      scheduleAutoPrompt();
      if (state.site.alwaysTranslate && !state.site.disabled && !domainIgnored()
          && !state.page.active && !state.page.hasTranslations) {
        setTimeout(() => {
          if (!state.page.active && !state.page.hasTranslations) translatePageWithTarget();
        }, 800);
      }
    };
    try {
      chrome.storage.local.get([SITE_PREFS_KEY, BALL_POS_KEY], (got) => {
        const all = (got && got[SITE_PREFS_KEY]) || {};
        const p = (host && all[host]) || {};
        state.site = {
          disabled: !!p.disabled,
          neverPrompt: !!p.neverPrompt,
          alwaysTranslate: !!p.alwaysTranslate
        };
        const pos = got && got[BALL_POS_KEY];
        if (pos) {
          state.ball.side = pos.side === 'left' ? 'left' : 'right';
          state.ball.top = Number(pos.top) || 16;
        }
        finish();
      });
    } catch (e) {
      finish();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[BALL_POS_KEY] && changes[BALL_POS_KEY].newValue) {
        const pos = changes[BALL_POS_KEY].newValue;
        state.ball.side = pos.side === 'left' ? 'left' : 'right';
        state.ball.top = Number(pos.top) || 16;
        applyBallPosition();
      }
      if (changes[SITE_PREFS_KEY]) {
        const all = changes[SITE_PREFS_KEY].newValue || {};
        const p = all[hostKey()] || {};
        state.site = {
          disabled: !!p.disabled,
          neverPrompt: !!p.neverPrompt,
          alwaysTranslate: !!p.alwaysTranslate
        };
        if (state.site.disabled) { removeBall(); closeCard(); hideSelectionIcon(); }
        else updateBall();
      }
    });
  } catch (e) { /* ignore */ }

  document.addEventListener('pointerdown', (e) => {
    if (ui.inUi(e.target)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (ui.hostEl() && path.includes(ui.hostEl())) return;
    closeCard();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCard();
  }, true);

  window.addEventListener('resize', () => {
    applyBallPosition();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const next = { ...state.settings };
      for (const k of Object.keys(changes)) if (changes[k].newValue !== undefined) next[k] = changes[k].newValue;
      state.settings = next;
      onSettingsChanged();
    });
  } catch (e) { /* ignore */ }

  function domainIgnored() {
    const host = (location.hostname || '').toLowerCase();
    if (!host) return false;
    const list = String(state.settings.ignoreDomains || '')
      .split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return list.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p || host.endsWith('.' + p)));
  }

  function callBackground(msg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      // 后台休眠或消息丢失时不能无限等待
      const waitMs = Math.max(15000, (Number(state.settings.timeoutSec) || 60) * 1000 + 8000);
      const timer = setTimeout(() => {
        finish({ ok: false, code: 'timeout', error: '扩展后台无响应，请刷新页面后重试' });
      }, msg.type === 'translate' ? waitMs : 5000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            finish({ ok: false, code: 'internal', error: '扩展后台无响应，请到 chrome://extensions 重新加载扩展' });
            return;
          }
          finish(resp || { ok: false, code: 'internal', error: '扩展后台无响应' });
        });
      } catch (e) {
        finish({ ok: false, code: 'internal', error: '扩展已更新，请刷新页面后重试' });
      }
    });
  }

  /* ---------------- Shadow DOM UI ---------------- */

  const SHADOW_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
    .toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(10px);
      background: rgba(20,21,24,.97); color: #ece9e2; border: 1px solid rgba(200,169,106,.35);
      border-radius: 10px; padding: 9px 14px; font-size: 13px; line-height: 1.55; letter-spacing: .01em;
      box-shadow: 0 10px 34px rgba(0,0,0,.5); opacity: 0; transition: opacity .18s ease, transform .18s ease;
      max-width: min(78vw, 560px); pointer-events: auto; }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast.err { border-color: rgba(220,120,100,.55); color: #ffd9cf; }
    .toast.ok { border-color: rgba(120,190,150,.45); }
    .icon { position: fixed; width: 30px; height: 30px; border-radius: 50%; display: flex;
      align-items: center; justify-content: center; background: rgba(20,21,24,.97);
      border: 1px solid rgba(200,169,106,.75); color: #e2cd97; font-size: 14px; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.45); user-select: none; transition: transform .12s, background .12s; }
    .icon:hover { transform: scale(1.08); background: #26272c; }
    .bubble { position: fixed; background: rgba(20,21,24,.985); border: 1px solid rgba(200,169,106,.32);
      border-radius: 12px; color: #ece9e2; box-shadow: 0 18px 52px rgba(0,0,0,.62); overflow: hidden;
      max-width: min(92vw, 430px); pointer-events: auto; }
    .bubble .hd { display: flex; align-items: center; gap: 8px; padding: 8px 12px 6px;
      border-bottom: 1px solid rgba(255,255,255,.06); }
    .bubble .tag { color: #c8a96a; font-size: 11px; letter-spacing: .03em; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble .pin { color: #7f828c; font-size: 10px; letter-spacing: .02em; white-space: nowrap; }
    .bubble .cache-chip { display: none; color: #9ec8a7; font-size: 10px; white-space: nowrap; }
    .bubble .cache-chip.on { display: inline; }
    .bubble .body { padding: 10px 14px; font-size: 14px; line-height: 1.68; white-space: pre-wrap;
      max-height: 44vh; overflow: auto; word-break: break-word; }
    .bubble .body.empty { color: #8b8d96; font-style: italic; }
    .bubble .ft { display: flex; justify-content: flex-end; gap: 8px; padding: 7px 9px;
      border-top: 1px solid rgba(255,255,255,.06); background: rgba(255,255,255,.02); }
    .bubble button { background: transparent; border: 1px solid rgba(255,255,255,.16); color: #d8d5cc;
      font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
    .bubble button:hover { border-color: rgba(200,169,106,.6); color: #f0e4c0; }
    .bubble button:disabled { opacity: .4; cursor: default; }
    .stat { position: fixed; right: 16px; bottom: 16px; width: 236px; padding: 10px 12px 9px;
      background: rgba(20,21,24,.97); border: 1px solid rgba(200,169,106,.3); border-radius: 10px;
      color: #ece9e2; box-shadow: 0 10px 34px rgba(0,0,0,.55); pointer-events: auto;
      transition: opacity .25s ease, transform .25s ease; }
    .stat.hide { opacity: 0; transform: translateY(6px); pointer-events: none; }
    .stat .row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .stat .title { color: #c8a96a; letter-spacing: .04em; }
    .stat .count { flex: 1; color: #b9b7b0; text-align: right; }
    .stat .btn { background: transparent; border: 1px solid rgba(255,255,255,.18); color: #ddd; font-size: 11px;
      padding: 3px 9px; border-radius: 5px; cursor: pointer; }
    .stat .btn:hover { border-color: rgba(200,169,106,.65); color: #f0e4c0; }
    .stat .bar { margin-top: 8px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.09); overflow: hidden; }
    .stat .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#a8874e,#d3b479);
      transition: width .3s ease; }
    .stat .note { margin-top: 7px; font-size: 11px; line-height: 1.5; color: #9a9ca6; display: none; }
    .stat .note.on { display: block; }
    .stat .note.err { color: #ffb9a8; }
    .fab { position: fixed; left: 16px; bottom: 16px; width: 36px; height: 36px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center; background: rgba(20,21,24,.97);
      border: 1px solid rgba(200,169,106,.45); color: #dcc48c; font-size: 14px; cursor: pointer;
      box-shadow: 0 8px 26px rgba(0,0,0,.5); user-select: none; }
    .fab:hover { background: #26272c; color: #f0e0b6; }
    .fab.on { border-color: rgba(200,169,106,.95); color: #f3e2b4; }
    .ball { position: fixed; top: 16px; right: 16px; width: 34px; height: 34px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; background: rgba(22,23,27,.96);
      border: 1px solid rgba(200,169,106,.55); color: #d9c48f; font-size: 14px; cursor: grab;
      box-shadow: 0 8px 26px rgba(0,0,0,.5); user-select: none; touch-action: none; z-index: 3; }
    .ball:hover { border-color: rgba(200,169,106,.9); color: #f0e0b6; }
    .ball.on { border-color: rgba(200,169,106,.95); color: #f3e2b4;
      box-shadow: 0 0 0 3px rgba(200,169,106,.16), 0 8px 26px rgba(0,0,0,.5); }
    .ball:active { cursor: grabbing; }
    .lang-card { position: fixed; width: 300px; padding: 12px 14px; background: rgba(22,23,27,.985);
      border: 1px solid rgba(200,169,106,.28); border-radius: 14px; color: #ece9e2;
      box-shadow: 0 22px 60px rgba(0,0,0,.62); z-index: 4; opacity: 0; transform: translateY(-6px);
      pointer-events: none; transition: opacity .18s ease, transform .18s ease; }
    .lang-card.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .lc-hd { display: flex; align-items: flex-start; gap: 8px; }
    .lc-title { flex: 1; font-size: 15px; line-height: 1.4; }
    .lc-title b { color: #e3c98f; font-weight: 600; }
    .lc-x { border: 0; background: transparent; color: #8b8d96; font-size: 17px; cursor: pointer; padding: 0 2px; line-height: 1; }
    .lc-x:hover { color: #f0e4c0; }
    .lc-sub { margin-top: 12px; font-size: 11px; color: #8f929c; letter-spacing: .05em; }
    .lc-sel { position: relative; margin-top: 6px; }
    .lc-sel::after { content: '⌄'; position: absolute; right: 10px; top: 6px; color: #c8a96a; pointer-events: none; font-size: 12px; }
    .lc-lang-sel { width: 100%; appearance: none; -webkit-appearance: none; background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.16); border-radius: 8px; color: #ece9e2; font-size: 13px;
      padding: 7px 10px; outline: none; cursor: pointer; }
    .lc-lang-sel:hover { border-color: rgba(200,169,106,.5); }
    .lc-go-row { margin-top: 12px; display: flex; gap: 8px; }
    .lc-more { flex: 0 0 auto; background: transparent; border: 1px solid rgba(255,255,255,.16); color: #b9b7b0;
      font-size: 12px; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    .lc-go { flex: 1; background: linear-gradient(180deg,#c8a96a,#a8874e); border: 0; color: #17181c;
      font-size: 13px; font-weight: 600; padding: 9px 12px; border-radius: 8px; cursor: pointer; }
    .lc-go:hover { filter: brightness(1.06); }
    .lc-go:disabled { background: rgba(255,255,255,.1); color: #7b7d86; cursor: not-allowed; filter: none; }
    .lc-warn { display: none; margin-top: 7px; font-size: 11px; color: #ffb9a8; }
    .lc-warn.on { display: block; }
    .lc-morebox { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); }
    .lc-morebox.open { display: block; }
    .lc-seg { display: flex; gap: 6px; margin-bottom: 8px; }
    .lc-seg button { flex: 1; background: transparent; border: 1px solid rgba(255,255,255,.14); color: #a9abb4;
      font-size: 12px; padding: 6px; border-radius: 7px; cursor: pointer; }
    .lc-seg button.active { border-color: rgba(200,169,106,.75); color: #f0e4c0; background: rgba(200,169,106,.1); }
    .lc-toggle { width: 100%; background: transparent; border: 1px solid rgba(255,255,255,.14); color: #d8d5cc;
      font-size: 12px; padding: 7px; border-radius: 7px; cursor: pointer; margin-bottom: 8px; }
    .lc-toggle:hover { border-color: rgba(200,169,106,.6); color: #f0e4c0; }
    .lc-chk { display: flex; align-items: center; gap: 7px; margin-top: 7px; font-size: 12px; color: #b9b7b0; cursor: pointer; }
    .lc-chk input { accent-color: #c8a96a; width: 13px; height: 13px; cursor: pointer; }
    .lc-prog { display: none; margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.07); }
    .lc-prog.on { display: block; }
    .lc-prog-row { display: flex; align-items: center; gap: 8px; }
    .lc-count { flex: 1; font-size: 11px; color: #c9c6bd; }
    .lc-stop { background: transparent; border: 1px solid rgba(255,255,255,.18); color: #ddd; font-size: 11px;
      padding: 3px 9px; border-radius: 5px; cursor: pointer; }
    .lc-stop:hover { border-color: rgba(220,120,100,.6); color: #ffd9cf; }
    .lc-note { margin-top: 4px; font-size: 11px; line-height: 1.5; color: #9a9ca6; }
    .lc-note.err { color: #ffb9a8; }
    .paste-card { position: fixed; right: 16px; bottom: 24px; width: 320px; background: rgba(22,23,27,.985);
      border: 1px solid rgba(200,169,106,.38); border-radius: 12px; color: #ece9e2; padding: 11px 13px;
      box-shadow: 0 18px 48px rgba(0,0,0,.6); z-index: 5; }
    .pc-hd { display: flex; align-items: center; gap: 8px; }
    .pc-title { flex: 1; font-size: 12.5px; color: #ffcdb8; }
    .pc-x { border: 0; background: transparent; color: #8b8d96; font-size: 16px; line-height: 1; cursor: pointer; }
    .pc-x:hover { color: #f0e4c0; }
    .pc-note { margin-top: 6px; font-size: 11px; line-height: 1.55; color: #9a9ca6; }
    .pc-body { margin-top: 8px; max-height: 120px; overflow: auto; padding: 8px 9px; font-size: 12.5px;
      line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.12); border-radius: 7px; user-select: text; }
    .pc-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .pc-copy { background: linear-gradient(180deg,#c8a96a,#a8874e); border: 0; color: #17181c; font-size: 12px;
      font-weight: 600; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
    .pc-copy:hover { filter: brightness(1.06); }
    .pc-ok { font-size: 11px; color: #8fd0a4; }
  `;

  const ui = (() => {
    let host = null;
    let root = null;
    let toastEl = null;
    let toastTimer = 0;

    function ensure() {
      if (root && host && host.isConnected) return root;
      host = document.createElement('div');
      host.id = 'trf-root';
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
      (document.documentElement || document.body).appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = SHADOW_CSS;
      root.appendChild(style);
      return root;
    }

    function toast(text, opts = {}) {
      const r = ensure();
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        r.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.className = 'toast show' + (opts.type ? ' ' + opts.type : '');
      clearTimeout(toastTimer);
      if (!opts.sticky) {
        toastTimer = setTimeout(() => { toastEl.className = 'toast' + (opts.type ? ' ' + opts.type : ''); }, opts.duration || 2400);
      }
    }

    function inUi(el) {
      return !!(host && el && host.contains(el));
    }

    function hostEl() { ensure(); return host; }

    return { ensure, toast, inUi, hostEl };
  })();

  /* ---------------- 方向判定 ---------------- */

  function detectLang(text) {
    const s = String(text || '').slice(0, 2000);
    const kana = /[\u3040-\u30ff\u31f0-\u31ff]/.test(s);
    const hangul = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(s);
    const han = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (kana) return { code: 'ja', label: '日本語' };
    if (hangul) return { code: 'ko', label: '한국어' };
    if (han >= 1 && letters > 0 && han / letters >= 0.5) return { code: 'zh', label: '中文' };
    if (/[а-яА-ЯёЁ]/.test(s)) return { code: 'ru', label: 'Русский' };
    if (/[\u0600-\u06ff]/.test(s)) return { code: 'ar', label: 'العربية' };
    if (/[\u0e00-\u0e7f]/.test(s)) return { code: 'th', label: 'ไทย' };
    if ((s.match(/[ñ¿¡]/g) || []).length >= 1) return { code: 'es', label: 'Español' };
    if ((s.match(/[äöüßÄÖÜ]/g) || []).length >= 2) return { code: 'de', label: 'Deutsch' };
    if ((s.match(/[àâçéèêëîïôûùÿœæ]/g) || []).length >= 2) return { code: 'fr', label: 'Français' };
    if (/[A-Za-z]/.test(s)) return { code: 'en', label: '英语' };
    return null;
  }

  /** 三空格 / 划词：默认自动判定；开启「遵循源语言」后用设置里的源语言 */
  function followSrcLang() {
    return state.settings.followSourceLang ? (state.settings.sourceLang || 'auto') : 'auto';
  }

  function resolveDirection(text, target, srcLang) {
    const raw = String(text || '');
    if (!raw.trim()) return { err: 'empty' };
    const forcedSrc = srcLang && srcLang !== 'auto' ? srcLang : '';
    let det;
    if (forcedSrc) {
      det = { code: forcedSrc, label: sourceLabelOf(forcedSrc) };
    } else {
      det = detectLang(raw);
      if (!det) return { err: 'unknown' };
    }
    let to = target && target !== 'auto' ? target : '';
    if (!to) {
      const mode = state.settings.directionMode;
      if (mode === 'en') to = 'en';
      else if (mode === 'zh') to = 'zh-Hans';
    }
    if (!to) to = isChineseCode(det.code) ? 'en' : 'zh-Hans';
    const dirLabel = `${det.label} → ${targetLabelOf(to)}`;
    return {
      to,
      srcCode: det.code,
      srcLabel: det.label,
      forcedSrc: !!forcedSrc,
      label: forcedSrc ? dirLabel : `检测：${dirLabel}`
    };
  }

  /* ---------------- 文本切分 ---------------- */

  function splitIntoUnits(text, maxChars, maxParas) {
    const limitChars = Math.max(200, Number(maxChars) || 800);
    const limitParas = Math.max(1, Number(maxParas) || 6);
    const paras = String(text).replace(/\r\n/g, '\n').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const units = [];
    let cur = [];
    let curLen = 0;
    const flush = () => { if (cur.length) { units.push(cur); cur = []; curLen = 0; } };

    for (const p of paras) {
      if (p.length > limitChars) {
        flush();
        const sentences = p.match(/[^.!?。！？\n]+[.!?。！？]?["'”’）)]?\s*/g) || [p];
        let buf = '';
        for (const sn of sentences) {
          if ((buf + sn).length > limitChars && buf.trim()) { units.push([buf.trim()]); buf = ''; }
          buf += sn;
          while (buf.length > limitChars) { units.push([buf.slice(0, limitChars)]); buf = buf.slice(limitChars); }
        }
        if (buf.trim()) units.push([buf.trim()]);
        continue;
      }
      if (cur.length >= limitParas || (curLen + p.length + 2 > limitChars && cur.length)) flush();
      cur.push(p);
      curLen += p.length + 2;
    }
    flush();
    return units;
  }

  function splitParagraphs(text, n) {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];
    const byBlank = raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (byBlank.length === n) return byBlank;
    const byLine = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (byLine.length === n) return byLine;
    return byBlank.length ? byBlank : byLine.length ? byLine : [raw];
  }

  /** 模型返回段数与请求不一致时的兜底：按最短相邻合并 / 最长句子切分，绝不丢段 */
  function forceAlign(parts, n) {
    let p = parts.map((s) => String(s).trim()).filter(Boolean);
    if (!p.length) return null;
    if (p.length === n) return p;

    while (p.length > n) {
      let bi = 0;
      let best = Infinity;
      for (let i = 0; i < p.length - 1; i++) {
        const len = p[i].length + p[i + 1].length;
        if (len < best) { best = len; bi = i; }
      }
      p.splice(bi, 2, `${p[bi].replace(/\s+$/, '')} ${p[bi + 1].replace(/^\s+/, '')}`);
    }

    while (p.length < n) {
      let li = 0;
      for (let i = 1; i < p.length; i++) if (p[i].length > p[li].length) li = i;
      const s = p[li];
      let cut = -1;
      const mid = Math.floor(s.length / 2);
      const marks = [];
      for (let i = 0; i < s.length; i++) if ('。！？；.!?;\n'.includes(s[i])) marks.push(i + 1);
      if (marks.length) {
        cut = marks.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a), marks[0]);
      }
      if (cut <= 0 || cut >= s.length) return null;
      p.splice(li, 1, s.slice(0, cut).trim(), s.slice(cut).trim());
    }
    return p;
  }

  /* ---------------- 批量请求 ---------------- */

  function throwIfStopped() {
    if (state.page.stopped) {
      const e = new Error('已中止');
      e.code = 'aborted';
      throw e;
    }
  }

  /**
   * 批量翻译：先按段查缓存（命中段不发请求），未命中段合批请求并写回缓存。
   * 返回 { parts, cached, cacheMs }。
   */
  async function requestBatch(texts, dir, opts = {}) {
    const n = texts.length;
    const tCache = performance.now();
    let hits = new Array(n).fill(null);
    let missIdx = [];

    if (opts.noCache) {
      missIdx = texts.map((_, i) => i);
    } else {
      const cr = await callBackground({ type: 'cache-get', texts, src: dir.srcCode, to: dir.to });
      if (cr && cr.ok && Array.isArray(cr.items)) {
        cr.items.forEach((it, i) => { if (it && it.hit) hits[i] = it.t; });
        missIdx = hits.map((h, i) => (h == null ? i : -1)).filter((i) => i >= 0);
      } else {
        missIdx = texts.map((_, i) => i);
      }
    }
    const cacheMs = Math.max(0, Math.round(performance.now() - tCache));

    if (!missIdx.length) {
      return { parts: hits.slice(), cached: n, cacheMs, allCached: true };
    }

    const missTexts = missIdx.map((i) => texts[i]);
    const m = missTexts.length;
    const text = missTexts.join('\n\n');
    const retry = opts.retry === undefined ? 1 : opts.retry;
    let last = null;
    let lastParts = null;
    let parts2 = null;

    for (let attempt = 0; attempt <= retry; attempt++) {
      throwIfStopped();
      const id = `trf-${++state.seq}-${Math.random().toString(36).slice(2, 7)}`;
      state.page.inflightIds.add(id);
      let res;
      try {
        res = await callBackground({
          type: 'translate', id, text, count: m, to: dir.to, src: dir.srcCode,
          stream: true, push: !!opts.push
        });
      } finally {
        state.page.inflightIds.delete(id);
      }
      if (!res.ok) {
        last = res;
        if (res.code === 'aborted') { const e = new Error('已中止'); e.code = 'aborted'; throw e; }
        if (res.code === 'disconnected' || res.code === 'timeout') {
          const e = new Error(res.error);
          e.code = res.code;
          throw e;
        }
        continue;
      }
      const parts = splitParagraphs(res.text, m);
      if (parts.length === m) { parts2 = parts; break; }
      lastParts = parts;
      last = { ok: false, code: 'mismatch', error: `译文段数与原文不一致（${parts.length}/${m}）` };
    }

    if (!parts2 && last && last.code === 'mismatch' && lastParts) {
      const aligned = forceAlign(lastParts, m);
      if (aligned && aligned.length === m) parts2 = aligned;
    }
    if (!parts2) {
      const e = new Error((last && last.error) || '翻译失败');
      e.code = (last && last.code) || 'fail';
      throw e;
    }

    const merged = hits.slice();
    missIdx.forEach((idx, k) => { merged[idx] = parts2[k]; });

    if (!opts.noCache) {
      // 等待写回完成，保证「翻译完立刻再翻」必定命中
      try {
        await callBackground({
          type: 'cache-put',
          items: missIdx.map((idx, k) => ({ text: texts[idx], t: parts2[k] })),
          src: dir.srcCode,
          to: dir.to
        });
      } catch (e) { /* 缓存写入失败不影响翻译结果 */ }
    }

    return { parts: merged, cached: n - m, cacheMs, allCached: false, parts2 };
  }

  /** 将任意长度文本按设置切块，顺序翻译后合并 */
  async function translateLong(text, dir, opts = {}) {
    const units = splitIntoUnits(text, state.settings.batchChars, state.settings.batchParagraphs);
    const outs = [];
    let cached = 0;
    let cacheMs = 0;
    for (const unit of units) {
      const r = await requestBatch(unit, dir, opts);
      outs.push(...r.parts);
      cached += r.cached;
      cacheMs = Math.max(cacheMs, r.cacheMs);
    }
    return { parts: outs, cached, cacheMs };
  }

  /* ---------------- 功能一：输入框三连空格 ---------------- */

  const spaceSeq = [];
  let tripleBusy = false;

  function isSearchLike(el) {
    if (el.getAttribute('type') === 'search') return true;
    const hint = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`;
    if (/search|query|搜索|查找/i.test(hint)) return true;
    if (el.closest('[role="search"], form[action*="search"]')) return true;
    return false;
  }

  function findField(target) {
    let el = target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || !el.closest) return null;
    const ce = el.closest('[contenteditable]');
    if (ce && ce.getAttribute('contenteditable') !== 'false' && ce.isContentEditable) {
      return { el: ce, type: 'ce' };
    }
    if (el instanceof HTMLTextAreaElement) {
      if (el.disabled || el.readOnly) return null;
      return { el, type: 'textarea' };
    }
    if (el instanceof HTMLInputElement) {
      if (el.disabled || el.readOnly || el.type === 'password' || isSearchLike(el)) return null;
      const ok = ['text', 'url', 'email', 'tel', ''].includes(el.type) || el.type === 'search';
      if (!ok) return null;
      return { el, type: 'input' };
    }
    return null;
  }

  function readField(field) {
    return field.type === 'ce' ? String(field.el.innerText || '') : String(field.el.value || '');
  }

  function caretToEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** 真正存活的编辑区：field.el 可能已被富文本编辑器重建/替换 */
  function liveEditable(field) {
    const el = field.el;
    if (el && el.isConnected && el.isContentEditable) return el;
    const a = document.activeElement;
    if (a && a.isContentEditable) {
      const ce = (a.closest && a.closest('[contenteditable]:not([contenteditable="false"])')) || a;
      if (ce.isContentEditable) return ce;
    }
    const sel = window.getSelection && window.getSelection();
    const node = sel && sel.anchorNode;
    if (node) {
      const n = node.nodeType === 3 ? node.parentElement : node;
      const ce = n && n.closest && n.closest('[contenteditable]:not([contenteditable="false"])');
      if (ce && ce.isContentEditable) return ce;
    }
    return el;
  }

  function editableTextOf(el) {
    if (!el) return '';
    try { return String(el.innerText != null ? el.innerText : (el.textContent || '')); } catch (e) { return ''; }
  }

  function currentFieldText(field) {
    return field.type === 'ce' ? editableTextOf(liveEditable(field)) : String(field.el.value || '');
  }

  function selectAllIn(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusEditable(el) {
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* ignore */ } }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 诊断日志：仅 debugFill 开启时输出，同时写一个 DOM 属性方便外部取证 */
  function fillDiag(field, stage, extra) {
    if (!state.settings.debugFill) return;
    try {
      const a = document.activeElement;
      const sel = window.getSelection && window.getSelection();
      const anchor = sel && sel.anchorNode;
      const anchorEl = anchor ? (anchor.nodeType === 3 ? anchor.parentElement : anchor) : null;
      const selCe = anchorEl && anchorEl.closest && anchorEl.closest('[contenteditable]:not([contenteditable="false"])');
      const live = field.type === 'ce' ? liveEditable(field) : field.el;
      const info = {
        stage,
        type: field.type,
        active: a ? { tag: a.tagName, cls: String(a.className || '').slice(0, 60), ce: !!a.isContentEditable, connected: a.isConnected } : null,
        selEditable: selCe ? { tag: selCe.tagName, cls: String(selCe.className || '').slice(0, 60), connected: selCe.isConnected } : null,
        live: live ? { tag: live.tagName, cls: String(live.className || '').slice(0, 60), connected: live.isConnected } : null,
        text: { len: editableTextOf(live).length, head: editableTextOf(live).slice(0, 20) },
        ...extra
      };
      console.debug('[trf-fill]', JSON.stringify(info));
      document.documentElement.setAttribute('data-trf-fill', JSON.stringify(info));
    } catch (e) { /* ignore */ }
  }

  /* 回填时间线与守护窗口 */

  const fillCtx = { field: null, writing: false, userTyped: false };
  let fillGuardGen = 0;
  let fillTraceStart = 0;
  let fillTraceLog = [];

  function fillTrace(label, extra = {}) {
    if (!state.settings.debugFill) return;
    const f = fillCtx.field;
    const text = f ? currentFieldText(f) : '';
    const item = {
      t: Math.round(performance.now() - (fillTraceStart || performance.now())),
      label, len: text.length, head: text.slice(0, 20),
      ...extra
    };
    fillTraceLog.push(item);
    if (fillTraceLog.length > 80) fillTraceLog.splice(0, fillTraceLog.length - 80);
    try { console.debug('[trf-fill]', JSON.stringify(item)); } catch (e) { /* ignore */ }
    try { document.documentElement.setAttribute('data-trf-timeline', JSON.stringify(fillTraceLog)); } catch (e) { /* ignore */ }
  }

  // 回填会话是否仍然有效：发送 / 清空 / 失焦 / 用户删除 后立即作废，之后不再有任何写入
  let guardLive = false;
  function cancelFillGuard(reason) {
    if (!guardLive) return;
    guardLive = false;
    fillGuardGen += 1;
    fillCtx.field = null;
    fillTrace('guard-cancel', { reason });
    // 作废后不残留 toast（失败卡片与 toast 都不弹）
    try {
      const r = ui.ensure();
      const t = r.querySelector('.toast');
      if (t) t.remove();
    } catch (e) { /* ignore */ }
  }

  /** 守护判定：只有「被还原成原文」才允许重试；清空与用户改动一律终止 */
  function judgeGuard(cur, orig, want) {
    if (cur === want) return 'ok';
    if (!cur) return 'empty';
    const needleLen = Math.min(6, orig.length);
    if (orig && (cur === orig || (cur.length >= needleLen && orig.includes(cur))) ) return 'reverted';
    return 'changed';
  }

  // 记录站点自身派发的输入事件（isTrusted 的才算用户输入，避免把编辑器 reconciliation 当成人打字）
  ['beforeinput', 'input', 'compositionend'].forEach((type) => {
    document.addEventListener(type, (e) => {
      if (!fillCtx.field) return;
      const ours = fillCtx.writing;
      fillTrace((ours ? 'ours:' : 'site:') + type, {
        inputType: e.inputType || '',
        data: String(e.data == null ? '' : e.data).slice(0, 20),
        trusted: !!e.isTrusted
      });
      if (!ours && e.isTrusted) {
        fillCtx.userTyped = true;
        // 用户删除（全选删除/退格）：立即作废，清空后不回填
        if (String(e.inputType || '').startsWith('delete')) cancelFillGuard('delete');
      }
    }, true);
  });

  // 发送/清空的即时信号：回车、删除键、点按钮、失焦、选区离开编辑区
  document.addEventListener('keydown', (e) => {
    if (!guardLive || !e.isTrusted) return;
    if (e.key === 'Enter') cancelFillGuard('enter');
    // 真实删除键（部分编辑器全选删除不派发 beforeinput，这里兜住）
    else if (e.key === 'Delete' || e.key === 'Backspace') cancelFillGuard('delete-key');
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!guardLive || !e.isTrusted) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('button, [role="button"], input[type="submit"]')) cancelFillGuard('send-button');
  }, true);
  document.addEventListener('focusout', (e) => {
    if (!guardLive) return;
    if (fillCtx.field && fillCtx.field.el === e.target) cancelFillGuard('blur');
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!guardLive || !fillCtx.field) return;
    const el = liveEditable(fillCtx.field);
    if (!el) { cancelFillGuard('detached'); return; }
    const sel = document.getSelection();
    const node = sel && sel.anchorNode;
    if (node && !el.contains(node.nodeType === 3 ? node.parentNode : node)) cancelFillGuard('selection-left');
  });

  function copyText(text) {
    return new Promise((resolve) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(execCopy(text)));
          return;
        }
      } catch (e) { /* ignore */ }
      resolve(execCopy(text));
    });
  }
  function execCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /** 三级兜底全部失败时的提示卡片：显示译文 + 复制按钮 */
  function showFillCard(translated, reason) {
    const r = ui.ensure();
    let card = r.querySelector('.paste-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'paste-card';
      card.innerHTML =
        '<div class="pc-hd"><span class="pc-title">此输入框不支持自动回填</span><button class="pc-x" title="关闭">×</button></div>' +
        '<div class="pc-note"></div><div class="pc-body"></div>' +
        '<div class="pc-row"><button class="pc-copy">复制译文</button><span class="pc-ok"></span></div>';
      card.querySelector('.pc-x').addEventListener('click', () => card.remove());
      card.querySelector('.pc-copy').addEventListener('click', () => {
        copyText(card.querySelector('.pc-body').textContent).then((ok) => {
          card.querySelector('.pc-ok').textContent = ok ? '已复制' : '复制失败，请手动选中';
        });
      });
    }
    card.querySelector('.pc-note').textContent = reason;
    const body = card.querySelector('.pc-body');
    body.textContent = translated;
    card.querySelector('.pc-ok').textContent = '';
    r.appendChild(card);
    copyText(translated).then((ok) => {
      if (!card.isConnected) return;
      card.querySelector('.pc-note').textContent = ok
        ? '富文本编辑器用内部状态覆盖了写入，译文已自动复制，可直接粘贴回输入框。'
        : '此输入框拒绝写入，自动复制也失败了；请手动选中下方译文后粘贴。';
    });
    return card;
  }

  /** 模拟粘贴（Lexical/Draft 对 paste 的接受度通常高于 execCommand） */
  async function pasteFill(field, text) {
    const node = liveEditable(field);
    if (!node || !node.isConnected) return false;
    focusEditable(node);
    fillCtx.writing = true;
    try {
      selectAllIn(node);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', escapeHtml(text).replace(/\n/g, '<br>'));
      let ev;
      try { ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); }
      catch (e) { ev = new Event('paste', { bubbles: true, cancelable: true }); }
      if (!ev.clipboardData) {
        try { Object.defineProperty(ev, 'clipboardData', { value: dt }); } catch (e) { /* ignore */ }
      }
      node.dispatchEvent(ev);
    } catch (e) { /* ignore */ }
    fillCtx.writing = false;
    await sleep(80);
    return normText(editableTextOf(liveEditable(field))) === normText(text);
  }

  /** 主路径（参考 read-frog）：请求 MAIN world 脚本直接调用编辑器内部 API（Lexical / Slate / Draft）
   *  隔离世界访问不到页面 JS 对象（__lexicalEditor、React fiber），只能靠 postMessage 桥接。 */
  let mainFillSeq = 0;
  function mainWorldFill(field, text, timeout = 1200) {
    return new Promise((resolve) => {
      const node = liveEditable(field);
      if (!node || !node.isConnected) { resolve({ ok: false, engine: 'none', reason: 'no-live-node' }); return; }
      const id = 'trf' + (++mainFillSeq) + '-' + Math.random().toString(36).slice(2, 8);
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg, true);
        resolve(res);
      };
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.type !== 'trf:input-fill-result' || d.id !== id) return;
        finish({ ok: !!d.ok, engine: String(d.engine || ''), reason: String(d.reason || '') });
      };
      window.addEventListener('message', onMsg, true);
      try {
        focusEditable(node);
        const target = location.origin === 'null' ? '*' : location.origin;
        window.postMessage({ type: 'trf:input-fill', id, text }, target);
      } catch (err) {
        finish({ ok: false, engine: 'error', reason: String(err) });
        return;
      }
      setTimeout(() => finish({ ok: false, engine: 'timeout', reason: 'main-world-timeout' }), timeout);
    });
  }

  /** 回填守护窗口：80/300/800/1500ms 回读；只有被还原成原文才重试，清空/用户改动立即终止 */
  function startFillGuard(field, text, originalRaw) {
    const gen = ++fillGuardGen;
    const want = normText(text);
    const orig = normText(originalRaw == null ? '' : originalRaw);
    guardLive = true;
    fillCtx.field = field;
    fillCtx.userTyped = false;
    let retries = 0;
    (async () => {
      let prev = 0;
      for (const at of [80, 300, 800, 1500]) {
        await sleep(Math.max(0, at - prev));
        prev = at;
        if (gen !== fillGuardGen) return;
        const live = liveEditable(field);
        if (!live || !live.isConnected) { fillTrace('guard-stop-detached@' + at); guardLive = false; fillCtx.field = null; return; }
        if (fillCtx.userTyped) { fillTrace('guard-stop-user@' + at); guardLive = false; fillCtx.field = null; return; }
        const cur = normText(currentFieldText(field));
        const verdict = judgeGuard(cur, orig, want);
        fillTrace('guard@' + at, { match: cur === want, verdict, retries });
        if (verdict === 'empty') { cancelFillGuard('empty@' + at); return; }
        if (verdict === 'changed') { cancelFillGuard('changed@' + at); return; }
        if (verdict === 'ok') continue;
        if (retries >= 3) continue;
        retries += 1;
        // 重试优先走编辑器 API（主路径），失败再退到模拟粘贴
        const apiRetry = await mainWorldFill(field, text);
        const ok = apiRetry.ok ? true : await pasteFill(field, text);
        fillTrace('guard-retry-' + retries, { ok, engine: apiRetry.ok ? apiRetry.engine : 'paste', after: currentFieldText(field).slice(0, 20) });
        await sleep(80);
        if (gen !== fillGuardGen) return;
      }
      if (gen !== fillGuardGen) return;
      if (fillCtx.userTyped) { guardLive = false; fillCtx.field = null; return; }
      const cur = normText(currentFieldText(field));
      const verdict = judgeGuard(cur, orig, want);
      if (verdict === 'ok') {
        fillTrace('guard-pass');
      } else if (verdict === 'reverted') {
        fillTrace('guard-fail');
        showFillCard(text, '编辑器把写入的译文异步还原了，自动重试 3 次仍失败；译文已复制，可直接粘贴。');
        ui.toast('回填被编辑器还原，译文已显示在右下角', { type: 'err', duration: 5000 });
      } else {
        // 清空 / 用户改动：作废会话，不弹卡片、不 toast、不抢焦点
        fillTrace('guard-stop-' + verdict);
      }
      guardLive = false;
      fillCtx.field = null;
    })();
  }

  /** 回填：input/textarea 直接写值；contenteditable 走 execCommand → 模拟粘贴 → Range 替换，每级 80ms 回读 */
  async function writeField(field, text, originalRaw) {
    const el = field.el;
    if (field.type !== 'ce') {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text }));
      try { el.setSelectionRange(text.length, text.length); } catch (e) { /* 只读类型忽略 */ }
      return true;
    }

    const original = originalRaw == null ? editableTextOf(liveEditable(field)) : String(originalRaw);
    fillCtx.field = field;
    fillTrace('fill-start', { original: original.slice(0, 20), target: text.slice(0, 20) });
    const want = normText(text);

    // 主路径（参考 read-frog）：MAIN world 直接调用编辑器内部 API，让编辑器自己 reconciliation
    let node = liveEditable(field);
    const api = await mainWorldFill(field, text);
    fillTrace('level0-editor-api', { ok: api.ok, engine: api.engine, reason: api.reason });
    if (api.ok) {
      await sleep(80);
      node = liveEditable(field);
      const t0 = editableTextOf(node);
      const m0 = normText(t0) === want;
      fillDiag(field, 'level0', { engine: api.engine, after: t0.slice(0, 80), match: m0 });
      fillTrace('level0', { engine: api.engine, match: m0 });
      if (m0) {
        // 编辑器内部已把选区移到末尾，这里不再改选区，只同步存活节点
        field.el = node;
        startFillGuard(field, text, original);
        return true;
      }
    }

    // 一级（后备）：选中整个真实编辑区 + execCommand insertText
    node = liveEditable(field);
    focusEditable(node);
    selectAllIn(node);
    let ret = false;
    fillCtx.writing = true;
    try { ret = document.execCommand('insertText', false, text); } catch (e) { ret = false; }
    fillCtx.writing = false;
    await sleep(80);
    node = liveEditable(field);
    const t1 = editableTextOf(node);
    fillDiag(field, 'level1', { ret, after: t1.slice(0, 80), match: normText(t1) === want });
    fillTrace('level1', { ret, connected: node && node.isConnected, match: normText(t1) === want });
    if (normText(t1) === want) { focusEditable(node); caretToEnd(node); field.el = node; startFillGuard(field, text, original); return true; }

    // 二级：模拟粘贴（Lexical/Draft 会读 clipboardData）
    const ok2 = await pasteFill(field, text);
    node = liveEditable(field);
    const t2 = editableTextOf(node);
    fillDiag(field, 'level2', { after: t2.slice(0, 80), match: normText(t2) === want });
    fillTrace('level2', { match: ok2 });
    if (ok2 || normText(t2) === want) { focusEditable(node); caretToEnd(node); field.el = node; startFillGuard(field, text, original); return true; }

    // 三级：Range 直接替换 + 手动派发 beforeinput/input
    node = liveEditable(field);
    focusEditable(node);
    fillCtx.writing = true;
    try {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      selectAllIn(node);
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
      } else {
        node.textContent = text;
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch (e) { /* ignore */ }
    fillCtx.writing = false;
    await sleep(80);
    node = liveEditable(field);
    const t3 = editableTextOf(node);
    fillDiag(field, 'level3', { after: t3.slice(0, 80), match: normText(t3) === want });
    fillTrace('level3', { match: normText(t3) === want, connected: node && node.isConnected });
    if (normText(t3) === want) { focusEditable(node); caretToEnd(node); field.el = node; startFillGuard(field, text, original); return true; }

    // 三级全失败：尝试恢复原文，再弹出可复制的译文卡片
    try {
      node = liveEditable(field);
      if (normText(editableTextOf(node)) !== normText(original)) {
        focusEditable(node);
        selectAllIn(node);
        document.execCommand('insertText', false, original);
        await sleep(60);
      }
    } catch (e) { /* ignore */ }
    const restored = editableTextOf(liveEditable(field));
    fillDiag(field, 'fail', { restored: restored.slice(0, 80), original: original.slice(0, 80) });
    fillTrace('fill-fail', { restored: restored.slice(0, 20), match: normText(restored) === want });
    fillCtx.field = null;
    showFillCard(text, '此输入框（富文本编辑器）拒绝写入。译文已尝试复制，若未成功请手动复制后粘贴。');
    ui.toast('此输入框不支持自动回填，译文已显示在右下角', { type: 'err', duration: 5000 });
    return false;
  }

  function onTripleSpace(field) {
    if (tripleBusy || state.site.disabled || domainIgnored()) return;
    const raw = readField(field);
    const source = raw.replace(/[ \u00a0]+$/, '');
    if (!source.trim()) { ui.toast('请先输入内容'); return; }
    if (source.length > 2000) { ui.toast(`内容过长（${source.length} 字），请分段后再翻译`, { type: 'err' }); return; }

    fillCtx.field = field;
    fillCtx.userTyped = false;
    fillGuardGen += 1; // 取消上一次回填遗留的守护窗口，避免旧译文回写覆盖新内容
    guardLive = false;
    fillTraceStart = performance.now();
    fillTraceLog = [];
    fillTrace('trigger', { rawLen: raw.length });

    const dir = resolveDirection(source, null, followSrcLang());
    if (dir.err) {
      fillCtx.field = null;
      ui.toast(dir.err === 'empty' ? '请先输入内容' : '无法识别内容语言，请检查输入', { type: 'err' });
      return;
    }

    tripleBusy = true;
    state.busyFields.add(field.el);
    ui.toast('翻译中…', { sticky: true });

    (async () => {
      try {
        const r = await translateLong(source, dir);
        const out = r.parts.join('\n\n');
        if (normText(currentFieldText(field)) !== normText(raw)) {
          fillCtx.field = null;
          ui.toast('内容已修改，已取消回填（保留你的新输入）', { type: 'err', duration: 3500 });
          return;
        }
        const ok = await writeField(field, out, source);
        if (!ok) return; // 已在右下角显示可复制的译文卡片
        const cacheTag = r.cached ? ` · 缓存 · ${(r.cacheMs / 1000).toFixed(2)}s` : '';
        ui.toast(`已翻译为${targetLabelOf(dir.to)}${cacheTag}`, { type: 'ok', duration: 1800 });
      } catch (e) {
        const cur = currentFieldText(field);
        if (normText(cur) === normText(raw)) await writeField(field, source, source); // 去掉触发时残留的空格
        fillCtx.field = null;
        if (e.code === 'disconnected') ui.toast(DISCONNECTED_HINT, { type: 'err', duration: 7000 });
        else if (e.code === 'aborted') ui.toast('已中止', { duration: 1600 });
        else ui.toast(`翻译失败：${e.message || '未知错误'}`, { type: 'err', duration: 5000 });
      } finally {
        tripleBusy = false;
        state.busyFields.delete(field.el);
      }
    })();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
      if (e.key !== ' ') spaceSeq.length = 0;
      return;
    }
    if (!state.settings.tripleSpaceEnabled || domainIgnored()) return;

    const field = findField(e.target || document.activeElement);
    if (!field || state.busyFields.has(field.el)) return;

    const gapMax = Math.min(400, Math.max(120, Number(state.settings.tripleSpaceWindowMs) || 800));
    const totalMax = Math.max(200, Number(state.settings.tripleSpaceWindowMs) || 800);
    const now = performance.now();

    if (spaceSeq.length && now - spaceSeq[spaceSeq.length - 1] > gapMax) spaceSeq.length = 0;
    spaceSeq.push(now);
    if (spaceSeq.length > 3) spaceSeq.splice(0, spaceSeq.length - 3);

    if (spaceSeq.length === 3) {
      const total = spaceSeq[2] - spaceSeq[0];
      if (total <= totalMax && spaceSeq[1] - spaceSeq[0] < 400 && spaceSeq[2] - spaceSeq[1] < 400) {
        e.preventDefault(); // 第三次空格不能落进输入框
        spaceSeq.length = 0;
        onTripleSpace(field);
      } else {
        spaceSeq.shift();
      }
    }
  }, true);

  /* 输入框翻译快捷键（默认 Ctrl/Cmd + Shift + Enter，可在设置页自定义） */

  const DEFAULT_INPUT_SHORTCUT = 'Ctrl+Shift+Enter';

  function shortcutParts(spec) {
    const raw = String(spec || DEFAULT_INPUT_SHORTCUT).split('+').map((s) => s.trim()).filter(Boolean);
    const mods = { ctrl: false, alt: false, shift: false };
    let key = '';
    for (const p of raw) {
      const low = p.toLowerCase();
      if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'command' || low === 'meta' || p === '⌘') mods.ctrl = true;
      else if (low === 'alt' || low === 'option' || p === '⌥') mods.alt = true;
      else if (low === 'shift' || p === '⇧') mods.shift = true;
      else key = p;
    }
    return { mods, key };
  }

  function comboKeyMatches(e, want) {
    const k = String(want || '').toLowerCase();
    if (!k) return false;
    const got = String(e.key || '').toLowerCase();
    if (k === 'space') return got === ' ' || got === 'space' || got === 'spacebar';
    return got === k;
  }

  function comboMatches(e, spec) {
    const { mods, key } = shortcutParts(spec);
    if (!key) return false;
    if (!mods.ctrl && !mods.alt && !mods.shift) return false; // 至少一个修饰键
    const ctrl = e.ctrlKey || e.metaKey; // Ctrl 与 Cmd 同等对待
    if (ctrl !== mods.ctrl || e.altKey !== mods.alt || e.shiftKey !== mods.shift) return false;
    return comboKeyMatches(e, key);
  }

  /** 快捷键命中时的输入框定位：事件目标 → 选区可编辑祖先 → activeElement */
  function fieldFromEvent(e) {
    const f = findField(e.target || document.activeElement);
    if (f) return f;
    const node = window.getSelection && window.getSelection().anchorNode;
    if (node) {
      const el = node.nodeType === 3 ? node.parentElement : node;
      const ce = el && el.closest && el.closest('[contenteditable]:not([contenteditable="false"])');
      if (ce && ce.isContentEditable) return { el: ce, type: 'ce' };
    }
    const a = document.activeElement;
    if (a && a.isContentEditable) {
      const ce = (a.closest && a.closest('[contenteditable]:not([contenteditable="false"])')) || a;
      return { el: ce, type: 'ce' };
    }
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (!state.settings.shortcutTranslateEnabled) return;
    if (e.isComposing || e.keyCode === 229 || e.repeat) return;
    if (!comboMatches(e, state.settings.inputShortcut || DEFAULT_INPUT_SHORTCUT)) return;
    if (domainIgnored() || state.site.disabled) return;
    const field = fieldFromEvent(e);
    if (!field || state.busyFields.has(field.el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    onTripleSpace(field);
  }, true);

  /* ---------------- 功能二：划词翻译 ---------------- */

  let iconEl = null;
  let bubbleEl = null;
  let bubbleId = null;
  let bubbleReqId = null;
  let scrollRaf = 0;

  function hideSelectionIcon() {
    if (iconEl) { iconEl.remove(); iconEl = null; }
  }

  function closeBubble() {
    if (bubbleReqId) {
      callBackground({ type: 'cancel', id: bubbleReqId });
      bubbleReqId = null;
    }
    if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; }
    document.removeEventListener('keydown', onDocKeydown, true);
    window.removeEventListener('scroll', onWindowScroll, { capture: true });
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') { closeBubble(); hideSelectionIcon(); }
  }

  function onWindowScroll() {
    // 滚动只收起图标；已打开的气泡保持常驻，并跟随原选区重新定位
    hideSelectionIcon();
    if (!bubbleEl || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!bubbleEl) return;
      const rect = currentSelectionRect();
      if (rect && state.selection) state.selection.lastRect = rect;
      positionBubble(bubbleEl);
    });
  }

  /** 取选区当前在视口中的位置（Range 会跟随文档滚动，即使选区已被浏览器清掉） */
  function currentSelectionRect() {
    const range = state.selection && state.selection.range;
    if (!range) return null;
    try {
      const rects = range.getClientRects();
      if (rects.length) {
        const last = rects[rects.length - 1];
        if (last && last.width > 0) return { left: last.left, right: last.right, top: last.top, bottom: last.bottom };
      }
      const box = range.getBoundingClientRect();
      if (box && (box.width || box.height)) {
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }
    } catch (e) { /* 节点被页面重渲染后 Range 可能失效 */ }
    return null;
  }

  function isEditableSelection(sel) {
    const node = sel.anchorNode;
    if (!node) return false;
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return false;
    return !!(el.closest('[contenteditable]:not([contenteditable="false"])') ||
      el.closest('input, textarea, [role="textbox"]'));
  }

  function placementRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(sel.rangeCount - 1);
    const rects = range.getClientRects();
    if (!rects.length) return null;
    const last = rects[rects.length - 1];
    if (!last || last.width <= 0) return null;
    return { left: last.left, right: last.right, top: last.top, bottom: last.bottom };
  }

  function showSelectionIcon(text, rect) {
    hideSelectionIcon();
    const r = ui.ensure();
    iconEl = document.createElement('div');
    iconEl.className = 'icon';
    iconEl.textContent = '译';
    iconEl.title = '翻译选中内容';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + 8;
    let top = rect.bottom + 8;
    if (left + 30 > vw - 6) left = rect.left - 38;
    if (left < 6) left = Math.max(6, rect.left);
    if (top + 30 > vh - 6) top = Math.max(6, rect.top - 38);
    // 选区在视口外（如程序化选中）时，把图标钳制回可视区域
    left = Math.min(Math.max(6, left), vw - 36);
    top = Math.min(Math.max(6, top), vh - 36);
    iconEl.style.left = `${left}px`;
    iconEl.style.top = `${top}px`;
    iconEl.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    iconEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.lastIconClickAt = performance.now();
      hideSelectionIcon();
      openBubble(text);
    });
    r.appendChild(iconEl);

    // 记录选区的 Range 副本，供气泡滚动跟随时重新定位
    let range = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) range = sel.getRangeAt(sel.rangeCount - 1).cloneRange();
    } catch (e) { /* ignore */ }
    state.selection = { text, rect, range, lastRect: rect };
  }

  function openBubble(text) {
    // 单实例：已有气泡时直接替换内容，不会叠出第二个
    closeBubble();
    const r = ui.ensure();
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'bubble';
    bubbleEl.style.visibility = 'hidden';
    bubbleEl.style.left = '0px';
    bubbleEl.style.top = '0px';

    const dir = resolveDirection(text, null, followSrcLang());
    bubbleEl.innerHTML = '';

    const hd = document.createElement('div');
    hd.className = 'hd';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = dir.err ? '无法识别语言' : dir.label;
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '常驻 · 关闭按钮 / Esc 收起';
    const cacheChip = document.createElement('span');
    cacheChip.className = 'cache-chip';
    hd.appendChild(tag);
    hd.appendChild(pin);
    hd.appendChild(cacheChip);
    bubbleEl.appendChild(hd);

    const body = document.createElement('div');
    body.className = 'body';
    bubbleEl.appendChild(body);

    const ft = document.createElement('div');
    ft.className = 'ft';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy';
    copyBtn.textContent = '复制';
    copyBtn.disabled = true;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => closeBubble());
    ft.appendChild(copyBtn);
    ft.appendChild(closeBtn);
    bubbleEl.appendChild(ft);

    copyBtn.addEventListener('click', async () => {
      const t = body.dataset.text || '';
      if (!t) return;
      let ok = false;
      try { await navigator.clipboard.writeText(t); ok = true; } catch (e) { ok = false; }
      if (!ok) {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
      }
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      if (!ok) ui.toast('复制失败，请手动选择译文复制', { type: 'err', duration: 2600 });
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });

    r.appendChild(bubbleEl);
    positionBubble(bubbleEl);

    if (dir.err) {
      body.className = 'body empty';
      body.textContent = dir.err === 'empty' ? '请先选中内容' : '无法识别选中内容的语言';
      document.addEventListener('keydown', onDocKeydown, true);
      window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true });
      return;
    }

    body.className = 'body empty';
    body.textContent = '翻译中…';

    const id = `trf-sel-${++state.seq}-${Math.random().toString(36).slice(2, 7)}`;
    bubbleId = id;
    bubbleReqId = id;

    // 流式增量（后台节流推送）
    const onPartial = (partialText) => {
      if (!bubbleEl || bubbleId !== id || !partialText) return;
      body.className = 'body';
      body.textContent = partialText;
    };
    pendingPartialHandler = onPartial;

    document.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true });

    (async () => {
      let dirForText = dir;
      const units = splitIntoUnits(text, state.settings.batchChars, state.settings.batchParagraphs);
      try {
        let out = '';
        let cachedTotal = 0;
        let cacheMs = 0;
        for (const unit of units) {
          if (bubbleId !== id) return;
          const r = await requestBatch(unit, dirForText, { push: true });
          cachedTotal += r.cached;
          cacheMs = Math.max(cacheMs, r.cacheMs);
          out = out ? `${out}\n\n${r.parts.join('\n\n')}` : r.parts.join('\n\n');
        }
        if (!bubbleEl || bubbleId !== id) return;
        bubbleId = null;
        bubbleReqId = null;
        body.className = 'body';
        body.textContent = out;
        body.dataset.text = out;
        copyBtn.disabled = false;
        if (cachedTotal > 0) {
          cacheChip.textContent = `缓存 · ${(cacheMs / 1000).toFixed(2)}s`;
          cacheChip.classList.add('on');
        }
        positionBubble(bubbleEl);
      } catch (e) {
        if (!bubbleEl || bubbleId !== id) return;
        bubbleId = null;
        bubbleReqId = null;
        body.className = 'body empty';
        body.textContent = e.code === 'disconnected' ? DISCONNECTED_HINT
          : e.code === 'aborted' ? '已中止'
            : `翻译失败：${e.message || '未知错误'}`;
        positionBubble(bubbleEl);
      }
    })();
  }

  let pendingPartialHandler = null;

  /**
   * 气泡定位：始终跟随原选区在文档中的位置（Range 副本，选区被清掉后依然有效）。
   * 选区滚出视口时吸附到视口边缘，气泡本身永不因此消失。
   */
  function positionBubble(el) {
    if (!el) return;
    el.style.visibility = 'hidden';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const box = el.getBoundingClientRect();
    const w = Math.min(box.width || 320, vw - 16);
    const h = box.height || 120;
    const clampX = (v) => Math.max(8, Math.min(v, Math.max(8, vw - w - 8)));

    const rect = currentSelectionRect() || (state.selection && state.selection.lastRect) || null;
    let left;
    let top;
    if (!rect) {
      left = clampX((vw - w) / 2);
      top = Math.max(8, vh / 2 - h / 2);
    } else if (rect.bottom < 0) {
      // 选区滚到视口上方：贴顶显示
      left = clampX(rect.left);
      top = 8;
    } else if (rect.top > vh) {
      // 选区滚到视口下方：贴底显示
      left = clampX(rect.left);
      top = Math.max(8, vh - h - 8);
    } else {
      left = rect.left;
      top = rect.bottom + 10;
      if (left + w > vw - 8) left = Math.max(8, rect.right - w);
      if (top + h > vh - 8) top = Math.max(8, rect.top - h - 10);
    }

    el.style.left = `${clampX(left)}px`;
    el.style.top = `${Math.max(8, Math.min(top, Math.max(8, vh - h - 8)))}px`;
    el.style.visibility = 'visible';
  }

  document.addEventListener('mouseup', (e) => {
    if (!state.settings.selectionEnabled || domainIgnored()) return;
    if (ui.inUi(e.target)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (ui.hostEl() && path.includes(ui.hostEl())) return;

    setTimeout(() => {
      // 刚点过图标时不要重建图标（点击图标本身也会触发 mouseup）
      if (performance.now() - (state.lastIconClickAt || 0) < 150) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelectionIcon(); return; }
      if (isEditableSelection(sel)) { hideSelectionIcon(); return; }
      const text = String(sel.toString() || '').replace(/\u00a0/g, ' ').trim();
      if (!text) { hideSelectionIcon(); return; }
      if (text.length > 2000) {
        ui.toast(`选中内容过长（${text.length} 字），请控制在 2000 字以内`, { type: 'err', duration: 3000 });
        hideSelectionIcon();
        return;
      }
      const rect = placementRect();
      if (!rect) return;
      // 已打开的气泡不动：这里只重建「译」图标（新气泡会替换旧气泡）
      showSelectionIcon(text, rect);
    }, 0);
  });

  document.addEventListener('pointerdown', (e) => {
    if (ui.inUi(e.target)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (ui.hostEl() && path.includes(ui.hostEl())) return;
    // 只收起图标；已打开的气泡不因点击外部而关闭（关闭仅靠气泡内按钮或 Esc）
    if (iconEl && !ui.inUi(e.target)) hideSelectionIcon();
  }, true);

  /* ---------------- 功能三：整页翻译 ---------------- */

  const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DD', 'DT',
    'BLOCKQUOTE', 'FIGCAPTION', 'DIV', 'UL', 'OL', 'DL', 'ARTICLE', 'SECTION', 'ASIDE', 'HEADER',
    'FOOTER', 'MAIN', 'NAV', 'FORM', 'LABEL', 'TR', 'CAPTION']);

  function findBlock(el) {
    let cur = el;
    let depth = 0;
    while (cur && depth < 10) {
      if (cur === document.body || cur === document.documentElement) return null;
      const tag = cur.tagName;
      if (BLOCK_TAGS.has(tag)) return cur;
      let display = '';
      try { display = getComputedStyle(cur).display; } catch (e) { display = ''; }
      if (display && !['inline', 'contents', 'inline-block', 'inline-flex', 'inline-grid', 'table-row-group'].includes(display)) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.getClientRects().length > 0;
    } catch (e) {
      return false;
    }
  }

  function looksLikeNoise(text) {
    if (text.length < 2) return true;
    if (!/\p{L}/u.test(text)) return true;               // 纯数字/符号
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return true; // 纯 URL
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return true; // 纯邮箱
    return false;
  }

  /** 收集本页可翻译段落，返回 [{el, text}]，并打上 data-trf=pending 防止重复 */
  function collectParagraphs(root) {
    const records = [];
    if (!root || !document.body) return records;
    const blockCache = new Map();
    const blockedCache = new Map();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let blocked = blockedCache.get(parent);
        if (blocked === undefined) {
          blocked = !!parent.closest(SKIP_SELECTOR);
          blockedCache.set(parent, blocked);
        }
        return blocked ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    const map = new Map();
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      let block = blockCache.get(parent);
      if (block === undefined) {
        block = findBlock(parent);
        blockCache.set(parent, block);
      }
      if (!block || block.hasAttribute('data-trf')) continue;
      if (!isVisible(block)) continue;
      let rec = map.get(block);
      if (!rec) { rec = { el: block, text: '' }; map.set(block, rec); }
      const raw = node.nodeValue;
      if (rec.text && /[A-Za-z0-9]$/.test(rec.text) && /^[A-Za-z0-9]/.test(raw)) rec.text += ' ';
      rec.text += raw;
    }

    for (const [el, rec] of map) {
      const text = rec.text.replace(/\s+/g, ' ').trim();
      if (!text || looksLikeNoise(text)) continue;
      if (el.textContent.trim().length === 0) continue;
      el.setAttribute('data-trf', 'pending');
      records.push({ el, text });
    }
    return records;
  }

  function makeTrSpan(text) {
    const span = document.createElement('span');
    span.className = 'trf-tr-block';
    span.setAttribute('data-trf', 'tr');
    span.setAttribute('translate', 'no');
    span.textContent = text;
    span.style.cssText = Object.entries(DEFAULT_BLOCK_STYLE).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';');
    return span;
  }

  function renderParagraphs(recs, outs) {
    recs.forEach((rec, i) => {
      const txt = outs[i];
      if (!txt) return;
      if (state.settings.pageMode === 'target') {
        const orig = document.createElement('span');
        orig.setAttribute('data-trf', 'orig');
        orig.className = 'trf-orig-hidden';
        orig.style.display = 'none';
        while (rec.el.firstChild) orig.appendChild(rec.el.firstChild);
        rec.el.appendChild(orig);
      }
      rec.el.appendChild(makeTrSpan(txt));
      rec.el.setAttribute('data-trf', 'done');
      state.page.hasTranslations = true;
    });
  }

  function buildJob() {
    const q = state.page.queue;
    if (!q.length) return null;
    const limitChars = Math.max(200, Number(state.settings.batchChars) || 800);
    const limitParas = Math.max(1, Number(state.settings.batchParagraphs) || 6);

    if (q[0].text.length > limitChars) {
      const rec = q.shift();
      return { paras: [rec], chunked: true };
    }
    const paras = [];
    let chars = 0;
    while (q.length && paras.length < limitParas) {
      const rec = q[0];
      if (rec.text.length > limitChars) break;
      if (chars + rec.text.length + 2 > limitChars && paras.length) break;
      q.shift();
      paras.push(rec);
      chars += rec.text.length + 2;
    }
    return paras.length ? { paras, chunked: false } : null;
  }

  function statusBar() {
    const r = ui.ensure();
    let bar = r.querySelector('.stat');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'stat';
      bar.innerHTML = `<div class="row"><span class="title">整页翻译</span>
        <span class="count">已译 0/0 段</span><button class="btn">中止</button></div>
        <div class="bar"><i></i></div><div class="note"></div>`;
      bar.querySelector('.btn').addEventListener('click', () => {
        stopPageTranslation('已中止');
      });
      r.appendChild(bar);
    }
    return bar;
  }

  function updateStatus(extra = {}) {
    const bar = statusBar();
    clearTimeout(state.page.hideTimer);
    bar.classList.remove('hide');
    const count = bar.querySelector('.count');
    const note = bar.querySelector('.note');
    const fill = bar.querySelector('.bar i');
    const done = state.page.done;
    const total = Math.max(state.page.total, done);
    count.textContent = `已译 ${done}/${total} 段`;
    fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
    const cacheNote = state.page.cached ? `缓存命中 ${state.page.cached} 段 · ${(state.page.cacheMs / 1000).toFixed(2)}s` : '';
    if (extra.note) {
      note.className = 'note on' + (extra.error ? ' err' : '');
      note.textContent = extra.note + (cacheNote ? ` · ${cacheNote}` : '');
    } else if (state.page.failed) {
      note.className = 'note on';
      note.textContent = `失败 ${state.page.failed} 段（已跳过）` + (cacheNote ? ` · ${cacheNote}` : '');
    } else if (cacheNote) {
      note.className = 'note on';
      note.textContent = cacheNote;
    } else {
      note.className = 'note';
      note.textContent = '';
    }
    updateCardProgress({ note: extra.note, error: extra.error });
    if (extra.hideIn) {
      clearTimeout(state.page.hideTimer);
      state.page.hideTimer = setTimeout(() => {
        bar.classList.add('hide');
        updateCardProgress();
        closeCard();
      }, extra.hideIn);
    }
  }

  async function runJob(job) {
    const recs = job.paras;
    try {
      let outs;
      if (job.chunked) {
        const r = await translateLong(recs[0].text, state.page.dir);
        outs = [r.parts.join('\n\n')];
        state.page.cached += r.cached;
        state.page.cacheMs = Math.max(state.page.cacheMs, r.cacheMs);
      } else {
        const r = await requestBatch(recs.map((x) => x.text), state.page.dir);
        outs = r.parts;
        state.page.cached += r.cached;
        state.page.cacheMs = Math.max(state.page.cacheMs, r.cacheMs);
      }
      if (!state.page.active) return;
      renderParagraphs(recs, outs);
      state.page.done += recs.length;
      updateStatus();
    } catch (e) {
      state.page.failed += recs.length;
      updateStatus();
      if (e.code === 'disconnected') {
        stopPageTranslation(DISCONNECTED_HINT, true);
        throw e;
      }
      if (e.code === 'aborted') throw e;
    }
  }

  async function drainQueue() {
    if (state.page.draining) return;
    state.page.draining = true;
    const conc = Math.min(2, Math.max(1, Number(state.settings.concurrency) || 1));
    const workers = [];
    for (let i = 0; i < conc; i++) {
      workers.push((async () => {
        while (state.page.active && !state.page.stopped) {
          const job = buildJob();
          if (!job) break;
          try { await runJob(job); } catch (e) { break; }
        }
      })());
    }
    await Promise.all(workers);
    state.page.draining = false;

    if (state.page.active && !state.page.stopped) {
      if (state.page.queue.length) { drainQueue(); return; }
      updateStatus({ note: '翻译完成', hideIn: 3000 });
    }
  }

  function stopPageTranslation(note, isError = false) {
    state.page.stopped = true;
    state.page.active = false;
    for (const id of state.page.inflightIds) callBackground({ type: 'cancel', id });
    state.page.inflightIds.clear();
    updateStatus({ note, error: isError, hideIn: isError ? 0 : 2500 });
  }

  function startPageTranslation(target) {
    if (state.page.active) return;
    if (state.site.disabled || domainIgnored()) {
      ui.toast('扩展在当前网站已禁用，可在面板里重新开启', { type: 'err' });
      return;
    }
    const recs = collectParagraphs(document.body);
    if (!recs.length) {
      ui.toast('本页没有可翻译的正文', { type: 'err' });
      return;
    }
    const sample = recs.slice(0, 3).map((r) => r.text).join('\n\n').slice(0, 800);
    const dir = resolveDirection(sample, target || state.settings.targetLang || 'zh-Hans',
      state.settings.sourceLang || 'auto');
    if (dir.err || !dir) {
      ui.toast('无法识别页面语言', { type: 'err' });
      return;
    }

    state.page.active = true;
    state.page.stopped = false;
    state.page.queue = [];
    state.page.total = 0;
    state.page.done = 0;
    state.page.failed = 0;
    state.page.cached = 0;
    state.page.cacheMs = 0;
    state.page.hasTranslations = false;
    state.page.dir = dir;

    state.page.queue.push(...recs);
    state.page.total = recs.length;
    updateStatus();
    updateBall();
    updateCard();
    startObserver();
    drainQueue();
  }

  function translatePageWithTarget() {
    startPageTranslation(state.settings.targetLang || 'zh-Hans');
  }

  function restorePage(opts = {}) {
    state.page.stopped = true;
    state.page.active = false;
    state.page.draining = false;
    state.page.queue = [];
    for (const id of state.page.inflightIds) callBackground({ type: 'cancel', id });
    state.page.inflightIds.clear();
    clearTimeout(state.page.hideTimer);
    if (state.page.observer) {
      state.page.observer.disconnect();
      state.page.observer = null;
    }
    clearTimeout(state.page.scanTimer);

    // 先还原「仅译文」模式下的原文副本
    document.querySelectorAll('[data-trf="orig"]').forEach((orig) => {
      const parent = orig.parentElement;
      if (!parent) { orig.remove(); return; }
      while (orig.firstChild) parent.insertBefore(orig.firstChild, orig);
      orig.remove();
    });
    // 再移除译文块
    document.querySelectorAll('[data-trf="tr"]').forEach((el) => el.remove());
    // 最后清掉标记
    document.querySelectorAll('[data-trf]').forEach((el) => el.removeAttribute('data-trf'));

    state.page.hasTranslations = false;
    state.page.total = 0;
    state.page.done = 0;
    state.page.failed = 0;
    state.page.cached = 0;
    state.page.cacheMs = 0;
    const bar = ui.ensure().querySelector('.stat');
    if (bar) bar.remove();
    updateBall();
    updateCard();
    if (!opts.silent) ui.toast('已还原原文', { duration: 1600 });
  }

  function togglePage() {
    if (state.site.disabled) {
      ui.toast('扩展在当前网站已禁用，可在面板里重新开启', { type: 'err' });
      return;
    }
    if (domainIgnored()) {
      ui.toast('当前域名在忽略列表中，未执行翻译', { type: 'err' });
      return;
    }
    if (state.page.active || state.page.hasTranslations) restorePage();
    else translatePageWithTarget();
  }

  function scanAndQueue() {
    if (!state.page.active || state.page.stopped) return;
    const recs = collectParagraphs(document.body);
    if (!recs.length) return;
    state.page.queue.push(...recs);
    state.page.total += recs.length;
    updateStatus();
    drainQueue();
  }

  function startObserver() {
    if (state.page.observer) return;
    state.page.observer = new MutationObserver(() => {
      if (!state.page.active || state.page.stopped) return;
      clearTimeout(state.page.scanTimer);
      state.page.scanTimer = setTimeout(scanAndQueue, 300); // 节流 300ms
    });
    state.page.observer.observe(document.body, { childList: true, subtree: true });
  }

  function togglePage() {
    if (domainIgnored()) {
      ui.toast('当前域名在忽略列表中，未执行翻译', { type: 'err' });
      return;
    }
    if (state.page.active || state.page.hasTranslations) restorePage();
    else startPageTranslation();
  }

  /* ---------------- 后台消息 ---------------- */

  function pageState() {
    const info = state.pageLang || pageLangInfo();
    return {
      ok: true,
      active: state.page.active,
      hasTranslations: state.page.hasTranslations,
      done: state.page.done,
      total: state.page.total,
      failed: state.page.failed,
      cached: state.page.cached,
      langCode: info ? info.code : null,
      langLabel: info ? info.label : null,
      targetLang: state.settings.targetLang || 'zh-Hans',
      site: { ...state.site },
      disabled: state.site.disabled || domainIgnored()
    };
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'toggle-page') {
        togglePage();
        setTimeout(() => sendResponse(pageState()), 30);
        return true;
      }
      if (msg.type === 'get-state') {
        sendResponse(pageState());
        return false;
      }
      if (msg.type === 'set-site-pref') {
        const patch = msg.patch || {};
        const clean = {};
        for (const k of ['disabled', 'neverPrompt', 'alwaysTranslate']) {
          if (typeof patch[k] === 'boolean') clean[k] = patch[k];
        }
        saveSitePrefs(clean);
        sendResponse(pageState());
        return false;
      }
      if (msg.type === 'tr-partial') {
        if (typeof pendingPartialHandler === 'function') pendingPartialHandler(msg.text);
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'page-state') {
        sendResponse(pageState());
        return false;
      }
      return false;
    });
  } catch (e) { /* ignore */ }

  loadSettings();
  loadSitePrefsAndBall();
})();
