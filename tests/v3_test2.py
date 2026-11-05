#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.1 改造验证（二）：缓存命中/清除/整页二次命中率/换语言条目/回归"""
import json, os, re, time
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
EN_URL = "http://127.0.0.1:8099/test.html"
ZH_URL = "http://127.0.0.1:8099/zh.html"
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


def bubble_info(page):
    return sh(page, """(() => { const b=r.querySelector('.bubble'); if(!b) return null;
        const body=b.querySelector('.body'); const chip=b.querySelector('.cache-chip');
        const copy=b.querySelector('.copy');
        return {exists:true, body:body&&body.textContent,
                chip:chip&&chip.textContent, chipOn:chip?chip.classList.contains('on'):false,
                copyDisabled: copy ? copy.disabled : null,
                count:r.querySelectorAll('.bubble').length}; })()""")


def select_id(page, sel_id):
    last = None
    for _ in range(3):
        page.evaluate("""(id) => { const el=document.getElementById(id); if(!el) return;
            const rg=document.createRange(); rg.selectNodeContents(el);
            const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""", sel_id)
        try:
            page.wait_for_function("""() => { const h=document.getElementById('trf-root');
                const r=h&&h.shadowRoot; const i=r&&r.querySelector('.icon');
                return !!(i && i.getBoundingClientRect().width>0); }""", timeout=5000)
            return
        except Exception as e:
            last = e
            time.sleep(0.3)
    raise last


def click_shadow(page, selector):
    box = sh(page, f"(() => {{ const e=r.querySelector('{selector}'); if(!e) return null;"
                   f" const b=e.getBoundingClientRect(); return {{x:b.left+b.width/2, y:b.top+b.height/2}}; }})()")
    if not box:
        raise RuntimeError("找不到元素：" + selector)
    page.mouse.click(box["x"], box["y"])


def set_sync(opts, patch):
    opts.evaluate("(p) => chrome.storage.sync.set(p)", patch)


def cache_stats(opts):
    return opts.evaluate("""async () => new Promise(r => chrome.runtime.sendMessage({type:'cache-stats'}, r))""")


def cache_clear(opts):
    return opts.evaluate("""async () => new Promise(r => chrome.runtime.sendMessage({type:'cache-clear'}, r))""")


def op_tab_msg(opts, tab_id, msg):
    return opts.evaluate("""async ([id, m]) => new Promise(r => chrome.tabs.sendMessage(id, m, r))""", [tab_id, msg])


def tab_id_of(opts, url):
    return opts.evaluate("""async (url) => {
        const tabs = await new Promise(r => chrome.tabs.query({}, r));
        const t = tabs.filter(x => x.url && x.url.split('#')[0] === url).sort((a,b)=>b.id-a.id)[0];
        return t ? t.id : null; }""", url)


def page_stat(page):
    return sh(page, """(() => { const s=r.querySelector('.stat'); if(!s) return null;
        return {count:(s.querySelector('.count')||{}).textContent,
                note:(s.querySelector('.note')||{}).textContent,
                hidden:s.classList.contains('hide')}; })()""")


def tr_counts(page):
    return page.evaluate("""() => ({spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf]').length,
        multi: [...document.querySelectorAll('[data-trf="done"]')].filter(b => b.querySelectorAll('.trf-tr-block').length !== 1).length})""")


def wait_page_done(page, timeout=200):
    t = time.time()
    st = None
    while time.time() - t < timeout:
        st = page_stat(page)
        c = tr_counts(page)
        if st and st["note"] and st["note"].startswith("翻译完成") and c["spans"] >= 1:
            return st, time.time() - t, c
        time.sleep(0.5)
    return st, time.time() - t, tr_counts(page)


def sel_translate(page, sel_id, timeout=90):
    """划词一次，返回（耗时，气泡信息）；以复制按钮可用作为「翻译完成」标志"""
    # 确保上一轮气泡已收起
    for _ in range(10):
        if bubble_info(page) is None:
            break
        page.keyboard.press("Escape")
        time.sleep(0.2)
    select_id(page, sel_id)
    t = time.time()
    click_shadow(page, ".icon")
    while time.time() - t < timeout:
        b = bubble_info(page)
        body = (b or {}).get("body") or ""
        if b and b["exists"] and b.get("copyDisabled") is False and body.strip():
            return time.time() - t, b
        time.sleep(0.05)
    return time.time() - t, bubble_info(page)


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
    opt.wait_for_function("() => !!document.getElementById('endpoint')", timeout=15000)
    set_sync(opt, {"endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3,
                   "timeoutSec": 60, "directionMode": "auto", "tripleSpaceEnabled": True,
                   "tripleSpaceWindowMs": 800, "selectionEnabled": True, "pageMode": "dual",
                   "batchChars": 800, "batchParagraphs": 6, "concurrency": 1,
                   "ignoreDomains": "", "floatButton": True, "targetLang": "zh-Hans", "cacheTTL": 30,
                   "sourceLang": "auto", "autoPromptEnPage": False, "followSourceLang": False})
    opt.evaluate("() => chrome.storage.local.remove(['trf:sitePrefs', 'trf:ballPos'])")
    for pg in list(ctx.pages):
        if EN_URL in (pg.url or "") or ZH_URL in (pg.url or ""):
            try: pg.close()
            except Exception: pass
    time.sleep(0.6)

    # ---------- A 清缓存归零 ----------
    c0 = cache_clear(opt)
    s0 = cache_stats(opt)
    rec("A 清除缓存后统计归零", bool(c0 and c0["ok"] and s0 and s0["count"] == 0),
        {"清除返回": c0, "统计": s0})

    # ---------- B 同一句两次：第二次命中且 <50ms ----------
    page = ctx.new_page()
    page.add_init_script("try{sessionStorage.setItem('trf:prompted:'+location.hostname,'1')}catch(e){}")
    page.goto(EN_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.6)

    d1, b1 = sel_translate(page, "p3")
    time.sleep(0.4)
    s1 = cache_stats(opt)
    rec("B1 首次划词（未命中，走网络）", bool(b1 and b1.get("body") and not b1.get("chipOn")),
        {"耗时s": round(d1, 3), "chip": b1 and b1.get("chip"), "chipOn": b1 and b1.get("chipOn"),
         "统计": s1 and {"hits": s1["hits"], "misses": s1["misses"], "count": s1["count"]}})

    page.keyboard.press("Escape")
    time.sleep(0.3)
    d2, b2 = sel_translate(page, "p3")
    time.sleep(0.4)
    s2 = cache_stats(opt)
    hit_fast = (d2 < 0.05)
    chip_txt = (b2 or {}).get("chip") or ""
    m = re.search(r"(\d+\.\d+)s", chip_txt)
    chip_sec = float(m.group(1)) if m else None
    inner_fast = chip_sec is not None and chip_sec < 0.05
    rec("B2 第二次同句命中缓存且 <50ms", bool(b2 and b2.get("chipOn") and "缓存" in chip_txt
                                            and (hit_fast or inner_fast) and b2["body"] == b1["body"]),
        {"首次s": round(d1, 3), "二次端到端s": round(d2, 3), "chip": chip_txt,
         "缓存内耗时s": chip_sec,
         "译文一致": b2 and b1 and b2["body"] == b1["body"],
         "统计": s2 and {"hits": s2["hits"], "misses": s2["misses"]}}, f"{SHOT}/v3-cache-bubble.png")
    page.screenshot(path=f"{SHOT}/v3-cache-bubble.png")

    # ---------- C popup 显示缓存 + 清除确认 ----------
    tid = tab_id_of(opt, EN_URL)
    pop = ctx.new_page()
    pop.goto(f"{EXT}/popup.html?tabId={tid}")
    pop.wait_for_function("() => !!document.getElementById('statusMain')", timeout=15000)
    time.sleep(1.5)
    cn = pop.evaluate("() => document.getElementById('cacheNum').textContent")
    rec("C1 面板显示缓存条数/占用/命中率", "缓存" in cn and "条" in cn and "命中率" in cn, {"cacheNum": cn})
    pop.on("dialog", lambda d: d.accept())
    pop.click("#clearCache")
    time.sleep(1.2)
    tip = pop.evaluate("() => document.getElementById('tip').textContent")
    s3 = cache_stats(opt)
    rec("C2 面板「清除缓存」确认后归零并提示条数",
        bool("已清除" in tip and s3 and s3["count"] == 0),
        {"提示": tip, "统计": s3 and {"count": s3["count"], "hits": s3["hits"], "misses": s3["misses"]}},
        f"{SHOT}/v3-popup-cache-cleared.png")
    pop.screenshot(path=f"{SHOT}/v3-popup-cache-cleared.png")

    # ---------- D 清缓存后再翻同句走网络 ----------
    pop.close()
    page.keyboard.press("Escape")
    time.sleep(0.3)
    d3, b3 = sel_translate(page, "p3")
    s4 = cache_stats(opt)
    rec("D 清除后再翻译走网络（无缓存标注）",
        bool(d3 > 0.05 and b3 and not b3.get("chipOn")),
        {"耗时s": round(d3, 3), "chipOn": b3 and b3.get("chipOn"), "统计": s4 and {"hits": s4["hits"], "misses": s4["misses"]}})

    # ---------- E 整页二次命中率 ----------
    base = cache_stats(opt)
    t_start = time.time()
    op_tab_msg(opt, tid, {"type": "toggle-page"})
    st1, dur1, c1 = wait_page_done(page, 220)
    s5 = cache_stats(opt)
    rec("E1 整页首次翻译（网络）", bool(c1["spans"] == 19 and c1["multi"] == 0),
        {"stat": st1, "段数": c1, "耗时s": round(dur1, 1),
         "统计": s5 and {"hits": s5["hits"], "misses": s5["misses"], "hitRate": round(s5["hitRate"], 3)}})

    op_tab_msg(opt, tid, {"type": "toggle-page"})  # 还原
    time.sleep(1.2)
    r_back = tr_counts(page)
    t2 = time.time()
    op_tab_msg(opt, tid, {"type": "toggle-page"})
    st2, dur2, c2 = wait_page_done(page, 60)
    s6 = cache_stats(opt)
    cache_note = (st2 or {}).get("note") or ""
    rec("E2 整页二次翻译全命中（<2s，命中率上升）",
        bool(dur2 < 2.0 and "缓存命中" in cache_note and c2["spans"] == 19 and r_back["spans"] == 0),
        {"首次s": round(dur1, 1), "二次s": round(dur2, 2), "完成note": cache_note,
         "还原干净": r_back, "命中率": round(s6["hitRate"], 3),
         "统计": {"hits": s6["hits"], "misses": s6["misses"]}}, f"{SHOT}/v3-cache-page-2nd.png")
    page.screenshot(path=f"{SHOT}/v3-cache-page-2nd.png")

    # ---------- F 换目标语言必为不同条目（中文页整页翻译，6 段） ----------
    op_tab_msg(opt, tid, {"type": "toggle-page"})  # 还原英文页
    time.sleep(1.0)
    cache_clear(opt)
    set_sync(opt, {"targetLang": "zh-Hans"})
    page_z = ctx.new_page()
    page_z.add_init_script("try{sessionStorage.setItem('trf:prompted:'+location.hostname,'1')}catch(e){}")
    page_z.goto(ZH_URL, wait_until="domcontentloaded")
    page_z.bring_to_front()
    page_z.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page_z.set_viewport_size({"width": 1280, "height": 800})
    tid_z = tab_id_of(opt, ZH_URL)
    time.sleep(0.6)
    op_tab_msg(opt, tid_z, {"type": "toggle-page"})
    stz1, durz1, cz1 = wait_page_done(page_z, 150)
    cnt1 = cache_stats(opt)["count"]
    op_tab_msg(opt, tid_z, {"type": "toggle-page"})
    time.sleep(1.2)
    set_sync(opt, {"targetLang": "en"})
    time.sleep(0.6)
    op_tab_msg(opt, tid_z, {"type": "toggle-page"})
    stz2, durz2, cz2 = wait_page_done(page_z, 150)
    cnt2 = cache_stats(opt)["count"]
    rec("F 同一原文换目标语言生成新条目（不误用旧缓存）",
        bool(cnt1 == 6 and cnt2 == 12 and cz1["spans"] == 6 and cz2["spans"] == 6),
        {"条数": {"翻成简体后": cnt1, "再翻成英文后": cnt2},
         "耗时s": [round(durz1, 1), round(durz2, 1)],
         "段数": [cz1["spans"], cz2["spans"]]})
    page_z.close()
    set_sync(opt, {"targetLang": "zh-Hans"})
    page.bring_to_front()
    page.keyboard.press("Escape")
    time.sleep(0.3)

    # ---------- G 回归：三空格（独立页面，避免整页翻译残留影响） ----------
    page_g = ctx.new_page()
    page_g.add_init_script("try{sessionStorage.setItem('trf:prompted:'+location.hostname,'1')}catch(e){}")
    page_g.goto(EN_URL, wait_until="domcontentloaded")
    page_g.bring_to_front()
    page_g.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page_g.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.8)
    s7 = cache_stats(opt)
    page_g.click("#plain")
    page_g.fill("#plain", "")
    page_g.keyboard.type("Please translate this short sentence.")
    t = time.time()
    for _ in range(3):
        page_g.keyboard.press("Space")
        time.sleep(0.09)
    val = ""
    for _ in range(120):
        val = page_g.evaluate("() => document.getElementById('plain').value")
        if val and not re.search(r"[A-Za-z]{4,}", val):
            break
        time.sleep(0.25)
        if time.time() - t > 45:
            break
    s8 = cache_stats(opt)
    changed = bool(val and val.strip() and not re.search(r"[A-Za-z]{4,}", val))
    rec("G1 三空格翻译替换输入框内容", changed,
        {"结果": val[:80], "耗时s": round(time.time() - t, 1),
         "缓存": {"hits": s8["hits"], "misses": s8["misses"]}}, f"{SHOT}/v3-regression-triple.png")
    page_g.screenshot(path=f"{SHOT}/v3-regression-triple.png")
    page_g.close()

    # ---------- G 回归：气泡常驻 ----------
    page.keyboard.press("Escape")
    time.sleep(0.3)
    select_id(page, "p2")
    click_shadow(page, ".icon")
    for _ in range(300):
        if (bubble_info(page) or {}).get("copyDisabled") is False:
            break
        time.sleep(0.1)
    time.sleep(0.3)
    b0 = bubble_info(page)
    page.mouse.move(600, 200, steps=6)
    page.mouse.move(300, 500, steps=8)
    time.sleep(1.2)
    b_move = bubble_info(page)
    page.mouse.wheel(0, 500)
    time.sleep(1.2)
    b_scroll = bubble_info(page)
    rec("G2 划词气泡常驻（鼠标移动/滚动不消失）",
        bool(b0 and b_move and b_scroll and b_move["exists"] and b_scroll["exists"] and b_scroll["count"] == 1),
        {"初始": bool(b0), "移动后": bool(b_move), "滚动后": bool(b_scroll), "气泡数": b_scroll and b_scroll["count"]},
        f"{SHOT}/v3-regression-bubble-scroll.png")
    page.screenshot(path=f"{SHOT}/v3-regression-bubble-scroll.png")

    # 气泡关闭（Esc）
    page.keyboard.press("Escape")
    time.sleep(0.4)
    rec("G3 Esc 关闭气泡", bubble_info(page) is None, {"气泡": bubble_info(page)})

    log["total_seconds"] = round(time.time() - t0, 1)
    log["passed"] = sum(1 for x in log["tests"] if x["pass"])
    log["failed"] = sum(1 for x in log["tests"] if not x["pass"])
    with open(f"{SHOT}/v3-report-2.json", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f"\n=== {log['passed']} 通过 / {log['failed']} 失败，总耗时 {log['total_seconds']}s ===", flush=True)
    br.close()
