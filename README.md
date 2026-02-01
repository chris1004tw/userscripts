# Chris's Userscripts

## 安裝方式

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/) 瀏覽器擴充套件（[Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)、[Edge](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)、[Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)、[Safari](https://apps.apple.com/app/tampermonkey/id6738342400)、[Opera](https://addons.opera.com/en/extensions/details/tampermonkey-beta/)）
2. 點擊下方的 <kbd>Install</kbd> 連結即可安裝對應腳本

## 通用

| 名稱 | 說明 | 安裝 |
| :--- | :--- | :--- |
| 移除 URL 追蹤<br/> | 自動移除 URL 中的追蹤參數，保護您的隱私。<br/>支援 Google、Facebook、Twitter、YouTube、淘寶等主流網站。<br/>部分規則引用自 [ClearURLs](https://github.com/ClearURLs/Addon) 專案。 | [Install](https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js) |
| 複製當前網址 | 按下 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> 複製當前網址。<br/>在 X/Twitter 上會自動轉換為 [fxTwitter](https://github.com/FixTweet/FxTwitter) 連結並新增複製按鈕。 | [Install](https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js) |

## Gemini

| 名稱 | 說明 | 安裝 |
| :--- | :--- | :--- |
| Gemini 固定使用模型 | 自動將 Gemini 切換為指定模型 (Pro / Fast / Thinking)<br/>並透過 Tampermonkey 選單手動切換固定模型。 | [Install](https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js) |

## 替換字型

| 名稱 | 說明 | 安裝 |
| :--- | :--- | :--- |
| 替換字體為 AppleGothic | 將頁面字體改為 AppleGothic (簡體用 AppleGothicSC)<br/>還原字體替換對 Icon 的影響。<br/>支援黑名單管理，可針對特定網站停用。 | [Install](https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js) |

---

大部分的 Code 都由 Claude Opus 4.5 Thinking 完成
