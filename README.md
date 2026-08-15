# Chris's Userscripts

## 安裝方式

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/) 瀏覽器擴充套件（[Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)、[Edge](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)、[Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)、[Safari](https://apps.apple.com/app/tampermonkey/id6738342400)、[Opera](https://addons.opera.com/en/extensions/details/tampermonkey-beta/)）
2. **Chrome 用戶**：前往 `chrome://extensions/` 並開啟右上角的 **Developer mode**
3. **Tampermonkey 設定**：進入 Tampermonkey Settings → 將 **Config mode** 改為 **Advanced**
4. 將 **Content Script API** 改為 **UserScripts API Dynamic**

> ⚠️ 若未更改步驟 4 的設定，首次開啟 Chrome 的分頁將不會套用腳本，需手動重新整理頁面才會生效。

5. 點擊下方的 <kbd>Install</kbd> 連結即可安裝對應腳本

## 通用

> 以下腳本皆為**獨立運作**，可依需求個別安裝。

| 名稱 | 說明 | 版本 | 安裝 |
| :--- | :--- | :---: | :--- |
| 移除 URL 追蹤 | 自動移除 URL 中的追蹤參數，保護您的隱私。<br/>完整保留本地通用與精確 hostname 規則，另整合 ClearURLs JSON、AdGuard URL Tracking Protection、Actually Legitimate URL Shortener 與 uBlock Origin `privacy-removeparam` 遠端規則。三份 TXT 各自快取與更新，合併後去重；單一來源失敗或回應截斷時沿用最後成功版本。Amazon `ufe`、淘寶商品款式等既有安全政策不受遠端例外影響，並透過 Tampermonkey `urlchange` 重新清理 SPA 寫回的追蹤參數。 | 0.4.7 | [Install](https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js) |
| 複製當前網址 | 按下 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> 複製當前網址。<br/>特定網站改寫 URL：<br/>・在 X/Twitter 上轉換為 fxTwitter 連結，僅保留快捷鍵功能，不向站點介面注入 Icon。<br/>・在 Threads 上保留原始網址，避免第三方嵌入服務的 429 錯誤。<br/>・在 Amazon.co.jp 上將商品網址簡化為 `/dp/ASIN` 格式。<br/>・在 PChome 24h 上轉換為 Pancake 連結。<br/>・在蝦皮上轉換為短網址。 | 0.4.5 | [Install](https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js) |
| 社群媒體影片音量鎖定 | 為 Facebook、Instagram、Threads、X 的影片設定預設音量與靜音狀態。可透過 Tampermonkey 選單設定；影片可使用平台內建音量滑桿自由調整，切換到下一支影片時會恢復設定音量，避免突然爆音。 | 0.1.3 | [Install](https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js) |
| Medium&nbsp;付費牆繞過 | 自動跳轉至第三方服務閱讀 Medium 全文。<br/>透過 Tampermonkey 選單切換預設服務（Freedium / Archive.today / ReadMedium）。<br/>支援自動跳轉開關切換。 | 0.1.1 | [Install](https://github.com/chris1004tw/userscripts/raw/main/bypass-medium-paywall.user.js) |
| Threads&nbsp;自動點擊&nbsp;Spoiler | 自動點擊 Threads 的 Spoiler 按鈕，揭露被隱藏的文字、圖片與影片內容。<br/>支援多語系標籤偵測（Spoiler / 劇透 / 爆雷 / 스포일러 / ネタバレ）。 | 0.1.1 | [Install](https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js) |

## Gemini

| 名稱 | 說明 | 版本 | 安裝 |
| :--- | :--- | :---: | :--- |
| Gemini 固定使用模型 | 自動將 Gemini 切換為指定模型 (Pro / Fast / Thinking)<br/>並透過 Tampermonkey 選單手動切換固定模型。 | 0.4.4 | [Install](https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js) |

## 替換字體

| 名稱 | 說明 | 版本 | 安裝 |
| :--- | :--- | :---: | :--- |
| 替換字體為 AppleGothic | 將頁面字體改為 AppleGothic (簡體用 AppleGothicSC)<br/>還原字體因替換而對 Icon Font 造成的影響。<br/>程式碼區域的英數優先使用 Cascadia Code 等寬字體，中文在 generic `monospace` 前回退至 AppleGothic；GitHub `#read-only-cursor-text-area` 另以 inline `!important` 抵抗動態樣式。<br/>支援黑名單管理，可針對特定網站停用。 | 0.4.7 | [Install](https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js) |

## 測試與驗證

專案使用 Node.js 內建的 `node:test`、`node:vm` 與最小 DOM／GM stub，不需要安裝額外套件。目前共有 8 個測試檔、87 項測試，七支正式 userscript 均有獨立行為測試。

```powershell
node --test
Get-ChildItem -File -Filter '*.user.js' | ForEach-Object { node --check $_.FullName }
Get-ChildItem -Recurse -File -Path 'tests' -Filter '*.js' | ForEach-Object { node --check $_.FullName }
```

## 維護索引

| 腳本／文件 | 主要入口與職責 | 行為測試 |
| :--- | :--- | :--- |
| `remove-url-tracker.user.js` | `compileTextRules()` 安全解析 AdGuard／uBO `$removeparam`；`initializeTextRuleSources()` 管理三份獨立 TXT 快取；`cleanURL()` 合併本地、ClearURLs 與 TXT 規則；`cleanCurrentURL()` 整合 History API 與 Tampermonkey `urlchange` | `tests/remove-url-tracker.test.js` |
| `copy-current-url.user.js` | `copyCurrentUrl()` 複製與派送，Threads 保留原網址；`convertToFxTwitter()` 轉換 X/Twitter 網址；`convertToAmazonShort()` 簡化 Amazon 商品網址；不向 X 介面注入 Icon | `tests/copy-current-url.test.js` |
| `social-media-volume-fix.user.js` | `syncToPage()` 套用播放預設值；`getVolumeChangeCorrectionState()`／`handleMediaStateChange()` 以每影片有限 burst 協調平台調整；`processVideoScanQueue()`／`queueVideoScanContinuation()` 逐幀掃描並從 removal 後方局部續接 | `tests/social-media-volume-fix.test.js` |
| `bypass-medium-paywall.user.js` | `isServiceUrl()` 服務站辨識；`redirect()` 跳轉 | `tests/bypass-medium-paywall.test.js` |
| `threads-auto-reveal-spoiler.user.js` | `revealSpoilersIn()` 揭露內容；`queueScan()` 分幀掃描 | `tests/threads-auto-reveal-spoiler.test.js` |
| `gemini-fixed-mode.user.js` | `waitForElement()` 等待介面；`switchToMode()` 切換模式 | `tests/gemini-fixed-mode.test.js` |
| `force-fonts-applegothic.user.js` | `initStyles()` 程式碼中英文字型 fallback；`processElement()` 字體／Icon 判定；`setupMutationObserver()` 增量掃描 | `tests/force-fonts-applegothic.test.js` |
| `README.md`／metadata | 版本、反向連結與 JSDoc 一致性 | `tests/documentation-consistency.test.js` |

---

## 參考來源

- 移除 URL 追蹤的遠端 JSON 規則由 [ClearURLs](https://github.com/ClearURLs/Addon) 專案提供
- 移除 URL 追蹤的 TXT 規則由 [AdGuard URL Tracking Protection](https://github.com/AdguardTeam/FiltersRegistry/tree/master/filters/filter_17_TrackParam)、[Actually Legitimate URL Shortener](https://github.com/DandelionSprout/adfilt/blob/master/LegitimateURLShortener.txt) 與 [uBlock Origin uAssets](https://github.com/uBlockOrigin/uAssets/blob/master/filters/privacy-removeparam.txt) 提供
- PChome 短網址服務由 [p.pancake.tw](https://p.pancake.tw/) 提供
- 蝦皮轉換短網址參考自 [gnehs/userscripts](https://github.com/gnehs/userscripts)
- 社群媒體影片音量鎖定原始版本由 [ttoan12](https://github.com/ttoan12/social-network-video-volume-fix) 開發

大部分的 Code 都由 Claude Opus 4.6 Thinking 完成
