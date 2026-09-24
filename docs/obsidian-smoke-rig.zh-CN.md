# Obsidian 真机 smoke 台

[← 扩展 Piem](extending.zh-CN.md) · [English](obsidian-smoke-rig.md)

`smoke-*-obsidian.mjs` 系列脚本在虚拟桌面上的**真实 Obsidian 运行时**里验证
piem——这是唯一能照见原生弹窗、插件沙箱、受限模式、手机模拟和冷启动时序的
一层。happy-dom 预览和单元测试都替代不了它。

起台子的流程曾经只存在于各次会话的临时目录里，每个新会话都要重新推导一遍、
把同一批坑重新踩一遍。现在 `scripts/obsidian-rig.py` 一条命令全包了：

```bash
# 对一次性台子跑完整的桌面 + 手机 smoke
python3 scripts/obsidian-rig.py "$PWD" ~/piem-rig-smoke 9333 \
  --download \
  --smoke scripts/smoke-rpiv-todo-obsidian.mjs

# 只起台子，手动 CDP 驱动（Ctrl-C 拆台）
python3 scripts/obsidian-rig.py "$PWD" ~/piem-rig-probe 9333 --download
```

管家会：构建插件（esbuild production）；把 `main.js`、`manifest.json`、
`styles.css` 部署进一次性 vault；在全新 profile 里注册该 vault 让应用跳过
选库页；以 CDP 端口拉起 Xvfb 和 Obsidian；打开社区插件总开关；等
`agentService` 就位；开焦点模拟；然后跑该 smoke 的桌面 pass——如果 smoke
支持 `--expect-mobile`（从源码探测），再跑 390×844 的官方手机模拟 pass。
拆台时按进程组击杀并通过 `/proc` 收拾孤儿。

## 选项

| 选项 | 作用 |
| --- | --- |
| `--smoke <脚本>` | 台子就绪后跑这个 smoke；省略则保持台子供手动驱动 |
| `--download` | 找不到 runtime 时，下载钉死的 aarch64 构建（`obsidian-1.13.7-arm64.tar.gz`）到 `<root>/runtime` |
| `--obsidian <路径>` | 指定 Obsidian 二进制，跳过已知位置搜索 |
| `--skip-build` | 部署现成的 `main.js` 而不构建；全新 worktree 里没有它，先构建 |
| `--data <文件>` | 播种 vault 插件的 `data.json`；要对话的 smoke 需要带 `activeModelId` 的 provider 行 |
| `--display :N` | Xvfb 显示号（默认 `:114`） |

前提：本机是 aarch64——amd64 的 `.deb` 跑不起来，用 arm64 tarball。需要
Xvfb 和 Node ≥ 22。全新 worktree 需要 `node_modules`（从主检出硬链接——别
跑完整 install，它会刷掉 lockfile 并连带升级 TypeScript）。

`scripts/run-smoke-proactive.py` 是管家出现前的产物，自带一份流程副本专跑
proactive smoke；新场景一律用管家。

## 管家已经布防的坑——调试前先读这份

下面每一条都曾经伪装成产品 bug。它们全是台子层面的事实，不是 piem 的。

1. **CDP 必须锁定 `index.html`。** `/json/list` 里可能同时有
   `starter.html`，它的 `window.app` 是没有插件的空壳：所有 evaluate 返回
   `{}` 或超时。管家锁定
   `url.startsWith('app://') && url.includes('index.html')`。
2. **全新 profile 必须有 `obsidian.json`** 并以 `"open": true` 注册 vault，
   否则应用停在选库页，插件永远不加载。
3. **插件解锁有两道门，都不吭声。** 社区插件总开关在 localStorage；关着
   时 `loadPlugin` 静默空转。管家跑 `setEnable(true)` +
   `enablePluginAndSave('piem')`，然后验证 `agentService`——不是插件壳；
   壳在而 service 不在是经典假绿。
4. **冷启动很慢。** 纯净 vault 上 service 可能 >30s；管家给 90s。别缩短。
5. **Xvfb 窗口永远「未聚焦」**，未聚焦的渲染器会把计时器和 SSE 收尾节流到
   回复晚到几十秒——看起来像挂死。管家替你开
   `Emulation.setFocusEmulationEnabled`。
6. **`Emulation.setDeviceMetricsOverride` 比 `emulateMobile(false)` 活得久。**
   回桌面必须显式 `clearDeviceMetricsOverride`；管家拆台时清。
7. **`Runtime.evaluate` 不接受裸 `await`**——语法错误会被驱动层吞掉。表达式
   要包 async IIFE。
8. **模型 mock 需要 CORS 和终止块**：OPTIONS 预检回 204 + 响应带
   `Access-Control-Allow-Origin: *`；结尾必须发 `finish_reason:"stop"` 的
   终止块——缺了它 pi-ai 抛 "Stream ended without finish_reason"，面板出现
   假 provider 失败。用 `--data` 播种带 `activeModelId` 的 provider；
   `normalizeSettings` 会静默丢掉缺它的自定义 provider。
9. **永远不要对这套台子用 `pkill -f`。** 模式串会匹配你自己的命令行，刀落
   在自己身上（exit 144，输出丢失）。按 PID 杀，或交给管家的 `/proc` 拆台。
10. **先构建再判死刑。** 全新 worktree 没有 `main.js`；esbuild 跑过之前所有
    bundleLoad 测试都是假红。
11. **台目录是一次性的，机器是共享的。** 动手杀既有端口/显示上的东西之前，
    先确认没有别的会话在飞：对插件版本号、PID、文件时间戳。

## Smoke 清单

| 脚本 | 覆盖 |
| --- | --- |
| `smoke-community-obsidian.mjs` | 成品服务上的社区扩展桥 |
| `smoke-research-extensions-obsidian.mjs` | research/clarify 扩展端到端 |
| `smoke-extension-ui-obsidian.mjs` | 原生弹窗、composer、生命周期、模型请求 |
| `smoke-generic-bridge-obsidian.mjs` | 通用桥契约 |
| `smoke-background-bridge-obsidian.mjs` | 后台工厂桥（测试 vault 用生产包副本） |
| `smoke-session-obsidian.mjs` | 会话存储往返（仅桌面） |
| `smoke-bookmark-obsidian.mjs` | 书签适配器 |
| `smoke-rpiv-todo-obsidian.mjs` | `@juicesharp/rpiv-todo` 桥含 Node 访问负对照 |
| `smoke-typography-obsidian.mjs` | 真实渲染下的排版（用 `--baseline`，无手机档） |
| `smoke-proactive-obsidian.mjs` | 主动智能（用专属的 `run-smoke-proactive.py`） |

不需要 Obsidian 的 DOM 级视觉验证用预览 harness（`bun
scripts/preview-visual.mjs`——必须 bun 不是 node，stub 用了参数属性；snap
Chromium 读不了 `/tmp`，探针页放 `~/` 下）。
