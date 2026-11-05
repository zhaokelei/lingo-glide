# Privacy Policy / 隐私说明

Last updated: 2026-11-05

## English

Lingo Glide (the "extension") translates page text and text field content on the user's own machine.

**What the extension reads.** It reads the text of the page you are viewing and the content of the text field you are typing in, and only when you ask for a translation: triple-space or the input shortcut, the selection icon, the page translation button, or the page shortcut. Nothing is read in the background.

**Where requests go.** Translation requests are sent to the local server the user configures, `http://127.0.0.1:8080/v1` by default. That server runs on the same machine through llama.cpp. The extension sends nothing to the developer or to any other remote host, and it contacts no analytics, update, or advertising endpoint.

**What is collected.** Nothing. No personal data, browsing history, page content, or usage statistics are collected, uploaded, shared, or sold. There is no account system, no telemetry, no third-party SDK, and no crash reporting.

**What is stored locally.** Two things, both inside `chrome.storage`:

- Settings (server address, model name, shortcut, target language, switches, ignored sites), in `chrome.storage.sync`. If the user has Chrome sync enabled, Chrome copies them to the user's own Google account; the developer cannot access them.
- Translation cache (source text hash and translated text) and cache counters, in `chrome.storage.local`, on this device only.

Clearing the cache: open the extension popup, click "清除缓存" (Clear cache), or remove the extension.

**Removing the data.** Uninstalling the extension deletes `chrome.storage.local` and the extension's `chrome.storage.sync` entries. Cache can be cleared at any time from the popup without uninstalling.

**Network access.** The extension has no server of its own. The only endpoints it can reach are the user's local translation server and the pages the user opens (content scripts). If the local server is not running, translation fails with an on-screen hint; no data is sent anywhere else as a fallback.

**Contact.** Questions or reports: open an issue at https://github.com/zhaokelei/lingo-glide/issues.

## 中文

Lingo Glide（下称「本扩展」）在本机完成网页文本与输入框内容的翻译。

**读取范围。** 只在你主动触发翻译时读取当前网页的文本和正在输入的文本框内容，触发方式包括：连按三次空格或输入框快捷键、划词图标、整页翻译按钮、整页快捷键。后台不读取任何内容。

**请求去向。** 翻译请求只发往你自己配置的本地服务，默认 `http://127.0.0.1:8080/v1`，该服务由本机的 llama.cpp 提供。扩展不向开发者或任何其他远端主机发送数据，也不访问统计、更新、广告类接口。

**采集内容。** 无。不采集、不上传、不共享、不出售任何个人数据、浏览记录、页面内容或使用统计。没有账号体系，没有埋点，没有第三方 SDK，没有崩溃上报。

**本地存储。** 只有两类数据，都放在 `chrome.storage`：

- 设置项（服务地址、模型名、快捷键、目标语言、开关、忽略站点），存于 `chrome.storage.sync`。如果用户开启 Chrome 同步，由 Chrome 同步到用户自己的 Google 账号，开发者无法访问。
- 翻译缓存（原文哈希与译文）和缓存计数，存于 `chrome.storage.local`，只留在本机。

清除缓存：点扩展弹窗里的「清除缓存」，或卸载扩展。

**删除数据。** 卸载扩展会同时删除 `chrome.storage.local` 和本扩展在 `chrome.storage.sync` 中的条目；缓存也可以随时在弹窗里清空，无需卸载。

**网络访问。** 扩展没有自己的服务器。能访问的只有用户本机的翻译服务和用户打开的网页（内容脚本）。本地服务未启动时，界面提示连接失败，不会改走其他地址。

**联系方式。** 问题与反馈请开 Issue：https://github.com/zhaokelei/lingo-glide/issues。
