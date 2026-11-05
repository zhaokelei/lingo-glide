#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5b：发送/清空后不误回填（S1–S5）+ 回归"""
import json, os, time
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
BASE = "http://127.0.0.1:8099"
SHOT = "test-results"
os.makedirs(SHOT, exist_ok=True)
log = {"tests": [], "timeline": {}}
t0 = time.time()


def rec(name, ok, detail):
    log["tests"].append({"case": name, "pass": bool(ok), "detail": detail, "at": round(time.time() - t0, 1)})
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:700], flush=True)


def cjk(s):
    return sum(1 for ch in (s or "") if "\u4e00" <= ch <= "\u9fff")


def st(pg):
    return pg.evaluate("() => window.__stateText()")


def dom(pg):
    return pg.evaluate("() => document.getElementById('editor').innerText")


def tl(pg):
    raw = pg.evaluate("() => document.documentElement.getAttribute('data-trf-timeline')")
    return json.loads(raw) if raw else []


def shadow_text(pg, sel):
    return pg.evaluate("""(sel) => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const e=r&&r.querySelector(sel); return e ? e.textContent : null; }""", sel)


def open_page(ctx):
    pg = ctx.new_page()
    pg.goto(BASE + "/fb_lexical.html", wait_until="domcontentloaded")
    pg.wait_for_function("() => window.__lexicalReady === true", timeout=20000)
    pg.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=20000)
    pg.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.6)
    return pg


def fill(pg, src):
    pg.evaluate("() => window.__lexClear()")
    time.sleep(0.2)
    pg.click("#editor")
    pg.keyboard.type(src, delay=8)
    time.sleep(0.25)
    pg.keyboard.press("Control+Shift+Enter")
    t = time.time()
    base = "".join(src.split())
    while time.time() - t < 60:
        s = st(pg)
        if s.strip() and "".join(s.split()) != base:
            return s, time.time() - t
        time.sleep(0.05)
    return st(pg), time.time() - t


with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = br.contexts[0]

    boot = ctx.new_page()
    try:
        boot.goto(EXT + "/options.html", wait_until="domcontentloaded", timeout=15000)
    except Exception:
        pass
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
    time.sleep(0.5)

    # ---------- S1 回填后点发送并清空：不得重写 ----------
    pg = open_page(ctx)
    out1, d1 = fill(pg, "你现在在做什么？")
    time.sleep(0.3)
    pg.click("#send")
    time.sleep(1.5)
    s1, m1 = st(pg), dom(pg)
    sent1 = pg.evaluate("() => ({count: window.__sentCount||0, last: window.__lastSentText||''})")
    card1 = shadow_text(pg, ".paste-card")
    toast1 = shadow_text(pg, ".toast")
    tls1 = tl(pg)
    log["timeline"]["S1"] = tls1
    rec("S1 发送后保持空、无重写、无卡片/toast、站点收到译文",
        s1.strip() == "" and m1.strip() == "" and sent1["count"] == 1 and cjk(sent1["last"]) == 0 and not card1 and not toast1,
        {"译文": out1[:40], "发送": sent1, "1.5s后state": s1[:20], "1.5s后DOM": m1[:20],
         "卡片": card1, "toast": (toast1 or "")[:30],
         "时间线": [(x["label"], x.get("verdict"), x.get("reason")) for x in tls1 if x["label"].startswith("guard")]})
    pg.screenshot(path=f"{SHOT}/v5b-s1-sent.png")
    pg.close()

    # ---------- S2 站点还原成原文：守护仍能重试并保留译文 ----------
    pg = open_page(ctx)
    src2 = "The weather is nice today and I want to go out for a walk"
    out2, d2 = fill(pg, src2)
    time.sleep(0.3)
    pg.evaluate("(t) => window.__siteRevert(t)", src2)
    time.sleep(1.6)
    s2 = st(pg)
    tls2 = tl(pg)
    log["timeline"]["S2"] = tls2
    guards = [(x["label"], x.get("verdict")) for x in tls2 if x["label"].startswith("guard")]
    retries = [(x["label"], x.get("ok"), x.get("engine")) for x in tls2 if x["label"].startswith("guard-retry")]
    rec("S2 被站点还原后仍重试成功（原功能不被破坏）",
        cjk(s2) > 0 and len(retries) >= 1,
        {"译文": out2[:40], "还原后最终state": s2[:60], "guard": guards, "retry": retries})
    pg.close()

    # ---------- S3 回填后用户继续输入：不覆盖 ----------
    pg = open_page(ctx)
    out3, d3 = fill(pg, "请打开窗户。")
    time.sleep(0.3)
    pg.click("#editor")
    pg.keyboard.press("End")
    pg.keyboard.type(" extra", delay=8)
    time.sleep(1.2)
    s3 = st(pg)
    rec("S3 用户继续输入后不被覆盖", s3.endswith(" extra") and cjk(s3) == 0,
        {"state": s3[-50:], "guard": [(x["label"], x.get("verdict"), x.get("reason")) for x in tl(pg) if x["label"].startswith("guard")]})
    pg.close()

    # ---------- S4 回车发送（不点按钮） ----------
    pg = open_page(ctx)
    out4, d4 = fill(pg, "这件事我们明天再讨论吧。")
    time.sleep(0.3)
    pg.click("#editor")
    pg.keyboard.press("Enter")
    time.sleep(1.5)
    s4 = st(pg)
    sent4 = pg.evaluate("() => ({count: window.__sentCount||0, last: window.__lastSentText||''})")
    tls4 = tl(pg)
    log["timeline"]["S4"] = tls4
    rec("S4 回车发送后不回填、输入框为空",
        s4.strip() == "" and sent4["count"] == 1 and cjk(sent4["last"]) == 0,
        {"发送": sent4, "1.5s后state": s4[:20],
         "时间线": [(x["label"], x.get("reason")) for x in tls4 if x["label"].startswith("guard")]})
    pg.close()

    # ---------- S5 手动全选删除（真实按键） ----------
    pg = open_page(ctx)
    out5, d5 = fill(pg, "这本书我已经读完了。")
    time.sleep(0.3)
    pg.click("#editor")
    # 用浏览器全选后再按真实 Delete（beforeinput deleteContentBackward 为 isTrusted）
    pg.evaluate("() => document.execCommand('selectAll')")
    time.sleep(0.2)
    pg.keyboard.press("Delete")
    time.sleep(1.5)
    s5, m5 = st(pg), dom(pg)
    tls5 = tl(pg)
    log["timeline"]["S5"] = tls5
    retries5 = [x for x in tls5 if x["label"].startswith("guard-retry")]
    cancel5 = [x.get("reason") for x in tls5 if x["label"] == "guard-cancel"]
    rec("S5 用户全选删除后不回填",
        s5.strip() == "" and m5.strip() == "" and not retries5,
        {"1.5s后state": s5[:20], "DOM": m5[:20], "retry": len(retries5), "cancel": cancel5,
         "时间线": [(x["label"], x.get("reason"), x.get("inputType")) for x in tls5 if x["label"].startswith("guard") or "input" in x["label"]]})
    pg.close()

    # ---------- R. 回归 ----------
    tr = ctx.new_page()
    tr.goto(BASE + "/test.html", wait_until="domcontentloaded")
    tr.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    tr.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.9)
    # R1 三空格（textarea）
    ta = "plain"
    tr.fill(f"#{ta}", "")
    tr.click(f"#{ta}")
    tr.keyboard.type("请把门关好。", delay=6)
    tr.keyboard.press("Space"); time.sleep(0.12)
    tr.keyboard.press("Space"); time.sleep(0.12)
    tr.keyboard.press("Space")
    v1 = ""
    t = time.time()
    while time.time() - t < 40:
        v1 = tr.evaluate("(id) => document.getElementById(id).value", ta)
        if v1.strip() and cjk(v1) == 0:
            break
        time.sleep(0.1)
    rec("R1 三空格（textarea）回归", bool(v1.strip()) and cjk(v1) == 0, {"值": (v1 or "")[:40]})
    # R2 快捷键（React 风格受控 textarea）
    ti = "ctrl"
    tr.fill(f"#{ti}", "")
    tr.click(f"#{ti}")
    tr.keyboard.type("大家早上好。", delay=6)
    tr.keyboard.press("Control+Shift+Enter")
    v2 = ""
    t = time.time()
    while time.time() - t < 40:
        v2 = tr.evaluate("(id) => document.getElementById(id).value", ti)
        if v2.strip() and cjk(v2) == 0:
            break
        time.sleep(0.1)
    rec("R2 快捷键（受控 textarea）回归", bool(v2.strip()) and cjk(v2) == 0, {"值": (v2 or "")[:40]})
    # R3 划词
    tr.evaluate("""() => { const el=document.getElementById('p3'); const rg=document.createRange();
        rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""")
    time.sleep(0.5)
    ic = tr.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const i=r&&r.querySelector('.icon'); if(!i) return null; const b=i.getBoundingClientRect();
        return {x:b.left+b.width/2,y:b.top+b.height/2}; }""")
    if ic:
        tr.mouse.click(ic["x"], ic["y"])
    bub = None
    t = time.time()
    while time.time() - t < 40:
        bub = shadow_text(tr, ".bubble")
        if bub:
            break
        time.sleep(0.2)
    rec("R3 划词气泡回归", bool(bub), {"气泡": (bub or "")[:40]})
    tr.keyboard.press("Escape")
    # R4 整页
    pz = ctx.new_page()
    pz.goto(BASE + "/zh.html", wait_until="domcontentloaded")
    pz.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pz.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.7)
    ball = pz.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const b=r&&r.querySelector('.ball'); if(!b) return null; const x=b.getBoundingClientRect();
        return {x:x.left+x.width/2,y:x.top+x.height/2}; }""")
    pz.mouse.click(ball["x"], ball["y"]); time.sleep(0.4)
    go = pz.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const b=r&&r.querySelector('.lc-go'); if(!b) return null; const x=b.getBoundingClientRect();
        return {x:x.left+x.width/2,y:x.top+x.height/2}; }""")
    pz.mouse.click(go["x"], go["y"])
    done = False
    stt = ""
    t = time.time()
    while time.time() - t < 120:
        stt = pz.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
            const s=r&&r.querySelector('.stat .note'); return s ? s.textContent : ''; }""")
        n = pz.evaluate("() => document.querySelectorAll('.trf-tr-block').length")
        if stt.startswith("翻译完成") and n >= 6:
            done = True
            break
        time.sleep(0.5)
    rec("R4 整页翻译回归", done, {"状态": (stt or "")[:40]})
    # R5 缓存
    stats = opt.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'cache-stats'}, r))")
    rec("R5 缓存统计回归", bool(stats) and isinstance(stats.get("count"), int), {"统计": stats})
    # R6 popup 快捷键提示
    pp = ctx.new_page()
    pp.goto(EXT + "/popup.html", wait_until="domcontentloaded")
    time.sleep(0.8)
    hint = pp.evaluate("() => { const e=document.getElementById('shortcutHint'); return e ? e.textContent : null; }")
    rec("R6 popup 快捷键提示回归", bool(hint) and ("输入框翻译" in hint), {"提示": (hint or "")[:60]})

    print("TOTAL %d/%d PASS in %.1fs" % (sum(1 for x in log["tests"] if x["pass"]), len(log["tests"]), time.time() - t0), flush=True)

with open(f"{SHOT}/v5b-report.json", "w") as f:
    json.dump(log, f, ensure_ascii=False, indent=2)
