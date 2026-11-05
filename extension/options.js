/* 设置页逻辑：读写 chrome.storage.sync，连接测试，快捷键展示 */
'use strict';

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

function saveOne(key) {
  const value = readControl(key);
  if (value === undefined) return;
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
      testResult.textContent = res.hasModel
        ? `已连接 · ${res.endpoint} · 模型 ${res.model}`
        : `已连接，但服务里没有模型「${res.model}」（现有：${models}）`;
      testResult.className = res.hasModel ? 'result ok' : 'result err';
    } else {
      testResult.textContent = `连接失败：${res.error}`;
      testResult.className = 'result err';
    }
  });
});

document.getElementById('resetBtn').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => {
    FIELDS.forEach((k) => writeControl(k, DEFAULTS[k]));
    flashSaved();
    testResult.textContent = '已恢复默认设置';
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
