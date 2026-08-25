# Chris's Userscripts

## 安裝方式

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/) 瀏覽器擴充套件（[Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)、[Edge](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)、[Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)、[Safari](https://apps.apple.com/app/tampermonkey/id6738342400)、[Opera](https://addons.opera.com/en/extensions/details/tampermonkey-beta/)）
2. **Chrome 用戶**：前往 `chrome://extensions/` 並開啟右上角的 **Developer mode**
3. **Tampermonkey 設定**：進入 Tampermonkey Settings → 將 **Config mode** 改為 **Advanced**
4. 將 **Content Script API** 改為 **UserScripts API Dynamic**

> 若未更改步驟 4 的設定，首次開啟 Chrome 的分頁將不會套用腳本，需手動重新整理頁面才會生效。

5. 點擊下方的「安裝」連結即可安裝對應腳本

## 通用

> 以下腳本皆為**獨立運作**，可依需求個別安裝。

| 名稱 | 說明 | 版本 | 連&#8288;結 |
| :--- | :--- | :---: | :--- |
| 移除 URL 追蹤 | 自動移除網址中的追蹤參數，讓分享連結更乾淨。會保留商品選項、搜尋條件等網站正常運作需要的參數，並清除 Instagram `igsi` 分享標記；其他清理規則也會定期更新。 | 0.4.9 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js) |
| 複製當前網址 | 按下 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> 複製目前網址。X/Twitter 會轉成 fxTwitter 連結，Amazon.co.jp、PChome 24h 與蝦皮商品頁則會轉成較短、方便分享的網址；Threads 保留原始網址。 | 0.4.6 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js) |
| 社群媒體影片音量鎖定 | 為 Facebook、Instagram、Threads、X 的影片設定預設音量與靜音狀態。可從 Tampermonkey 選單調整；目前影片仍可使用網站本身的音量滑桿，切換影片後會恢復預設音量。 | 0.1.5 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js) |
| Medium&nbsp;付費牆繞過 | 開啟 Medium 文章時，自動跳轉至第三方閱讀服務。可從 Tampermonkey 選單選擇 Freedium、Archive.today 或 ReadMedium，也能關閉自動跳轉。 | 0.1.1 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/bypass-medium-paywall.user.js) |
| Threads&nbsp;自動點擊&nbsp;Spoiler | 自動展開 Threads 中被 Spoiler 隱藏的文字、圖片與影片。支援「Spoiler」、「劇透」、「剧透」、「爆雷」、「스포일러」與「ネタバレ」標籤。 | 0.1.2 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js) |

## Gemini

| 名稱 | 說明 | 版本 | 連&#8288;結 |
| :--- | :--- | :---: | :--- |
| Gemini 固定使用模型 | 每次開啟 Gemini 時，自動切換到指定的 Flash-Lite、Flash 或 Pro 模型。模型與「延伸思考」可分別從 Tampermonkey 選單設定。 | 0.4.5 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js) |

## 替換字體

| 名稱 | 說明 | 版本 | 連&#8288;結 |
| :--- | :--- | :---: | :--- |
| 替換字體為 AppleGothic | 將網頁的一般文字改為 AppleGothic，同時保留圖示與程式碼原本適合的字體。若特定網站顯示異常，可從 Tampermonkey 選單將該網站加入黑名單。 | 0.4.9 | [安&#8288;裝](https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js) |

<!--
## 維護索引

| 腳本／文件 | 主要入口與職責 | 行為測試 |
| :--- | :--- | :--- |
| `remove-url-tracker.user.js` | `compileClearUrlsRules()`／`compileBraveRules()`／`compileFirefoxRules()` 將三個官方 JSON 來源統一成 provider 規則；`migrateLegacyRemoteCacheOnce()` 以版本標記一次清除八個舊快取鍵；`SITE_RULES`／`createLocalCleaningContext()`／`isLocalRemoval()` 執行 Instagram `igsi` 等站點規則與本地全清快路徑；`initializeRemoteRuleSourcesOnce()`／`loadRemoteRuleSource()` 延後讀取來源並拒絕空規則或截短更新；`cleanURL()`／`cleanCurrentURL()` 保留原始 query 編碼、套用規則世代去重並處理 SPA | `tests/remove-url-tracker.test.js` |
| `copy-current-url.user.js` | metadata 以 `@noframes` 限制頂層執行；`copyCurrentUrl()` 複製與派送，快捷鍵排除 Alt／Meta 與重複事件，Threads 保留原網址；`convertToFxTwitter()` 透過 URL API 正規化 X/Twitter 網址；`convertToAmazonShort()` 簡化 Amazon 商品網址；`convertToShopeeShort()` 僅接受數字 ID 並統一兩種商品路徑；`convertToPancake()` 轉換 PChome 商品網址；不向 X 介面注入 Icon | `tests/copy-current-url.test.js` |
| `social-media-volume-fix.user.js` | metadata `@noframes` 與 runtime 防線限制頂層執行；`syncToPage()` 套用播放預設值；`getVolumeChangeCorrectionState()`／`handleMediaStateChange()` 以每影片有限 burst 與單次 descriptor 差異處理協調平台調整；`processVideoScanQueue()` 快取每節點的第一個子元素並逐幀掃描，`queueVideoScanContinuation()` 局部續接移除後的兄弟鏈 | `tests/social-media-volume-fix.test.js` |
| `bypass-medium-paywall.user.js` | `isServiceUrl()` 服務站辨識；`redirect()` 跳轉 | `tests/bypass-medium-paywall.test.js` |
| `threads-auto-reveal-spoiler.user.js` | metadata `@noframes` 與 runtime 防線限制頂層執行；`queueScan()` 以同一套分幀 traversal 掃描初始與動態內容；`queueScanContinuation()` 僅續接目前 active root；`isSpoilerLabel()` 以短標籤快速路徑支援六種文案；`clickIfNeeded()` 隔離單一按鈕點擊失敗 | `tests/threads-auto-reveal-spoiler.test.js` |
| `gemini-fixed-mode.user.js` | metadata `@noframes` 與 runtime 防線排除 `/_/bscframe` 重複實例；`findModeOption()`／`switchToMode()` 固定三模型；`waitForThinkingOption()`／`syncExtendedThinking()` 獨立同步延伸思考且缺少選項即失敗；`attemptAutoSwitch()` 維持同輪單次同步與三次重試；`updateMainMenuLabel()`／`updateThinkingMenuLabel()` 沿用首次回傳 ID 原地更新兩列 | `tests/gemini-fixed-mode.test.js` |
| `force-fonts-applegothic.user.js` | `buildStyles()` 建立一般字體、Icon 排除、GitHub 程式碼語意 selector、首頁 utility 邊界與 exact textarea 特異性；`createClassTokenSelector()`／`createClassPrefixSelectors()` 搭配完整 `google-symbols` token 與 `-icon` 邊界排除 Google Maps 等常見 Icon class；`registerMenuCommands()` 管理網站黑名單；`init()` 只注入 CSS，不掃描 DOM 或攔截 Canvas | `tests/force-fonts-applegothic.test.js` |
| `README.md`／metadata | 版本、反向連結與 JSDoc 一致性 | `tests/documentation-consistency.test.js` |
-->

---

## 參考來源

- 移除 URL 追蹤的遠端 JSON 規則由 [ClearURLs Rules](https://github.com/ClearURLs/Rules)、[Brave Clean URLs](https://github.com/brave/adblock-lists/blob/master/brave-lists/clean-urls.json) 與 [Firefox Query Stripping](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html) 提供
- PChome 短網址服務由 [p.pancake.tw](https://p.pancake.tw/) 提供
- 蝦皮轉換短網址參考自 [gnehs/userscripts](https://github.com/gnehs/userscripts)
- 社群媒體影片音量鎖定原始版本由 [ttoan12](https://github.com/ttoan12/social-network-video-volume-fix) 開發

程式碼主要由 Claude Opus 4.6 Thinking、GPT-5.6 Sol 協助完成。
