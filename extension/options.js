/* 设置页逻辑：读写 chrome.storage.sync，连接测试，快捷键展示 */
'use strict';

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8080',
  model: 'hy-mt2',
  temperature: 0.3,
  timeoutSec: 60,
  directionMode: 'auto',
  tripleSpaceEnabled: true,
  tripleSpaceWindowMs: 800,
  shortcutTranslateEnabled: true,
  inputShortcut: 'Ctrl+Shift+Enter',
  debugFill: false,
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
  cacheTTL: 30
};

/* 保存前校验：URL 只收 http/https 且必须有主机名；模型名不能为空；key 只去首尾空白 */
const VALIDATORS = {
  endpoint(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: '服务地址不能为空' };
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      return { ok: false, error: '服务地址不是合法 URL' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只支持 http 或 https 地址' };
    if (!u.hostname) return { ok: false, error: '服务地址缺少主机名' };
    return { ok: true, value: s };
  },
  model(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: '模型名不能为空' };
    return { ok: true, value: s };
  }
};

const FIELDS = Object.keys(DEFAULTS);
const saveDot = document.getElementById('saveDot');
const testResult = document.getElementById('testResult');
let saveTimer = null;

function flashSaved() {
  saveDot.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDot.classList.remove('show'), 1400);
}

function readControl(key) {
  const el = document.getElementById(key);
  if (!el) return undefined;
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return el.value;
}

function writeControl(key, value) {
  const el = document.getElementById(key);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value === undefined || value === null ? '' : value;
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (got) => {
    const s = { ...DEFAULTS, ...got };
    FIELDS.forEach((k) => writeControl(k, s[k]));
    updateShortcut();
    updateInputShortcutUI(s.inputShortcut);
  });
}

/* ---------------- API Key：只存 chrome.storage.local，界面只露末 4 位 ---------------- */

const keyInput = document.getElementById('apiKey');
const keyMask = document.getElementById('apiKeyMask');
const toggleKeyBtn = document.getElementById('toggleKey');
let apiKeyRaw = '';
let keyRevealed = false;

function maskKey(k) {
  if (!k) return '';
  return k.length <= 4 ? '••••' : '••••' + k.slice(-4);
}

function renderKey() {
  const has = !!apiKeyRaw;
  if (!has) {
    keyRevealed = false;
    keyInput.style.display = '';
    keyInput.type = 'password';
    keyInput.value = '';
    keyMask.hidden = true;
    toggleKeyBtn.textContent = '显示';
    return;
  }
  if (keyRevealed) {
    keyInput.style.display = '';
    keyInput.type = 'text';
    keyInput.value = apiKeyRaw;
    keyMask.hidden = true;
    toggleKeyBtn.textContent = '隐藏';
    return;
  }
  keyInput.style.display = 'none';
  keyMask.textContent = maskKey(apiKeyRaw);
  keyMask.hidden = false;
  toggleKeyBtn.textContent = '显示';
}

function saveKey(raw) {
  const clean = String(raw == null ? '' : raw).trim();
  apiKeyRaw = clean;
  return new Promise((resolve) => {
    chrome.storage.local.set({ apiKey: clean }, () => {
      if (chrome.runtime.lastError) {
        testResult.textContent = `保存失败：${chrome.runtime.lastError.message}`;
        testResult.className = 'result err';
        resolve(false);
        return;
      }
      flashSaved();
      resolve(true);
    });
  });
}

keyInput.addEventListener('change', () => { saveKey(keyInput.value).then(renderKey); });
keyInput.addEventListener('blur', () => { if (!keyRevealed) renderKey(); });

keyMask.addEventListener('click', () => {
  keyInput.style.display = '';
  keyMask.hidden = true;
  keyInput.type = 'password';
  keyInput.focus();
  keyInput.setSelectionRange(keyInput.value.length, keyInput.value.length);
});

toggleKeyBtn.addEventListener('click', () => {
  if (keyInput.style.display !== 'none') apiKeyRaw = keyInput.value.trim();
  if (!apiKeyRaw) {
    testResult.textContent = '当前没有 Key，直接输入即可';
    testResult.className = 'result muted';
    return;
  }
  keyRevealed = !keyRevealed;
  renderKey();
});

document.getElementById('clearKeyBtn').addEventListener('click', () => {
  chrome.storage.local.remove('apiKey', () => {
    apiKeyRaw = '';
    keyRevealed = false;
    renderKey();
    testResult.textContent = '已清除本机存储的 API Key';
    testResult.className = 'result ok';
  });
});

chrome.storage.local.get({ apiKey: '' }, (got) => {
  apiKeyRaw = String(got.apiKey || '').trim();
  renderKey();
});

function saveOne(key) {
  let value = readControl(key);
  if (value === undefined) return;
  const v = VALIDATORS[key];
  if (v) {
    const r = v(value);
    if (!r.ok) {
      testResult.textContent = r.error;
      testResult.className = 'result err';
      return;
    }
    value = r.value;
  }
  chrome.storage.sync.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      testResult.textContent = `保存失败：${chrome.runtime.lastError.message}`;
      testResult.className = 'result err';
      return;
    }
    flashSaved();
  });
}

FIELDS.forEach((key) => {
  const el = document.getElementById(key);
  if (!el) return;
  // 地址与模型名需要校验，只在提交时保存，避免输入过程中反复报错
  if (VALIDATORS[key]) {
    el.addEventListener('change', () => saveOne(key));
    return;
  }
  const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(evt, () => saveOne(key));
  if (evt === 'input') el.addEventListener('change', () => saveOne(key));
});

function updateShortcut() {
  const label = document.getElementById('shortcutText');
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((cmds) => {
    const c = (cmds || []).find((x) => x.name === 'translate-page');
    if (c && c.shortcut) label.textContent = c.shortcut.replace(/Option/g, 'Alt');
  });
}

document.getElementById('shortcutLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

/* ---------------- 输入框翻译快捷键录制 ---------------- */

const DEFAULT_INPUT_SHORTCUT = 'Ctrl+Shift+Enter';
const PAGE_SHORTCUT = 'Alt+T';
const shortcutTextEl = document.getElementById('inputShortcutText');
const recordBtn = document.getElementById('recordShortcut');
const resetShortcutBtn = document.getElementById('resetShortcut');
const shortcutResultEl = document.getElementById('shortcutResult');
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
let recordingShortcut = false;
let recordHintTimer = null;

function comboParts(spec) {
  const raw = String(spec || '').split('+').map((s) => s.trim()).filter(Boolean);
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

function canonCombo(spec) {
  const { mods, key } = comboParts(spec);
  if (!key) return '';
  const out = [];
  if (mods.ctrl) out.push('Ctrl');
  if (mods.alt) out.push('Alt');
  if (mods.shift) out.push('Shift');
  out.push(key);
  return out.join('+');
}

function prettyCombo(spec) {
  const { mods, key } = comboParts(spec);
  if (!key) return DEFAULT_INPUT_SHORTCUT;
  if (isMac) {
    return [mods.ctrl ? '⌘' : null, mods.alt ? '⌥' : null, mods.shift ? '⇧' : null, key].filter(Boolean).join(' ');
  }
  return [mods.ctrl ? 'Ctrl' : null, mods.alt ? 'Alt' : null, mods.shift ? 'Shift' : null, key]
    .filter(Boolean).join(' + ');
}

function keyLabel(e) {
  const k = String(e.key || '');
  if (!k || k === 'Unidentified') return '';
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  if (/^F\d{1,2}$/i.test(k)) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function setShortcutResult(text, kind) {
  shortcutResultEl.textContent = text;
  shortcutResultEl.className = 'tip' + (kind ? ' ' + kind : '');
}

function updateInputShortcutUI(spec) {
  const canon = canonCombo(spec) || DEFAULT_INPUT_SHORTCUT;
  shortcutTextEl.textContent = prettyCombo(canon);
  const platformEl = document.getElementById('shortcutPlatform');
  if (platformEl) platformEl.textContent = isMac ? 'macOS 上显示为 ⌘；Ctrl 与 Cmd 均可触发' : 'Ctrl 与 Cmd 均可触发';
}

function stopRecord(hint) {
  recordingShortcut = false;
  clearTimeout(recordHintTimer);
  window.removeEventListener('keydown', onRecordKey, true);
  recordBtn.textContent = '修改快捷键';
  recordBtn.classList.remove('recording');
  if (hint) setShortcutResult(hint, 'ok');
}

function startRecord() {
  if (recordingShortcut) { stopRecord('已取消录制'); return; }
  recordingShortcut = true;
  recordBtn.textContent = '按下组合键…（Esc 取消）';
  recordBtn.classList.add('recording');
  setShortcutResult('请按「修饰键 + 主键」，例如 Ctrl+Shift+Enter 或 Alt+Q');
  window.addEventListener('keydown', onRecordKey, true);
}

function onRecordKey(e) {
  if (!recordingShortcut) return;
  if (['Control', 'Meta', 'Alt', 'Shift', 'OS', 'CapsLock'].includes(e.key)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return; // 只按修饰键不结束录制，等主键
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    stopRecord('已取消录制，快捷键未修改');
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();

  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyLabel(e);

  if (!mods.length) {
    stopRecord();
    setShortcutResult('必须至少包含一个修饰键（Ctrl/Cmd、Alt 或 Shift），单个按键容易误触，未保存', 'err');
    return;
  }
  if (!key) {
    stopRecord();
    setShortcutResult('无法识别这个按键，请换一个组合', 'err');
    return;
  }

  const combo = canonCombo(mods.join('+') + '+' + key);
  if (combo === canonCombo(PAGE_SHORTCUT)) {
    stopRecord();
    setShortcutResult('与整页翻译快捷键 Alt+T 冲突，请换一个组合', 'err');
    return;
  }
  if (combo === canonCombo('Ctrl+Q') || combo === canonCombo('Ctrl+W') || combo === canonCombo('Ctrl+T') || combo === canonCombo('Ctrl+N')) {
    stopRecord();
    setShortcutResult('该组合被浏览器常用功能占用，请换一个组合', 'err');
    return;
  }

  chrome.storage.sync.set({ inputShortcut: combo }, () => {
    if (chrome.runtime.lastError) {
      stopRecord();
      setShortcutResult(`保存失败：${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    updateInputShortcutUI(combo);
    flashSaved();
    stopRecord(`已保存：${prettyCombo(combo)}，当前页面立即生效`);
  });
}

recordBtn.addEventListener('click', startRecord);

resetShortcutBtn.addEventListener('click', () => {
  if (recordingShortcut) stopRecord();
  chrome.storage.sync.set({ inputShortcut: DEFAULT_INPUT_SHORTCUT }, () => {
    updateInputShortcutUI(DEFAULT_INPUT_SHORTCUT);
    setShortcutResult(`已恢复默认快捷键：${prettyCombo(DEFAULT_INPUT_SHORTCUT)}`);
    flashSaved();
  });
});

document.getElementById('testBtn').addEventListener('click', () => {
  const btn = document.getElementById('testBtn');
  btn.disabled = true;
  testResult.textContent = '正在连接…';
  testResult.className = 'result';
  chrome.runtime.sendMessage({ type: 'test-connection' }, (res) => {
    btn.disabled = false;
    if (chrome.runtime.lastError || !res) {
      testResult.textContent = '无法与扩展后台通信，请重新加载扩展';
      testResult.className = 'result err';
      return;
    }
    if (res.ok) {
      const models = (res.models || []).join('、') || '未返回模型列表';
      const head = res.remote ? `已连接 · 远程 · ${res.model}` : `已连接 · ${res.model}`;
      testResult.textContent = res.hasModel
        ? `${head}（${res.endpoint}）`
        : `已连接，但服务里没有模型「${res.model}」（现有：${models}）`;
      testResult.className = res.hasModel ? 'result ok' : 'result err';
    } else if (res.code === 'auth') {
      testResult.textContent = 'API Key 无效或未授权';
      testResult.className = 'result err';
    } else {
      testResult.textContent = `连接失败：${res.error}`;
      testResult.className = 'result err';
    }
  });
});

document.getElementById('resetBtn').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => {
    FIELDS.forEach((k) => writeControl(k, DEFAULTS[k]));
    chrome.storage.local.remove('apiKey', () => {
      apiKeyRaw = '';
      renderKey();
    });
    flashSaved();
    testResult.textContent = '已恢复默认设置（API Key 已清除）';
    testResult.className = 'result ok';
  });
});

load();

/* ---------------- 缓存统计 ---------------- */

const cacheStatsEl = document.getElementById('cacheStats');
const cacheResultEl = document.getElementById('cacheResult');

function fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function refreshCacheStats() {
  chrome.runtime.sendMessage({ type: 'cache-stats' }, (st) => {
    if (chrome.runtime.lastError || !st || !st.ok) {
      cacheStatsEl.textContent = '缓存服务不可用';
      return;
    }
    const rate = Math.round((st.hitRate || 0) * 100);
    cacheStatsEl.textContent =
      `${st.count} 条 · ${fmtBytes(st.bytes)} · 命中率 ${rate}%（命中 ${st.hits} / 未命中 ${st.misses}）· 最近清理：${fmtTime(st.lastClear)}`;
  });
}

document.getElementById('clearCacheBtn').addEventListener('click', () => {
  if (!confirm('确定清除全部翻译缓存？')) return;
  chrome.runtime.sendMessage({ type: 'cache-clear' }, (r) => {
    if (chrome.runtime.lastError || !r || !r.ok) {
      cacheResultEl.textContent = '清除失败';
      cacheResultEl.className = 'result err';
      return;
    }
    cacheResultEl.textContent = `已清除 ${r.removed || 0} 条缓存`;
    cacheResultEl.className = 'result ok';
    refreshCacheStats();
  });
});

refreshCacheStats();
setInterval(refreshCacheStats, 3000);
