# 2026-09-15 兼容主题哨兵视觉 smoke（styled extension text）

真机：Xvfb :112 + Obsidian 1.13.7（arm64 runtime），vault `piem-todo-smoke-20260915/vault`，
bundle 为本分支生产构建（SHA f1b7044f…，与工作区构建一致）。复用 PR #435 的
`run.py` 编排 + `smoke-rpiv-todo-obsidian.mjs` 契约。

## 结论：全绿

| 轮次 | 结果 | 证据 |
| --- | --- | --- |
| 桌面（1024px） | 16/16 checks，4 个 provider 请求 | `rpiv-todo-desktop.json`、`rpiv-todo-desktop-overlay.png` |
| 移动（390×844 @2x 官方模拟） | 20/20 checks（含 Node 审计六控件全拒） | `rpiv-todo-mobile.json`、`rpiv-todo-mobile-overlay.png` |

视觉判定（PIL 像素量测，非目测）：

- **颜色解码生效**：标题「Todos (0/1)」紫 = (138, 92, 245) = Obsidian 亮色
  `--text-accent` #8a5cf5，逐像素吻合；树形 `└─` 灰 = faint 档。哨兵→span→
  Obsidian token 的链路在真机闭环。
- **无尾随空隙**：卡片文字底距 vs 顶距 = 桌面 13/11 px、移动 12/12 px，
  对称（边缘空白行若未被修剪会多出一整行 ~20px）。
- **等宽与卡片化**：`└─` 与 `●` 列对齐（等宽字体承重）；卡片背景
  `--background-secondary` + 边框圆角与 styles.css 规则一致。
- **宽度随视口**：同一组件在 1024 与 390 都正确挂载收窄，无溢出。

## 过程教训

1. 复制旧 profile 会带来两个陈旧状态：`obsidian.json` 的 vault 路径
   （要改指新 vault 且必须重启 Obsidian 才生效）、mobile 模拟开关
   （`app.emulateMobile(false)` 复位）。
2. run.py 吞 smoke stderr 的路径：stdout 尾行 "{}" 也能被 json.loads 成功，
   失败原因全丢。手动直跑 node 脚本一眼看到真错。
3. 拆台仍按 profile 路径精准匹配 pgrep，勿 `pkill -f` 裸跑（自杀两回的前科）。

## Review 收口（b0ecbd9）

代码评审四个 P2 已折进本分支：非典型 SGR 复位（`[m` / `[0;0m`）现在也能闭
色（`isPaletteReset`）；C1 CSI（0x9B）在 `plainText` 与 DOM 解码器两处都带
参数整段丢弃（C1 介绍符后还要跳过一个伪 `[`）；边缘空白行修剪改按解析后
形状判定，哨兵包裹的空格行照样修掉；widget 原始行在 surfaces 入口统一走
`plainText(text, true)`，与原生树同一消毒边界；全空白的原生 text 节点渲染
为 null。视觉无变化，未再跑 smoke（rpiv-todo 只发典型形式）。
