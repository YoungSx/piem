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
12. **启动后约 25s 内 `requestUrl` 根本发不出包。** 主进程的持久 cookie 存储
    还没加载完，`URLRequestHttpJob` 把每个会带 cookie 的请求都排在那次加载
    后面。它是定时器而不是 I/O：两次运行只差 5ms，`--password-store=basic`
    毫无影响——这是 Chromium best-effort 任务围栏的特征，SQLite cookie 存储
    的加载就排在围栏后面。NetLog 看得很清楚：加载在 +23ms 开始，Obsidian 自
    己的两个更新检查请求在 +22ms 和 +25ms 到来、各触发一次 key load，+6294ms
    发出的探针触发第三次，存储加载与三次 key load 在 +25053ms 一起完成——那
    一刻每个被挂住的请求才越过 `COMPUTED_PRIVACY_MODE`，也正是 profile 里的
    `Cookies` 文件第一次被写的时刻。三个请求本身随后在 5–166ms 内陆续结束
    （+25058、+25097、+25219）；有意义的是那个共同的解挂瞬间。比这更早去连
    MCP，就会看到 `requestUrl` 挂过
    `CONNECT_TIMEOUT_MS`，报出一个与插件无关的握手超时——这正是组合冷启动
    失败、而几分钟后手工跑同一脚本却通过的原因。管家现在会先对 loopback 上
    的 CDP 端点发一个带 cookie 的 `requestUrl`，等它**拿到 HTTP 状态码**再把
    台子交出去——落地不算信号：Chromium 有一部分请求会在进入 cookie 阶段之前
    就被拒（能撞上的是受限端口名单，而 CDP 端口是你自己传的），这种探针会在
    毫秒级失败而围栏仍然立着，所以探针失败是致命错误而不是一行告警。再遇到
    同类现象不要用重试或放大超时「修」它，两者都只是遮住它。另外，渲染端
    `fetch` 在这里当不了对照：跨源且不带凭据时它不发 cookie，整段窗口里都是
    毫秒级返回。
13. **全新 vault 会弹「信任作者」模态框，而它会把应用按在受限模式里。**
    `enablePluginAndSave` 会强行加载插件，于是 `agentService` 出现、看着很
    健康——但模态框还立着时 vault 仍未受信，聊天视图渲染的是「连接模型以
    开始」的空状态，播种的设置也到不了它那里（模型切换器冻在内置回退上）。
    管家在每轮 unlock 轮询里幂等地点掉那个「信任作者」按钮。回归时的标志：
    `getSnapshot()` 正确，但挂载出来的视图卡在默认模型上。

## Smoke 清单

| 脚本 | 覆盖 |
| --- | --- |
| `smoke-codemode-obsidian.mjs` | Code Mode：本机模型/MCP 测试服务、真实 Vault 调用、取消、输出限额、分支存储及移动端 Node 访问 |
| `smoke-community-obsidian.mjs` | 成品服务上的社区扩展桥 |
| `smoke-research-extensions-obsidian.mjs` | research/clarify 扩展端到端 |
| `smoke-extension-ui-obsidian.mjs` | 原生弹窗、composer、生命周期、模型请求 |
| `smoke-generic-bridge-obsidian.mjs` | 通用桥契约 |
| `smoke-background-bridge-obsidian.mjs` | 后台工厂桥（测试 vault 用生产包副本） |
| `smoke-session-obsidian.mjs` | 会话存储往返（仅桌面） |
| `smoke-durable-obsidian.mjs` | Harness 任务：真实写入后中断、插件重载与恢复、停止、只读查询，以及官方手机加载器的 Node 访问负对照 |
| `smoke-bookmark-obsidian.mjs` | 书签适配器 |
| `smoke-rpiv-todo-obsidian.mjs` | `@juicesharp/rpiv-todo` 桥含 Node 访问负对照 |
| `smoke-typography-obsidian.mjs` | 真实渲染下的排版（用 `--baseline`，无手机档） |
| `smoke-proactive-obsidian.mjs` | 主动智能（用专属的 `run-smoke-proactive.py`） |
| `smoke-model-icon-obsidian.mjs` | composer 模型切换器的厂商标记：会画出来、跟随当前模型、未知厂商时不出现 |

durable smoke 还会限制插件可见的 `Platform` 应用标志，因为官方手机模拟仍
报告 `isDesktopApp: true`。报告同时保留原始与受限标志。6 个负对照必须被真实
的插件专用加载器拒绝；只替换插件看到的平台 API，不修改产物或宿主。
它验证的是桌面 Chromium 上的受限移动端契约，不是 iOS WebKit 或 Android 真机。

不需要 Obsidian 的 DOM 级视觉验证用预览 harness（`bun
scripts/preview-visual.mjs`——必须 bun 不是 node，stub 用了参数属性；snap
Chromium 读不了 `/tmp`，探针页放 `~/` 下）。
