#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.1 改造验证（三）：自动提示范围/源语言/popup 联动/设置页开关"""
import json, os, re, time
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
EN_URL = "http://127.0.0.1:8099/test.html"
ZH_URL = "http://127.0.0.1:8099/zh.html"
JA_URL = "http://127.0.0.1:8099/ja.html"
SHOT = "test-results"
os.makedirs(SHOT, exist_ok=True)

log = {"tests": [], "shots": [], "env": {"browser": "Edge (Chromium) via CDP"}}
t0 = time.time()


def rec(name, ok, detail, shot=None):
    log["tests"].append({"case": name, "pass": bool(ok), "detail": detail, "at": round(time.time() - t0, 1)})
    if shot:
        log["shots"].append(shot)
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:520], flush=True)


def sh(page, expr):
    return page.evaluate(
        "(expr) => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
        " if(!r) return null; try { return (new Function('r','return ('+expr+')'))(r); } catch(e){ return 'ERR:'+e.message; } }",
        expr,
    )


def card_info(page):
    return sh(page, """(() => { const c=r.querySelector('.lang-card'); if(!c) return null;
        const go=c.querySelector('.lc-go'); const warn=c.querySelector('.lc-warn');
        return {show:c.classList.contains('show'),
                title:(c.querySelector('.lc-title')||{}).textContent,
                go:go?go.textContent:null, disabled:go?go.disabled:null,
                warn:warn?warn.textContent:null, warnOn:warn?warn.className:null}; })()""")


def ball_info(page):
    return sh(page, """(() => { const b=r.querySelector('.ball'); if(!b) return null;
        const x=b.getBoundingClientRect();
        return {left:x.left, top:x.top, right:x.right, bottom:x.bottom, w:x.width}; })()""")


def click_ball(page):
    b = ball_info(page)
    if not b:
        raise RuntimeError("没有悬浮球")
    page.mouse.click((b["left"] + b["right"]) / 2, (b["top"] + b["bottom"]) / 2)
    time.sleep(0.35)


def click_shadow(page, selector):
    box = sh(page, f"(() => {{ const e=r.querySelector('{selector}'); if(!e) return null;"
                   f" const b=e.getBoundingClientRect(); return {{x:b.left+b.width/2, y:b.top+b.height/2}}; }})()")
    if not box:
        raise RuntimeError("找不到元素：" + selector)
    page.mouse.click(box["x"], box["y"])


def set_sync(opts, patch):
    opts.evaluate("(p) => chrome.storage.sync.set(p)", patch)
    time.sleep(0.5)


def tr_counts(page):
    return page.evaluate("""() => ({spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf]').length,
        text: [...document.querySelectorAll('.trf-tr-block')].map(b => b.textContent).join('\\n')})""")


def page_stat(page):
    return sh(page, """(() => { const s=r.querySelector('.stat'); if(!s) return null;
        return {note:(s.querySelector('.note')||{}).textContent, count:(s.querySelector('.count')||{}).textContent}; })()""")


def wait_done(page, timeout=180):
    t = time.time()
    while time.time() - t < timeout:
        st = page_stat(page)
        if st and st["note"] and st["note"].startswith("翻译完成"):
            return st, time.time() - t
        time.sleep(0.5)
    return page_stat(page), time.time() - t


def open_page(ctx, url, prompted=True):
    page = ctx.new_page()
    if prompted:
        page.add_init_script("try{sessionStorage.setItem('trf:prompted:'+location.hostname,'1')}catch(e){}")
    page.goto(url, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.5)
    return page


def base_settings(opts):
    set_sync(opts, {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3,
        "timeoutSec": 60, "directionMode": "auto", "tripleSpaceEnabled": True,
        "tripleSpaceWindowMs": 800, "selectionEnabled": True, "pageMode": "dual",
        "batchChars": 800, "batchParagraphs": 6, "concurrency": 1, "ignoreDomains": "",
        "floatButton": True, "targetLang": "zh-Hans", "sourceLang": "auto",
        "autoPromptEnPage": True, "followSourceLang": False, "cacheTTL": 30
    })
    opts.evaluate("() => chrome.storage.local.remove(['trf:sitePrefs', 'trf:ballPos'])")


with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = br.contexts[0]

    boot = ctx.new_page()
    boot.goto(EXT + "/options.html")
    try: boot.evaluate("() => chrome.runtime.reload()")
    except Exception: pass
    time.sleep(3)
    try: boot.close()
    except Exception: pass

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    opt.wait_for_function("() => !!document.getElementById('sourceLang')", timeout=15000)
    base_settings(opt)
    for pg in list(ctx.pages):
        if any(u in (pg.url or "") for u in (EN_URL, ZH_URL, JA_URL)):
            try: pg.close()
            except Exception: pass
    time.sleep(0.6)

    # ---------- A 英文页自动弹一次 ----------
    page = open_page(ctx, EN_URL, prompted=False)
    time.sleep(2.6)
    c = card_info(page)
    rec("A1 英文页 1.5s 自动展开卡片", bool(c and c["show"] and "英语" in (c["title"] or "")),
        {"卡片": c}, f"{SHOT}/v3-auto-english.png")
    page.screenshot(path=f"{SHOT}/v3-auto-english.png")
    click_shadow(page, ".lang-card .lc-x")
    time.sleep(0.6)
    c3 = card_info(page)
    rec("A2 点 × 关闭卡片", bool(c3 and not c3["show"] and ball_info(page)), {"卡片": c3 and c3["show"]})
    time.sleep(2.6)
    c4 = card_info(page)
    rec("A3 同一会话不再重复自动提示", bool(c4 is None or not c4["show"]), {"卡片": c4 and c4["show"]})

    # ---------- B 中文页不弹 ----------
    page.close()
    page = open_page(ctx, ZH_URL, prompted=False)
    time.sleep(5.2)
    c = card_info(page)
    rec("B1 中文页 5 秒不自动提示", bool(c is None or not c["show"]),
        {"卡片": c and {"show": c["show"], "title": c["title"]}})
    click_ball(page)
    c2 = card_info(page)
    rec("B2 中文页手动点球可展开", bool(c2 and c2["show"] and "中文" in (c2["title"] or "")),
        {"卡片": c2 and {"show": c2["show"], "title": c2["title"], "go": c2["go"]}},
        f"{SHOT}/v3-manual-zh.png")
    page.screenshot(path=f"{SHOT}/v3-manual-zh.png")

    # ---------- C 日文页不弹、手动识别日本語 ----------
    page.close()
    page = open_page(ctx, JA_URL, prompted=False)
    time.sleep(5.2)
    c = card_info(page)
    rec("C1 日文页 5 秒不自动提示", bool(c is None or not c["show"]),
        {"卡片": c and {"show": c["show"], "title": c["title"]}})
    click_ball(page)
    c2 = card_info(page)
    rec("C2 日文页手动展开并识别日本語", bool(c2 and c2["show"] and "日本語" in (c2["title"] or "")),
        {"卡片": c2 and {"show": c2["show"], "title": c2["title"]}},
        f"{SHOT}/v3-manual-ja.png")
    page.screenshot(path=f"{SHOT}/v3-manual-ja.png")

    # ---------- D 设置开关：关掉英文页自动提示 ----------
    page.close()
    set_sync(opt, {"autoPromptEnPage": False})
    page = open_page(ctx, EN_URL, prompted=False)
    time.sleep(5.2)
    c = card_info(page)
    rec("D1 关闭「英文页自动提示」→ 5 秒不弹", bool(c is None or not c["show"]),
        {"卡片": c and c["show"]})
    set_sync(opt, {"autoPromptEnPage": True})
    time.sleep(2.2)
    c2 = card_info(page)
    rec("D2 重新打开开关 → 不刷新页面即弹", bool(c2 and c2["show"]),
        {"卡片": c2 and {"show": c2["show"], "title": c2["title"]}},
        f"{SHOT}/v3-toggle-autoprompt.png")
    page.screenshot(path=f"{SHOT}/v3-toggle-autoprompt.png")

    # ---------- E 目标语言 = English 时英文页不弹、按钮禁用 ----------
    page.close()
    set_sync(opt, {"targetLang": "en", "sourceLang": "auto"})
    page = open_page(ctx, EN_URL, prompted=False)
    time.sleep(4.2)
    c = card_info(page)
    rec("E1 目标设为 English → 英文页不自动弹", bool(c is None or not c["show"]),
        {"卡片": c and c["show"]})
    click_ball(page)
    c2 = card_info(page)
    rec("E2 源与目标相同 → 翻译按钮禁用并提示",
        bool(c2 and c2["show"] and c2["disabled"] is True and "源与目标语言相同" in (c2["warn"] or "")),
        {"卡片": c2 and {"title": c2["title"], "go": c2["go"], "disabled": c2["disabled"], "warn": c2["warn"]}},
        f"{SHOT}/v3-same-lang-warn.png")
    page.screenshot(path=f"{SHOT}/v3-same-lang-warn.png")
    page.close()

    # ---------- F popup 源语言 English + 目标简体：英文页方向与标题 ----------
    set_sync(opt, {"targetLang": "zh-Hans", "sourceLang": "en"})
    page = open_page(ctx, EN_URL, prompted=False)
    time.sleep(2.2)
    c = card_info(page)
    rec("F1 源语言 English → 卡片标题「翻译 English 页面？」", bool(c and c["show"] and "English" in (c["title"] or "")),
        {"卡片": c and {"show": c["show"], "title": c["title"], "go": c["go"]}},
        f"{SHOT}/v3-source-en-card.png")
    page.screenshot(path=f"{SHOT}/v3-source-en-card.png")
    click_shadow(page, ".lang-card .lc-go")
    st, dur = wait_done(page, 180)
    tr = tr_counts(page)
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", tr["text"]))
    rec("F2 英文页按 English→简体中文 翻译", bool(tr["spans"] == 19 and has_cjk and not tr["text"].strip().startswith("Translation")),
        {"段数": tr["spans"], "耗时s": round(dur, 1), "含中文": has_cjk, "首段": tr["text"][:60]}, f"{SHOT}/v3-source-en-done.png")
    page.screenshot(path=f"{SHOT}/v3-source-en-done.png")
    time.sleep(3.4)
    click_ball(page)
    click_shadow(page, ".lang-card .lc-go")  # 还原
    time.sleep(1.0)
    rec("F3 还原干净", tr_counts(page)["spans"] == 0, {"段数": tr_counts(page)["spans"]})
    page.close()

    # ---------- G 源语言简体中文 + 目标 English：中文页翻成英文 ----------
    set_sync(opt, {"targetLang": "en", "sourceLang": "zh-Hans"})
    page = open_page(ctx, ZH_URL, prompted=True)
    click_ball(page)
    c = card_info(page)
    rec("G1 中文页卡片标题显示「翻译 简体中文 页面？」", bool(c and c["show"] and "简体中文" in (c["title"] or "")),
        {"卡片": c and {"show": c["show"], "title": c["title"], "disabled": c["disabled"]}},
        f"{SHOT}/v3-source-zh-card.png")
    page.screenshot(path=f"{SHOT}/v3-source-zh-card.png")
    click_shadow(page, ".lang-card .lc-go")
    st, dur = wait_done(page, 180)
    tr = tr_counts(page)
    latin_only = not bool(re.search(r"[\u4e00-\u9fff]", tr["text"])) and bool(re.search(r"[A-Za-z]", tr["text"]))
    rec("G2 中文页手动翻译为英文（无中文残留）", bool(tr["spans"] == 6 and latin_only),
        {"段数": tr["spans"], "耗时s": round(dur, 1), "全英文": latin_only, "首段": tr["text"][:80]},
        f"{SHOT}/v3-source-zh-en.png")
    page.screenshot(path=f"{SHOT}/v3-source-zh-en.png")
    time.sleep(3.4)
    click_ball(page)
    click_shadow(page, ".lang-card .lc-go")
    time.sleep(1.0)
    rec("G3 还原干净", tr_counts(page)["spans"] == 0, {"段数": tr_counts(page)["spans"]})
    page.close()

    # ---------- H 划词遵循源语言开关 ----------
    set_sync(opt, {"targetLang": "zh-Hans", "sourceLang": "en", "followSourceLang": True})
    page = open_page(ctx, EN_URL, prompted=True)
    page.evaluate("""(id) => { const el=document.getElementById(id); const rg=document.createRange();
        rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""", "p2")
    time.sleep(0.4)
    click_shadow(page, ".icon")
    tag = None
    for _ in range(200):
        tag = sh(page, """(() => { const b=r.querySelector('.bubble'); return b ? (b.querySelector('.tag')||{}).textContent : null; })()""")
        if tag and "→" in tag:
            break
        time.sleep(0.15)
    rec("H1 开启「划词/输入遵循源语言」→ 方向用 English", bool(tag and tag.startswith("English")),
        {"气泡方向": tag}, f"{SHOT}/v3-follow-source-on.png")
    page.keyboard.press("Escape")
    set_sync(opt, {"followSourceLang": False})
    time.sleep(0.6)
    page.evaluate("""(id) => { const el=document.getElementById(id); const rg=document.createRange();
        rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""", "p2")
    time.sleep(0.4)
    click_shadow(page, ".icon")
    tag2 = None
    for _ in range(200):
        tag2 = sh(page, """(() => { const b=r.querySelector('.bubble'); return b ? (b.querySelector('.tag')||{}).textContent : null; })()""")
        if tag2 and "→" in tag2:
            break
        time.sleep(0.15)
    rec("H2 关闭后恢复自动判定（检测：英语）", bool(tag2 and tag2.startswith("检测：")),
        {"气泡方向": tag2}, f"{SHOT}/v3-follow-source-off.png")
    page.screenshot(path=f"{SHOT}/v3-follow-source-off.png")
    page.keyboard.press("Escape")

    # ---------- I 「此网站不再提示」持久化 ----------
    set_sync(opt, {"autoPromptEnPage": True, "sourceLang": "auto", "targetLang": "zh-Hans", "followSourceLang": False})
    page.close()
    page = open_page(ctx, EN_URL, prompted=False)   # 新会话，应自动弹
    time.sleep(2.4)
    c = card_info(page)
    auto_before = bool(c and c["show"])
    if c and c["show"]:
        page.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h.shadowRoot;
            const cb=r.querySelector('.lc-never'); cb.checked=true; cb.dispatchEvent(new Event('change', {bubbles:true})); }""")
        time.sleep(0.4)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    time.sleep(5.2)
    c2 = card_info(page)
    rec("I1 勾选「此网站不再提示」后刷新不再弹", bool(auto_before and (c2 is None or not c2["show"])),
        {"勾选前自动弹": auto_before, "刷新后": c2 and c2["show"]})
    click_ball(page)
    rec("I2 仍可手动点球展开", bool((card_info(page) or {}).get("show")), {"卡片": card_info(page) and card_info(page)["show"]})
    page.close()

    # 清理站点偏好，避免影响其它验证
    opt.evaluate("() => chrome.storage.local.remove(['trf:sitePrefs'])")

    log["total_seconds"] = round(time.time() - t0, 1)
    log["passed"] = sum(1 for x in log["tests"] if x["pass"])
    log["failed"] = sum(1 for x in log["tests"] if not x["pass"])
    with open(f"{SHOT}/v3-report-3.json", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f"\n=== {log['passed']} 通过 / {log['failed']} 失败，总耗时 {log['total_seconds']}s ===", flush=True)
    br.close()
