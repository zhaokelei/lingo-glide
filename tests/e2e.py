#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地翻译扩展 · 实机验收脚本（Edge + CDP + Playwright）"""
import json, os, time
from playwright.sync_api import sync_playwright

EXT_ID = "flpkblpfaaipejpfphekemnkhnpglofl"
EXT = f"chrome-extension://{EXT_ID}"
TEST_URL = "http://127.0.0.1:8099/test.html"
SHOT = "test-results"
os.makedirs(SHOT, exist_ok=True)

log = {"tests": [], "env": {"browser": "Microsoft Edge 156 (Chromium) via CDP", "test_url": TEST_URL}}
t_start = time.time()


def record(name, ok, detail, shot=None):
    entry = {"case": name, "pass": bool(ok), "detail": detail, "shot": shot, "at": round(time.time() - t_start, 1)}
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


def toast_text(page):
    return page.evaluate(
        "() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
        " const t=r&&r.querySelector('.toast'); return t ? {text:t.textContent, show:t.classList.contains('show'), cls:t.className} : null; }"
    )


def stat_text(page):
    return page.evaluate(
        "() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
        " const s=r&&r.querySelector('.stat'); if(!s) return null;"
        " return {count:(s.querySelector('.count')||{}).textContent, note:(s.querySelector('.note')||{}).textContent, hidden:s.classList.contains('hide')}; }"
    )


def wait_value_no_cjk(page, sel, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = page.evaluate(
            "(sel) => { const e=document.querySelector(sel); return e ? (e.value !== undefined ? e.value : e.innerText) : null; }", sel
        )
        if v and len(v.strip()) > 2 and not any("\u4e00" <= c <= "\u9fff" for c in v):
            return v, time.time() - t0
        time.sleep(0.25)
    return page.evaluate(
        "(sel) => { const e=document.querySelector(sel); return e ? (e.value !== undefined ? e.value : e.innerText) : null; }", sel
    ), time.time() - t0


def triple_space(page):
    for i in range(3):
        page.keyboard.press(" ")
        time.sleep(0.09)


def set_settings(opt_page, data):
    opt_page.evaluate("(d) => chrome.storage.sync.set(d)", data)


def toggle_page(opt_page, page):
    return opt_page.evaluate(
        """async (url) => {
             const tabs = await new Promise(r => chrome.tabs.query({}, r));
             const t = tabs.find(x => x.url && x.url.split('#')[0] === url);
             if (!t) return {ok:false, error:'未找到标签页'};
             const res = await new Promise(r => chrome.tabs.sendMessage(t.id, {type:'toggle-page'}, r));
             return {ok:true, res, tabId:t.id};
           }""",
        page.url.split("#")[0],
    )


def select_paragraph(page, sel_id):
    page.evaluate(
        """(id) => {
             const el = document.getElementById(id);
             const r = document.createRange(); r.selectNodeContents(el);
             const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
             document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
           }""",
        sel_id,
    )
    page.wait_for_function(
        "() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;"
        " const i=r&&r.querySelector('.icon'); return !!(i && i.getBoundingClientRect().width > 0); }",
        timeout=5000,
    )


def click_icon(page):
    rect = shadow(page, "(() => { const i=r.querySelector('.icon'); const b=i.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2}; })()")
    page.mouse.click(rect["x"], rect["y"])


def bubble_info(page):
    return shadow(page, """(() => {
        const b = r.querySelector('.bubble'); if (!b) return null;
        const tag = b.querySelector('.tag'); const body = b.querySelector('.body');
        const copy = b.querySelector('.ft button'); 
        return {tag: tag && tag.textContent, body: body && body.textContent,
                copyDisabled: copy ? copy.disabled : null,
                visible: b.getBoundingClientRect().width > 0};
      })()""")


with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = browser.contexts[0]

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    # 每次实验都从干净设置开始
    set_settings(opt, {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3,
        "timeoutSec": 60, "directionMode": "auto", "tripleSpaceEnabled": True,
        "tripleSpaceWindowMs": 800, "selectionEnabled": True, "pageMode": "dual",
        "batchChars": 800, "batchParagraphs": 6, "concurrency": 1,
        "ignoreDomains": "", "floatButton": False,
    })
    time.sleep(0.5)

    # ---------- 用例 1：普通 textarea ----------
    page = ctx.new_page()
    page.goto(TEST_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    page.click("#plain")
    page.type("#plain", "本地翻译扩展需要把这段话翻译成英文。", delay=0)
    time.sleep(0.2)
    triple_space(page)
    val, dt = wait_value_no_cjk(page, "#plain")
    ok = bool(val) and not any("\u4e00" <= c <= "\u9fff" for c in val) and val == val.rstrip()
    shot = f"{SHOT}/01-textarea.png"
    page.screenshot(path=shot)
    record("1. 普通 textarea 三空格翻译", ok,
           {"原文": "本地翻译扩展需要把这段话翻译成英文。", "结果": val, "耗时s": round(dt, 1),
            "末尾无空格": val == val.rstrip()}, shot)

    # ---------- 用例 2：React 风格受控 textarea ----------
    page.click("#ctrl")
    page.type("#ctrl", "这段文字用来验证受控组件不会被还原。", delay=0)
    time.sleep(0.2)
    triple_space(page)
    val2, dt2 = wait_value_no_cjk(page, "#ctrl")
    time.sleep(1.5)  # 等待受控组件的 rAF 回写
    val2_after = page.input_value("#ctrl")
    ok = val2 == val2_after and bool(val2) and not any("\u4e00" <= c <= "\u9fff" for c in val2)
    shot = f"{SHOT}/02-controlled-textarea.png"
    page.screenshot(path=shot)
    record("2. React 风格受控 textarea 三空格翻译", ok,
           {"结果": val2, "1.5s 后仍保持": val2 == val2_after, "耗时s": round(dt2, 1)}, shot)

    # ---------- 用例 3：contenteditable ----------
    page.click("#ce")
    page.type("#ce", "富文本框里的内容也应该被翻译成英文。", delay=0)
    time.sleep(0.2)
    triple_space(page)
    val3, dt3 = wait_value_no_cjk(page, "#ce")
    focus_ok = page.evaluate("() => document.activeElement && document.activeElement.id === 'ce'")
    caret_ok = page.evaluate(
        """() => { const el=document.getElementById('ce'); const s=getSelection();
             if (!s || s.rangeCount===0) return false;
             const r=s.getRangeAt(0); const box=document.createRange(); box.selectNodeContents(el); box.setEnd(r.endContainer, r.endOffset);
             return box.toString().length === el.innerText.length; }"""
    )
    ok = bool(val3) and not any("\u4e00" <= c <= "\u9fff" for c in val3) and focus_ok
    shot = f"{SHOT}/03-contenteditable.png"
    page.screenshot(path=shot)
    record("3. contenteditable 三空格翻译", ok,
           {"结果": val3, "焦点保持": focus_ok, "光标在末尾": caret_ok, "耗时s": round(dt3, 1)}, shot)

    # ---------- 用例 4：搜索框 / 密码框不触发 ----------
    page.click("#searchbox")
    page.type("#searchbox", "你好世界", delay=0)
    triple_space(page)
    time.sleep(2)
    page.click("#pwd")
    page.type("#pwd", "你好世界", delay=0)
    triple_space(page)
    time.sleep(1)
    s_val = page.input_value("#searchbox")
    p_val = page.input_value("#pwd")
    t = toast_text(page)
    ok = s_val.startswith("你好世界") and p_val.startswith("你好世界") and not (t and "翻译中" in t.get("text", "") and t.get("show"))
    record("4. 搜索框/密码框不触发", ok,
           {"搜索框": s_val, "密码框": p_val, "toast": t}, f"{SHOT}/04-excluded-inputs.png")

    # ---------- 用例 5：划词（英文→中文） ----------
    page.mouse.click(30, 30)  # 清空残留选区/气泡
    select_paragraph(page, "p1")
    shot = f"{SHOT}/05-selection-icon.png"
    page.screenshot(path=shot)
    icon_ok = bool(shadow(page, "(() => { const i=r.querySelector('.icon'); return i && i.getBoundingClientRect().width > 0 ? {x:i.getBoundingClientRect().left, y:i.getBoundingClientRect().top} : null; })()"))
    click_icon(page)
    t0 = time.time()
    info = None
    while time.time() - t0 < 120:
        info = bubble_info(page)
        if info and info.get("body") and not any("\u4e00" <= c <= "\u9fff" for c in "") and info["body"] != "翻译中…" and not info["copyDisabled"]:
            break
        time.sleep(0.4)
    has_cjk = bool(info and info.get("body") and any("\u4e00" <= c <= "\u9fff" for c in info["body"]))
    tag_ok = bool(info and "检测：英文 → 简体中文" in (info.get("tag") or ""))
    ok = icon_ok and has_cjk and tag_ok and info["visible"]
    shot2 = f"{SHOT}/06-selection-bubble.png"
    page.screenshot(path=shot2)
    record("5. 划词图标 + 英文→中文气泡", ok,
           {"浮出图标": icon_ok, "方向标签": info and info.get("tag"), "译文": info and info.get("body"),
            "复制按钮可用": info and not info.get("copyDisabled"), "耗时s": round(time.time() - t0, 1)}, shot2)

    # Esc 关闭
    page.keyboard.press("Escape")
    time.sleep(0.3)
    closed = bubble_info(page) is None
    record("6. Esc 关闭气泡", closed, {"气泡已关闭": closed})

    # ---------- 用例 7：划词（中文→英文） ----------
    select_paragraph(page, "p0cn")
    click_icon(page)
    t0 = time.time()
    info = None
    while time.time() - t0 < 120:
        info = bubble_info(page)
        if info and info.get("body") and info["body"] != "翻译中…" and not info.get("copyDisabled"):
            break
        time.sleep(0.4)
    no_cjk = bool(info and info.get("body") and not any("\u4e00" <= c <= "\u9fff" for c in info["body"]))
    tag_ok = bool(info and "检测：中文 → English" in (info.get("tag") or ""))
    ok = no_cjk and tag_ok
    shot = f"{SHOT}/07-selection-zh-en.png"
    page.screenshot(path=shot)
    record("7. 划词中文→英文方向", ok, {"方向标签": info and info.get("tag"), "译文": info and info.get("body")}, shot)
    page.keyboard.press("Escape")

    # ---------- 用例 8：整页翻译 ----------
    page.mouse.click(30, 30)
    page.close()
    page = ctx.new_page()
    page.goto(TEST_URL, wait_until="domcontentloaded")
    page.bring_to_front()
    page.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    time.sleep(0.5)

    used_alt = True
    page.keyboard.press("Alt+t")
    time.sleep(2.5)
    started = page.evaluate("() => !!document.querySelector('[data-trf]')")
    if not started:
        used_alt = False
        toggle_page(opt, page)
        time.sleep(1.5)

    t0 = time.time()
    samples = []
    last_count = -1
    while time.time() - t0 < 300:
        st = stat_text(page)
        cnt = page.evaluate("() => document.querySelectorAll('.trf-tr-block').length")
        done = page.evaluate("() => document.querySelectorAll('[data-trf=\"done\"]').length")
        if st and st.get("count"):
            samples.append(st["count"])
        if cnt != last_count:
            last_count = cnt
        finished = st and st.get("note") == "翻译完成"
        if (finished or (st and st.get("hidden"))) and cnt > 0 and cnt == done:
            break
        time.sleep(1.2)

    elapsed = time.time() - t0
    stats = page.evaluate(
        """() => {
             const spans = [...document.querySelectorAll('.trf-tr-block')];
             const blocks = [...document.querySelectorAll('[data-trf="done"]')];
             const perBlock = blocks.map(b => ({tag: b.tagName, id: b.id, spans: b.querySelectorAll('.trf-tr-block').length}));
             const multi = perBlock.filter(x => x.spans !== 1);
             const style = spans.length ? getComputedStyle(spans[0]) : null;
             return {spans: spans.length, blocks: blocks.length, multi, 
                     style: style ? {display: style.display, fontStyle: style.fontStyle, borderLeft: style.borderLeftWidth, opacity: style.opacity} : null,
                     sampleText: spans.length ? spans[0].textContent.slice(0, 120) : null,
                     p1HasSpan: !!document.querySelector('#p1 .trf-tr-block'),
                     p2HasSpan: !!document.querySelector('#p2 .trf-tr-block')};
           }"""
    )
    ok = stats["spans"] > 0 and stats["spans"] == stats["blocks"] and not stats["multi"] and stats["p1HasSpan"]
    shot = f"{SHOT}/08-page-dual.png"
    page.screenshot(path=shot, full_page=True)
    record("8. 整页翻译（双语对照）", ok,
           {"触发方式": "Alt+T 快捷键" if used_alt else "扩展消息（同一函数路径）",
            "译文块数": stats["spans"], "已标记原文块数": stats["blocks"], "每块译文数异常": stats["multi"],
            "样式": stats["style"], "样例译文": stats["sampleText"],
            "进度采样": samples[-4:], "耗时s": round(elapsed, 1)}, shot)

    # 用例 9：再次触发还原
    if used_alt:
        page.keyboard.press("Alt+t")
    else:
        toggle_page(opt, page)
    time.sleep(2)
    restored = page.evaluate(
        """() => ({spans: document.querySelectorAll('.trf-tr-block').length,
                   marks: document.querySelectorAll('[data-trf]').length,
                   p1: (document.getElementById('p1')||{}).textContent})"""
    )
    ok = restored["spans"] == 0 and restored["marks"] == 0 and "Local translation keeps your text" in (restored["p1"] or "")
    shot = f"{SHOT}/09-page-restored.png"
    page.screenshot(path=shot)
    record("9. 再次触发还原原文", ok, restored, shot)

    # ---------- 用例 10：服务未连接 ----------
    set_settings(opt, {"endpoint": "http://127.0.0.1:8098/v1"})
    time.sleep(0.8)
    # 10a 三空格
    page.click("#plain")
    page.type("#plain", "服务断开时的提示测试。", delay=0)
    triple_space(page)
    t0 = time.time()
    t = None
    while time.time() - t0 < 30:
        t = toast_text(page)
        if t and ("未连接" in t.get("text", "") or "失败" in t.get("text", "")):
            break
        time.sleep(0.4)
    ok_a = bool(t and "未连接" in t.get("text", ""))
    shot = f"{SHOT}/10a-service-down-input.png"
    page.screenshot(path=shot)
    record("10a. 服务未连接 · 输入框提示", ok_a, {"toast": t, "耗时s": round(time.time() - t0, 1)}, shot)

    # 10b 划词
    page.keyboard.press("Escape")
    page.mouse.click(30, 30)
    select_paragraph(page, "p2")
    click_icon(page)
    t0 = time.time()
    info = None
    while time.time() - t0 < 30:
        info = bubble_info(page)
        if info and info.get("body") and ("未连接" in info["body"] or "失败" in info["body"]):
            break
        time.sleep(0.4)
    ok_b = bool(info and "未连接" in (info.get("body") or ""))
    shot = f"{SHOT}/10b-service-down-selection.png"
    page.screenshot(path=shot)
    record("10b. 服务未连接 · 划词提示", ok_b, {"气泡": info and info.get("body")}, shot)
    page.keyboard.press("Escape")

    # 10c 整页
    toggle_page(opt, page)
    t0 = time.time()
    st = None
    while time.time() - t0 < 40:
        st = stat_text(page)
        if st and ("未连接" in (st.get("note") or "")):
            break
        time.sleep(0.5)
    ok_c = bool(st and "未连接" in (st.get("note") or ""))
    shot = f"{SHOT}/10c-service-down-page.png"
    page.screenshot(path=shot)
    record("10c. 服务未连接 · 整页提示", ok_c, {"状态条": st, "耗时s": round(time.time() - t0, 1)}, shot)

    # 还原设置
    set_settings(opt, {"endpoint": "http://127.0.0.1:8080/v1"})
    time.sleep(0.5)
    # 清掉半翻译状态
    toggle_page(opt, page)
    time.sleep(1)

    log["total_seconds"] = round(time.time() - t_start, 1)
    log["passed"] = sum(1 for x in log["tests"] if x["pass"])
    log["failed"] = sum(1 for x in log["tests"] if not x["pass"])
    with open(f"{SHOT}/report.json", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f"\n=== {log['passed']} 通过 / {log['failed']} 失败，总耗时 {log['total_seconds']}s ===")
    browser.close()
