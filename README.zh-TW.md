<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon.png">
    <img src="assets/icon-onlight.webp" width="120" alt="">
  </picture>
</p>

<h1 align="center">Piem</h1>

<p align="center">
  <b>把你一直拖著沒做的那件筆記雜活，交出去。</b>
</p>

<p align="center">
  一個住在 Obsidian 側欄裡的 AI 編碼代理，它真的會改你的筆記。<br>
  不是把答案貼給你、讓你自己貼回去的聊天框。
</p>

<p align="center">
  <img alt="版本" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.version&label=version&color=7c3aed">
  <img alt="最低 Obsidian 版本" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&prefix=%E2%89%A5&color=7c3aed">
  <img alt="行動裝置一等公民" src="https://img.shields.io/badge/mobile-first%20class-7c3aed">
  <img alt="授權條款" src="https://img.shields.io/github/license/YoungSx/piem?color=7c3aed">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文 · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="assets/screenshots/errand-desktop.webp" alt="Obsidian 左邊開著範例筆記，右邊是 Piem 的聊天面板，展示硬體表、購買建議和上手步驟。">
</p>

<p align="center">
  <sub>你的筆記在左邊，代理在右邊。範例依舊演示重建，檔案操作由真實外掛執行。</sub>
</p>

---

## ▶️ 一次委託，從頭到尾

你打開一篇剪藏。幾個月前存的，一直沒動。你在側欄裡敲：

> **根據筆記內容，推薦一套適合初學者的硬體清單和購買建議。**

<p align="center">
  <img src="assets/screenshots/errand-trace.webp" width="620" alt="Piem 的對話記錄：兩個展開的群組將三次思考與讀取、寫入和編輯工具的回條放在一起，編輯顯示 +4 -0 的改動，下方是回覆。">
</p>

*目前介面實拍於獨立的 Obsidian 範例庫。對話文字由腳本編排，外掛的讀取、寫入和編輯工具實際執行。*

它讀了那篇筆記，在旁邊新建了一條——硬體表、購買建議、上手步驟都在
裡面。然後回頭給原筆記補了一個指向新筆記的 `[[雙向連結]]`，讓圖譜知道這
兩條是一夥的。

動了兩個檔案：**儲存硬體清單，補上雙向連結（原筆記 +4 −0）。** 思考和工具呼叫
收在同一個摺疊群組裡，打開就能看到每一步。回覆裡交代了改動的是哪兩條筆記。

你一個檔案都沒打開。你只是看了一眼收據，然後接著過自己的日子。

這就是全部的想法。Piem 有手——[二十多個庫工具](docs/tools.md)——而且
它真的會用。

## ☕ 如果它剛替你省了一個下午

Piem 免費、MIT 授權，而且會一直這樣。它是一個人晚上和週末的專案。如果它剛
才替你幹完了一小時你一直不想碰的活，請杯咖啡不算過分。

<p align="center">
  <a href="https://ko-fi.com/shangxin"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="在 Ko-fi 上支持作者"></a>
</p>

<p align="center"><sub>瘋狂星期四，V 我 50。🍗</sub></p>

## 🧰 它手上還有什麼

|  |  |
| --- | --- |
| **二十多個庫工具** | 讀、搜、寫、改、移動、丟垃圾桶、走訪連結、改 frontmatter、掃任務、驅動編輯器 —— [看全部](docs/tools.md) |
| **子代理，平行跑** | 把自成體系的任務派出去；對話記錄彼此隔離，層級在構造上封頂三層，不是靠一句檢查 —— [怎麼運作](docs/tools.md#subagents) |
| **MCP 伺服器** | 遠端工具併入代理自己的工具表，帶命名前綴，任何一份對話記錄都不會謊報某個工具的來處 —— [接一個](docs/extending.md#mcp-servers) |
| **技能** | 可重複使用的指令，來自內建、你的庫，或者你早就在給 pi 用的 `~/.pi` 目錄。敲 <kbd>/</kbd> 就能叫 —— [寫一個](docs/extending.md#skills) |
| **跟著你走的上下文** | 你正打開的那篇筆記——路徑和正文——每一輪都隨訊息同行，上下文視窗將滿時對話自己壓縮 |
| **動作就在手邊** | 空面板按你打開的筆記給出起步動作；每條回覆下面是複製、插到游標處、附加到筆記，或者讓它就地重答一次 |
| **你的端點，你的金鑰** | 任何 OpenAI 相容或 Anthropic-messages 的 base URL，十六個預設開箱可選，能力欄位自動填 —— [怎麼配](docs/settings.md#models) |
| **圖片** | 貼上或拖進輸入框，隨訊息一起走 |
| **英文與简体中文** | 預設跟隨 Obsidian 自己的語言，想要不一樣時可以手動覆寫 |

## ⏱️ 五分鐘就能用起來

**1. 裝上。** 最省事的是 [BRAT](https://github.com/TfTHacker/obsidian42-brat)：
先從社群外掛裝 BRAT，然後 **Add beta plugin** → `YoungSx/piem`。以後的更新它
替你管。

想手動裝？從 [最新 release](https://github.com/YoungSx/piem/releases/latest)
拿 `main.js`、`manifest.json`、`styles.css`，丟進
`<庫>/.obsidian/plugins/piem/`，重新載入 Obsidian，在 **設定 → 第三方外掛** 裡
啟用 **Piem**。

**2. 給它一個腦子。** 打開 **設定 → Piem → Models**，加一個服務商和 API
金鑰。預設建議 DeepSeek；任何 OpenAI 相容或 Anthropic-messages 的端點都行，
**Test** 按鈕會走你聊天時實際用的那條傳輸通道去探測，而不是找條方便的替代。

**3. 問它點什麼。** 命令面板 → **Piem: Open chat**，然後把你一直躲著的那件事
說出來。<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> 傳送——或者在
**General** 裡改成直接按 <kbd>Enter</kbd>。

想從原始碼建置？[CONTRIBUTING.md](CONTRIBUTING.md) 裡有那五條命令。

## 📱 手機也算一台真電腦

<p align="center">
  <img src="assets/screenshots/mobile-empty.webp" width="290" alt="Obsidian 官方手機模擬中的傳送前草稿：技能卡片與筆記引用同在文字輸入框內。">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/screenshots/mobile-done.webp" width="290" alt="Obsidian 官方手機模擬中的重建演示：已儲存的硬體清單和雙向連結。">
</p>

<p align="center">
  <sub>傳送前與完成後：左邊是輸入框內的技能和筆記引用，右邊是完成的範例。兩圖均使用 Obsidian 官方手機模擬。</sub>
</p>

Piem 的 `isDesktopOnly` 是 `false`，而且是當真的。工具、子代理、技能、圖片
——在手機上全都能用。串流輸出也能，只要你把它打開。

這份承諾有代價，而且值得讓你知道代價是什麼。

**MCP 伺服器只支援遠端。** stdio 傳輸要拉起子行程，手機做不到。一個在手機上
不可能存在的能力，寧可對所有人都不做，也不做成桌面端的意外驚喜。

**逐字串流預設關著。** Obsidian 的 `requestUrl` 是唯一在所有平台都不受 CORS
約束的通道，而它根本沒有增量讀取這回事——整段回覆湊齊了才一次落下。要真串流
就得用瀏覽器自己的 `fetch`，多數 endpoint 其實是放行它的；改一個設定就行（模
型 → 網路 → 網路傳輸）。它之所以不是預設，是因為能不能用是 endpoint 說了算
而不是我們說了算，而本地自己跑的模型通常得手動放行。

## 🔓 裝之前先說清楚：它改筆記不問你

**`write` 和 `edit` 之前沒有確認步驟。** 沒有對話框，沒有等你批的 diff。你一
開口，你的筆記就變了。

這是刻意的，也是這筆交易的條款：一個要問你十二次許可的代理，你會停用它。它
反過來向你要的是：

- 讓它對著一個你願意被改動的庫，也是一個你願意**發給你的模型服務商**的
  庫——搜尋碰到哪個檔案，就把那個檔案發出去了；
- 事後讀一遍對話記錄。每一處改動都來自一次工具呼叫，每一次工具呼叫都擺在
  那兒，沒藏；
- 把庫放進版本控制，或者靠 Obsidian 自己的檔案復原。`trash_note` 走的是
  Obsidian 的垃圾桶，刪掉的東西按常規辦法就能撈回來。

你的 API 金鑰在桌面端用系統金鑰圈密封，在手機上是明文存的——因為那裡沒有可
以拿來密封的東西，把這件事說出來比含糊過去更好。發布版帶
[簽名溯源](https://github.com/YoungSx/piem/attestations)，你下載的那串位元組
能追回這個儲存庫。

錯誤報告與效能資料預設發給 Piem 維護者，可在 **擴充能力** 中關閉分享。
正文擷取關閉，但錯誤文字可能包含筆記內容。傳送範圍詳見
[安全與隱私](docs/security.md)。

## 📚 想深挖

| | |
| --- | --- |
| [**代理的工具**](docs/tools.md) | 每一個工具、它做不到的事，以及子代理怎麼運作 |
| [**擴充 Piem**](docs/extending.md) | 技能、提示範本、MCP 伺服器 |
| [**設定**](docs/settings.md) | 服務商與模型、聊天行為、命令、會話存在哪 |
| [**安全與隱私**](docs/security.md) | 什麼會離開你的庫、金鑰存在哪、Obsidian 審核會點名的那些能力 |

想參與？[CONTRIBUTING.md](CONTRIBUTING.md) 看流程，[AGENTS.md](AGENTS.md)
看約定。

## 🙏 站在別人的肩膀上

Piem 跑在 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi-mono)
上，也就是 pi 的代理執行時——所以你早先為 pi 寫的技能，在這裡原樣可用。

它是從 [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) 長出來
的。謝謝那個起點。

MIT 授權。第三方聲明在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
