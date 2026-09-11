# OTel 扩展选型调研

日期：2026-09-11；热度 API 查询时间约为 17:09–17:14 UTC。Piem 最终核对基线：`1f359926653e08ac04ee398eaf161a3d38e43b5a`。本轮只做选型并保存本文，未安装候选、改动插件代码、启动 Collector 或验证真实导出。

**选择 `@amaster.ai/pi-telemetry` 0.1.15 作为优先适配对象。** 用户尚未选接收端，按通用 OTLP 评估。它维护活跃、提供标准 OTLP/HTTP traces、使用每实例 provider，最新版已修复默认关闭正文采集的问题。不过五个候选都不能原样直接接入当前 bridge：DoomPi 是库，其余四个都有真实事件或运行时缺口。下载量只用于兼容性相近时比较，不能盖过这些差异。

## 下载量与发布

统一使用 npm downloads API 的完整日期区间，避免 Pi 目录缓存和滚动窗口不同造成错位。近 7 天为 **2026-09-04 至 2026-09-10**，近 30 天为 **2026-08-12 至 2026-09-10**，首尾均计入；不把查询当天尚未结束的数据混入。

| 候选 | 最新 npm 版本 | 发布时间 UTC | 近 7 天下载 | 近 30 天下载 | npm 已发布版本数 |
| --- | --- | --- | ---: | ---: | ---: |
| [@agimon-ai/doompi-telemetry][doompi-npm] | 0.0.1-alpha.67 | 2026-09-09 04:44 | [3,485][doompi-week] | [17,497][doompi-month] | 59 |
| [pi-phoenix][phoenix-npm] | 0.1.3 | 2026-04-22 16:08 | [1,956][phoenix-week] | [13,475][phoenix-month] | 4 |
| [pi-otel][piotel-npm] | 0.1.0 | 2026-05-16 09:55 | [1,195][piotel-week] | [4,139][piotel-month] | 1 |
| [@amaster.ai/pi-telemetry][amaster-npm] | 0.1.15 | 2026-09-11 06:36 | [479][amaster-week] | [3,626][amaster-month] | 92 |
| [@mammothb/pi-otel][mammoth-npm] | 0.2.1 | 2026-08-25 10:06 | [8][mammoth-week] | [931][mammoth-month] | 6 |

下载量是包被下载的次数，包含依赖安装、CI、重复下载，不能等同于用户数、活跃用户或独立安装数。DoomPi telemetry 属于发行版 monorepo 的基础库；总下载量不能直接与独立扩展比较。已发布版本数也包含 alpha/beta，不代表相同次数的实质改进。

同次打开 Pi 目录，五包依次显示 `16.6K/mo · 4,768/wk`、`12.3K/mo · 4,189/wk`、`2,973/mo · 1,980/wk`、`3,573/mo · 315/wk`、`926/mo · 26/wk`，页面没有标出这些数对应的具体日期，与上述固定窗口有差异。最终比较采用可复核的 npm API 数，不拼接两种口径。[目录页][doompi-gallery] [Phoenix][phoenix-gallery] [pi-otel][piotel-gallery] [amaster][amaster-gallery] [mammothb][mammoth-gallery]

## 维护活跃度

核对默认分支 commit 历史；monorepo 另外限定包路径和 `src/`。GitHub 的 `updated_at` 可以被仓库元数据活动改变，`pushed_at` 也不保证默认分支或该包有源码更新，均不作为“最近修复日期”。

| 候选 | 公共仓库与最近相关活动 | 本轮可支持的判断 |
| --- | --- | --- |
| DoomPi telemetry | [AgiFlow/doompi][doompi-repo]，默认分支 `main`。包路径最近提交 `2c2db51`，2026-09-09，为整套 monorepo 的 `chore(release): publish`；`src/` 最近提交 `c95a092`，2026-08-28 10:50，`feat(doompi-telemetry): add end-to-end observability and trace reporting`。查询前 6 条源码提交仅返回它与 08-22 initial commit。[包历史][doompi-commits] [源码历史][doompi-source-commits] | 发行版频繁发布，但该 telemetry 库最近实质源码活动为 08-28。不能把 09-09 的联动版本更新写成当天 telemetry 修复 |
| amaster telemetry | [TGYD-helige/pi][amaster-repo]，默认分支 `master`。包路径最近提交 `811d6da`，2026-09-11 04:49，修复 `includePayloads:false` 在 exporter factory 被丢弃；上一条 `e8ea8f6` 同日 03:18，改进输入即时 span 与退出时未结束 span 清理。此前 09-01 修工具错误和入口循环依赖。当天 npm 0.1.15 与 [GitHub v0.1.15 release][amaster-release] 均已发布。[包历史][amaster-commits] | 五个候选中，明确可安装为扩展且最近仍有具体可靠性、隐私和加载修复的候选。npm 元数据没有 `gitHead`；本轮另读固定发布 tarball，确认 false 参数传递修复及退出结束未完成 span 的逻辑均已包含 |
| pi-phoenix | [philipbjorge/pi-phoenix][phoenix-repo]，默认分支 `main`。最新提交 `af8c23b`，2026-04-22 16:10，修改 AGENTS.md；上一条 `c32bac6` 同日 16:07，`Refine thinking capture and Phoenix rendering`。npm 同日发布 0.1.3。[提交历史][phoenix-commits] | 独立扩展里下载量最高；本轮没有找到 04-22 之后的默认分支开发活动。仓库 `updated_at:2026-07-23` 不能据此改写为七月维护 |
| pi-otel | [NikiforovAll/pi-otel][piotel-repo]，默认分支 `master`。最新提交 `697e441`，2026-05-16 09:59，`docs: badges`；该版本仅发布一次。[提交历史][piotel-commits] | 下载量高于 amaster，但最近默认分支活动停在 05-16。仓库 `updated_at:2026-08-20` 不能据此改写为八月开发 |
| mammothb pi-otel | npm 和 [Pi 页面][mammoth-gallery] 均未提供 repository/homepage。作者名下同名仓库 API 返回 404；[限定作者的 GitHub 仓库搜索][mammoth-search] 返回 0 项。6 个 npm 版本发布于 08-22 至 08-25 | 可确认最近 npm 发布于 08-25，无法从已提供公开来源核定当前源码提交、issue 处理或仓库活跃度；这不证明源码一定不公开 |

GitHub release API 中，DoomPi、Phoenix、无 scope 的 pi-otel 查询均为空；不代表这些包没有通过 npm 发布。amaster 有对应的正式 GitHub release。仓库查询时均未标记 archived；mammothb 因未定位仓库无法确认。[DoomPi releases][doompi-releases] [Phoenix releases][phoenix-releases] [pi-otel releases][piotel-releases]

## 包身份与初步筛选

- **DoomPi telemetry 排除出直接扩展候选。** Pi 页面把类型标为 `package`，其 README 明写：`This is a library, not a Pi extension. It has no Pi manifest or Pi peer dependency and should not be added to a DoomPi layer.` 使用示例要求宿主调用 `createDoomTelemetry`、`recordEvent`、`flush` 和 `shutdown`，并非安装后自动收集生命周期。它还要求 Node.js >=22.19.0。[官方目录及 README][doompi-gallery]
- **amaster 优先做适配评估。** 它声明 Pi extension manifest，OTLP/HTTP 与 Langfuse exporter，配置能控制正文采集；最近有具体维护。不能只因为源码写了官方 SDK，就推断当前 bridge 已经支持。[包目录及 README][amaster-gallery]
- **Phoenix 是明确选用 Arize Phoenix 时的候选。** 它采用 OpenInference，页面明确写会检查会话、系统提示、模型调用、工具 schema、provider 请求和工具执行；采集目标与数据范围需要一起考虑。[包目录及 README][phoenix-gallery]
- **mammothb 值得保留为 traces + metrics 的备选。** 页面声明 Grafana OTLP/HTTP、默认不采正文，以及 `/otel-status`、`/otel-flush`。近一周下载 8 次且源码仓库未定位，不宜在“同样合适”的前提尚未成立时按几个月总发布数判断活跃。[包目录及 README][mammoth-gallery]
- **无 scope 的 pi-otel 是偏 Aspire 的候选。** 页面默认 gRPC/4317，`/otel start` 会尝试启动本地 Aspire/Docker/Podman，须分开考虑追踪库和本地后台进程功能。[包目录及 README][piotel-gallery]

## 固定发布源码与现有 bridge

桥接行为以当前代码为准：[事件集合](../src/extensions/extensionEvents.ts)、[注册检查](../src/extensions/extensionHost.ts)、[构建依赖边界](../scripts/pi-extensions.mjs)、[虚拟 process](../src/extensions/node/process.ts)、[会话平台](../src/extensions/extensionPlatform.ts)。未知事件使该扩展被跳过；虚拟 env 冻结；当前 Node 映射不含 crypto、net、async_hooks 或 timers/promises。`session_before_fork` 已支持，不能沿用旧文档将它列为缺口。

对照四个发布入口的 `pi.on(...)` 与实际事件集合，得到以下静态结果。未运行这些入口；只比较注册调用及宿主验证代码。

| 候选 | 当前不支持的无条件事件注册 | 其余关键差异 | 排序 |
| --- | --- | --- | --- |
| amaster 0.1.15 | `before_provider_request`、`after_provider_response`、`session_compact`；`dist/extension.js:343,368,493` | 每实例 `BasicTracerProvider`；需要 crypto、Buffer、文件配置与可写会话环境适配；OTLP 路径仍静态引入 Langfuse | 首选适配 |
| mammothb 0.2.1 | `session_compact`、`session_before_tree`、`before_provider_request`、`after_provider_response`；`index.ts:164,188,228,235` | traces + metrics；模块级 SDK 与全局 provider；配置依赖还支持执行命令获取凭据 | 确需 metrics 时的备选 |
| Phoenix 0.1.3 | `before_provider_request`；`src/index.ts:209` | NodeTracerProvider / async_hooks、`execFileSync`；默认大量正文采集；配置和显示偏 Phoenix | 选定 Phoenix 后再考虑 |
| pi-otel 0.1.0 | `before_provider_request`、`after_provider_response`；`dist/index.js:157,166` | NodeSDK、gRPC、TCP 探测、Aspire/Docker/Podman 进程控制；另有 endpoint 问题 | 不优先 |

**amaster 的取舍。** [固定 tarball][amaster-tarball] 的 `dist/langfuse/exporters.js:51–54,371–406` 创建实例 provider，不调用全局 `setGlobalTracerProvider`。其采用的 OTel SDK 有官方 browser 映射；阅读 Langfuse 5.10.1 与 OTel 2.10.0 的相关路径，未发现此路径要求 AsyncLocalStorage。不能把所有 OTel SDK 一概判为 Node 专用。

通用导出是 **OTLP/HTTP JSON traces**，不是 protobuf，也不含独立 metrics/logs。endpoint 自动补 `/v1/traces`，可传 headers，默认 20 spans / 5 秒批量、15 秒请求上限。数据字段仍大量使用 `langfuse.*`；标准 OTLP 接收端能接收，并不等于所有后端都能自动识别为标准 GenAI 看板。见发布包 `dist/otel.js:4–5,46–58`、`dist/langfuse/exporters.js:389–398`、`dist/langfuse/mapping.js`、`dist/langfuse/metadata.js`。本轮没有声称其满足完整 GenAI semantic conventions。

默认 `includePayloads:false` 已核实于 `dist/config.js:2–5`、`dist/otel.js:37–39`、`dist/langfuse/utils.js:87–108`：组合 factory 显式传递 false，exporter 删除正文、工具参数/结果与流事件。**错误文字仍总是发送**，不能描述为完全无敏感数据。入口即使关闭正文导出也仍序列化流事件，最多保留 1,000,000 字节再在 exporter 处移除，见 `dist/extension.js:6,389–406`；移动端接入应测这项成本。

退出时确实会结束未完成 span 再 shutdown（`dist/langfuse/exporters.js:86–103`），但 `456–457` 的 `Promise.race` 最多等待 30 秒，并不取消落败的任务/计时器。Piem `extensionHost.ts:639–660` 只给 shutdown 一秒，且 `CommunityHost.dispose()` 先停会话平台。因此需要明确 exporter 的独立资源归属与结束流程，不能简单复用“正在执行的工具操作”作用域。

原厂入口还通过 `process.env.PI_TELEMETRY_*` 和 `process.pid` 传递父子进程关联（`dist/extension.js:179–220`、`dist/langfuse/exporters.js:114,178,429`），与 Piem 同一 WebView 的多会话不相同。配置入口读取 settings 文件；虽然另有标准 OTEL 环境变量解析器，**安装默认扩展不等于自动使用该解析器**。接入必须提供真实的 settings 与会话配置映射。

**mammothb 的额外成本。** [固定 tarball][mammoth-tarball] `src/sdk.ts:163–179,261–279` 使用模块级 `active/inflight`，启动新 SDK 会关闭旧实例，shutdown 会清除全局 tracer/meter；直接放进“一会话一工厂”的宿主会相互影响。`src/config.ts:54–59` 默认不采正文，`src/sdk.ts:191–214` 提供 OTLP/HTTP JSON traces + metrics，10 秒采集一次指标。其 `@mammothb/pi-shared@1.6.0` 的 `src/resolve-secret.ts:1,38–49` 还支持 `cmd:` 并调用 `child_process.execFileSync`，不是仅有 env/file。当前未定位公共仓库是维护可追溯性限制，不能据此断言它没有源码。

**Phoenix 的协议没有锁定后端。** [发布源码][phoenix-source-provider] 使用标准 OTLP/HTTP protobuf，可以发通用 Collector；但 `PHOENIX_*` 配置、OpenInference 字段与跳转链接偏 Phoenix。`global:false` 是优点，但依赖的 `@arizeai/phoenix-otel@1.2.0` 仍静态导入 `AsyncLocalStorageContextManager` 和 `NodeTracerProvider`。[配置源码][phoenix-source-config] 还导入 `execFileSync`。默认采集 prompt、system prompt、thinking、上下文、工具输入输出和 provider payload，扩展没有 metadata-only 设置。npm 固定版的入口、provider 已与对应 GitHub commit 逐字节核对。

**pi-otel 还有通用 endpoint 问题。** [固定 tarball][piotel-tarball] `dist/otel/sdk.js:53–56` 的 TCP 探测拒绝无显式端口的 URL；`https://collector.example` 因而被判不可用。`59–65,97–112` 将同一个 endpoint 原样给多个 signal，没有为 HTTP 自动拼接各自路径。NodeSDK、gRPC 和 `node:net` 静态导入，以及 `/otel` 的进程控制均与当前 bridge 不匹配。它虽可选择 HTTP，改配置本身不会消除这些导入。

**DoomPi 的库身份已确认。** [固定 README][doompi-source-readme] 明确不提供 Pi manifest/factory。[默认适配器][doompi-source-adapter] 延迟加载 `@agimon-ai/log-sink-mcp/telemetry/node`，后者直接使用 async_hooks、fs 与 Node OTel。可以注入替代后端，但那需要自行提供遥测传输和事件接线，不能算作现成扩展的直接安装优势。

## 接入时必须完成的工作

1. 先给 provider 请求/响应、成功压缩等缺失事件接上真实执行路径；不能仅放宽事件名单却从不发送事件。
2. 固定并审计 amaster 原厂源码和完整依赖图，使用 OTel 官方 browser 入口；crypto、配置与 trace 关联按真实宿主能力适配。OTLP browser transport 使用 `globalThis.fetch`，不会自动走 Piem 的 `requestUrl` 或 scoped fetch。需处理 CORS、请求归属和超时，不能全局替换 fetch。
3. exporter、批量计时器和关闭清理按会话归属，避免阻塞普通对话操作。验证两个会话并行、切换、Stop、断网、卸载与重新加载；30 秒的原厂等待预算不能直接照搬进一秒卸载路径。
4. 接收端由用户配置，正文默认不导出，并说明错误文字的边界。若用户要 Prometheus/Grafana 指标而非主要看请求链路，再提升 mammothb 的评估优先级。

作为背景，仓库锁定的 `@earendil-works/pi-telemetry@0.84.3` 是另一包：官方 README 明确它只提供 backend-neutral contract / schema，没有 exporter；不能把已有同名依赖误认为已经具备 OTLP 导出。[固定版本 README][pi-native-readme]

## 本轮验证边界

热度调查只读取 npm registry、npm downloads API、Pi 包页面和 GitHub API；每个请求限时 20 秒，每批最多 3 个并发。兼容性核读下载固定 npm tarball，并检查发布源码、相关传递依赖与最终 Piem 事件集合。没有安装依赖、执行候选代码或启动任何长驻服务，也没有测量完整打包体积。安装依赖大小不等于最终 bundle 大小。

本轮并非集成验收；真实 Collector 收包、Obsidian 内会话结束与插件卸载、多个面板同时运行、断网重试和移动端行为均未验证。研究文档本身不触发代码 PR。

[doompi-npm]: https://registry.npmjs.org/%40agimon-ai%2Fdoompi-telemetry
[phoenix-npm]: https://registry.npmjs.org/pi-phoenix
[amaster-npm]: https://registry.npmjs.org/%40amaster.ai%2Fpi-telemetry
[mammoth-npm]: https://registry.npmjs.org/%40mammothb%2Fpi-otel
[piotel-npm]: https://registry.npmjs.org/pi-otel
[doompi-week]: https://api.npmjs.org/downloads/point/2026-09-04:2026-09-10/%40agimon-ai%2Fdoompi-telemetry
[doompi-month]: https://api.npmjs.org/downloads/point/2026-08-12:2026-09-10/%40agimon-ai%2Fdoompi-telemetry
[phoenix-week]: https://api.npmjs.org/downloads/point/2026-09-04:2026-09-10/pi-phoenix
[phoenix-month]: https://api.npmjs.org/downloads/point/2026-08-12:2026-09-10/pi-phoenix
[amaster-week]: https://api.npmjs.org/downloads/point/2026-09-04:2026-09-10/%40amaster.ai%2Fpi-telemetry
[amaster-month]: https://api.npmjs.org/downloads/point/2026-08-12:2026-09-10/%40amaster.ai%2Fpi-telemetry
[mammoth-week]: https://api.npmjs.org/downloads/point/2026-09-04:2026-09-10/%40mammothb%2Fpi-otel
[mammoth-month]: https://api.npmjs.org/downloads/point/2026-08-12:2026-09-10/%40mammothb%2Fpi-otel
[piotel-week]: https://api.npmjs.org/downloads/point/2026-09-04:2026-09-10/pi-otel
[piotel-month]: https://api.npmjs.org/downloads/point/2026-08-12:2026-09-10/pi-otel
[doompi-gallery]: https://pi.dev/packages/@agimon-ai/doompi-telemetry?name=opentelemetry
[phoenix-gallery]: https://pi.dev/packages/pi-phoenix?name=opentelemetry
[amaster-gallery]: https://pi.dev/packages/@amaster.ai/pi-telemetry?name=opentelemetry
[mammoth-gallery]: https://pi.dev/packages/@mammothb/pi-otel?name=otel
[piotel-gallery]: https://pi.dev/packages/pi-otel?name=otel
[doompi-repo]: https://api.github.com/repos/AgiFlow/doompi
[phoenix-repo]: https://api.github.com/repos/philipbjorge/pi-phoenix
[amaster-repo]: https://api.github.com/repos/TGYD-helige/pi
[piotel-repo]: https://api.github.com/repos/NikiforovAll/pi-otel
[doompi-commits]: https://api.github.com/repos/AgiFlow/doompi/commits?path=packages/core/doompi-telemetry&per_page=5
[doompi-source-commits]: https://api.github.com/repos/AgiFlow/doompi/commits?path=packages/core/doompi-telemetry/src&per_page=6
[amaster-commits]: https://api.github.com/repos/TGYD-helige/pi/commits?path=packages/pi-telemetry&per_page=5
[phoenix-commits]: https://api.github.com/repos/philipbjorge/pi-phoenix/commits?per_page=5
[piotel-commits]: https://api.github.com/repos/NikiforovAll/pi-otel/commits?per_page=5
[mammoth-search]: https://api.github.com/search/repositories?q=%22pi-otel%22%20user%3Amammothb&per_page=10
[amaster-release]: https://github.com/TGYD-helige/pi/releases/tag/v0.1.15
[doompi-releases]: https://api.github.com/repos/AgiFlow/doompi/releases?per_page=2
[phoenix-releases]: https://api.github.com/repos/philipbjorge/pi-phoenix/releases?per_page=2
[piotel-releases]: https://api.github.com/repos/NikiforovAll/pi-otel/releases?per_page=2
[amaster-tarball]: https://registry.npmjs.org/@amaster.ai/pi-telemetry/-/pi-telemetry-0.1.15.tgz
[mammoth-tarball]: https://registry.npmjs.org/@mammothb/pi-otel/-/pi-otel-0.2.1.tgz
[piotel-tarball]: https://registry.npmjs.org/pi-otel/-/pi-otel-0.1.0.tgz
[doompi-source-readme]: https://github.com/AgiFlow/doompi/blob/ca4146c0ffae92ecc5ca5613b9ccc8604691d9b8/packages/core/doompi-telemetry/README.md#L7-L8
[doompi-source-adapter]: https://github.com/AgiFlow/doompi/blob/ca4146c0ffae92ecc5ca5613b9ccc8604691d9b8/packages/core/doompi-telemetry/src/adapters/logSinkTelemetry.ts#L20-L32
[phoenix-source-provider]: https://github.com/philipbjorge/pi-phoenix/blob/c32bac6d76e60945ad30ebad4c368959793f7fbb/src/trace/provider.ts#L11-L30
[phoenix-source-config]: https://github.com/philipbjorge/pi-phoenix/blob/c32bac6d76e60945ad30ebad4c368959793f7fbb/src/config.ts#L23-L55
[pi-native-readme]: https://unpkg.com/@earendil-works/pi-telemetry@0.84.3/README.md
