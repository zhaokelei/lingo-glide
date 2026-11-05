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
  batchMinChars: 200,
  concurrency: 1,
  requestIntervalMs: 0,
  maxRetries: 3,
  retryBaseMs: 600,
  retryMaxMs: 8000,
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
  '7. 译文要地道自然，符合目标语言的表达习惯。',
  '8. 文本中的 ⟦TRF数字⟧、⟦TRFO数字⟧、⟦TRFC数字⟧ 是不可翻译占位符，必须原样保留，不得增删、改写、翻译或调整配对顺序。'
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

/* ---------------- 全局有界并发调度（速率 · 退避 · 取消） ---------------- */

let activeCount = 0;
const waiting = [];
let nextStartAt = 0;    // 全局请求起始节流：下一次允许发起请求的时间
let cooldownUntil = 0;  // 429/5xx 触发的全局退避截止时间
let pumpTimer = null;

/** 并发上限：设置 1–3，默认沿用设置里的 1（本机单槽推理时排队比并行稳） */
function concurrencyLimit() {
  const n = Number(settings.concurrency);
  return Number.isFinite(n) ? Math.min(3, Math.max(1, Math.round(n))) : 1;
}

/** 全局速率：两次请求之间至少间隔 N ms（0 = 不限制） */
function requestIntervalMs() {
  const n = Number(settings.requestIntervalMs);
  return Number.isFinite(n) ? Math.min(2000, Math.max(0, Math.round(n))) : 0;
}

function abortError() {
  const e = new Error('已中止');
  e.code = 'aborted';
  return e;
}

function schedulePump(delay) {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, Math.max(0, delay));
}

function pump() {
  while (activeCount < concurrencyLimit() && waiting.length) {
    const item = waiting[0];
    if (item.aborted && item.aborted()) {
      waiting.shift();
      item.reject(abortError());
      continue;
    }
    const now = Date.now();
    const readyAt = Math.max(now, nextStartAt, cooldownUntil);
    if (readyAt > now) {
      schedulePump(readyAt - now);
      return;
    }
    waiting.shift();
    nextStartAt = now + requestIntervalMs();
    activeCount++;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeCount--;
        pump();
      });
  }
}

function enqueue(fn, opts = {}) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject, jobId: opts.jobId, aborted: opts.aborted });
    pump();
  });
}

/* 每个上层 translate 消息一个取消令牌；并发子批共用一个，cancel 一次全停 */
const jobControls = new Map();

function jobControl(id) {
  let job = jobControls.get(id);
  if (!job) {
    job = { ctrl: new AbortController(), cancelled: false, active: 0 };
    jobControls.set(id, job);
  }
  return job;
}

function cancelJob(id) {
  const job = jobControls.get(id);
  if (!job) return false;
  job.cancelled = true;
  job.ctrl.abort();
  let removed = 0;
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (waiting[i].jobId === id) {
      waiting.splice(i, 1)[0].reject(abortError());
      removed++;
    }
  }
  console.info(`[trf/cancel] id=${id} 已中止：排队取消 ${removed} 个，在途 ${job.active} 个`);
  return true;
}


/* ---------------- 请求与 SSE ---------------- */

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

/** 清理模型输出中的常见污染：只处理提示词自身可能诱导出的前缀，不做语言名硬匹配 */
function cleanOutput(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^(译文|翻译结果|翻译)\s*[:：]\s*/, '');
  t = t.replace(/^(translation|translated)\s*[:：]\s*/i, '');
  // 整段被同种引号包裹时只脱一层，且内部不得再出现同类引号（避免误伤正常译文）
  const pairs = [['"', '"'], ['“', '”'], ['「', '」']];
  for (const [a, b] of pairs) {
    if (t.startsWith(a) && t.endsWith(b) && t.length > 2) {
      const ch = t.slice(1, t.length - 1);
      if (ch.includes(a) || ch.includes(b)) break;
      t = ch.trim();
      break;
    }
  }
  return t.trim();
}

/* ---------------- 占位符保护（代码/URL/邮箱/品牌/成对标签） ----------------- */

const PROTECT_MARK_ALL = /⟦TRF([OC]?)(\d+)⟧/g;

const PROTECT_RULES = [
  // 成对的 HTML 标签在 protectText 里单独处理，这里只保护落单标签
  { kind: 'tag', re: /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g },
  { kind: 'url', re: /(?:https?:\/\/|www\.)[^\s<>"'`，。；：！？、）)\]】]+/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'code', re: /`[^`\n]{1,160}`/g },
  { kind: 'path', re: /(?<![\w])\/(?:[\w.@-]+\/)+[\w.@-]*/g },
  { kind: 'call', re: /\b[A-Za-z_$][\w$]*\(\)/g },
  { kind: 'dotted', re: /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,}\b/g },
  { kind: 'snake', re: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g },
  { kind: 'version', re: /\bv?\d+(?:\.\d+){1,3}\b/g },
  { kind: 'acronym', re: /\b(?:API|URL|URI|HTTP|HTTPS|HTML|CSS|JSON|XML|YAML|CSV|SQL|CPU|GPU|RAM|SSD|USB|PDF|PNG|JPEG|JPG|GIF|SVG|SDK|CLI|IDE|DNS|TCP|UDP|TLS|SSL|VPN|IP|OS|AI|LLM|GPT|DOM|CORS|JWT|SSH|FTP|UI|UX)\b/g },
  { kind: 'model', re: /\b[A-Za-z]{1,8}\d{2,4}[A-Za-z0-9-]*\b/g },
  { kind: 'brand', re: /\b[A-Za-z][a-z]+[A-Z][A-Za-z0-9]*\b/g },
  { kind: 'mark', re: /[A-Za-z0-9][A-Za-z0-9.+_-]{0,24}[™®]/g }
];

/**
 * 把不可翻译片段替换成带索引占位符：
 * - 单个片段 → ⟦TRF0⟧
 * - 成对标签 → ⟦TRFO0⟧内文⟦TRFC0⟧（内文仍可翻译，标签本身受保护）
 * 返回 { text, tokens }，tokens 下标即占位符编号。
 */
function protectText(text) {
  const tokens = [];
  let out = String(text == null ? '' : text);
  if (!out) return { text: out, tokens };
  const mint = (kind, value) => { tokens.push({ kind, value }); return tokens.length - 1; };

  // 1) 成对标签：保留内文，标签本身用 OPEN/CLOSE 包裹
  out = out.replace(/<([A-Za-z][\w:-]*)(?:\s[^<>]*)?>[\s\S]{0,4000}?<\/\1>/g, (m) => {
    const headEnd = m.indexOf('>');
    if (headEnd < 0) return m;
    const closeStart = m.lastIndexOf('</');
    if (closeStart <= headEnd) return m;
    const open = m.slice(0, headEnd + 1);
    const close = m.slice(closeStart);
    const inner = m.slice(headEnd + 1, closeStart);
    const id = mint('pair', { open, close });
    return `⟦TRFO${id}⟧${inner}⟦TRFC${id}⟧`;
  });

  // 2) 其余片段按规则顺序保护；占位符本身不会命中任何规则
  for (const rule of PROTECT_RULES) {
    out = out.replace(rule.re, (m) => `⟦TRF${mint(rule.kind, m)}⟧`);
  }
  return { text: out, tokens };
}

/** 校验并还原占位符；数量、配对、顺序任一不符都返回 ok:false（由调用方降级重试） */
function restoreProtected(text, tokens) {
  const s = String(text || '');
  if (!tokens.length) return { ok: true, text: s };
  const counts = new Map();
  let unknown = 0;
  let m;
  PROTECT_MARK_ALL.lastIndex = 0;
  while ((m = PROTECT_MARK_ALL.exec(s))) {
    const key = `${m[1] || 'S'}${m[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!tokens[Number(m[2])]) unknown++;
  }
  if (unknown) return { ok: false, reason: `未知占位符 ${unknown} 个` };
  if (!counts.size) return { ok: false, reason: '占位符全部丢失' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'pair') {
      if (counts.get(`O${i}`) !== 1 || counts.get(`C${i}`) !== 1) {
        return { ok: false, reason: `成对占位符 #${i} 缺失或重复` };
      }
      const oi = s.indexOf(`⟦TRFO${i}⟧`);
      const ci = s.indexOf(`⟦TRFC${i}⟧`);
      if (oi < 0 || ci < oi) return { ok: false, reason: `成对占位符 #${i} 顺序错误` };
    } else if (counts.get(`S${i}`) !== 1) {
      return { ok: false, reason: `占位符 #${i} 缺失或重复` };
    }
  }
  let out = s;
  out = out.replace(/⟦TRFO(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value.open : ''));
  out = out.replace(/⟦TRFC(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value.close : ''));
  out = out.replace(/⟦TRF(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value : ''));
  return { ok: true, text: out };
}

/** 流式推送时把占位符还原成原文，避免气泡里闪现 ⟦TRF0⟧ */
function visibleProtected(text, tokens) {
  if (!tokens || !tokens.length) return text;
  return String(text || '')
    .replace(/⟦TRFO(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value.open : ''))
    .replace(/⟦TRFC(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value.close : ''))
    .replace(/⟦TRF(\d+)⟧/g, (_, d) => (tokens[Number(d)] ? tokens[Number(d)].value : ''));
}

class RequestError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/** 单次 HTTP 请求（一次尝试）：流式增量只累加到本次请求自己的 acc，避免串段 */
async function requestOnce({ id, partialId, text, count, to, src, stream, push, tabId, frameId, job }) {
  const timeoutMs = Math.max(5, Number(settings.timeoutSec) || 60) * 1000;
  const ctrl = new AbortController();
  const onJobAbort = () => ctrl.abort();
  job.active++;
  if (job.ctrl.signal.aborted) ctrl.abort();
  else job.ctrl.signal.addEventListener('abort', onJobAbort, { once: true });

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
  const prot = protectText(text);
  if (prot.tokens.length) {
    console.info('[trf/protect] 已保护 ' + prot.tokens.length + ' 个片段：' + prot.tokens.map((t) => t.kind).join(','));
  }

  try {
    const body = {
      model: settings.model || DEFAULTS.model,
      temperature: Number(settings.temperature ?? DEFAULTS.temperature),
      max_tokens: 1500,
      stream: !!stream,
      messages: buildMessages({ text: prot.text, count, to, src })
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
      throw new RequestError('http', `服务返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`, {
        status: res.status,
        retryAfter: res.headers.get('retry-after') || ''
      });
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
              safeSendTab(tabId, frameId, { type: 'tr-partial', id: partialId || id, text: visibleProtected(acc, prot.tokens) });
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

    const restored = restoreProtected(cleanOutput(acc), prot.tokens);
    if (!restored.ok) {
      console.warn('[trf/protect] 校验失败：' + restored.reason + '（占位符 ' + prot.tokens.length + ' 个，原文 ' + String(text || '').length + ' 字）');
      return {
        ok: false, code: 'protected',
        error: `占位符校验失败：${restored.reason}`,
        ms: Date.now() - started
      };
    }
    if (prot.tokens.length) console.info('[trf/protect] 校验通过并已还原');
    return { ok: true, text: restored.text, ms: Date.now() - started, protected: prot.tokens.length };
  } catch (e) {
    if (timedOut) {
      return { ok: false, code: 'timeout', error: `请求超时（${Math.round(timeoutMs / 1000)}s），模型可能在排队或文本过长` };
    }
    if (e && e.name === 'AbortError') {
      return { ok: false, code: 'aborted', error: '已中止' };
    }
    if (e instanceof RequestError) {
      return { ok: false, code: e.code, error: e.message, status: e.status, retryAfter: e.retryAfter };
    }
    // fetch 网络层失败：本机多半是服务没启动，远端多半是被跨域拦下或地址不可达
    if (!isLocalEndpoint()) {
      return { ok: false, code: 'cors', error: CORS_HINT };
    }
    return { ok: false, code: 'disconnected', error: DISCONNECTED_HINT };
  } finally {
    clearTimeout(timer);
    job.active--;
    job.ctrl.signal.removeEventListener('abort', onJobAbort);
  }
}

/* ---------------- 动态分批 · 重试 · 组装 ---------------- */

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

/** 与 content.js 一致的分段口径：优先空行，其次换行 */
function splitSegments(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function partsOf(text, count) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const byBlank = raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length === count) return byBlank;
  const byLine = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length === count) return byLine;
  return byBlank.length ? byBlank : (byLine.length ? byLine : [raw]);
}

/** 超长单段按句子边界切开，尽量贴近上限；返回块数组 */
function splitLongSegment(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return [s];
  const sentences = s.match(/[^.!?。！？；;\n]+[.!?。！？；;]?["'”’）)]?\s*/g) || [s];
  const out = [];
  let buf = '';
  for (const sn of sentences) {
    if (buf && (buf + sn).length > maxChars) {
      const cut = buf.trim();
      if (cut) out.push(cut);
      buf = '';
    }
    buf += sn;
    while (buf.length > maxChars) {
      const cut = buf.slice(0, maxChars).trim();
      if (cut) out.push(cut);
      buf = buf.slice(maxChars);
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.length ? out : [s];
}

function makeBatch(segs, reason) {
  return {
    text: segs.map((s) => s.text).join('\n\n'),
    count: segs.length,
    segs,
    chunk: null,
    reason: reason || 'pack'
  };
}

/**
 * 动态分批：段数与字符数双上限；长段单独成批（超上限再按句切开），
 * 短尾批在不超过上限时并回上一批。上限取自 batchChars/batchParagraphs，
 * 合并下限取 batchMinChars，均可通过设置调整。
 */
function planBatches(text, count) {
  const maxChars = clampInt(settings.batchChars, 200, 4000, 800);
  const maxParas = clampInt(settings.batchParagraphs, 1, 40, 6);
  const minChars = Math.min(maxChars, clampInt(settings.batchMinChars, 50, 4000, 200));
  const raw = String(text == null ? '' : text);
  const segs = splitSegments(raw);

  if (!segs.length) {
    return { batches: [{ text: raw.trim(), count: Math.max(1, Number(count) || 1), segs: null, chunk: null, reason: 'raw' }], segsTotal: 0, maxChars, maxParas, minChars };
  }
  if (count && Number(count) > 0 && segs.length !== Number(count)) {
    console.warn(`[trf/batch] 段数不一致：声明 ${count} 段，实际 ${segs.length} 段，回退单批请求`);
    return { batches: [{ text: segs.join('\n\n'), count: Number(count) || segs.length, segs: null, chunk: null, reason: 'raw' }], segsTotal: segs.length, maxChars, maxParas, minChars };
  }

  const batches = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    batches.push(makeBatch(cur, 'pack'));
    cur = [];
    curLen = 0;
  };

  segs.forEach((t, i) => {
    if (t.length > maxChars) {
      flush();
      const chunks = splitLongSegment(t, maxChars);
      chunks.forEach((c) => batches.push({
        text: c, count: 1, segs: null, reason: chunks.length > 1 ? 'split-long' : 'long-alone',
        chunk: { segIndex: i, chunks: chunks.length }
      }));
      return;
    }
    if (cur.length >= maxParas || (curLen + t.length + 2 > maxChars && cur.length)) flush();
    cur.push({ text: t, segIndex: i });
    curLen += t.length + 2;
  });
  flush();

  // 尾批过短：在不超上限时并回上一批，减少一次请求
  if (batches.length >= 2) {
    const a = batches[batches.length - 2];
    const b = batches[batches.length - 1];
    if (!a.chunk && !b.chunk && b.text.length < minChars &&
        a.count + b.count <= maxParas && a.text.length + b.text.length + 2 <= maxChars) {
      batches[batches.length - 2] = makeBatch(a.segs.concat(b.segs), 'merge-tail');
      batches.pop();
    }
  }

  const splitChunks = batches.filter((b) => b.chunk && b.chunk.chunks > 1).length;
  console.info(`[trf/batch] 计划 segments=${segs.length} chars=${raw.length} maxChars=${maxChars} maxParas=${maxParas} minChars=${minChars} batches=${batches.length} splitChunks=${splitChunks}`);
  if (batches.length <= 8) {
    batches.forEach((b, i) => console.info(`[trf/batch] #${i} segs=${b.count} chars=${b.text.length} reason=${b.reason}`));
  }
  return { batches, segsTotal: segs.length, maxChars, maxParas, minChars };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function retryDelayInfo(res, attempt) {
  const base = clampInt(settings.retryBaseMs, 100, 10000, 600);
  const cap = Math.max(base, clampInt(settings.retryMaxMs, base, 30000, 8000));
  let header = 0;
  const raw = String((res && res.retryAfter) || '').trim();
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) header = Math.round(sec * 1000);
    else {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) header = Math.max(0, at - Date.now());
    }
  }
  const backoff = Math.min(cap, base * Math.pow(2, attempt));
  return header > 0
    ? { delay: Math.min(cap, header), source: 'retry-after' }
    : { delay: backoff, source: 'backoff' };
}

function shouldRetry(res) {
  if (!res) return false;
  if (res.code === 'timeout') return true;
  if (res.code === 'http' && RETRYABLE_STATUS.has(Number(res.status))) return true;
  return false;
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 通过全局调度器发一次批请求，带 429/5xx/超时的指数退避与全局冷却 */
async function runLeaf(job, batch, label, msg) {
  const maxRetries = clampInt(settings.maxRetries, 0, 5, 3);
  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (job.cancelled) return { ok: false, code: 'aborted', error: '已中止' };
    let res;
    try {
      res = await enqueue(
        () => requestOnce({
          id: label,
          partialId: msg.id,
          text: batch.text,
          count: batch.count,
          to: msg.to,
          src: msg.src,
          stream: msg.stream,
          push: !!batch.push,
          tabId: msg.tabId,
          frameId: msg.frameId,
          job
        }),
        { jobId: msg.id, aborted: () => job.cancelled }
      );
    } catch (e) {
      return { ok: false, code: 'aborted', error: '已中止' };
    }
    if (res && res.ok) return res;
    last = res;
    if (!shouldRetry(res) || attempt >= maxRetries) break;
    const { delay, source } = retryDelayInfo(res, attempt);
    if (Number(res.status) === 429) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
    }
    console.warn(`[trf/retry] ${label} code=${res.code} status=${res.status || 0} attempt=${attempt + 1}/${maxRetries} wait=${delay}ms source=${source} concurrency=${concurrencyLimit()} inFlight=${activeCount}`);
    try {
      await sleepWithSignal(delay, job.ctrl.signal);
    } catch (e) {
      return { ok: false, code: 'aborted', error: '已中止' };
    }
  }
  return last || { ok: false, code: 'internal', error: '未知请求错误' };
}

const DOWNGRADE_CODES = new Set(['timeout', 'protected', 'empty', 'mismatch']);

/** 一批：请求 → 段数校验 → 失败自动二分降批（透明，对 content.js 仍是一整段结果） */
async function runBatch(job, batch, label, msg, depth = 0) {
  const res = await runLeaf(job, batch, label, msg);
  if (res.ok) {
    const parts = partsOf(res.text, batch.count);
    if (parts.length === batch.count && parts.every((p) => String(p || '').trim())) {
      return { ok: true, parts, ms: res.ms || 0, protected: res.protected || 0 };
    }
    const code = parts.length !== batch.count ? 'mismatch' : 'empty';
    console.warn(`[trf/batch] ${label} 校验失败 code=${code} parts=${parts.length}/${batch.count}`);
    res.ok = false;
    res.code = code;
    res.error = code === 'mismatch'
      ? `译文段数与原文不一致（${parts.length}/${batch.count}）`
      : '译文存在空段';
  }
  if (!res.ok && DOWNGRADE_CODES.has(res.code) && batch.segs && batch.count > 1 && depth < 3 && !job.cancelled) {
    const mid = Math.ceil(batch.count / 2);
    const left = makeBatch(batch.segs.slice(0, mid), 'bisect');
    const right = makeBatch(batch.segs.slice(mid), 'bisect');
    console.warn(`[trf/batch] 降批 ${label}: ${batch.count} 段 → ${left.count}+${right.count}（原因 ${res.code}）`);
    const l = await runBatch(job, left, `${label}.a`, msg, depth + 1);
    const r = await runBatch(job, right, `${label}.b`, msg, depth + 1);
    if (l.ok && r.ok) {
      return { ok: true, parts: l.parts.concat(r.parts), ms: l.ms + r.ms, protected: l.protected + r.protected };
    }
    if (job.cancelled) return { ok: false, code: 'aborted', error: '已中止' };
    return l.ok ? r : l;
  }
  return res;
}

/** 并发调度下按批次并行翻译并组装回原始段序；对上层保持「一次请求一批」的返回结构 */
async function translateInBatches(msg) {
  const started = Date.now();
  const job = jobControl(msg.id);
  const plan = planBatches(msg.text, msg.count);
  const pushable = plan.batches.length === 1 && plan.batches[0].count === 1 && !plan.batches[0].chunk;
  const tasks = plan.batches.map((b) => ({ ...b, push: pushable && !!msg.push }));
  console.info(`[trf/queue] id=${msg.id} 并发上限=${concurrencyLimit()} 速率间隔=${requestIntervalMs()}ms 批次=${tasks.length}`);

  try {
    const results = await Promise.all(tasks.map((b, i) => runBatch(job, b, `b${i}`, msg)));
    if (job.cancelled) return { ok: false, code: 'aborted', error: '已中止' };

    const out = [];
    let pending = null;
    const joiner = /^(zh|ja|ko)/i.test(String(msg.to || '')) ? '' : ' ';
    let protectedTotal = 0;
    for (let i = 0; i < tasks.length; i++) {
      const r = results[i];
      const b = tasks[i];
      if (!r.ok) {
        console.warn(`[trf/batch] 批次 ${i} 失败 code=${r.code}，整单返回失败`);
        return { ok: false, code: r.code, error: r.error || '翻译失败' };
      }
      protectedTotal += r.protected || 0;
      if (b.chunk) {
        if (!pending || pending.segIndex !== b.chunk.segIndex) {
          pending = { segIndex: b.chunk.segIndex, text: r.parts[0] || '' };
        } else {
          pending.text += joiner + (r.parts[0] || '');
        }
        continue;
      }
      if (pending) { out.push(pending.text); pending = null; }
      for (const p of r.parts) out.push(p);
    }
    if (pending) out.push(pending.text);

    const expected = Number(msg.count) > 0 ? Number(msg.count) : (plan.segsTotal || out.length);
    if (out.length !== expected) {
      console.warn(`[trf/batch] 组装段数不符 ${out.length}/${expected}`);
      return { ok: false, code: 'mismatch', error: `译文段数与原文不一致（${out.length}/${expected}）` };
    }
    console.info(`[trf/batch] 完成 id=${msg.id} 批次=${tasks.length} 段数=${out.length} 用时=${Date.now() - started}ms`);
    return { ok: true, text: out.join('\n\n'), ms: Date.now() - started, protected: protectedTotal };
  } finally {
    if (jobControls.get(msg.id) === job) jobControls.delete(msg.id);
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
const CACHE_SCHEMA_KEY = 'trf:cacheSchema';
/* 键结构变化（新增 endpoint/model/prompt 指纹）时递增，旧键整体失效一次 */
const CACHE_KEY_VERSION = 2;
const CACHE_MAX = 5000;
const CACHE_BYTES_LIMIT = 8 * 1024 * 1024;

let cacheIndex = null;      // { [hash]: lastUsedTs }
let cacheStats = null;      // { hits, misses, lastClear }
let cacheIndexDirty = false;
let cacheStatsDirty = false;
let cacheFlushTimer = 0;
let cachePutCount = 0;

let cacheSchemaReady = null;

/** 一次性迁移：旧键结构直接清空，避免换模型/换地址后命中旧译文 */
async function migrateCacheSchema() {
  try {
    const got = await chrome.storage.local.get(CACHE_SCHEMA_KEY);
    if (Number(got[CACHE_SCHEMA_KEY]) === CACHE_KEY_VERSION) return;
    const all = await chrome.storage.local.get(null);
    const victims = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (victims.length) await chrome.storage.local.remove(victims);
    await chrome.storage.local.set({ [CACHE_SCHEMA_KEY]: CACHE_KEY_VERSION });
    cacheIndex = {};
    cacheIndexDirty = true;
    if (victims.length) console.info('[trf/cache] 缓存键结构升级到 v' + CACHE_KEY_VERSION + '，清理旧条目 ' + victims.length + ' 条');
  } catch (e) { /* 存储不可用时照常工作 */ }
}

async function ensureCacheMeta() {
  if (!cacheSchemaReady) cacheSchemaReady = migrateCacheSchema();
  await cacheSchemaReady;
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

function endpointHost() {
  try { return new URL(baseUrl()).host; } catch (e) { return 'invalid'; }
}

async function cacheKeyFor(text, src, to) {
  const scope = `${CACHE_KEY_VERSION}|${PROMPT_VERSION}|${settings.model || DEFAULTS.model}|${endpointHost()}`;
  return sha256Hex(`${scope}|${src || 'auto'}→${to}|${text}`);
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
    translateInBatches({ ...msg, tabId, frameId })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: 'internal', error: `内部错误：${e && e.message ? e.message : e}` }));
    return true;
  }

  if (msg.type === 'cancel') {
    cancelJob(msg.id);
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
