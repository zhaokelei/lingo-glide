/* 本地翻译扩展 - 页面主世界输入注入（manifest: world MAIN, document_start）
 *
 * 为什么必须放在 MAIN world：
 *   富文本编辑器（Lexical / Slate / Draft.js）的编辑器实例挂在页面自己的 DOM 对象上
 *   （`__lexicalEditor`、React fiber 上的 hook state），这些是页面主世界的 JS 对象，
 *   扩展隔离世界（ISOLATED）里的 DOM 包装看不到。只在隔离世界模拟 DOM 输入，
 *   编辑器随后会用内部 editor state 把 DOM 覆盖回原文。
 *
 * 机制参考 read-frog（https://github.com/mengxi-ream/read-frog，作者 mengxi-ream）：
 *   src/entrypoints/input-injector.content/index.ts          —— MAIN world 入口 + postMessage 桥
 *   src/entrypoints/input-injector.content/replace-text.ts   —— Lexical/Slate/Draft 分派 + fallback
 *   src/entrypoints/input-injector.content/editors/lexical.ts —— root.select + insertRawText
 *   src/entrypoints/input-injector.content/editors/slate.ts
 *   src/entrypoints/input-injector.content/editors/draft-js.ts
 * 它不做模拟按键/DOM 写回，而是直接调用编辑器自己的 API，让编辑器自己 reconciliation。
 *
 * 通信：隔离世界的 content.js 用 window.postMessage 发 {type:'trf:input-fill', id, text}，
 *       本脚本回 {type:'trf:input-fill-result', id, ok, engine, reason}。
 */
(() => {
  'use strict';
  if (window.__trfInputInjector) return;
  window.__trfInputInjector = true;

  const REQ = 'trf:input-fill';
  const RES = 'trf:input-fill-result';

  /** 穿透 shadow root 找到真正持有焦点的元素（read-frog: utils/dom/active-element.ts） */
  function getDeepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  /** 选区所在的可编辑祖先（有些编辑器把焦点放在隐藏节点上，activeElement 不是编辑区） */
  function selectionEditable() {
    try {
      const sel = window.getSelection && window.getSelection();
      const node = sel && sel.anchorNode;
      if (!node) return null;
      const el = node.nodeType === 3 ? node.parentElement : node;
      return el && el.closest ? el.closest('[contenteditable]:not([contenteditable="false"])') : null;
    } catch (e) { return null; }
  }

  function resolveEditable() {
    const a = getDeepActiveElement();
    if (a && a.isContentEditable) return a;
    const s = selectionEditable();
    if (s && s.isContentEditable) return s;
    return null;
  }

  /* ---------------- Lexical ---------------- */

  function getLexicalEditor(element) {
    const editor = element.__lexicalEditor;
    if (!editor) return null;
    if (typeof editor.update !== 'function') return null;
    if (typeof editor.getEditorState !== 'function') return null;
    if (typeof editor.getRootElement !== 'function') return null;
    // 节点被编辑器重建过时，旧元素上的 __lexicalEditor 不能用于新元素
    if (editor.getRootElement() !== element) return null;
    return editor;
  }

  function isLexicalElement(element) {
    return element.getAttribute('data-lexical-editor') === 'true' || !!getLexicalEditor(element);
  }

  function replaceLexical(element, text) {
    const editor = getLexicalEditor(element);
    if (!editor) return false;
    let root;
    try { root = editor.getEditorState()._nodeMap && editor.getEditorState()._nodeMap.get('root'); } catch (e) { root = null; }
    if (!root || typeof root.select !== 'function' || typeof root.getChildrenSize !== 'function') return false;
    let replaced = false;
    try {
      editor.update(() => {
        const selection = root.select(0, root.getChildrenSize());
        // insertRawText 保留译文里的换行与制表符
        selection.insertRawText(text);
        replaced = true;
      }, { tag: 'history-push', discrete: true });
    } catch (e) { return false; }
    return replaced;
  }

  /* ---------------- Slate ---------------- */

  function findReactFiber(element) {
    const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return key ? element[key] : null;
  }

  function isSlateEditor(value) {
    return !!value && typeof value === 'object' &&
      typeof value.apply === 'function' &&
      typeof value.insertText === 'function' &&
      Array.isArray(value.children);
  }

  function findSlateEditor(fiber) {
    let cur = fiber;
    while (cur) {
      let hook = cur.memoizedState;
      while (hook) {
        if (isSlateEditor(hook.memoizedState)) return hook.memoizedState;
        hook = hook.next;
      }
      cur = cur.return;
    }
    return null;
  }

  function getSlateEditor(element) {
    const fiber = findReactFiber(element);
    return fiber ? findSlateEditor(fiber) : null;
  }

  function isSlateElement(element) {
    return element.getAttribute('data-slate-editor') === 'true' || !!getSlateEditor(element);
  }

  function findLeafPath(node, path, first) {
    if ('text' in node && typeof node.text === 'string') return path;
    const children = node.children;
    if (!children || !children.length) return null;
    const index = first ? 0 : children.length - 1;
    return findLeafPath(children[index], path.concat(index), first);
  }

  function replaceSlate(element, text) {
    const editor = getSlateEditor(element);
    if (!editor) return false;
    const startPath = findLeafPath({ children: editor.children }, [], true);
    const endPath = findLeafPath({ children: editor.children }, [], false);
    if (!startPath || !endPath) return false;
    let endNode = { children: editor.children };
    for (let i = 0; i < endPath.length; i++) endNode = endNode.children[endPath[i]];
    try {
      editor.apply({
        type: 'set_selection',
        properties: editor.selection,
        newProperties: {
          anchor: { path: startPath, offset: 0 },
          focus: { path: endPath, offset: endNode.text.length }
        }
      });
      editor.insertText(text);
    } catch (e) { return false; }
    return true;
  }

  /* ---------------- Draft.js ---------------- */

  function isDraftEditorState(value) {
    return !!value && typeof value === 'object' &&
      typeof value.getCurrentContent === 'function' &&
      typeof value.getSelection === 'function';
  }

  function isDraftElement(element) {
    return !!((element.closest && element.closest('.DraftEditor-root')));
  }

  function findDraftEditor(element) {
    const contentEl = (element.closest && element.closest('.public-DraftEditor-content')) || element;
    let fiber = findReactFiber(contentEl);
    while (fiber) {
      const props = fiber.memoizedProps;
      if (props && isDraftEditorState(props.editorState) && typeof props.onChange === 'function') {
        return { editorState: props.editorState, onChange: props.onChange };
      }
      const stateNode = fiber.stateNode;
      const stateNodeProps = (stateNode && stateNode.props) || {};
      if (isDraftEditorState(stateNodeProps.editorState)) {
        return { editorState: stateNodeProps.editorState, onChange: stateNodeProps.onChange };
      }
      fiber = fiber.return;
    }
    return null;
  }

  function replaceDraft(element, text) {
    const found = findDraftEditor(element);
    if (!found || !found.editorState) return false;
    const editorState = found.editorState;
    const contentState = editorState.getCurrentContent();
    const EditorStateConstructor = Object.getPrototypeOf(editorState).constructor;
    const ContentStateConstructor = Object.getPrototypeOf(contentState).constructor;
    if (typeof ContentStateConstructor.createFromText !== 'function' || typeof EditorStateConstructor.push !== 'function') return false;
    try {
      const newContent = ContentStateConstructor.createFromText(text);
      let next = EditorStateConstructor.push(editorState, newContent, 'insert-characters');
      if (typeof EditorStateConstructor.moveSelectionToEnd === 'function') next = EditorStateConstructor.moveSelectionToEnd(next);
      found.onChange(next);
    } catch (e) { return false; }
    return true;
  }

  /* ---------------- 通用兜底 ---------------- */

  function replaceFallback(element, text) {
    element.focus();
    let ok = false;
    try { ok = document.execCommand('selectAll'); } catch (e) { ok = false; }
    let ret = false;
    try { ret = document.execCommand('insertText', false, text); } catch (e) { ret = false; }
    return !!ret;
  }

  /** 分派：与 read-frog replace-text.ts 的 replaceText 一致 */
  function replaceText(text) {
    const element = resolveEditable();
    if (!element) return { ok: false, engine: 'none', reason: 'not-contenteditable' };

    if (isLexicalElement(element) && replaceLexical(element, text)) {
      return { ok: true, engine: 'lexical' };
    }
    if (isSlateElement(element) && replaceSlate(element, text)) {
      return { ok: true, engine: 'slate' };
    }
    if (isDraftElement(element) && replaceDraft(element, text)) {
      return { ok: true, engine: 'draft-js' };
    }
    if (replaceFallback(element, text)) {
      return { ok: true, engine: 'execCommand' };
    }
    return { ok: false, engine: 'none', reason: 'all-editor-apis-failed' };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== REQ || typeof data.text !== 'string' || !data.id) return;
    let out;
    try {
      out = replaceText(data.text);
    } catch (err) {
      out = { ok: false, engine: 'error', reason: String((err && err.message) || err) };
    }
    try {
      window.postMessage({ type: RES, id: data.id, ok: out.ok, engine: out.engine, reason: out.reason || '' },
        window.location.origin === 'null' ? '*' : window.location.origin);
    } catch (e) { /* ignore */ }
  });
})();
