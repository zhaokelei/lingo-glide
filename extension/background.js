/* 本地翻译扩展 - 后台 Service Worker
 * 职责：所有网络请求（避免 content script 的 CORS 限制）、全局低并发队列、
 *       SSE 流式解析、超时与中止、右键菜单、快捷键、连接测试。
 */
'use strict';

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8080/v1',
  model: 'hy-mt2',
  temperature: 0.3,
  timeoutSec: 60,
  directionMode: 'auto',
  tripleSpaceEnabled: true,
  tripleSpaceWindowMs: 800,
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

const DISCONNECTED_HINT = '本地翻译服务未连接，请先双击桌面『启动翻译模型.command』';
const CORS_HINT = '服务未允许来自扩展的跨域请求';

const SYSTEM_PROMPT = [
  '你是专业翻译引擎，严格遵守以下规则：',
  '1. 只输出译文，不要解释、注释、前缀、引号或语言标签。',
  '2. 保持段落结构：输入用空行分段，输出必须用空行分段，段数必须与输入完全一致。',
  '3. 代码、URL、邮箱、文件路径、变量名、型号、品牌、人名地名保持原样。',
  '4. 术语前后统一；没有通行译名的术语保留原文并用括号附注。',
  '5. 不增删、不总结、不合并段落、不拆分段落。',
  '6. 目标语言为中文时，简体输出简体、繁体输出繁体，不要混用。',
  '7. 译文要地道自然，符合目标语言的表达习惯。'
].join('\n');

const SRC_NAMES = {
  zh: '中文', 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文',
  en: '英文', ja: '日文', ko: '韩文', ru: '俄文',
  fr: '法文', de: '德文', es: '西班牙文', ar: '阿拉伯文', th: '泰文', other: '原文'
};
const TARGET_NAMES = {
  'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: '地道、自然的英文',
  ja: '日语', ko: '韩语', ru: '俄语', fr: '法语', de: '德语', es: '西班牙语', ar: '阿拉伯语'
};
const PROMPT_VERSION = 'p2';

let settings = { ...DEFAULTS };
/* API Key 只存 chrome.storage.local：sync 会同步到用户自己的 Google 账号，密钥不该走那里 */
let apiKey = '';
const settingsReady = (async () => {
  try {
    const [got, local] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ apiKey: '' })
    ]);
    settings = { ...DEFAULTS, ...got };
    apiKey = String(local.apiKey || '').trim();
  } catch (e) {
    // 扩展刚安装时可能还不可用，使用默认值即可
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.apiKey) {
    apiKey = String(changes.apiKey.newValue || '').trim();
    return;
  }
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) {
    if (changes[key].newValue !== undefined) settings[key] = changes[key].newValue;
  }
});

/* ---------------- 全局低并发队列 ---------------- */

let activeCount = 0;
const waiting = [];

function concurrencyLimit() {
  const n = Number(settings.concurrency);
  return Number.isFinite(n) ? Math.min(2, Math.max(1, n)) : 1;
}

function pump() {
  while (activeCount < concurrencyLimit() && waiting.length) {
    const job = waiting.shift();
    activeCount++;
    job.fn()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCount--;
        pump();
      });
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    pump();
  });
}

/* ---------------- 请求与 SSE ---------------- */

const inflight = new Map();

/** 归一化服务地址：去掉末尾斜杠与 /v1，拼接时统一补 /v1，避免出现 /v1/v1/ */
function normalizeBase(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { url: '', error: '服务地址不能为空' };
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { url: '', error: '服务地址不是合法 URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: '', error: '只支持 http 或 https 地址' };
  if (!u.hostname) return { url: '', error: '服务地址缺少主机名' };
  const url = s.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  return { url, error: '' };
}

function baseUrl() {
  return normalizeBase(settings.endpoint).url || 'http://127.0.0.1:8080';
}

function apiUrl(path) {
  return `${baseUrl()}/v1${path}`;
}

function isLocalEndpoint() {
  try {
    const host = new URL(baseUrl()).hostname;
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
  } catch (e) {
    return true;
  }
}

/** 有 Key 才带 Authorization；本地 llama.cpp 无 Key 时保持原样 */
function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildInstruction(to, src, count) {
  const srcName = SRC_NAMES[src] || '原文';
  const targetName = TARGET_NAMES[to] || '简体中文';
  const cnt = count > 1 ? `（共 ${count} 段，输出必须也是 ${count} 段，段与段之间用空行分隔）` : '';
  const same = src === to || (src === 'zh' && String(to).startsWith('zh'));
  if (same) return `把下面的${srcName}改写为${targetName}，保持原意${cnt}：`;
  return `把下面的${srcName}翻译成${targetName}${cnt}：`;
}

function buildMessages({ text, count, to, src }) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${buildInstruction(to, src, count)}\n\n${text}` }
  ];
}

/** 清理模型输出中的常见污染：语言前缀、包裹引号 */
function cleanOutput(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^(译文|翻译结果|翻译|translation|translated)\s*[:：]\s*/i, '');
  t = t.replace(/^(简体中文|中文|英文|english|chinese)\s*[:：]\s*/i, '');
  // 整段被同种引号包裹时去掉
  for (const [a, b] of [['"', '"'], ['“', '”'], ['「', '」'], ["'", "'"], ['‘', '’'], ['《', '》']]) {
    while (t.startsWith(a) && t.endsWith(b) && t.length > 2) {
      const inner = t.slice(a.length, t.length - b.length);
      if (inner.includes(a) || inner.includes(b)) break;
      t = inner.trim();
    }
  }
  return t.trim();
}

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function chatCompletion({ id, text, count, to, src, stream, push, tabId, frameId }) {
  const timeoutMs = Math.max(5, Number(settings.timeoutSec) || 60) * 1000;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);

  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
  };
  arm();

  const started = Date.now();
  let acc = '';
  let lastPush = 0;

  try {
    const body = {
      model: settings.model || DEFAULTS.model,
      temperature: Number(settings.temperature ?? DEFAULTS.temperature),
      max_tokens: 1500,
      stream: !!stream,
      messages: buildMessages({ text, count, to, src })
    };

    const res = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store'
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new RequestError('auth', 'API Key 无效或未授权');
      }
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch (e) { /* 忽略 */ }
      throw new RequestError('http', `服务返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase();

    if (res.body && (stream || ctype.includes('text/event-stream'))) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;

      const handleFrame = (frame) => {
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { finished = true; continue; }
          let json;
          try { json = JSON.parse(data); } catch (e) { continue; } // 容错：跳过不完整块
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          const piece = delta && typeof delta.content === 'string' ? delta.content : '';
          if (piece) {
            acc += piece;
            if (push && tabId && Date.now() - lastPush > 150) {
              lastPush = Date.now();
              safeSendTab(tabId, frameId, { type: 'tr-partial', id, text: acc });
            }
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); // 流式：以「无数据」计时，避免长文本误判超时
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(frame);
        }
        if (finished) break;
      }
      const tail = buf.trim();
      if (tail) handleFrame(tail);

      if (!acc && !finished && !ctype.includes('text/event-stream')) {
        throw new RequestError('http', '服务返回空响应');
      }
    } else {
      const json = await res.json();
      const msg = json && json.choices && json.choices[0] && json.choices[0].message;
      acc = (msg && msg.content) || '';
      if (!acc) throw new RequestError('http', '服务返回空译文');
    }

    return { ok: true, text: cleanOutput(acc), ms: Date.now() - started };
  } catch (e) {
    if (timedOut) {
      return { ok: false, code: 'timeout', error: `请求超时（${Math.round(timeoutMs / 1000)}s），模型可能在排队或文本过长` };
    }
    if (e && e.name === 'AbortError') {
      return { ok: false, code: 'aborted', error: '已中止' };
    }
    if (e instanceof RequestError) {
      return { ok: false, code: e.code, error: e.message };
    }
    // fetch 网络层失败：本机多半是服务没启动，远端多半是被跨域拦下或地址不可达
    if (!isLocalEndpoint()) {
      return { ok: false, code: 'cors', error: CORS_HINT };
    }
    return { ok: false, code: 'disconnected', error: DISCONNECTED_HINT };
  } finally {
    clearTimeout(timer);
    inflight.delete(id);
  }
}

function safeSendTab(tabId, frameId, msg) {
  try {
    const p = frameId ? chrome.tabs.sendMessage(tabId, msg, { frameId }) : chrome.tabs.sendMessage(tabId, msg);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* 页面可能已关闭 */ }
}

/* ---------------- 翻译缓存（SHA-256 键 · TTL · LRU · 配额保护） ---------------- */

const CACHE_PREFIX = 'trf:c:';
const CACHE_INDEX_KEY = 'trf:cacheIndex';
const CACHE_STATS_KEY = 'trf:cacheStats';
const CACHE_MAX = 5000;
const CACHE_BYTES_LIMIT = 8 * 1024 * 1024;

let cacheIndex = null;      // { [hash]: lastUsedTs }
let cacheStats = null;      // { hits, misses, lastClear }
let cacheIndexDirty = false;
let cacheStatsDirty = false;
let cacheFlushTimer = 0;
let cachePutCount = 0;

async function ensureCacheMeta() {
  if (cacheIndex && cacheStats) return;
  const got = await chrome.storage.local.get([CACHE_INDEX_KEY, CACHE_STATS_KEY]);
  if (!cacheIndex) cacheIndex = got[CACHE_INDEX_KEY] || {};
  if (!cacheStats) cacheStats = got[CACHE_STATS_KEY] || { hits: 0, misses: 0, lastClear: 0 };
}

function scheduleCacheFlush() {
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => { flushCacheMeta(); }, 700);
}

async function flushCacheMeta() {
  clearTimeout(cacheFlushTimer);
  cacheFlushTimer = 0;
  if (!cacheIndex || !cacheStats) return;
  const payload = {};
  if (cacheIndexDirty) { payload[CACHE_INDEX_KEY] = cacheIndex; cacheIndexDirty = false; }
  if (cacheStatsDirty) { payload[CACHE_STATS_KEY] = cacheStats; cacheStatsDirty = false; }
  if (!Object.keys(payload).length) return;
  try { await chrome.storage.local.set(payload); } catch (e) { /* 配额异常忽略 */ }
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cacheKeyFor(text, src, to) {
  return sha256Hex(`${PROMPT_VERSION}|${src || 'auto'}→${to}|${settings.model || DEFAULTS.model}|${text}`);
}

function cacheTTLMs() {
  const days = Number(settings.cacheTTL);
  return Math.max(1, Number.isFinite(days) ? days : 30) * 86400000;
}

/** 按段查询缓存；命中会累计 hits 并刷新 LRU 时间 */
async function cacheLookup(texts, src, to) {
  await ensureCacheMeta();
  const now = Date.now();
  const ttl = cacheTTLMs();
  const keys = await Promise.all(texts.map((t) => cacheKeyFor(t, src, to)));
  const got = await chrome.storage.local.get(keys.map((k) => CACHE_PREFIX + k));
  const out = [];
  const updates = {};
  const expired = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const e = got[CACHE_PREFIX + k];
    const alive = e && typeof e.t === 'string' && e.t && (now - (Number(e.at) || 0) <= ttl);
    if (alive) {
      e.hits = (Number(e.hits) || 0) + 1;
      updates[CACHE_PREFIX + k] = e;
      cacheIndex[k] = now;
      cacheIndexDirty = true;
      cacheStats.hits++;
      cacheStatsDirty = true;
      out.push({ hit: true, t: e.t });
    } else {
      if (e) { expired.push(CACHE_PREFIX + k); delete cacheIndex[k]; cacheIndexDirty = true; }
      cacheStats.misses++;
      cacheStatsDirty = true;
      out.push({ hit: false });
    }
  }
  if (Object.keys(updates).length) {
    try { await chrome.storage.local.set(updates); } catch (e) { /* ignore */ }
  }
  if (expired.length) {
    try { await chrome.storage.local.remove(expired); } catch (e) { /* ignore */ }
  }
  scheduleCacheFlush();
  return out;
}

async function cacheStore(items, src, to) {
  await ensureCacheMeta();
  const now = Date.now();
  const payload = {};
  let saved = 0;
  for (const it of items || []) {
    const text = it && it.text;
    const t = it && it.t;
    if (typeof text !== 'string' || !text || typeof t !== 'string' || !t) continue;
    const k = await cacheKeyFor(text, src, to);
    payload[CACHE_PREFIX + k] = { t, at: now, hits: 0 };
    cacheIndex[k] = now;
    saved++;
  }
  if (!saved) return 0;
  cacheIndexDirty = true;
  try { await chrome.storage.local.set(payload); } catch (e) { return 0; }
  await evictCache();
  scheduleCacheFlush();
  return saved;
}

/** 超过 5000 条按 LRU 淘汰到上限；接近 8MB 时主动淘汰最旧 20% */
async function evictCache() {
  const count = Object.keys(cacheIndex).length;
  let need = count > CACHE_MAX ? count - CACHE_MAX : 0;
  cachePutCount++;
  if (!need && cachePutCount % 200 === 0) {
    try {
      const bytes = await chrome.storage.local.getBytesInUse(null);
      if (bytes > CACHE_BYTES_LIMIT) need = Math.ceil(count * 0.2);
    } catch (e) { /* ignore */ }
  }
  if (need <= 0) return;
  const victims = Object.keys(cacheIndex)
    .sort((a, b) => (cacheIndex[a] || 0) - (cacheIndex[b] || 0))
    .slice(0, need);
  for (const k of victims) delete cacheIndex[k];
  cacheIndexDirty = true;
  try { await chrome.storage.local.remove(victims.map((k) => CACHE_PREFIX + k)); } catch (e) { /* ignore */ }
}

async function cacheStatsInfo() {
  await ensureCacheMeta();
  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (e) { /* ignore */ }
  const total = cacheStats.hits + cacheStats.misses;
  return {
    ok: true,
    count: Object.keys(cacheIndex).length,
    bytes,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: total ? cacheStats.hits / total : 0,
    lastClear: cacheStats.lastClear || 0,
    ttlDays: Math.max(1, Number(settings.cacheTTL) || 30)
  };
}

async function cacheClear() {
  await ensureCacheMeta();
  let victims = [];
  try {
    const all = await chrome.storage.local.get(null);
    victims = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (victims.length) await chrome.storage.local.remove(victims);
  } catch (e) { /* ignore */ }
  cacheIndex = {};
  cacheStats = { hits: 0, misses: 0, lastClear: Date.now() };
  cacheIndexDirty = true;
  cacheStatsDirty = true;
  await flushCacheMeta();
  return { ok: true, removed: victims.length };
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'translate') {
    const tabId = sender.tab && sender.tab.id;
    const frameId = sender.tab && sender.tab.id ? sender.frameId : undefined;
    enqueue(() => chatCompletion({ ...msg, tabId, frameId }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: 'internal', error: `内部错误：${e && e.message ? e.message : e}` }));
    return true;
  }

  if (msg.type === 'cancel') {
    const ctrl = inflight.get(msg.id);
    if (ctrl) ctrl.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'test-connection') {
    (async () => {
      await settingsReady;
      sendResponse(await testConnection());
    })();
    return true;
  }

  if (msg.type === 'settings-hint') {
    sendResponse({ ok: true, hint: DISCONNECTED_HINT });
    return false;
  }

  if (msg.type === 'cache-get') {
    (async () => {
      await settingsReady;
      const items = await cacheLookup(Array.isArray(msg.texts) ? msg.texts : [], msg.src, msg.to);
      sendResponse({ ok: true, items });
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'cache-put') {
    (async () => {
      await settingsReady;
      const saved = await cacheStore(msg.items, msg.src, msg.to);
      sendResponse({ ok: true, saved });
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'cache-stats') {
    (async () => {
      await settingsReady;
      sendResponse(await cacheStatsInfo());
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'cache-clear') {
    (async () => {
      await settingsReady;
      sendResponse(await cacheClear());
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return false;
});

async function testConnection() {
  const norm = normalizeBase(settings.endpoint);
  if (norm.error) return { ok: false, code: 'config', error: norm.error, endpoint: String(settings.endpoint || '') };
  const timeoutMs = 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl('/models'), {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: authHeaders()
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'auth', error: 'API Key 无效或未授权', endpoint: baseUrl() };
    }
    if (!res.ok) return { ok: false, code: 'http', error: `HTTP ${res.status}`, endpoint: baseUrl() };
    const json = await res.json();
    const list = (json && (json.data || json.models)) || [];
    const ids = list.map((m) => m.id || m.name).filter(Boolean);
    const hasModel = ids.length === 0 || ids.includes(settings.model);
    return {
      ok: true, models: ids, endpoint: baseUrl(), model: settings.model, hasModel,
      remote: !isLocalEndpoint(), hasKey: !!apiKey
    };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, code: 'timeout', error: '连接超时（5s）', endpoint: baseUrl() };
    if (!isLocalEndpoint()) return { ok: false, code: 'cors', error: CORS_HINT, endpoint: baseUrl() };
    return { ok: false, code: 'disconnected', error: DISCONNECTED_HINT, endpoint: baseUrl() };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 右键菜单 / 快捷键 ---------------- */

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'trf-translate-page',
      title: '翻译此页 / 还原原文',
      contexts: ['page', 'selection']
    }, () => { void chrome.runtime.lastError; });
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'trf-translate-page') togglePage(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'translate-page') togglePage();
});

async function togglePage(tab) {
  try {
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = active;
    }
    if (!tab || !tab.id) return;
    const url = tab.url || '';
    if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(url)) return; // 受保护页面不可注入

    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
    } catch (e) {
      // 页面在扩展安装前就已打开：手动注入一次
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
    }
  } catch (e) {
    // 页面不允许注入（如设置页、Web Store）时静默忽略
  }
}
