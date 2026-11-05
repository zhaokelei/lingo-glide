#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v4 验证：富文本回填三级兜底 + 守护窗口 + 自定义快捷键 + 回归"""
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
    print(("PASS " if ok else "FAIL ") + name + " :: " + json.dumps(detail, ensure_ascii=False)[:600], flush=True)


def cjk_ratio(s):
    s = s or ""
    if not s.strip():
        return 0
    n = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")
    return n / len(s)


def wait_field(page, el_id, pred, timeout=90):
    t = time.time()
    last = ""
    while time.time() - t < timeout:
        try:
            last = page.evaluate("(id) => { const e=document.getElementById(id); return e ? (e.value!=null && e.tagName!=='DIV' ? e.value : e.innerText) : ''; }", el_id)
        except Exception:
            last = ""
        if pred(last):
            return True, last, time.time() - t
        time.sleep(0.05)
    return False, last, time.time() - t


def timeline(page):
    raw = page.evaluate("() => document.documentElement.getAttribute('data-trf-timeline')")
    return json.loads(raw) if raw else []


def toasts(page):
    return page.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        if(!r) return []; return [...r.querySelectorAll('.toast,.toast-card,.tiptext')].map(x=>x.textContent); }""")


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


def clear_field(page, el_id):
    page.click("#" + el_id)
    page.keyboard.press("Control+A")
    page.keyboard.press("Backspace")
    time.sleep(0.15)


def type_text(page, el_id, text):
    tag = page.evaluate("(id) => { const e=document.getElementById(id); return e ? e.tagName : ''; }", el_id)
    if tag in ("INPUT", "TEXTAREA"):
        page.fill("#" + el_id, "")
    else:
        clear_field(page, el_id)
    page.click("#" + el_id)
    page.keyboard.type(text, delay=8)
    time.sleep(0.15)


def press_shortcut(page, combo):
    page.keyboard.press(combo)


def get_sync(page, keys):
    return page.evaluate("(keys) => new Promise(r => chrome.storage.sync.get(keys, r))", keys)


def set_sync(page, patch):
    page.evaluate("(p) => new Promise(r => chrome.storage.sync.set(p, r))", patch)


with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = br.contexts[0]

    boot = ctx.new_page()
    try:
        boot.goto(EXT + "/options.html", wait_until="domcontentloaded", timeout=15000)
    except Exception as e:
        print("WARN options direct open failed:", str(e)[:120], flush=True)
    time.sleep(2)
    try: boot.close()
    except Exception: pass

    opt = ctx.new_page()
    opt.goto(EXT + "/options.html")
    opt.wait_for_function("() => !!document.getElementById('endpoint')", timeout=15000)

    set_sync(opt, {
        "endpoint": "http://127.0.0.1:8080/v1", "model": "hy-mt2", "temperature": 0.3, "timeoutSec": 60,
        "directionMode": "auto", "tripleSpaceEnabled": True, "tripleSpaceWindowMs": 800,
        "shortcutTranslateEnabled": True, "inputShortcut": "Ctrl+Shift+Enter", "debugFill": True,
        "selectionEnabled": True, "pageMode": "dual", "batchChars": 800, "batchParagraphs": 6,
        "concurrency": 1, "ignoreDomains": "", "floatButton": True, "targetLang": "zh-Hans",
        "cacheTTL": 30, "sourceLang": "auto", "autoPromptEnPage": False, "followSourceLang": False
    })
    opt.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'cache-clear'}, r))")
    time.sleep(0.5)

    # ================= A. 模拟页 A：写入后被内部 state 立即还原 =================
    pa = ctx.new_page()
    pa.goto(BASE + "/lexical_sim.html?mode=revert", wait_until="domcontentloaded")
    pa.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pa.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.6)

    type_text(pa, "mc", "hello")
    press_shortcut(pa, "Control+Shift+Enter")
    ok, txt, dur = wait_field(pa, "mc", lambda s: cjk_ratio(s) > 0.2, timeout=60)
    time.sleep(1.9)
    txt = pa.evaluate("() => document.getElementById('mc').innerText")
    tl = timeline(pa)
    log["timeline"]["A_word"] = tl
    levels = {x["label"]: x for x in tl}
    rec("A1 单词：回填成功（最终显示译文，守护后仍保持）",
        cjk_ratio(txt) > 0.5 and not re.search(r"[A-Za-z]{3,}", txt),
        {"最终文本": txt[:60], "耗时s": round(dur, 2), "level1_match": (levels.get("level1") or {}).get("match"),
         "level2_match": (levels.get("level2") or {}).get("match"),
         "阶段": [(x["label"], x.get("t"), x.get("match")) for x in tl]},
        f"{SHOT}/v4-lexical-word.png")
    pa.screenshot(path=f"{SHOT}/v4-lexical-word.png")

    type_text(pa, "mc", "Where are you now? I have been waiting for your reply for a while.")
    press_shortcut(pa, "Control+Shift+Enter")
    ok2, txt2, dur2 = wait_field(pa, "mc", lambda s: cjk_ratio(s) > 0.2, timeout=90)
    time.sleep(1.9)
    txt2 = pa.evaluate("() => document.getElementById('mc').innerText")
    tl2 = timeline(pa)
    log["timeline"]["A_sentence"] = tl2
    lv2 = {x["label"]: x for x in tl2}
    rec("A2 句子：写入被 state 还原后走 paste 成功（守护后保持）",
        cjk_ratio(txt2) > 0.5 and not re.search(r"[A-Za-z]{3,}", txt2),
        {"最终文本": txt2[:80], "耗时s": round(dur2, 2), "level1_match": (lv2.get("level1") or {}).get("match"),
         "level2_match": (lv2.get("level2") or {}).get("match"),
         "阶段": [(x["label"], x.get("t"), x.get("match")) for x in tl2]},
        f"{SHOT}/v4-lexical-sentence.png")
    pa.screenshot(path=f"{SHOT}/v4-lexical-sentence.png")

    # ================= B. 模拟页 B：延迟 600ms 还原（守护窗口重试） =================
    pb = ctx.new_page()
    pb.goto(BASE + "/lexical_sim.html?mode=delayed", wait_until="domcontentloaded")
    pb.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pb.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.6)
    type_text(pb, "mc", "Please send me the latest report before Friday evening.")
    press_shortcut(pb, "Control+Shift+Enter")
    okb, txtb, durb = wait_field(pb, "mc", lambda s: cjk_ratio(s) > 0.2, timeout=90)
    time.sleep(1.6)
    tlb = timeline(pb)
    log["timeline"]["B_delayed"] = tlb
    labels_b = [x["label"] for x in tlb]
    retry = [x for x in tlb if x["label"].startswith("guard-retry")]
    final = pb.evaluate("() => document.getElementById('mc').innerText")
    rec("B 延迟还原：守护窗口重试 paste 后最终为译文", okb and cjk_ratio(final) > 0.2 and bool(retry),
        {"最终文本": final[:80], "写入后端口": [l for l in labels_b if l.startswith("guard")],
         "guard@800_match": next((x.get("match") for x in tlb if x["label"] == "guard@800"), None),
         "重试次数": len(retry), "重试结果": [x.get("ok") for x in retry],
         "还原标记": pb.evaluate("() => !!window.__reverted")},
        f"{SHOT}/v4-guard-retry.png")
    pb.screenshot(path=f"{SHOT}/v4-guard-retry.png")

    # ================= C. 模拟页 B2：完全拒绝写入 → 译文卡片 =================
    pc = ctx.new_page()
    pc.goto(BASE + "/lexical_sim.html?mode=lock", wait_until="domcontentloaded")
    pc.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pc.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.8)
    before = pc.evaluate("() => document.getElementById('mc').innerText")
    pc.click("#mc")
    press_shortcut(pc, "Control+Shift+Enter")
    card = None
    t = time.time()
    while time.time() - t < 90:
        card = shadow_html(pc, ".paste-card")
        if card:
            break
        time.sleep(0.2)
    body = shadow_html(pc, ".paste-card .pc-body")
    note = shadow_html(pc, ".paste-card .pc-note")
    after = pc.evaluate("() => document.getElementById('mc').innerText")
    rec("C 完全拒绝写入：降级到译文卡片且原文未破坏",
        bool(card and body and cjk_ratio(body) > 0.2 and after.strip() == before.strip()),
        {"卡片": bool(card), "译文": (body or "")[:80], "说明": note, "原文": before[:60], "写入后": after[:60],
         "时间线": [(x["label"], x.get("match")) for x in timeline(pc)]},
        f"{SHOT}/v4-fill-card.png")
    shadow_click(pc, ".paste-card .pc-copy")
    time.sleep(0.6)
    copy_ok = shadow_html(pc, ".paste-card .pc-ok")
    rec("C2 卡片「复制译文」可用", bool(copy_ok and ("已复制" in copy_ok or "失败" in copy_ok)), {"按钮状态": copy_ok})
    pc.screenshot(path=f"{SHOT}/v4-fill-card.png")

    # ================= D. 模拟页 C：翻译期间继续输入 =================
    pd = ctx.new_page()
    pd.goto(BASE + "/lexical_sim.html?mode=revert", wait_until="domcontentloaded")
    pd.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pd.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.6)
    type_text(pd, "mc", "I am writing a rather long sentence so that the model needs some time to translate it.")
    press_shortcut(pd, "Control+Shift+Enter")
    time.sleep(0.7)
    pd.keyboard.type(" extra", delay=10)
    time.sleep(3)
    txtd = pd.evaluate("() => document.getElementById('mc').innerText")
    tst = toasts(pd)
    rec("D 翻译中继续输入：不覆盖新输入并提示", "extra" in txtd and cjk_ratio(txtd) < 0.1,
        {"最终文本": txtd, "提示": tst[-3:]})

    # ================= E. 普通 input / textarea 回归（一级成功） =================
    pe = ctx.new_page()
    pe.goto(BASE + "/test.html", wait_until="domcontentloaded")
    pe.wait_for_function("document.documentElement.hasAttribute('data-trf-ext')", timeout=15000)
    pe.set_viewport_size({"width": 1280, "height": 900})
    time.sleep(0.8)

    def fill_clear(page, el_id):
        page.fill("#" + el_id, "")
        time.sleep(0.15)

    fill_clear(pe, "plain")
    pe.click("#plain")
    pe.keyboard.type("Hello there, this is a plain textarea test.", delay=8)
    time.sleep(0.15)
    press_shortcut(pe, "Control+Shift+Enter")
    oke, tv, due = wait_field(pe, "plain", lambda s: cjk_ratio(s) > 0.5 and not re.search(r"[A-Za-z]{3,}", s), timeout=60)
    time.sleep(0.4)
    tv = pe.evaluate("() => document.getElementById('plain').value")
    cur1 = pe.evaluate("() => { const e=document.getElementById('plain'); return {sel:e.selectionStart, len:e.value.length}; }")
    rec("E1 textarea 快捷键一级回填", oke and cjk_ratio(tv) > 0.5 and not tv.endswith(" "),
        {"输出": tv[:60], "耗时s": round(due, 2), "光标": cur1})

    fill_clear(pe, "plain")
    pe.click("#plain")
    pe.keyboard.type("Please open the window, it is quite warm in this room.", delay=8)
    for _ in range(3):
        pe.keyboard.press(" ")
        time.sleep(0.05)
    oke2, tv2, due2 = wait_field(pe, "plain", lambda s: cjk_ratio(s) > 0.5 and not re.search(r"[A-Za-z]{3,}", s), timeout=60)
    time.sleep(0.4)
    tv2 = pe.evaluate("() => document.getElementById('plain').value")
    cur2 = pe.evaluate("() => { const e=document.getElementById('plain'); return {sel:e.selectionStart, len:e.value.length}; }")
    rec("E2 textarea 三空格回归", oke2 and cjk_ratio(tv2) > 0.5 and not tv2.endswith(" "),
        {"输出": tv2[:60], "耗时s": round(due2, 2), "光标": cur2})

    pd.bring_to_front()
    fill_clear(pd, "inp")
    pd.click("#inp")
    pd.keyboard.type("Good morning everyone.", delay=8)
    time.sleep(0.15)
    press_shortcut(pd, "Control+Shift+Enter")
    oke3, tv3, due3 = wait_field(pd, "inp", lambda s: cjk_ratio(s) > 0.5 and not re.search(r"[A-Za-z]{3,}", s), timeout=60)
    time.sleep(0.3)
    tv3 = pd.evaluate("() => document.getElementById('inp').value")
    cur3 = pd.evaluate("() => { const e=document.getElementById('inp'); return {sel:e.selectionStart, len:e.value.length}; }")
    rec("E3 input 快捷键回填", oke3 and cjk_ratio(tv3) > 0.5, {"输出": tv3[:60], "耗时s": round(due3, 2), "光标": cur3})

    # ================= F. 快捷键录制（设置页 UI） =================
    opt.bring_to_front()
    def record_combo(combo):
        opt.click("#recordShortcut")
        time.sleep(0.2)
        press_shortcut(opt, combo)
        time.sleep(0.6)

    record_combo("Control+Shift+Enter")
    s1 = get_sync(opt, ["inputShortcut"])
    txt1 = opt.evaluate("() => document.getElementById('inputShortcutText').textContent")
    res1 = opt.evaluate("() => document.getElementById('shortcutResult').textContent")
    rec("F1 录制默认 Ctrl+Shift+Enter 并保存", s1.get("inputShortcut") == "Ctrl+Shift+Enter",
        {"storage": s1, "显示": txt1, "提示": res1})

    # 当前页立即生效：不刷新，用新组合 Alt+Q
    record_combo("Alt+Q")
    s2 = get_sync(opt, ["inputShortcut"])
    txt2 = opt.evaluate("() => document.getElementById('inputShortcutText').textContent")
    rec("F2 录制 Alt+Q 并保存", s2.get("inputShortcut") == "Alt+Q", {"storage": s2, "显示": txt2})

    pe.bring_to_front()
    time.sleep(0.4)
    type_text(pe, "plain", "This tests the custom shortcut without reloading.")
    press_shortcut(pe, "Alt+Q")
    okf, tvf, duf = wait_field(pe, "plain", lambda s: cjk_ratio(s) > 0.2, timeout=60)
    rec("F3 保存后当前页立即用 Alt+Q（未刷新）", okf, {"输出": tvf[:60], "耗时s": round(duf, 2)})

    type_text(pe, "plain", "This old shortcut should not trigger anymore.")
    press_shortcut(pe, "Control+Shift+Enter")
    time.sleep(1.2)
    old_val = pe.evaluate("() => document.getElementById('plain').value")
    rec("F4 旧组合 Ctrl+Shift+Enter 不再触发", cjk_ratio(old_val) < 0.15, {"内容": old_val[:60]})

    # 冲突与校验
    opt.bring_to_front()
    record_combo("Alt+T")
    s3 = get_sync(opt, ["inputShortcut"])
    res3 = opt.evaluate("() => document.getElementById('shortcutResult').textContent")
    rec("F5 与整页翻译 Alt+T 冲突被拒绝", s3.get("inputShortcut") == "Alt+Q" and "冲突" in res3,
        {"storage": s3, "提示": res3})

    opt.click("#recordShortcut")
    time.sleep(0.2)
    opt.keyboard.press("q")
    time.sleep(0.5)
    s4 = get_sync(opt, ["inputShortcut"])
    res4 = opt.evaluate("() => document.getElementById('shortcutResult').textContent")
    rec("F6 无修饰键的单键被拒绝", s4.get("inputShortcut") == "Alt+Q" and "修饰键" in res4,
        {"storage": s4, "提示": res4})

    opt.click("#resetShortcut")
    time.sleep(0.5)
    s5 = get_sync(opt, ["inputShortcut"])
    rec("F7 恢复默认快捷键", s5.get("inputShortcut") == "Ctrl+Shift+Enter", {"storage": s5})

    # 关闭快捷键开关后失效
    opt.evaluate("() => { const el=document.getElementById('shortcutTranslateEnabled'); el.checked=false; el.dispatchEvent(new Event('change',{bubbles:true})); }")
    time.sleep(0.4)
    pe.bring_to_front()
    time.sleep(0.3)
    type_text(pe, "plain", "Shortcut disabled should not translate this.")
    press_shortcut(pe, "Control+Shift+Enter")
    time.sleep(1.2)
    v_off = pe.evaluate("() => document.getElementById('plain').value")
    rec("F8 关闭「启用快捷键」后不再触发", cjk_ratio(v_off) < 0.15, {"内容": v_off[:60]})
    opt.evaluate("() => { const el=document.getElementById('shortcutTranslateEnabled'); el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); }")
    time.sleep(0.4)

    # ================= G. popup 快捷键提示 =================
    tabs = opt.evaluate("""async (url) => { const tabs = await new Promise(r => chrome.tabs.query({}, r));
        return tabs.filter(t => t.url && t.url.split('#')[0] === url).map(t => t.id); }""", BASE + "/test.html")
    tid = tabs[0] if tabs else None
    pop = ctx.new_page()
    pop.goto(f"{EXT}/popup.html" + (f"?tabId={tid}" if tid else ""))
    pop.wait_for_function("() => !!document.getElementById('shortcutHint')", timeout=15000)
    time.sleep(1.0)
    hint = pop.evaluate("() => document.getElementById('shortcutHint').textContent")
    rec("G1 popup 显示当前快捷键", "Ctrl" in hint or "⌘" in hint, {"提示": hint})
    pop.evaluate("() => new Promise(r => chrome.storage.sync.set({inputShortcut:'Alt+Q'}, r))")
    time.sleep(0.8)
    hint2 = pop.evaluate("() => document.getElementById('shortcutHint').textContent")
    rec("G2 popup 提示随 storage 变化即时更新", ("Alt" in hint2 or "⌥" in hint2) and hint2 != hint, {"更新后": hint2})
    pop.evaluate("() => new Promise(r => chrome.storage.sync.set({inputShortcut:'Ctrl+Shift+Enter'}, r))")
    pop.close()

    # ================= H. 回归：划词 / 整页 / 缓存 =================
    pe.bring_to_front()
    time.sleep(0.3)
    pe.evaluate("""() => { const el=document.getElementById('plain'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }""")
    # 划词气泡
    pe.evaluate("""() => { const el=document.getElementById('p3'); const rg=document.createRange();
        rg.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }""")
    time.sleep(0.5)
    icon = pe.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
        const i=r&&r.querySelector('.icon'); if(!i) return null; const b=i.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2}; }""")
    if icon:
        pe.mouse.click(icon["x"], icon["y"])
    bubble = None
    t = time.time()
    while time.time() - t < 40:
        bubble = pe.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
            const b=r&&r.querySelector('.bubble'); return b ? b.textContent : null; }""")
        if bubble:
            break
        time.sleep(0.2)
    rec("H1 划词气泡回归", bool(bubble), {"气泡": (bubble or "")[:80]}, f"{SHOT}/v4-regression-bubble.png")
    pe.keyboard.press("Escape")

    # 整页翻译（中文页 → 英文）
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
    spans = marks = 0
    st = ""
    while time.time() - t < 120:
        st = pg.evaluate("""() => { const h=document.getElementById('trf-root'); const r=h&&h.shadowRoot;
            const s=r&&r.querySelector('.stat .note'); return s ? s.textContent : ''; }""")
        spans = pg.evaluate("() => document.querySelectorAll('.trf-tr-block').length")
        marks = pg.evaluate("() => document.querySelectorAll('[data-trf]').length")
        if st and st.startswith("翻译完成") and spans >= 6:
            done = True
            break
        time.sleep(0.5)
    rec("H2 整页翻译回归（中文→英文 6 段）", done, {"译块": spans, "标记": marks, "状态": st,
                                               "耗时s": round(time.time() - t, 1)})
    pg.screenshot(path=f"{SHOT}/v4-regression-page.png")

    cs = opt.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'cache-stats'}, r))")
    rec("H3 缓存统计仍工作", bool(cs and cs.get("count", 0) > 0), {"统计": cs})

    log["env"] = {"browser": "Edge via CDP", "server": "127.0.0.1:8080 hy-mt2"}
    json.dump(log, open(f"{SHOT}/v4-report.json", "w"), ensure_ascii=False, indent=2)
    passed = sum(1 for x in log["tests"] if x["pass"])
    print(f"TOTAL {passed}/{len(log['tests'])} PASS in {time.time()-t0:.1f}s", flush=True)
