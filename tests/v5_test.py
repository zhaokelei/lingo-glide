#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5 验证：MAIN world 编辑器 API 回填（参考 read-frog）+ 回归"""
import json, os, re, time
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
BASE = "http://127.0.0.1:8099"
SHOT = "test-results"
os.makedirs(SHOT, exist_ok=True)

log = {"tests": [], "shots": [], "timeline": {}}
t0 = time.time()


def rec(name, ok, detail, shot=None):
    log["tests"].append({"case": name, "pass": bool(ok), "detail": detail, "at": round(time.time() - t0, 1)})
    if shot:
        log["shots"].append(shot)
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:700], flush=True)


def timeline(page):
    raw = page.evaluate("() => document.documentElement.getAttribute('data-trf-timeline')")
    return json.loads(raw) if raw else []


def shadow_html(page, sel):
    return page.evaluate("""(sel) => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const e=r&&r.querySelector(sel); return e ? e.textContent : null; }""", sel)


def shadow_click(page, sel):
    box = page.evaluate("""(sel) => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const e=r&&r.querySelector(sel); if(!e) return null; const b=e.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2}; }""", sel)
    if not box:
        raise RuntimeError("找不到元素 " + sel)
    page.mouse.click(box["x"], box["y"])


def state_text(page):
    return page.evaluate("() => window.__stateText ? window.__stateText() : ''")


def dom_text(page, sel="#editor"):
    return page.evaluate("(sel) => { const e=document.querySelector(sel); return e ? e.innerText : ''; }", sel)


def clear_lexical(page):
    page.evaluate("() => window.__lexClear()")
    time.sleep(0.25)
    page.click("#editor")
    time.sleep(0.15)


def wait_until(fn, pred, timeout=60):
    t = time.time()
    last = None
    while time.time() - t < timeout:
        try:
            last = fn()
        except Exception:
            last = None
        if pred(last):
            return True, last, time.time() - t
        time.sleep(0.05)
    return False, last, time.time() - t


def cjk(s):
    return sum(1 for ch in (s or "") if "\u4e00" <= ch <= "\u9fff")


with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = br.contexts[0]

    boot = ctx.new_page()
    try:
        boot.goto(EXT + "/options.html", wait_until="domcontentloaded", timeout=15000)
    except Exception as e:
        print("WARN options open failed:", str(e)[:120], flush=True)
    time.sleep(2)
    try: boot.close()
    except Exception: pass

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    opt.wait_for_function("() => !!document.getElementById('endpoint')", timeout=15000)
    opt.evaluate("""(p) => new Promise(r => chrome.storage.sync.set(p, r))""", {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3, "timeoutSec": 60,
        "directionMode": "auto", "tripleSpaceEnabled": True, "tripleSpaceWindowMs": 800,
        "shortcutTranslateEnabled": True, "inputShortcut": "Ctrl+Shift+Enter", "debugFill": True,
        "selectionEnabled": True, "pageMode": "dual", "batchChars": 800, "batchParagraphs": 6,
        "concurrency": 1, "ignoreDomains": "", "floatButton": True, "targetLang": "zh-Hans",
        "cacheTTL": 30, "sourceLang": "auto", "autoPromptEnPage": False, "followSourceLang": False
    })
    opt.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'cache-clear'}, r))")
    time.sleep(0.5)

    # ============ L. 官方 Lexical（模拟 FB composer） ============
    pl = ctx.new_page()
    pl.goto(BASE + "/fb_lexical.html", wait_until="domcontentloaded")
    pl.wait_for_function("() => window.__lexicalReady === true", timeout=20000)
    pl.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=20000)
    pl.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.8)

    # 前置：确认 MAIN world 桥接脚本已注入，且 editor 实例可访问
    bridge = pl.evaluate("() => ({ injector: !!window.__trfInputInjector, editor: !!(document.getElementById('editor').__lexicalEditor) })")
    rec("L0 MAIN world 注入脚本 + __lexicalEditor 可见", bridge["injector"] and bridge["editor"], bridge)

    # L1 句子：快捷键翻译 → 编辑器 state 被接受
    clear_lexical(pl)
    pl.click("#editor")
    pl.keyboard.type("你现在在做什么？", delay=10)
    time.sleep(0.3)
    pl.keyboard.press("Control+Shift+Enter")
    ok, txt, dur = wait_until(lambda: state_text(pl), lambda s: cjk(s) == 0 and len(s.strip()) > 0, timeout=60)
    time.sleep(1.9)
    st = state_text(pl)
    dm = dom_text(pl)
    tl = timeline(pl)
    log["timeline"]["L1"] = tl
    lv = {x["label"]: x for x in tl}
    rec("L1 句子：编辑器内部 state 与 DOM 均为译文（守护后保持）",
        cjk(st) == 0 and len(st.strip()) > 0 and dm.strip() == st.strip(),
        {"state": st[:60], "dom": dm[:60], "耗时s": round(dur, 2),
         "level0": {"engine": (lv.get("level0") or {}).get("engine"), "match": (lv.get("level0") or {}).get("match")},
         "阶段": [(x["label"], x.get("t"), x.get("match"), x.get("engine")) for x in tl]},
        f"{SHOT}/v5-lexical-fb.png")
    pl.screenshot(path=f"{SHOT}/v5-lexical-fb.png")

    # L2 继续输入：译文后追加内容，state 与 DOM 同时更新
    pl.click("#editor")
    pl.keyboard.press("End")
    pl.keyboard.type(" extra", delay=10)
    time.sleep(0.4)
    st2 = state_text(pl)
    dm2 = dom_text(pl)
    rec("L2 译文后可继续输入（state/DOM 同步）",
        st2.endswith(" extra") and dm2.strip() == st2.strip(), {"state": st2[-40:], "dom": dm2[-40:]})

    # L3 发送：站点读到的就是译文
    sent = None
    try:
        pl.click("#send")
        time.sleep(0.4)
        sent = pl.evaluate("() => document.getElementById('sent').textContent")
    except Exception as e:
        sent = "ERR " + str(e)
    rec("L3 点击发送，站点拿到译文", bool(sent) and "extra" in sent and cjk(sent) == 0, {"sent": (sent or "")[:120]})

    # L4 旧机制对照：只用 execCommand 写 DOM，等站点 state 同步后会被还原（复现 FB 现象）
    clear_lexical(pl)
    pl.click("#editor")
    pl.keyboard.type("你现在在做什么？", delay=10)
    time.sleep(0.2)
    old = pl.evaluate("""() => {
        const el = document.getElementById('editor');
        el.focus();
        const r = document.createRange(); r.selectNodeContents(el);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        const ret = document.execCommand('insertText', false, 'What are you doing now?');
        return { ret, immediate: el.innerText };
    }""")
    time.sleep(0.9)
    after = pl.evaluate("""() => ({ dom: document.getElementById('editor').innerText,
        state: window.__stateText(), sent: false })""")
    rec("L4 对照：仅写 DOM 的旧机制无法让编辑器 state 接受译文",
        cjk(after["state"]) > 0 and cjk(after["dom"]) > 0,
        {"execCommand返回": old.get("ret"), "写入后立即": old.get("immediate", "")[:40],
         "900ms后DOM": after["dom"][:40], "900ms后state": after["state"][:40],
         "结论": "立即被拦截" if cjk(old.get("immediate", "")) > 0 else "写入后被 state 同步还原"})

    # L5 三空格在官方 Lexical 上回归
    clear_lexical(pl)
    pl.click("#editor")
    pl.keyboard.type("请打开窗户。", delay=10)
    time.sleep(0.2)
    pl.keyboard.press("Space")
    time.sleep(0.12)
    pl.keyboard.press("Space")
    time.sleep(0.12)
    pl.keyboard.press("Space")
    ok, txt, dur = wait_until(lambda: state_text(pl), lambda s: cjk(s) == 0 and len(s.strip()) > 0, timeout=60)
    time.sleep(1.0)
    st3 = state_text(pl)
    rec("L5 三空格在 Lexical 上回填（识别逻辑未改）",
        cjk(st3) == 0 and len(st3.strip()) > 0, {"state": st3[:60], "耗时s": round(dur, 2)})

    # ============ C. 完全拒写模拟页：仍降级到卡片 ============
    pc = ctx.new_page()
    pc.goto(BASE + "/lexical_sim.html?mode=lock", wait_until="domcontentloaded")
    pc.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pc.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.6)
    pc.click("#mc")
    pc.keyboard.type("The weather is nice today and I plan to go for a walk", delay=6)
    time.sleep(0.2)
    pc.keyboard.press("Control+Shift+Enter")
    card = None
    t = time.time()
    while time.time() - t < 90:
        card = shadow_html(pc, ".paste-card .pc-body")
        if card:
            break
        time.sleep(0.1)
    orig = pc.evaluate("() => document.getElementById('mc').innerText")
    tl_c = timeline(pc)
    log["timeline"]["C"] = tl_c
    rec("C 完全拒写页：降级译文卡片、原文未破坏",
        bool(card) and "The weather is nice" in orig,
        {"卡片译文": (card or "")[:40], "原文": orig[:40], "时间线": [(x["label"], x.get("engine"), x.get("match")) for x in tl_c]})
    if card:
        pc.screenshot(path=f"{SHOT}/v5-fill-card.png")

    # ============ R. 回归 ============
    pr = ctx.new_page()
    pr.goto(BASE + "/test.html", wait_until="domcontentloaded")
    pr.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pr.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(1.0)

    # R1 划词气泡
    pr.evaluate("""() => { const el=document.getElementById('p3'); const rg=document.createRange();
        rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""")
    time.sleep(0.5)
    icon = pr.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const i=r&&r.querySelector('.icon'); if(!i) return null; const b=i.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2}; }""")
    if icon:
        pr.mouse.click(icon["x"], icon["y"])
    bubble = None
    t = time.time()
    while time.time() - t < 40:
        bubble = pr.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
            const b=r&&r.querySelector('.bubble'); return b ? b.textContent : null; }""")
        if bubble:
            break
        time.sleep(0.2)
    rec("R1 划词气泡回归", bool(bubble), {"气泡": (bubble or "")[:60]})
    pr.keyboard.press("Escape")

    # R2 整页翻译（中文页 6 段）
    pg = ctx.new_page()
    pg.goto(BASE + "/zh.html", wait_until="domcontentloaded")
    pg.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pg.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.8)
    ball = pg.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const b=r&&r.querySelector('.ball'); if(!b) return null; const x=b.getBoundingClientRect();
        return {x:x.left+x.width/2, y:x.top+x.height/2}; }""")
    pg.mouse.click(ball["x"], ball["y"])
    time.sleep(0.5)
    go = pg.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const b=r&&r.querySelector('.lc-go'); if(!b) return null; const x=b.getBoundingClientRect();
        return {x:x.left+x.width/2, y:x.top+x.height/2, disabled:b.disabled}; }""")
    pg.mouse.click(go["x"], go["y"])
    t = time.time()
    done = False
    spans = 0
    st = ""
    while time.time() - t < 120:
        st = pg.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
            const s=r&&r.querySelector('.stat .note'); return s ? s.textContent : ''; }""")
        spans = pg.evaluate("() => document.querySelectorAll('.trf-tr-block').length")
        if st and st.startswith("翻译完成") and spans >= 6:
            done = True
            break
        time.sleep(0.5)
    rec("R2 整页翻译回归", done, {"译块": spans, "状态": (st or "")[:60]})

    # R3 缓存统计
    stats = opt.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'cache-stats'}, r))")
    rec("R3 缓存统计仍工作", bool(stats) and isinstance(stats.get("count"), int), {"统计": stats})

    print("TOTAL %d/%d PASS in %.1fs" % (sum(1 for x in log["tests"] if x["pass"]), len(log["tests"]), time.time() - t0), flush=True)

with open(f"{SHOT}/v5-report.json", "w") as f:
    json.dump(log, f, ensure_ascii=False, indent=2)
