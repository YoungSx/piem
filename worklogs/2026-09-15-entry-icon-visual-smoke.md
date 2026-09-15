# 2026-09-15 扩展入口图标最终视觉 smoke（PR #437）

真机：Xvfb :113 + Obsidian 1.13.7（arm64 runtime），vault `piem-entry-smoke-20260914/run2/vault`，
bundle 为本分支生产构建。驱动 `/tmp/visual.mjs`（CDP 截图，脚本化 openai-completions provider，
一次 todo create 工具调用 + 终态文本）。截图在 `run2/`，桌面与移动（390×844 @2x）各五张。

## 结论：全绿

| 状态 | 证据 | 判定 |
| --- | --- | --- |
| 默认态 | `desktop-panel/-row.png`、`mobile-panel/-row.png` | list-checks 图标落上下文行末尾；`<details>`「扩展操作」行确已消失，输入区下方干净 |
| popover | `desktop-popover.png`、`mobile-popover.png` | 动作行 + kbd（ctrl+shift+t）圆角卡片，390px 不破 |
| running | `desktop-pending.png`、`mobile-pending.png` | 图标着 --running 紫色调（呼吸为动画，静帧不可见） |
| failed | `desktop-failed.png`、`mobile-failed.png` | 图标变红 + 右上红点，popover 内 role=alert 错误行 |

## 过程教训（驱动侧，均非产品 bug）

1. **fixture 必须给终态**：服务器每轮回 create 工具调用 → agent 循环 208 个重复待办、
   `sendPrompt` 永不 resolve。第二轮起必须回纯文本 finish_reason=stop。
2. **失败态自动弹开 popover**（ExtensionEntryIcon.tsx:80）：staging 后再点入口按钮等于把它关上；
   先 ensureClosed 再开。
3. **staged run 要能放行**：pending 用永不 settle 的 Promise 会占住按钮，失败 run 点不下去；
   截图后手动 resolve。
4. **staged 描述要含 "todo"**：`entryIcon` 按描述选图标，中文描述落到 puzzle 兜底；
   想看真实观感就写「检查 todo 待办」。
5. **后台驱动进程要盯死**：TaskStop 只杀管道不杀 node；双 CDP 客户端抢握手标记。
   驱动循环已改为 runVisual promise 落定即退出。
