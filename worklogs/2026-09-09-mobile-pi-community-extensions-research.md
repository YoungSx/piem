# 基于现有 Node 桥的 Pi 社区扩展手机兼容性调研

日期：2026-09-09。Piem 基线：`e95ab7c`；官方 Pi 扩展宿主固定为 `0.84.3`。

**建议先接 `pi-assistant-provenance`，再接 `pi-model-switch` 和 `pi-invisible-continue`。** 三者的原版核心路径已通过本次无 Node VM 探针，但用了研究宿主；后两种接口层面的工作不能省略。下一批考虑 `pi-clarify`、`pi-web-search`；`pi-context` 留到会话桥更完整时。

**目前没有新增社区扩展可以承诺“装上就在 iOS/Android 可用”。** 当前产品只静态内置官方 bookmark，没有通用扩展安装入口。本次完成选型和可行性验证，没有改产品、安装到用户 Vault 或进行手机真机测试。以下“接入”均指审核固定版本、补好宿主接口，随正常 Piem 发布内置；上游 README 的 `pi install` 是 Pi CLI 命令，不是 Piem 手机安装方法。

## 证据与筛选方法

- 从 [Pi 官方包目录](https://pi.dev/packages)、npm `pi-package` 元信息和作者仓库发现候选。目录收录不代表官方兼容认证。
- 读取 **23 份固定 npm 发布物：22 个扩展包及 1 个配置依赖**。下载时比对 registry `dist.shasum`，只解包文本，没有安装依赖或运行安装脚本；最终复核 709 个已下载文件的 SHA-256，无变动。
- 根据真实入口、调用路径、维护活动、许可和 Piem 已有能力筛选。stars 只是调查时的关注度，集合仓库的 stars 不归到某一个扩展；没有根据 stars 宣称质量经过认证。
- 从原包中挑 3 个原版工厂，连接官方 `loadExtensionFromFactory`、`ExtensionRunner`、`wrapRegisteredTools` 做浏览器 VM 探针。模拟模型注册表、消息发送和模型切换都标为测试替身，没有把它们当作真实 Agent 或提供商调用。
- 核对生产代码与测试记录，并重跑两份桥接测试。旧 worklog 的 Obsidian 手机模拟结果单独列明，没有冒充本轮重跑。

## 现有桥究竟覆盖什么

| 层面 | 当前真实能力 | 对社区扩展的影响 |
| --- | --- | --- |
| Node 模块 | `path` 的纯路径计算、虚拟本地 `file:` URL、浏览器 `events`；私有 `process` 的 cwd 为 `/vault`，platform 为 `browser` | `/vault` 是路径身份，不等于获得文件访问权。没有电脑 HOME、真实环境变量或终端 |
| 文件 | `fs` 只读打包资源；当前资源仅 `/pi/package.json`。写入、目录扫描、watch、异步 readFile 均拒绝 | 不能将它理解成 Vault 的 Node 文件系统；`fs/promises` 也没有桥 |
| 系统能力 | `spawn/spawnSync`、运行时 `require/resolve`、`tmpdir` 均拒绝 | Git、PTY、ffmpeg、stdio MCP 等不会因加 polyfill 而在手机出现 |
| 解析范围 | 构建桥只匹配官方 `pi-coding-agent` 包内部的 importer | 第三方工厂的 `node:fs` 等 import **不会自动桥接**；需对已审核包增加明确范围 |
| Pi 宿主 | bookmark/unbookmark、`getEntries/getLabel/setLabel`、内部 notify | 工具、context/input 事件、模型、完整消息、配置和 UI 都要另外接线。现有 getEntries 甚至只投影 id/type/role，没有正文 |
| UI | 原生 Obsidian 书签 UI；Runner 为 print 模式 | 绑定了 UI 对象不等于所有 UI API 可用；select/input/widget/custom/theme 等当前全部拒绝 |
| 分发 | 固定工厂和官方文件摘要，代码随 main.js 发布 | 不从 URL/Vault 动态执行 JS/TS，不在手机安装 npm 包 |

证据：[Node 模块](../src/extensions/node/)、[资源 fs](../src/extensions/node/fs.ts)、[构建范围与拒绝门禁](../scripts/pi-extensions.mjs)、[生产宿主](../src/extensions/officialBookmark.ts)、[书签数据投影](../src/extensions/bookmarkHost.ts)、[产品扩展说明](../docs/extending.zh-CN.md)。

现有 [网络桥](../src/net/obsidianFetch.ts) 已明确：原生 fetch 受各平台 CORS 约束；Obsidian requestUrl 可以避开 CORS，但没有增量流式接口。社区扩展直接调用 fetch，不会自动进入这条桥。

## 六项短名单

表中“成本”是接口和生命周期复杂度判断，不是工期估算。所有项目都尚未产品集成或真机验收。

| 顺序、扩展及固定版本 | 用户得到什么 | 还要接什么 | 本次结论 |
| --- | --- | --- | --- |
| **1. [pi-assistant-provenance][provenance] 0.1.0** | 换模型后，让新模型知道上一段由谁写；有助于区分接力者 | `context`、真实当前模型；只读可选配置；扩展的虚拟文件身份 | **最适合首个接入。** 原版无自有网络、进程、TUI 或写盘；默认配置的标注、去重和工具续接保护已通过 VM。它不是面向用户的回复署名 UI |
| **2. [pi-model-switch][model-switch] 0.2.0** | 让代理查询、搜索和切换模型，例如按视觉能力或成本选模型 | 注册工具、`getAvailable/setModel`、已配置且可用的模型目录；可选 aliases.json | **价值高，成本中等。** 无 TUI/自有网络。原版 current/list/search/switch 通过模拟注册表探针；真实密钥、切换生效时机和别名落盘未验证 |
| **3. [pi-invisible-continue][invisible] 0.3.11** | 用户点继续，恢复工作时不额外把“继续”文字发给模型 | 命令、完整消息读取、忙闲状态；隐藏 custom message 的持久化、followUp 队列和 context 过滤 | **运行依赖最少，生命周期成本中等。** 只有 type import。原版标记发送和过滤通过 VM；真实模型续跑、重试和整理后的恢复未验证。只由用户触发，不是无限自动续跑 |
| **4. [pi-clarify][clarify] 1.0.1** | 把口语草稿整理成清楚提示词，放回输入框，由用户编辑并发送 | 模型查询/鉴权、`complete` 传输、input 事件、get/setEditorText、配置读写 | **值得第二批。** 源码明确有非 TUI 分支，适合手机输入；静态依赖仍带 BorderedLoader/CLI 根入口，不能因运行分支不用 TUI 就判已能打包。配置写入不能空实现；取消也要补齐 |
| **5. [pi-web-search][web-search] 1.5.0** | 用 Google、xAI、OpenAI 或 Anthropic 的搜索能力获取带引用结果；Gemini 另有 URL Context | fetch/流读取、鉴权、模型目录、只读配置、活动工具事件、Text 渲染；`util` 的编解码器 | **值得第二批。** 没有 child_process/用户文件写入；但根入口、TUI 和环境变量读取仍要处理。网页搜索增加 Piem 现有 web_fetch 之外的发现能力，服务端支持、费用及手机网络尚未实测 |
| **6. [pi-context][context] 2.2.0** | 对话检查点、时间线，以及带交接摘要的新分支 | 完整 Session 树/分支投影、branchWithSummary/branch/navigateTree、上下文用量、取消和命令派发；另有 TUI dashboard | **后续评估，成本高。** 主工具入口无自有 Node IO；主要难点是会话语义。0.84.3 满足其版本下限，不代表 Piem 已实现相同 CLI Session API |

### 维护与许可快照

| 扩展 | 调查时的质量信号 | 许可证据 |
| --- | --- | --- |
| assistant-provenance | dot314 集合约 130 stars，最近 push 2026-09-07；实现集中且无运行时依赖 | npm 有 MIT 正文和作者归属 |
| model-switch | 约 99 stars，最近 push 2026-08-23；单一工具、接口较小 | 声明 MIT，npm 未带 LICENSE；再分发前补核正文和归属 |
| invisible-continue | 约 15 stars，最近 push 2026-09-05；专门处理失败尾消息和工具配对，但社区验证规模较小 | 声明 MIT，npm 未带 LICENSE；再分发前补核正文和归属 |
| clarify | 约 178 stars，最近 push 2026-08-11；提供非 TUI 分支，改写后交回用户 | npm 有 MIT 正文和作者归属 |
| web-search | 约 25 stars，最近 push 2026-09-08；关注度小，但有持续 API 适配 | 声明 MIT，npm 未带 LICENSE；再分发前补核正文和归属 |
| context | 约 287 stars，最近 push 2026-09-09；包含命令派发超时和 session_shutdown 清理 | 声明 MIT，npm 未带 LICENSE；再分发前补核正文和归属 |

这些数字取自作者仓库 API，可能随时变化。源码和判断固定到下方 commit/npm 版本；未将“活跃”当作“已证明无缺陷”。

## 本次真实执行了什么

### 三个原版工厂的无 Node 探针

使用本仓库 esbuild 0.25.5、固定 Pi 0.84.3 的原版 loader/runner/wrapper。浏览器 CJS 产物在 VM 中初始化并异步调用；不提供全局 process、Buffer、require、Bun、fetch，也不提供真实文件系统、模型网络或定时器。未修改第三方工厂和现有桥模块。

| 工厂 | 当前构建解析器 | 研究性扩大解析范围后 | 实际执行路径 |
| --- | --- | --- | --- |
| invisible-continue | **构建通过**，无 external import | 不需要扩大 | `/continue` 发出 display:false、triggerTurn:true、deliverAs:followUp 标记；context 删除标记及末尾无工具调用的失败消息；保留带 toolCall 的助手消息；status 读取模拟完整消息 |
| assistant-provenance | **失败**：第三方 node:fs/path/url 没有映射 | **通过**：仅让该候选复用现有只读桥，并提供虚拟 import.meta.url | 默认无配置时的跨模型标注、重复过滤不叠加、工具结果续接不插入；传入消息未被原地修改 |
| model-switch | **失败**：第三方 node:fs/os/path/url 没有映射 | **通过**：同上，没有增加可写 fs | 原版工具经原版 wrapper 执行 current/list/search/switch，未知模型返回 isError；模拟 setModel 确实收到目标，**没有切换真实提供商**；只验无别名分支 |

扩大范围只发生在临时研究脚本，不是生产改动。它验证了“可以复用有限桥模块”，没有实现可读用户配置或完整 ExtensionAPI。真实宿主中，sendMessage 还必须启动/排队并持久化，setModel 必须真正兑现模型切换；探针的记录数组不提供这些行为。

独立研究产物分别为 344225 / 345796 / 348906 字节，包含研究宿主及官方运行器；**不是 Piem 的包体增量，也不是手机启动性能指标**。三个产物均无 external import，异步检查时 Node 全局仍缺席。执行前后入口 SHA-256 不变：

| 固定工厂 | SHA-256 |
| --- | --- |
| invisible-continue 0.3.11 continue.ts | `840726e68cfb992152ec83a828b86aa1bd35ab24b094a542b5281d4b85a5a0f1` |
| assistant-provenance 0.1.0 index.ts | `1d83ee0d686cbefded5b8a21f4cc5e374eef07bf9907cff5da458d17301fa40d` |
| model-switch 0.2.0 index.ts | `88c5ca0434d369dc172e415510715845bcccff7eeb6e1747603d42a52b1c7674` |

临时脚本和原始结果：[probe.mjs](/tmp/pi-mobile-extension-probe-2026-09-09/probe.mjs)、[results.json](/tmp/pi-mobile-extension-probe-2026-09-09/results.json)。在此工作树重跑：

```bash
timeout 45s node /tmp/pi-mobile-extension-probe-2026-09-09/probe.mjs
```

脚本需要本机现存的 `/tmp/pi-community-source-audit` 文本样本和本仓库依赖；不是可离开这些材料独立复现的产品测试。临时文件可能被系统清理。固定 npm 版本、commit、入口摘要和测试边界保留在本文。

### 现有桥回归

本轮分别执行，均通过：

```text
bun test src/extensions/node/nodeBridge.test.ts  → 3 pass / 0 fail
bun test scripts/pi-extensions.test.ts          → 4 pass / 0 fail
```

覆盖虚拟路径和拒绝能力、官方原版 bookmark 浏览器构建/运行、虚拟包资源读取，以及动态 loader 重新可达时构建失败。未重跑整仓 verify，因为产品代码和依赖没有修改。

已有 [书签验收记录](2026-09-09-pi-bookmark-bridge-smoke.md) 记载真实 Obsidian 的官方手机模拟、插件 require 隔离和 41 项检查；[成品 VM 测试](../src/bookmarkBundle.test.ts) 用真实 service 检查书签持久化。前者是历史执行记录，后者本轮只读了代码，均没有外推到新增候选。**iOS/Android 真机、系统 WebView、软键盘、后台恢复和性能仍未验收。**

## 不建议首批整包引入的热门扩展

| 项目 | 为什么暂缓或排除 | 对 Piem 的建议 |
| --- | --- | --- |
| [pi-context-prune][prune] 1.4.0，约 235 stars | fs/promises 配置写入、复杂 TUI、模型摘要、Session 写 API 和多种事件；自动摘要同时处理所有批次，无显式并发上限；自动路径没有统一卸载取消 | 放在后期；先评估净 token/费用/缓存收益及手机内存。不能宣传“免费省 token” |
| [pi-web-access][web-access] 0.28.0，约 1401 stars | Git clone/gh/curl、Chrome cookie/SQLite/钥匙串、ffmpeg/ffprobe 等，以及 Node 网络依赖 | 首批用较窄的 web-search 或既有 web_fetch/远程 MCP。HTTP 子功能可评估，不能拿它证明整包兼容 |
| [pi-subagents][subagents] 0.66.0，约 3514 stars | 后台路径实际 spawn Node + jiti，依赖 pi-server 0.85.0、真实文件/进程等 | 继续复用 Piem 已有子代理；包内部分前台路径不用进程，不代表整包可运行 |
| [pi-mcp-adapter][mcp-adapter] 2.32.1，约 1440 stars | stdio、native keyring、localhost OAuth 回调、worker/vm/进程等 | Piem 已有 Streamable HTTP MCP，优先用现有通道 |
| [rpiv-advisor][advisor] / rpiv-todo 2.9.0，rpiv 集合约 773 stars | 顾问系统提示词/配置同步文件读取、配置持久化、完整命令或清单 overlay 依赖 TUI | 顾问工具本身是模型请求，没有必需的子进程；后续可以评估。但会额外发送会话上下文给顾问模型，须说明接收方与费用 |
| [pi-fusion][fusion] 0.9.1，约 55 stars | 多模型评议，配置/TUI/会话条目都要接线；默认最多 3 个 panel，模型调用并发常量 4 | 用户确实需要多模型评议时再做，不能为功能相近而默认增加手机并发和费用 |
| [narumiruna 的 pi-btw/pi-firecrawl][narumi] | btw 完整入口带全屏 TUI、URL 打开的 spawn；firecrawl 带 TUI kit、临时目录和配置写入 | 不因为是聊天/HTTP 功能就判“天然支持手机” |
| [mitsuhiko/agent-stuff 的 answer][answer] | 提取问题后使用定制 TUI Editor 和两次 ui.custom，还有模型鉴权与完整分支读取 | 原生 Obsidian 问答 UI 适配完成前暂缓。其 continue.ts 很轻，但只有 shift+alt+enter 快捷键；手机仍需命令入口 |

### context-prune 的关键纠偏

原始工具结果不会被删除，但**日志仍会改变并增大**：它另存完整 resultText 索引、隐藏摘要、frontier 和统计。因此应描述为“保留记录，再写索引和摘要，减少以后发给模型的上下文”，不能写“不动日志”。索引仅保存文本块，不是对任意多模态输出的无损恢复。

1.4.0 默认 `enabled:false`；session_start 加载配置后的默认触发模式为 `agent-message`，开启后在完成回复时整理。本插件有自己的开关，不符合我们默认能力全部提供的直接接入预期。自动整理对所有批次 Promise.all，可能产生额外并发请求；手动进度定时器的清理也不都在 finally。完整评估需先解决取消、卸载、批次数量和输出上限。

证据：[配置默认值][prune-config]、[摘要并发][prune-summary]、[原版入口][prune]；npm dist/index.js 中对应行 64–73、339–360、543–569、4519–4520、4571–4624、4677–4795。仓库源码路径与 npm dist 行号不能混用。

### 两个较窄的 HTTP 备选

[ben-vargas/pi-packages][ben-packages] 的 `@benvargas/pi-exa-mcp@1.2.0` 与 `@benvargas/pi-firecrawl@1.1.0` 没有 TUI 或子进程，前者做 HTTP JSON-RPC，后者做 scrape/map/search。两者都有 MIT 正文，但会首次创建配置、把长输出写到 tmpdir，仍不能在当前桥原样工作。Piem 可先评估通过现有远程 MCP 获得相同服务；这属于接服务，不等于安装其 Pi 扩展，本次未配置或实调服务。

## 推荐的接入路线与手机验收门槛

1. **先用 provenance 建立真正的事件通路。** 在现有每会话 SessionRuntime 持有原版 Runner，把 emitContext 接到已有 transformContext；保留当前 Vault 上下文注入，确定两者顺序及 custom message 到模型消息的转换。不可替掉原有逻辑，或把数据标记不小心滤掉。允许的第三方 importer、只读资源、虚拟 import.meta.url 都按固定包审计。
2. **然后接模型工具。** 复用已有模型/凭据服务，仅暴露实际配置可用的模型。Piem 当前运行中切模型会延后到整轮收尾；社区工具若立刻返回 Switched 就可能与真实执行不符。需明确兼容语义，验证同一工具调用所在会话、模型日志和下一次请求，而不是只改设置。alias 配置需要真实 Vault 快照或只读发布资源，不能宣称现有 fs 可读用户文件。
3. **再接继续命令与消息动作。** 复用 Piem 的队列、忙闲、重试和压缩状态。原版 sendMessage 是 void 接口；异步写盘和后续派发必须有可等待的宿主调用边界及错误显示。Piem 当前未用 Agent.followUp；不能直接透传后就称原生队列兼容。只在用户触发时继续，不增设无限后台自动任务。
4. **HTTP/编辑框第二批。** 用 Obsidian 原生输入交互，复用密钥密封和网络通道。非流式 requestUrl 与扩展流式解析之间的差异需实测；没有拿真实凭据调用就不宣称搜索或改写 API 已通。配置同步写入要有真实持久化语义，不能以 Promise 冒充 fs.writeFileSync 的成功返回。
5. **每个候选再通过产品级验收。** 完整 release bundle、真实 Agent/Session、命令/工具/错误/取消、写盘失败、A/B 切会话、分叉/重载、连续触发、断网和卸载。iOS 与 Android 的 Obsidian 真机分别验证软键盘、系统 WebView、切后台再返回和大日志占用；量包体增量和新增定时器/监听/任务，而非引用本次 VM 的独立产物大小。

这些是后续实现的具体门槛，不是本次已通过清单。当前研究保留原版扩展和官方运行器，不推荐为适配某个扩展而重写全套运行时，或升级整套 Pi 作为默认前置。

## 固定来源与原始材料

六项核心 npm 版本：

- [pi-assistant-provenance 0.1.0](https://registry.npmjs.org/pi-assistant-provenance/0.1.0)，gitHead `16206091b2264c9e0f6d11933584211f8dd9bccc`。
- [pi-model-switch 0.2.0](https://registry.npmjs.org/pi-model-switch/0.2.0)，npm 无 gitHead；index.ts 与 [commit c8605ea][model-switch] 逐字一致。
- [pi-invisible-continue 0.3.11](https://registry.npmjs.org/pi-invisible-continue/0.3.11)，npm 无 gitHead；continue.ts 与 src/index.ts 均与 [commit 0d54cdb][invisible] 逐字一致。
- [pi-clarify 1.0.1](https://registry.npmjs.org/pi-clarify/1.0.1)，gitHead `aa2a7a1fa3446cd2700fcd68e10158b2809b10ac`。
- [pi-web-search 1.5.0](https://registry.npmjs.org/pi-web-search/1.5.0)，gitHead `d6eb1d76ad51797a15a483dea169f24b7b46d8ff`。
- [pi-context 2.2.0](https://registry.npmjs.org/pi-context/2.2.0)，gitHead `0235d4e762bb253fb1c4f781def0bc9eecbc4c45`。

本机材料：[23 份发布物与文件摘要清单](/tmp/pi-community-source-audit/audit-manifest.json)、[仓库维护快照](/tmp/pi-community-source-audit/repository-metadata.json)、[社区源码审计明细](/tmp/pi-mobile-community-discovery-2026-09-09.md)、[官方目录 HTML](/tmp/pi-packages-community-discovery.html)。原包、生成 bundle 和临时探针未纳入产品仓库；调研仅新增本文。

[provenance]: https://github.com/w-winter/dot314/blob/16206091b2264c9e0f6d11933584211f8dd9bccc/extensions/assistant-provenance/index.ts
[model-switch]: https://github.com/nicobailon/pi-model-switch/blob/c8605ea077e972e77166c3a0e6e5389e091741a9/index.ts
[invisible]: https://github.com/monotykamary/pi-invisible-continue/blob/0d54cdb734ab165e4db4d766eea4c360368334c1/continue.ts
[clarify]: https://github.com/dodo-reach/pi-clarify/blob/aa2a7a1fa3446cd2700fcd68e10158b2809b10ac/extensions/clarify.ts
[web-search]: https://github.com/ttttmr/pi-web-search/blob/d6eb1d76ad51797a15a483dea169f24b7b46d8ff/src/index.ts
[context]: https://github.com/ttttmr/pi-context/blob/0235d4e762bb253fb1c4f781def0bc9eecbc4c45/src/index.ts
[prune]: https://github.com/championswimmer/pi-context-prune/blob/a5fe6973a264dc37031ba02f1a3feb85b82709ab/index.ts
[prune-config]: https://github.com/championswimmer/pi-context-prune/blob/a5fe6973a264dc37031ba02f1a3feb85b82709ab/src/config.ts
[prune-summary]: https://github.com/championswimmer/pi-context-prune/blob/a5fe6973a264dc37031ba02f1a3feb85b82709ab/src/summarizer.ts
[web-access]: https://github.com/nicobailon/pi-web-access/tree/e55f78a6cf28e2ba5013e14c3dd7bb5eef2ac7c5
[subagents]: https://github.com/nicobailon/pi-subagents/blob/0fc0eebb9604970c506708b7508d6aa38921fde2/src/runs/background/async-execution.ts
[mcp-adapter]: https://github.com/nicobailon/pi-mcp-adapter/tree/10a45367e033a32026987a75d6f401e37340c86f
[advisor]: https://github.com/juicesharp/rpiv-mono/tree/59100c75f256a004fe4bb0ce8eb6266d79f0791a/packages/rpiv-advisor
[fusion]: https://github.com/synthetic-recon/pi-fusion/tree/abf45ea1901047798cd0bbd2a3c4dc09cb363bf3
[narumi]: https://github.com/narumiruna/pi-extensions/tree/3d15bc27d665925cbda63dc5c25647c9eb5ae13d/packages
[answer]: https://github.com/mitsuhiko/agent-stuff/blob/122e2994adddb113c04764c5697217dae120fcc6/extensions/answer.ts
[ben-packages]: https://github.com/ben-vargas/pi-packages/tree/fc0a6ac2bfb712f8e4d0fbf72857fff629837619/packages
