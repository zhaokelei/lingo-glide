#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.1 改造验证（一）：悬浮球拖动/卡片/自动提示/换语言/popup"""
import json, os, time
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
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:420], flush=True)


def sh(page, expr):
    return page.evaluate(
        "(expr) => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
        " if(!r) return null; try { return (new Function('r','return ('+expr+')'))(r); } catch(e){ return 'ERR:'+e.message; } }",
        expr,
    )


def ball_info(page):
    return sh(page, """(() => { const b=r.querySelector('.ball'); if(!b) return null;
        const x=b.getBoundingClientRect(); return {left:Math.round(x.left), top:Math.round(x.top),
        right:Math.round(x.right), bottom:Math.round(x.bottom), w:Math.round(x.width)}; })()""")


def card_info(page):
    return sh(page, """(() => { const c=r.querySelector('.lang-card'); if(!c) return null;
        const title=c.querySelector('.lc-title'); const lang=c.querySelector('.lc-lang');
        const sel=c.querySelector('.lc-lang-sel'); const go=c.querySelector('.lc-go');
        const prog=c.querySelector('.lc-count'); const note=c.querySelector('.lc-note');
        return {show:c.classList.contains('show'), title:title&&title.textContent,
                lang:lang&&lang.textContent, target:sel&&sel.value, go:go&&go.textContent,
                progress:prog&&prog.textContent, note:note&&note.textContent,
                moreOpen:c.querySelector('.lc-morebox').classList.contains('open')}; })()""")


def click_shadow(page, selector):
    box = sh(page, f"(() => {{ const e=r.querySelector('{selector}'); if(!e) return null;"
                   f" const b=e.getBoundingClientRect(); return {{x:b.left+b.width/2, y:b.top+b.height/2}}; }})()")
    if not box:
        raise RuntimeError("找不到元素：" + selector)
    page.mouse.click(box["x"], box["y"])


def set_select_shadow(page, selector, value):
    page.evaluate(
        """([h, v]) => { const host=document.getElementById('trf-root'); const r=host.shadowRoot;
             const el=r.querySelector(h); el.value=v; el.dispatchEvent(new Event('change', {bubbles:true})); }""",
        [selector, value],
    )


def page_tab_id(opts, url):
    return opts.evaluate("""async (url) => {
        const tabs = await new Promise(r => chrome.tabs.query({}, r));
        const t = tabs.filter(x => x.url && x.url.split('#')[0] === url).sort((a,b)=>b.id-a.id)[0];
        return t ? t.id : null;
      }""", url)


def op_tab_msg(opts, tab_id, msg):
    return opts.evaluate("""async ([id, m]) => new Promise(r => chrome.tabs.sendMessage(id, m, r))""", [tab_id, msg])


def tr_stats(page):
    return page.evaluate("""() => ({spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf="done"]').length,
        multi: [...document.querySelectorAll('[data-trf="done"]')].filter(b => b.querySelectorAll('.trf-tr-block').length !== 1).length,
        hasCjk: [...document.querySelectorAll('.trf-tr-block')].some(e => /[\\u4e00-\\u9fff]/.test(e.textContent)),
        hasLatin: [...document.querySelectorAll('.trf-tr-block')].some(e => /[A-Za-z]{3,}/.test(e.textContent))})""")


def wait_done(page, timeout=260):
    start = time.time()
    last = None
    while time.time() - start < timeout:
        st = sh(page, """(() => { const s=r.querySelector('.stat'); if(!s) return null;
            return {count:(s.querySelector('.count')||{}).textContent, note:(s.querySelector('.note')||{}).textContent}; })()""")
        stats = tr_stats(page)
        last = {"stat": st, "spans": stats["spans"], "marks": stats["marks"]}
        if st and st.get("note") and st["note"].startswith("翻译完成") and stats["spans"] > 0 and stats["spans"] == stats["marks"]:
            return last, time.time() - start
        time.sleep(0.8)
    return last, time.time() - start


def wait_card_show(page, timeout=8):
    start = time.time()
    while time.time() - start < timeout:
        c = card_info(page)
        if c and c["show"]:
            return c, time.time() - start
        time.sleep(0.2)
    return None, time.time() - start


with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = br.contexts[0]

    # 重新加载扩展
    boot = ctx.new_page()
    boot.goto(EXT + "/options.html")
    try:
        boot.evaluate("() => chrome.runtime.reload()")
    except Exception:
        pass
    time.sleep(3)
    try: boot.close()
    except Exception: pass

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    opt.wait_for_function("() => !!document.getElementById('endpoint')", timeout=15000)
    opt.evaluate("""(d) => chrome.storage.sync.set(d)""", {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3,
        "timeoutSec": 60, "directionMode": "auto", "tripleSpaceEnabled": True,
        "tripleSpaceWindowMs": 800, "selectionEnabled": True, "pageMode": "dual",
        "batchChars": 800, "batchParagraphs": 6, "concurrency": 1,
        "ignoreDomains": "", "floatButton": True, "targetLang": "zh-Hans", "cacheTTL": 30,
        "sourceLang": "auto", "autoPromptEnPage": True, "followSourceLang": False,
    })
    # 清空站点偏好与球位置，回到初始状态
    opt.evaluate("() => chrome.storage.local.remove(['trf:sitePrefs', 'trf:ballPos', 'trf:prompted:127.0.0.1'])")
    opt.evaluate("() => chrome.runtime.sendMessage({type:'cache-clear'})")
    time.sleep(0.8)

    for pg in list(ctx.pages):
        if EN_URL in (pg.url or "") or ZH_URL in (pg.url or ""):
            try: pg.close()
            except Exception: pass

    # ---------- 用例 1：悬浮球拖动 + 持久化 + 点击展开 ----------
    page = ctx.new_page()
    page.add_init_script("try{sessionStorage.setItem('trf:prompted:'+location.hostname,'1')}catch(e){}")
    page.goto(EN_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.8)
    b0 = ball_info(page)
    vw = page.evaluate("() => document.documentElement.clientWidth")
    ok_ball = bool(b0 and b0["right"] >= vw - 20 and b0["top"] <= 20)
    rec("1a 右上角悬浮球默认位置", ok_ball, {"ball": b0, "视口": [1280, 800], "内容宽": vw}, f"{SHOT}/v3-ball-default.png")
    page.screenshot(path=f"{SHOT}/v3-ball-default.png")

    # 拖动：从球心向左下移动 140/110
    page.mouse.move((b0["left"] + b0["right"]) / 2, (b0["top"] + b0["bottom"]) / 2)
    page.mouse.down()
    page.mouse.move(b0["left"] - 60, b0["top"] + 60, steps=12)
    page.mouse.move(300, 300, steps=12)
    page.mouse.up()
    time.sleep(0.4)
    b1 = ball_info(page)
    dragged = b1 and abs(b1["left"] - b0["left"]) > 50
    rec("1b 拖动悬浮球（>6px 判定为拖动）", dragged,
        {"拖动前": [b0["left"], b0["top"]], "拖动后": b1 and [b1["left"], b1["top"]],
         "吸边": b1 and (b1["left"] <= 24 or b1["right"] >= 1256)}, f"{SHOT}/v3-ball-dragged.png")
    page.screenshot(path=f"{SHOT}/v3-ball-dragged.png")

    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    time.sleep(1.0)
    b2 = ball_info(page)
    persisted = b2 and abs(b2["left"] - b1["left"]) <= 3 and abs(b2["top"] - b1["top"]) <= 3
    rec("1c 刷新后位置保留", persisted, {"拖动后": [b1["left"], b1["top"]], "刷新后": b2 and [b2["left"], b2["top"]]})

    # 点击（不拖）展开卡片
    page.mouse.click((b2["left"] + b2["right"]) / 2, (b2["top"] + b2["bottom"]) / 2)
    c, _ = wait_card_show(page, 3)
    rec("1d 单击（不拖）展开语言卡片", bool(c),
        {"卡片": c and {"title": c["title"], "target": c["target"], "go": c["go"]}}, f"{SHOT}/v3-card-opened.png")
    page.screenshot(path=f"{SHOT}/v3-card-opened.png")

    # 「更多」展开二级项
    click_shadow(page, ".lang-card .lc-more")
    time.sleep(0.4)
    c2 = card_info(page)
    rec("1e 卡片「更多」展开二级项", bool(c2 and c2["moreOpen"]), {"moreOpen": c2 and c2["moreOpen"]})

    # 点击卡片 × 关闭；再点球可见可控
    click_shadow(page, ".lang-card .lc-x")
    time.sleep(0.3)
    c3 = card_info(page)
    rec("1f × 关闭卡片", c3 is not None and not c3["show"], {"show": c3 and c3["show"]})
    try: page.close()
    except Exception: pass

    # ---------- 用例 2：英文页 1.5s 自动提示 + 卡片翻译进度 ----------
    page = ctx.new_page()
    t_nav = time.time()
    page.goto(EN_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    c, delay = wait_card_show(page, 6)
    title_ok = bool(c and c["title"] and "英语" in c["title"])
    rec("2a 英文页自动展开卡片（约 1.5s）", title_ok,
        {"出现耗时s": round(delay, 2), "标题": c and c["title"]}, f"{SHOT}/v3-card-auto-en.png")
    page.screenshot(path=f"{SHOT}/v3-card-auto-en.png")

    t_trans = time.time()
    click_shadow(page, ".lang-card .lc-go")
    time.sleep(1.2)
    mid = card_info(page)
    prog_visible = bool(mid and mid["show"] and mid["progress"] and "已译" in mid["progress"])
    page.screenshot(path=f"{SHOT}/v3-card-progress.png")
    last, dur = wait_done(page, 260)
    stats = tr_stats(page)
    ok2 = stats["spans"] == 19 and stats["marks"] == 19 and stats["multi"] == 0
    cs = card_info(page)
    rec("2b 卡片内进度 + 整页翻译段落数一致", ok2 and prog_visible,
        {"翻译中进度": mid and mid["progress"], "完成": last and last["stat"],
         "译文块": stats["spans"], "原文块": stats["marks"], "并段": stats["multi"],
         "卡片完成进度": cs and {"progress": cs["progress"], "note": cs["note"]},
         "耗时s": round(dur, 1)})
    page.screenshot(path=f"{SHOT}/v3-card-done.png")

    # 再次触发 = 还原（完成后约 3 秒淡出，等淡出后点球重新展开卡片）
    time.sleep(3.6)
    faded = card_info(page)
    rec("2c-pre 完成后约 3 秒卡片淡出", bool(faded and not faded["show"]), {"卡片": faded and {"show": faded["show"]}})
    b_done = ball_info(page)
    page.mouse.click((b_done["left"] + b_done["right"]) / 2, (b_done["top"] + b_done["bottom"]) / 2)
    c_re, _ = wait_card_show(page, 3)
    rec("2c-pre 完成后点球重新展开卡片", bool(c_re and c_re["go"] == "还原"),
        {"卡片": c_re and {"show": c_re["show"], "go": c_re["go"]}})
    click_shadow(page, ".lang-card .lc-go")
    time.sleep(1.2)
    restored = page.evaluate("""() => ({spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf]').length})""")
    rec("2c 卡片按钮再次点击还原", restored["spans"] == 0 and restored["marks"] == 0,
        {"还原后": restored, "耗时s": round(time.time() - t_trans, 1)})
    try: page.close()
    except Exception: pass

    # ---------- 用例 3：中文页不提示 ----------
    page = ctx.new_page()
    page.goto(ZH_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    time.sleep(5.2)
    c = card_info(page)
    no_prompt = c is None or not c["show"]
    rec("3a 中文页 5 秒不自动提示", no_prompt, {"卡片": c and {"show": c["show"], "title": c["title"]}})

    # 手动打开卡片 + 目标语言改成 English
    b = ball_info(page)
    page.mouse.click((b["left"] + b["right"]) / 2, (b["top"] + b["bottom"]) / 2)
    c, _ = wait_card_show(page, 3)
    title_zh = bool(c and c["title"] and "中文" in c["title"])
    set_select_shadow(page, ".lc-lang-sel", "en")
    time.sleep(0.4)
    c_en = card_info(page)
    rec("3b 中文页卡片标题 / 切到 English", title_zh and c_en and c_en["target"] == "en",
        {"标题": c and c["title"], "目标": c_en and c_en["target"], "按钮": c_en and c_en["go"]})

    click_shadow(page, ".lang-card .lc-go")
    last, dur = wait_done(page, 200)
    stats = tr_stats(page)
    ok3 = stats["spans"] > 0 and stats["spans"] == stats["marks"] and not stats["hasCjk"] and stats["hasLatin"]
    rec("3c 中文页译成英文且无中文残留", ok3,
        {"译文块": stats["spans"], "原文块": stats["marks"], "译文含中文": stats["hasCjk"],
         "译文含英文": stats["hasLatin"], "耗时s": round(dur, 1)}, f"{SHOT}/v3-zh-to-en.png")
    page.screenshot(path=f"{SHOT}/v3-zh-to-en.png", full_page=True)

    # 还原并恢复目标语言
    click_shadow(page, ".lang-card .lc-go")
    time.sleep(1.0)
    set_select_shadow(page, ".lc-lang-sel", "zh-Hans")
    time.sleep(0.3)

    # ---------- 用例 4：popup ----------
    # 恢复默认目标语言，重开干净的中文页，避免上一用例残留
    opt.evaluate("() => chrome.storage.sync.set({targetLang:'zh-Hans'})")
    for pg in list(ctx.pages):
        if ZH_URL in (pg.url or ""):
            try: pg.close()
            except Exception: pass
    page = ctx.new_page()
    page.goto(ZH_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.8)
    tab_id = page_tab_id(opt, ZH_URL)
    pop = ctx.new_page()
    pop.goto(f"{EXT}/popup.html?tabId={tab_id}")
    pop.wait_for_function("() => !!document.getElementById('statusMain')", timeout=15000)
    time.sleep(1.6)
    popinfo = pop.evaluate("""() => ({
        status: document.getElementById('statusMain').textContent,
        sub: document.getElementById('statusSub').textContent,
        main: document.getElementById('mainBtn').textContent,
        disabled: document.getElementById('mainBtn').disabled,
        prog: document.getElementById('progress').textContent,
        src: document.getElementById('sourceLang').value,
        target: document.getElementById('target').value,
        cache: document.getElementById('cacheNum').textContent,
        url: location.pathname })""")
    ok4 = popinfo["status"].startswith("已连接") and "设置" not in popinfo["url"] and popinfo["url"].endswith("popup.html")
    rec("4a 工具栏面板显示已连接（非设置页）", ok4, popinfo, f"{SHOT}/v3-popup.png")
    pop.screenshot(path=f"{SHOT}/v3-popup.png")

    # 面板主按钮：翻译 / 还原
    pop.click("#mainBtn")
    time.sleep(1.5)
    popmain = pop.evaluate("() => ({main: document.getElementById('mainBtn').textContent, prog: document.getElementById('progress').textContent})")
    st = op_tab_msg(opt, tab_id, {"type": "get-state"})
    rec("4b 面板主按钮触发整页翻译", bool(st and st["active"]), {"面板": popmain, "状态": st and {"active": st["active"], "total": st["total"]}})
    pop.click("#mainBtn")
    time.sleep(1.2)
    st2 = op_tab_msg(opt, tab_id, {"type": "get-state"})
    rec("4c 面板主按钮再次点击还原", bool(st2 and not st2["active"] and not st2["hasTranslations"]),
        {"状态": st2 and {"active": st2["active"], "translated": st2["hasTranslations"]}})

    # 开关即时生效：划词图标 / 悬浮球 / 站点禁用
    pop.uncheck("#swSelection")
    time.sleep(0.4)
    pop.check("#swSelection")
    pop.uncheck("#swBall")
    time.sleep(0.6)
    b_off = ball_info(page)
    pop.check("#swBall")
    time.sleep(0.6)
    b_on = ball_info(page)
    rec("4d 面板开关切换即时生效（悬浮球）", b_off is None and b_on is not None,
        {"关闭后球": b_off, "开启后球": b_on and [b_on["left"], b_on["top"]]})

    pop.check("#swSiteOff")
    time.sleep(0.6)
    st_off = op_tab_msg(opt, tab_id, {"type": "get-state"})
    b_siteoff = ball_info(page)
    pop.uncheck("#swSiteOff")
    time.sleep(0.6)
    st_on = op_tab_msg(opt, tab_id, {"type": "get-state"})
    rec("4e 本网站禁用扩展即时生效并可恢复",
        bool(st_off and st_off["disabled"] and b_siteoff is None and st_on and not st_on["disabled"]),
        {"禁用后": st_off and {"disabled": st_off["disabled"], "ball": bool(b_siteoff)},
         "恢复后": st_on and {"disabled": st_on["disabled"], "ball": bool(ball_info(page))}})

    # 服务停掉（用关闭端口模拟）→ 重测显示未连接
    opt.evaluate("() => chrome.storage.sync.set({endpoint:'http://127.0.0.1:8098/v1'})")
    time.sleep(0.5)
    pop.click("#retest")
    time.sleep(2.0)
    down = pop.evaluate("""() => ({status: document.getElementById('statusMain').textContent,
        sub: document.getElementById('statusSub').textContent,
        dot: document.getElementById('dot').className})""")
    ok_down = down["status"].startswith("未连接") and "err" in down["dot"]
    pop.screenshot(path=f"{SHOT}/v3-popup-disconnected.png")
    opt.evaluate("() => chrome.storage.sync.set({endpoint:'http://127.0.0.1:8080/v1'})")
    time.sleep(0.5)
    pop.click("#retest")
    time.sleep(1.8)
    up = pop.evaluate("() => document.getElementById('statusMain').textContent")
    rec("4f 停服务→重测显示未连接；恢复后已连接", ok_down and up.startswith("已连接"),
        {"未连接": down, "恢复": up}, f"{SHOT}/v3-popup-disconnected.png")

    log["total_seconds"] = round(time.time() - t0, 1)
    log["passed"] = sum(1 for x in log["tests"] if x["pass"])
    log["failed"] = sum(1 for x in log["tests"] if not x["pass"])
    with open(f"{SHOT}/v3-report-1.json", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f"\n=== {log['passed']} 通过 / {log['failed']} 失败，总耗时 {log['total_seconds']}s ===", flush=True)
    br.close()
