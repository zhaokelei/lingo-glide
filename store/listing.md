Item name (from manifest.json)
本地翻译 hy-mt2

Category
Productivity

Languages
中文（简体）, English

Short description (limit 132 characters)
Read any page in Chinese with a model on your own machine. Triple-space, select, or translate the whole page. No account, no cloud.

Detailed description (English)
This extension translates web pages and text fields with a language model that runs on your own computer through llama.cpp. Nothing is sent to a cloud service, and there is no account, key, or subscription.

Three ways to translate. In any text field, press the space bar three times and the text you have written is replaced with the translation. On a page, select a sentence and click the small icon next to the selection to get a card with the translation, which you can copy, keep open, or close with Esc. To read a whole article, press Alt+T or use the floating button to translate every paragraph in place; the extension shows the original above each translated paragraph, so names, figures, and quoted sentences can still be checked against the source. The floating button and the three-space trigger can each be turned off, and the input shortcut can be remapped from the options page.

What it needs. A local server that speaks the OpenAI chat API, by default http://127.0.0.1:8080/v1 with the model hy-mt2. Setup takes one shell script, and the model weights are downloaded separately; they are not part of the extension. If the server is not running, the extension says so instead of falling back to another service.

Practical details. Translations are cached locally, so repeated paragraphs come back instantly. Paragraph structure and blank lines are preserved, and code, URLs, file paths, and brand names are kept as they are. Every switch, the target language, and the server address live in the options page. Requires Chrome or Edge 111 or newer.

Single purpose
Translate the text a user selects or types, and the page a user is reading, using a translation service that runs on the same machine as the browser.

Permission justification: storage
Stores the extension settings (server address, model name, shortcut, target language, per-site switches) and a local translation cache. No personal data is stored.

Permission justification: contextMenus
Adds a right-click entry to translate or restore the current page.

Permission justification: scripting
Injects the page scripts into tabs that were already open when the user installs or enables the extension, so an open tab does not have to be reloaded.

Permission justification: activeTab
Lets the popup act on the tab the user is looking at when they press "translate this page", without access to other tabs.

Permission justification: host permissions (http://*/*, https://*/*, http://127.0.0.1:8080/*)
The content script has to run on whatever site the user chooses to read, and translation requests go only to the local server on 127.0.0.1:8080. No other remote host is contacted.

Remote code
No. All code is included in the package. The only network requests are to the local translation server the user configures.
