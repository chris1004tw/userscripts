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
| 移除 URL 追蹤 | 自動移除 URL 中的追蹤參數，保護您的隱私。<br/>支援 Google、Facebook、Twitter、YouTube、淘寶等主流網站。 | 0.4.1 | [Install](https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js) |
| 複製當前網址 | 按下 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> 複製當前網址。<br/>特定網站改寫 URL：<br/>・在 X/Twitter 上複製時會轉換為 fxTwitter 連結。<br/>・在 PChome 24h 上複製時會轉換為 pancake 連結。<br/>・在蝦皮上複製時會轉換為短網址的連結。 | 0.4 | [Install](https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js) |
| 社群媒體影片音量鎖定 | 鎖定 Facebook、Instagram、Threads、X 影片音量，防止被平台覆蓋。<br/>透過 Tampermonkey 選單調整音量與靜音，點擊原生靜音按鈕同樣有效。<br/>⚠️ 因平台 UI 更新速度過快，不支援平台內建音量滑桿，請透過 Tampermonkey 選單調整音量。 | 0.1 | [Install](https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js) |

## Gemini

| 名稱 | 說明 | 版本 | 安裝 |
| :--- | :--- | :---: | :--- |
| Gemini 固定使用模型 | 自動將 Gemini 切換為指定模型 (Pro / Fast / Thinking)<br/>並透過 Tampermonkey 選單手動切換固定模型。 | 0.4 | [Install](https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js) |

## 替換字體

| 名稱 | 說明 | 版本 | 安裝 |
| :--- | :--- | :---: | :--- |
| 替換字體為 AppleGothic | 將頁面字體改為 AppleGothic (簡體用 AppleGothicSC)<br/>還原字體因替換而對 Icon Font 造成的影響。<br/>程式碼區域使用 Cascadia Code 等寬字體。<br/>支援黑名單管理，可針對特定網站停用。 | 0.4.2 | [Install](https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js) |

---

## 參考來源

- 移除 URL 追蹤部分規則引用自 [ClearURLs](https://github.com/ClearURLs/Addon) 專案
- PChome 短網址服務由 [p.pancake.tw](https://p.pancake.tw/) 提供
- 蝦皮轉換短網址參考自 [gnehs/userscripts](https://github.com/gnehs/userscripts)
- 社群媒體影片音量鎖定原始版本由 [ttoan12](https://github.com/ttoan12/social-network-video-volume-fix) 開發

大部分的 Code 都由 Claude Opus 4.6 Thinking 完成
