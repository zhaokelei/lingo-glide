# 测试页说明

[返回中文说明](../../docs/README.zh-CN.md)

这些页面用来复现浏览器里的输入框行为，不参与扩展运行。

| 文件 | 用途 |
| --- | --- |
| `test.html` | 普通 `textarea`（`#plain`）、受控 textarea（`#ctrl`）、可划词段落（`#p3`）、搜索框、密码框 |
| `zh.html` | 中文页，验证「中文页不自动提示翻译」 |
| `ja.html` | 日文页 |
| `fb_lexical.html` | 官方 Lexical 0.42 + `@lexical/rich-text`，带发送按钮、Enter 发送、400ms 内部 state 同步、`__siteRevert` 还原，用来跑 S1–S5 |
| `lexical_sim.html` | 早期自绘 Lexical 模拟（`?mode=revert|delayed|lock`） |
| `messenger_sim.html` | Messenger composer 外观模拟 |
| `vendor/lexical-bundle.mjs` | Lexical 打包产物，页面直接 import |

`fb_lexical.html` 暴露了几个测试钩子：`window.__stateText()`、`window.__lexCurrent()`、`window.__lexClear()`、`window.__siteRevert(text)`、`window.__sentCount`、`window.__lastSentText`。自动化脚本靠它们断言。

## 重建 lexical-bundle.mjs

```
cd web/test-page
npm init -y
npm i esbuild @lexical/lexical@0.42.0 @lexical/rich-text@0.42.0
cat > entry.js <<'EOF'
export * from '@lexical/lexical'
export * from '@lexical/rich-text'
EOF
npx esbuild entry.js --bundle --format=esm --minify --outfile=vendor/lexical-bundle.mjs
rm -rf node_modules package-lock.json entry.js
```

`registerRichText(editor)` 必须调用，否则原生输入不会进入编辑器 state，敲字没有任何反应。
