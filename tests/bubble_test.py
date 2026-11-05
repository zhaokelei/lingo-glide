#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""划词气泡常驻修复 · 实机验证脚本（Edge + CDP + Playwright）"""
import json, os, time, random
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
TEST_URL = "http://127.0.0.1:8099/test.html"
SHOT = "test-results"
os.makedirs(SHOT, exist_ok=True)

log = {"tests": [], "env": {"browser": "Microsoft Edge 156 (Chromium) via CDP", "test_url": TEST_URL}}
t_start = time.time()


def record(name, ok, detail, shot=None):
    entry = {"case": name, "pass": bool(ok), "detail": detail, "shot": shot,
             "at": round(time.time() - t_start, 1)}
    log["tests"].append(entry)
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:400])
    return entry


def shadow(page, expr):
    return page.evaluate(
        "(expr) => { const h = document.getElementById('trf-root');"
        " const r = h && h.shadowRoot; if (!r) return null;"
        " try { return (new Function('r', 'return (' + expr + ')'))(r); } catch (e) { return 'ERR:' + e.message; } }",
        expr,
    )


def bubble(page):
    return shadow(page, """(() => {
        const b = r.querySelector('.bubble'); if (!b) return null;
        const tag = b.querySelector('.tag'); const body = b.querySelector('.body');
        const pin = b.querySelector('.pin');
        const copy = b.querySelector('.ft button');
        const rect = b.getBoundingClientRect();
        return {tag: tag && tag.textContent, body: body && body.textContent,
                pin: pin && pin.textContent, copyDisabled: copy ? copy.disabled : null,
                left: Math.round(rect.left), top: Math.round(rect.top),
                width: Math.round(rect.width), height: Math.round(rect.height),
                count: r.querySelectorAll('.bubble').length};
      })()""")


def bubble_count(page):
    return shadow(page, "(() => r.querySelectorAll('.bubble').length)()")


def sel_rect(page):
    return page.evaluate("""() => { const s=getSelection(); if (!s || s.rangeCount===0) return null;
        const r=s.getRangeAt(0); const rs=r.getClientRects(); if(!rs.length) return null;
        const b=rs[rs.length-1]; return {top:Math.round(b.top), bottom:Math.round(b.bottom), left:Math.round(b.left)}; }""")


def arm_clone(page):
    """把当前选区克隆到页面全局，供选区被清空后仍能测量锚点位置"""
    page.evaluate("""() => { const s=getSelection(); if (!s || s.rangeCount===0) { window.__trfClone=null; return; }
        window.__trfClone = s.getRangeAt(0).cloneRange(); }""")


def clone_rect(page):
    return page.evaluate("""() => { const r=window.__trfClone; if(!r) return null;
        try { const rs=r.getClientRects(); if (rs.length) { const b=rs[rs.length-1];
          return {top:Math.round(b.top), bottom:Math.round(b.bottom), left:Math.round(b.left)}; }
          const b=r.getBoundingClientRect(); return {top:Math.round(b.top), bottom:Math.round(b.bottom), left:Math.round(b.left)}; }
        catch(e) { return null; } }""")


def wait_bubble_done(page, timeout=150):
    t0 = time.time()
    info = None
    while time.time() - t0 < timeout:
        info = bubble(page)
        if info and info.get("body") and info["body"] != "翻译中…" and not info.get("copyDisabled"):
            return info, time.time() - t0
        time.sleep(0.35)
    return info, time.time() - t0


def select_paragraph(page, sel_id):
    last_err = None
    for attempt in range(3):
        page.evaluate(
            """(id) => {
                 const el = document.getElementById(id);
                 const r = document.createRange(); r.selectNodeContents(el);
                 const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                 document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
               }""",
            sel_id,
        )
        try:
            page.wait_for_function(
                "() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
                " const i=r&&r.querySelector('.icon'); return !!(i && i.getBoundingClientRect().width > 0); }",
                timeout=5000,
            )
            return
        except Exception as e:
            last_err = e
            time.sleep(0.3)
    raise last_err


def click_icon(page):
    rect = shadow(page, "(() => { const i=r.querySelector('.icon'); const b=i.getBoundingClientRect();"
                        " return {x:b.left+b.width/2, y:b.top+b.height/2}; })()")
    page.mouse.click(rect["x"], rect["y"])


def click_shadow(page, selector):
    rect = shadow(page, f"(() => {{ const i=r.querySelector('{selector}'); const b=i.getBoundingClientRect();"
                        f" return {{x:b.left+b.width/2, y:b.top+b.height/2}}; }})()")
    page.mouse.click(rect["x"], rect["y"])


def triple_space(page):
    for _ in range(3):
        page.keyboard.press(" ")
        time.sleep(0.09)


def stat_text(page):
    return shadow(page, """(() => { const s=r.querySelector('.stat'); if(!s) return null;
        return {count:(s.querySelector('.count')||{}).textContent, note:(s.querySelector('.note')||{}).textContent,
                hidden:s.classList.contains('hide')}; })()""")


with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = browser.contexts[0]

    # 重新加载扩展，确保新 content.js 生效
    boot = ctx.new_page()
    boot.goto(EXT + "/options.html")
    try:
        boot.evaluate("() => chrome.runtime.reload()")
    except Exception:
        pass
    time.sleep(3)
    try:
        boot.close()
    except Exception:
        pass

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    opt.wait_for_function("() => !!document.getElementById('endpoint')", timeout=15000)
    opt.evaluate("""(d) => chrome.storage.sync.set(d)""", {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3,
        "timeoutSec": 60, "directionMode": "auto", "tripleSpaceEnabled": True,
        "tripleSpaceWindowMs": 800, "selectionEnabled": True, "pageMode": "dual",
        "batchChars": 800, "batchParagraphs": 6, "concurrency": 1,
        "ignoreDomains": "", "floatButton": False,
    })
    time.sleep(0.6)

    # 清掉历史遗留的测试标签，避免同 URL 多标签导致消息发错标签
    for pg in list(ctx.pages):
        if TEST_URL in (pg.url or ""):
            try:
                pg.close()
            except Exception:
                pass

    page = ctx.new_page()
    page.goto(TEST_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(0.5)

    # ---------- 准备：打开一个气泡 ----------
    select_paragraph(page, "p2")
    arm_clone(page)
    click_icon(page)
    info, dt = wait_bubble_done(page, 150)
    opened = bool(info and info.get("body"))
    record("0. 划词点图标后气泡正常出现（基线）", opened,
           {"方向标签": info and info.get("tag"), "译文": info and info.get("body"),
            "常驻提示": info and info.get("pin"), "耗时s": round(dt, 1)})
    page.screenshot(path=f"{SHOT}/b1-opened.png")

    # ---------- 验证 1：鼠标随意移动 3 秒 ----------
    random.seed(20261105)
    for _ in range(30):
        page.mouse.move(random.randint(20, 1260), random.randint(20, 780), steps=4)
        time.sleep(0.1)
    info1 = bubble(page)
    ok1 = info1 is not None and bool(info1.get("body"))
    page.screenshot(path=f"{SHOT}/b2-after-mousemove-3s.png")
    record("1. 鼠标随意移动 3 秒后气泡仍在", ok1,
           {"气泡存在": info1 is not None, "译文": info1 and (info1.get("body") or "")[:60],
            "位置": info1 and [info1["left"], info1["top"]]}, f"{SHOT}/b2-after-mousemove-3s.png")

    # ---------- 验证 2：滚动 500px，气泡跟随选区 ----------
    before = bubble(page)
    r0 = clone_rect(page)
    page.mouse.wheel(0, 500)
    time.sleep(0.8)
    after = bubble(page)
    r1 = clone_rect(page)
    moved = bool(before and after and abs(after["top"] - before["top"]) >= 20)
    # 用与实现相同的定位规则（锚点 rect + 上下翻转 + 视口钳制）复算期望位置
    exp = None
    if r1 and after:
        vh, h = 800, after["height"]
        if r1["bottom"] < 0:
            exp = 8
        elif r1["top"] > vh:
            exp = max(8, vh - h - 8)
        else:
            t = r1["bottom"] + 10
            if t + h > vh - 8:
                t = max(8, r1["top"] - h - 10)
            exp = max(8, min(t, max(8, vh - h - 8)))
    follow = bool(exp is not None and after and abs(after["top"] - exp) <= 4)
    ok2 = after is not None and bool(after.get("body")) and moved and follow
    page.screenshot(path=f"{SHOT}/b3-after-scroll-500.png")
    record("2. 滚动 500px 后气泡仍在且位置随选区更新", ok2,
           {"气泡存在": after is not None, "滚动前气泡top": before and before["top"],
            "滚动后气泡top": after and after["top"], "选区锚点top变化": [r0 and r0["top"], r1 and r1["top"]],
            "按定位规则复算的期望top": exp, "误差<=4px": follow}, f"{SHOT}/b3-after-scroll-500.png")

    # ---------- 验证 3：点击气泡外部（空白处 + 别的输入框，选区被清空） ----------
    page.mouse.click(1100, 200)
    time.sleep(0.4)
    info3a = bubble(page)
    page.click("#searchbox")
    time.sleep(0.5)
    info3 = bubble(page)
    sel_after_click = sel_rect(page)
    ok3 = (info3a is not None and info3 is not None and bool(info3.get("body")))
    page.screenshot(path=f"{SHOT}/b4-after-outside-click.png")
    record("3. 点击气泡外部（空白处/别的输入框）后气泡仍在", ok3,
           {"空白处单击后气泡存在": info3a is not None,
            "点搜索框后气泡存在": info3 is not None, "译文": info3 and (info3.get("body") or "")[:60],
            "浏览器选区已被清空": sel_after_click is None,
            "气泡位置": info3 and [info3["left"], info3["top"]]}, f"{SHOT}/b4-after-outside-click.png")

    # ---------- 验证 4a：Esc 关闭 ----------
    page.keyboard.press("Escape")
    time.sleep(0.4)
    closed = bubble_count(page) == 0
    record("4a. 按 Esc 关闭气泡", closed, {"气泡数量": bubble_count(page)})

    # ---------- 验证 4b：关闭按钮 ----------
    select_paragraph(page, "p3")
    click_icon(page)
    info4, dt4 = wait_bubble_done(page, 150)
    click_shadow(page, ".bubble .ft button:last-child")
    time.sleep(0.4)
    closed2 = bubble_count(page) == 0
    page.screenshot(path=f"{SHOT}/b5-closed-by-button.png")
    record("4b. 点气泡内『关闭』按钮关闭", closed2,
           {"关闭前译文": info4 and (info4.get("body") or "")[:60], "气泡数量": bubble_count(page),
            "本次翻译耗时s": round(dt4, 1)}, f"{SHOT}/b5-closed-by-button.png")

    # ---------- 验证 5：连续划两段，单实例替换 ----------
    select_paragraph(page, "p2")
    click_icon(page)
    first, _ = wait_bubble_done(page, 150)
    old_body = first and first.get("body")
    # 气泡仍开着，重新选另一段并点图标
    select_paragraph(page, "p4")
    click_icon(page)
    second, dt5 = wait_bubble_done(page, 150)
    cnt = bubble_count(page)
    ok5 = cnt == 1 and bool(second and second.get("body")) and second.get("body") != old_body
    page.screenshot(path=f"{SHOT}/b6-single-instance-replaced.png")
    record("5. 连续划词：只有一个气泡且内容被替换", ok5,
           {"气泡数量": cnt, "旧译文": (old_body or "")[:60],
            "新译文": second and (second.get("body") or "")[:60],
            "内容不同": bool(second and second.get("body") != old_body), "耗时s": round(dt5, 1)})
    page.keyboard.press("Escape")
    time.sleep(0.3)

    # ---------- 验证 5b：复制按钮保持气泡 + 已复制 ----------
    select_paragraph(page, "p1")
    click_icon(page)
    info6, _ = wait_bubble_done(page, 150)
    click_shadow(page, ".bubble .ft button:first-child")
    time.sleep(0.5)
    label = shadow(page, "(() => { const b=r.querySelector('.ft button'); return b && b.textContent; })()")
    still_open = bubble_count(page) == 1
    page.screenshot(path=f"{SHOT}/b7-copy-kept-bubble.png")
    record("5b. 复制后气泡保持且按钮显示『已复制』", still_open and label == "已复制",
           {"按钮文案": label, "气泡仍在": still_open}, f"{SHOT}/b7-copy-kept-bubble.png")
    page.keyboard.press("Escape")
    time.sleep(0.3)

    # ---------- 回归 1：三空格输入框翻译 ----------
    page.click("#plain")
    page.type("#plain", "这次修复不应该影响输入框的三空格翻译。", delay=0)
    time.sleep(0.2)
    triple_space(page)
    t0 = time.time()
    val = ""
    while time.time() - t0 < 90:
        val = page.input_value("#plain")
        if val.strip() and not any("\u4e00" <= c <= "\u9fff" for c in val):
            break
        time.sleep(0.3)
    ok7 = bool(val.strip()) and not any("\u4e00" <= c <= "\u9fff" for c in val) and val == val.rstrip()
    page.screenshot(path=f"{SHOT}/b8-regression-triple-space.png")
    record("6a. 回归：三空格翻译（含末尾无空格）", ok7,
           {"结果": val, "耗时s": round(time.time() - t0, 1)}, f"{SHOT}/b8-regression-triple-space.png")

    # ---------- 回归 2：整页翻译 + 还原（用新标签页，避免复用标签的偶发关闭） ----------
    try:
        page.keyboard.press("Escape")
        page.close()
    except Exception:
        pass
    page = ctx.new_page()
    page.goto(TEST_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    time.sleep(0.4)
    opt.evaluate("""async (url) => {
        const tabs = await new Promise(r => chrome.tabs.query({}, r));
        const t = tabs.filter(x => x.url && x.url.split('#')[0] === url).sort((a,b)=>b.id-a.id)[0];
        if (!t) return {ok:false};
        return await new Promise(r => chrome.tabs.sendMessage(t.id, {type:'toggle-page'}, r));
      }""", TEST_URL)
    t0 = time.time()
    spans = 0
    st = None
    while time.time() - t0 < 260:
        st = stat_text(page)
        spans = page.evaluate("() => document.querySelectorAll('.trf-tr-block').length")
        done = page.evaluate('() => document.querySelectorAll(\'[data-trf="done"]\').length')
        if st and (st.get("note") == "翻译完成") and spans > 0 and spans == done:
            break
        time.sleep(1.0)
    elapsed = time.time() - t0
    stats = page.evaluate("""() => ({
        spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf="done"]').length,
        multiBlocks: [...document.querySelectorAll('[data-trf="done"]')]
          .filter(b => b.querySelectorAll('.trf-tr-block').length !== 1).length,
        p1: !!document.querySelector('#p1 .trf-tr-block') })""")
    ok8 = stats["spans"] > 0 and stats["spans"] == stats["marks"] and stats["multiBlocks"] == 0 and stats["p1"]
    page.screenshot(path=f"{SHOT}/b9-regression-page-dual.png", full_page=True)
    record("6b. 回归：整页翻译（段落不合并）", ok8,
           {"译文块": stats["spans"], "原文块": stats["marks"], "并段块数": stats["multiBlocks"],
            "状态条": st, "耗时s": round(elapsed, 1)}, f"{SHOT}/b9-regression-page-dual.png")

    opt.evaluate("""async (url) => {
        const tabs = await new Promise(r => chrome.tabs.query({}, r));
        const t = tabs.filter(x => x.url && x.url.split('#')[0] === url).sort((a,b)=>b.id-a.id)[0];
        if (!t) return {ok:false};
        return await new Promise(r => chrome.tabs.sendMessage(t.id, {type:'toggle-page'}, r));
      }""", TEST_URL)
    time.sleep(1.5)
    restored = page.evaluate("""() => ({spans: document.querySelectorAll('.trf-tr-block').length,
        marks: document.querySelectorAll('[data-trf]').length})""")
    ok9 = restored["spans"] == 0 and restored["marks"] == 0
    page.screenshot(path=f"{SHOT}/b10-regression-restored.png")
    record("6c. 回归：再次触发还原原文", ok9, restored, f"{SHOT}/b10-regression-restored.png")

    log["total_seconds"] = round(time.time() - t_start, 1)
    log["passed"] = sum(1 for x in log["tests"] if x["pass"])
    log["failed"] = sum(1 for x in log["tests"] if not x["pass"])
    with open(f"{SHOT}/bubble-report.json", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f"\n=== {log['passed']} 通过 / {log['failed']} 失败，总耗时 {log['total_seconds']}s ===")
    browser.close()
