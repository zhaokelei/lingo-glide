/* 工具栏 popup */
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

let tabId = null;
let pageState = null;
let pollTimer = 0;

const $ = (id) => document.getElementById(id);

function runtimeMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

function tabMsg(msg) {
  return new Promise((resolve) => {
    if (tabId == null) { resolve(null); return; }
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      tripleSpaceEnabled: true,
      selectionEnabled: true,
      floatButton: true,
      targetLang: 'zh-Hans',
      sourceLang: 'auto',
      autoPromptEnPage: true,
      shortcutTranslateEnabled: true,
      inputShortcut: 'Ctrl+Shift+Enter'
    }, resolve);
  });
}

function setSync(patch) {
  return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
}

function fillLangs() {
  const src = $('sourceLang');
  for (const t of SOURCE_LANGS) {
    const opt = document.createElement('option');
    opt.value = t.code;
    opt.textContent = t.label;
    src.appendChild(opt);
  }
  const sel = $('target');
  for (const t of TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.code;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
}

function tip(text, isErr) {
  const el = $('tip');
  el.textContent = text;
  el.className = 'tip show' + (isErr ? ' err' : '');
  setTimeout(() => { el.className = 'tip'; }, 2200);
}

async function refreshStatus() {
  const r = await runtimeMsg({ type: 'test-connection' });
  const dot = $('dot');
  const main = $('statusMain');
  const sub = $('statusSub');
  if (r && r.ok) {
    dot.className = 'dot ok';
    main.textContent = `已连接${r.model ? ' · ' + r.model : ''}`;
    sub.textContent = r.endpoint || '';
  } else {
    dot.className = 'dot err';
    main.textContent = '未连接';
    sub.textContent = (r && (r.endpoint || r.error)) || '本地服务未启动';
  }
}

function applySettings(s) {
  $('swTriple').checked = !!s.tripleSpaceEnabled;
  $('swSelection').checked = !!s.selectionEnabled;
  $('swBall').checked = !!s.floatButton;
  $('swAutoPrompt').checked = s.autoPromptEnPage !== false;
  $('sourceLang').value = s.sourceLang || 'auto';
  $('target').value = s.targetLang || 'zh-Hans';
  renderShortcutHint(s);
}

function prettyShortcut(spec) {
  const raw = String(spec || 'Ctrl+Shift+Enter').split('+').map((x) => x.trim()).filter(Boolean);
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const map = mac
    ? { ctrl: '⌘', control: '⌘', cmd: '⌘', meta: '⌘', alt: '⌥', option: '⌥', shift: '⇧' }
    : { ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Cmd', meta: 'Cmd', alt: 'Alt', option: 'Alt', shift: 'Shift' };
  return raw.map((p) => map[p.toLowerCase()] || p).join(mac ? ' ' : ' + ');
}

function renderShortcutHint(s) {
  const el = $('shortcutHint');
  if (!el) return;
  if (s.shortcutTranslateEnabled === false) {
    el.textContent = '输入框快捷键翻译已关闭（可在选项里开启）';
    return;
  }
  el.textContent = `输入框翻译：${prettyShortcut(s.inputShortcut)}（与三空格并存）`;
}

function renderState(s) {
  pageState = s;
  const main = $('mainBtn');
  const prog = $('progress');
  if (!s) {
    main.textContent = '翻译本页';
    main.disabled = true;
    prog.className = 'progress on';
    prog.textContent = '当前页面不可用，刷新页面后重试';
    $('swSiteOff').checked = false;
    $('swAlways').checked = false;
    return;
  }
  const translated = s.active || s.hasTranslations;
  main.disabled = !!s.disabled;
  main.textContent = translated ? '还原' : '翻译本页';

  $('swSiteOff').checked = !!s.site.disabled;
  $('swAlways').checked = !!s.site.alwaysTranslate;

  if (s.active) {
    prog.className = 'progress on';
    prog.textContent = `已译 ${s.done}/${Math.max(s.total, s.done)} 段${s.failed ? ` · 失败 ${s.failed} 段` : ''}${s.cached ? ` · 缓存 ${s.cached} 段` : ''}`;
  } else if (s.hasTranslations) {
    prog.className = 'progress on';
    prog.textContent = `已翻译${s.cached ? ` · 缓存命中 ${s.cached} 段` : ''} · 点击还原`;
  } else {
    prog.className = 'progress';
    prog.textContent = '';
  }

  if (s.targetLang && $('target').value !== s.targetLang) $('target').value = s.targetLang;
}

async function refreshState() {
  const s = await tabMsg({ type: 'get-state' });
  renderState(s);
}

function fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function refreshCache() {
  const st = await runtimeMsg({ type: 'cache-stats' });
  const el = $('cacheNum');
  if (!st || !st.ok) {
    el.textContent = '缓存不可用';
    return;
  }
  const rate = Math.round((st.hitRate || 0) * 100);
  el.textContent = `缓存 ${st.count} 条 · ${fmtBytes(st.bytes)} · 命中率 ${rate}%`;
}

async function init() {
  fillLangs();
  $('ver').textContent = chrome.runtime.getManifest().version;

  // 调试/测试时可显式指定标签页；真实弹窗不带参数，仍取当前活动页
  const forced = new URLSearchParams(location.search).get('tabId');
  if (forced) {
    tabId = Number(forced);
  } else {
    const tab = await getActiveTab();
    tabId = tab ? tab.id : null;
  }

  const s = await getSettings();
  applySettings(s);

  await refreshState();
  refreshStatus();
  refreshCache();

  $('retest').addEventListener('click', async () => {
    $('statusMain').textContent = '检测中…';
    await refreshStatus();
  });

  $('mainBtn').addEventListener('click', async () => {
    const r = await tabMsg({ type: 'toggle-page' });
    if (r) renderState(r);
    else tip('当前页面不可用，请刷新后重试', true);
    setTimeout(refreshState, 400);
  });

  $('sourceLang').addEventListener('change', async (e) => {
    await setSync({ sourceLang: e.target.value });
    tip('已切换源语言；整页翻译与卡片立即生效');
    refreshState();
  });

  $('target').addEventListener('change', async (e) => {
    await setSync({ targetLang: e.target.value });
    tip('已切换目标语言；如页面已翻译请先还原再翻译');
    refreshState();
  });

  $('swTriple').addEventListener('change', (e) => setSync({ tripleSpaceEnabled: e.target.checked }));
  $('swSelection').addEventListener('change', (e) => setSync({ selectionEnabled: e.target.checked }));
  $('swBall').addEventListener('change', (e) => setSync({ floatButton: e.target.checked }));
  $('swAutoPrompt').addEventListener('change', (e) => setSync({ autoPromptEnPage: e.target.checked }));

  $('swSiteOff').addEventListener('change', async (e) => {
    const r = await tabMsg({ type: 'set-site-pref', patch: { disabled: e.target.checked } });
    if (r) renderState(r);
    else tip('当前页面不可用', true);
  });

  $('swAlways').addEventListener('change', async (e) => {
    const r = await tabMsg({ type: 'set-site-pref', patch: { alwaysTranslate: e.target.checked } });
    if (r) renderState(r);
    else tip('当前页面不可用', true);
  });

  $('clearCache').addEventListener('click', async () => {
    if (!confirm('确定清除全部翻译缓存？')) return;
    const r = await runtimeMsg({ type: 'cache-clear' });
    if (r && r.ok) {
      tip(`已清除 ${r.removed || 0} 条缓存`);
      refreshCache();
    } else {
      tip('清除失败', true);
    }
  });

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!changes.inputShortcut && !changes.shortcutTranslateEnabled) return;
    getSettings().then(renderShortcutHint);
  });

  pollTimer = setInterval(() => { refreshState(); refreshCache(); }, 900);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

init();
