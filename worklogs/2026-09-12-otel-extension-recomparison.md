# 手机优先的 OTel 扩展重新比较

日期：2026-09-12。目标是 **Obsidian 手机和桌面共用兼容桥、通用 OTLP、尽量不绑定 Langfuse / Phoenix 等服务平台**。下载量只在满足这些条件后比较。以下是选型核验，不是接入完成声明。

重新比较后的建议：**不要因为 Langfuse 耦合就直接换装另一个扩展。旧五选一时，mammothb 最贴近目标，但仍有需要修改上游行为的缺口；如果愿意维护 Piem 自己的遥测接线，更值得采用官方 OTel 浏览器 SDK，并只接需要的元数据事件。** 后者是新开发工作，不是现成包，也没有证据表明首次实施一定更快。

本轮重新读取当前源码。调查期间观察到工作树从 `54b9dc87` 移至 `645917e6`；本轮未执行 Git 提交或分支操作，原就绪性记录基于更早的 `6c1a58fa`。最终比对确认本轮涉及的编译器、平台、事件集合、Agent 服务和子代理运行器没有随此变动。构建和行为探针使用这些源码，未借用上一轮的测试数或手机模拟结果。

## 原五个候选：重新排序依据

下载数据均从 npm 官方 API 本轮重读，月窗口 **2026-08-13～09-11**，周窗口 **2026-09-05～09-11**。下载不是用户数，也不能证明稳定性。包发布和 monorepo 的任意 push 不等于该包源码在活跃维护。

| 候选 | 当前版 / 发布日 | 近月 / 近周 | 对当前目标的判断 |
| --- | --- | --- | --- |
| **`@mammothb/pi-otel`** | 0.2.1 / 08-25 | 931 / 7 | **最贴近的现成候选**：纯 OTel traces + metrics、正文默认关；全局注册、配置路径、secret provider、事件和手机周期成本仍需改。npm 未给公共源码仓库，维护可核实性较弱。 |
| `@amaster.ai/pi-telemetry` | 0.1.15 / 09-11 | 3,371 / 415 | 维护较活跃，但通用 OTLP 路线静态依赖 Langfuse，且 metadata-only 仍逐流事件序列化；不再优先。若上游拆出纯 OTLP 入口可重新考虑。 |
| `pi-phoenix` | 0.1.3 / 04-22 | 13,023 / 1,667 | 原名单中真扩展下载最高；Phoenix SDK、NodeTracerProvider 和默认正文采集不合手机优先的方向。通用 OTLP 本身可用，问题不是协议被 Phoenix 独占。 |
| `pi-otel` | 0.1.0 / 05-16 | 4,139 / 991 | 无 Langfuse 仍不是合适替代：NodeSDK、gRPC/net、进程管理及 endpoint 行为要改，适配范围大。 |
| `@agimon-ai/doompi-telemetry` | 0.0.1-alpha.67 / 09-09 | 17,497 / 2,532 | 共享库，不是可直接登记的 Pi 扩展；默认适配器依赖 Node 遥测栈。高下载量不能与独立扩展直接比。 |

来源：[npm registry][registry]、[统一月下载 API 示例][downloads]；各包确切源 URL 和 JSON 位于 `/tmp/piem-otel-registry-compare-nlp9yg_k/`。按包路径查询的最后源码变更：amaster 09-11（`811d6da4`，正文过滤）；Phoenix 04-22（`c32bac6d`）；pi-otel 05-16（`d9f94365` 格式化，同日 `89c9e3f4` endpoint 修复）；DoomPi 08-28（`c95a0927`）。前轮的原厂实现证据见[初次调查](2026-09-11-otel-extension-research.md)，amaster 当前依赖图和 Langfuse 负担见[就绪性复核](2026-09-12-otel-bridge-readiness.md)。

## 增补搜索：更少依赖也没有现成胜者

本轮对 npm 的 `pi-package + opentelemetry` 和 `pi-package + otel` 各查一轮，先按元数据筛选，再读取四份相关发布源码。此搜索不构成全目录完备性证明。

| 新候选 | 本轮核验 | 为什么暂不采用 |
| --- | --- | --- |
| [`@devkade/pi-opentelemetry`][devkade-package] 0.1.3 | 02-20 发布、近月/近周 60/7；直接用官方 OTel base SDK + metrics，无 Langfuse。 | 默认详细采集；即便 strict，prompt 前 50 字和 bash 前 120 字仍进入 span 名称。无条件 `session_switch` 和对 `firstKeptEntryId` 的读取不兼容当前宿主；全局注册、关闭路径、长文本截断也需修。 |
| [`@the-agency/pi-observability`][agency-package] 0.4.0 | 09-11 发布、近月/近周 35/5；相关源码最后修改为 07-22。实例 provider，只导 traces。 | 无正文采集开关，发送 system prompt、skills、用户/助手/工具正文；无 `session_shutdown` / provider shutdown；默认写本机 JSONL，手机不适用。 |
| [`pi-phoenix-otel`][phoenix-lite-package] 0.2.0 | 09-08 发布；没有 npm 运行依赖，手写 OTLP protobuf，可指定通用 endpoint。 | 静态进程/本机文件依赖；默认 capture 开，关闭后 prompt 和工具路径仍进入 span 名称；工具失败的 wire span 仍一律编码为 OK；每回合等待导出且 export fetch 无自身超时。不是因名字里有 Phoenix 而排除。 |
| [`pi-telemetry-otel`][pi-telemetry-otel-package] 0.1.1 | 直接用官方 OTel SDK，实例 provider，可注入 runtime。 | 没有 capture 开关，input/tool/压缩摘要截断上报，prompt/命令进入 span 名称；`session_switch` 和 compaction cursor 不兼容，且把没有 UI 当作应关闭 SDK 的信号。 |

具体发布源码证据：

- Devkade `src/trace/provider.ts:36–47` 先设 global、然后用本地 provider，关闭时若 forceFlush 抛错会跳过 shutdown；不能错误推断成“B 必然立即关闭 A”。`src/metrics/provider.ts:24–26,64–66` 的 disabled 分支仍从 global 获取 meter，可能连到其他实例。`src/trace/span-manager.ts:63–73,151–161` 直接把未脱敏内容写进 span 名称；`src/privacy/payload-policy.ts:32–49` 从完整文本逐字符缩短、反复数 UTF-8 字节，超长输入最坏是二次方成本。`src/index.ts:208,332` 对应两项确定宿主不兼容。正确之处是有 shutdown，metrics 默认周期 60 秒，并无逐 token 事件缓冲。
- Agency `index.ts:301–325` 用 SimpleSpanProcessor；每个 span 完成即提交导出。`223–258` 实现本机 JSONL fallback；`423–465,488–505` 采集正文与技能。`373–548` 的注册入口没有 shutdown。`310` 构造无参数 OTLPTraceExporter，browser endpoint 配置还需核验，不能仅凭 env 分支认定已正确适配浏览器。
- Phoenix-lite `extensions/phoenix-otel.ts:44,160,689–701` 包含静态 child_process、顶层 tmpdir 和 detached `uvx arize-phoenix serve` 命令；未执行这些路径。`:148–154,508–516,579` 的 span 名称绕过 capture；`:269–282` 将全部 span 编码为 Status.OK，`:592–600` 只把工具错误放属性。`:412–435,605–613` 是等待 HTTP 导出路径；只有 Bearer key 配置，没有任意 header map。
- pi-telemetry-otel `extensions/index.ts:545,755` 订阅 `session_switch` / 读 `firstKeptEntryId`；`:564–580,655,674,757` 采集输入、工具和摘要及内容名称；`:728–737` 在 agent_end 的 `!ctx.hasUI` 分支 shutdown。Piem 关闭面板不等于会话结束，不能沿用这个 CLI 生命周期假设。runtime/span registry 用 globalThis 共享；即便有 runtime 注入入口，也未解决默认内容边界和宿主事件差异。

其余只做元数据初筛：`@damngamerz/pi-otel` 直接依赖 sdk-trace-node，`pi-otel-telemetry` 直接依赖 sdk-node；因明确 Node 专用依赖，不在本轮继续深读。这两者未做完整源码或运行验收，不把初筛写成全面审计。增补名单合计上述六包。

## `@mammothb/pi-otel`：最接近目标的旧候选，仍不能原样接入

本节基于[固定发布包 0.2.1][mammothb-package]及 `@mammothb/pi-shared@1.6.0`。重新下载发布包，SHA1 为 `9796caf55c8eed1f8215344a92fa08b93798aea0`，已有解包目录的全部 **16 个文件逐字节匹配**。下列 `index.ts` / `src/*` 路径均指这个发布包；`shared` 路径指[固定共享库][shared-package]。

### 哪些确实合适

- **没有 Langfuse / Phoenix 依赖。** `package.json` 直接列出官方 OTel API、trace/metrics SDK、OTLP HTTP exporters，以及共享配置库；版本固定在 OTel stable 2.10.0 / experimental 0.221.0。Grafana 的 dashboard 和样例只是附带资料，导出不需要 Grafana 专属接口。
- **支持 traces 和 metrics，协议是 OTLP/HTTP JSON。** `src/sdk.ts:191–214` 分别创建 trace 和 metric exporter；0.221.0 browser exporter 使用 JSON serializer。`src/config.ts:253–259` 从 base endpoint 分别补 `/v1/traces` 和 `/v1/metrics`，显式 per-signal 环境变量则原样采用；header 可配置。不是 gRPC，也不是 HTTP protobuf。
- **不逐 token 缓存事件。** `index.ts` 没有 `message_update` 订阅；按模型请求/响应、工具开始/结束等事件采集，避免了 amaster 即使关闭正文仍逐流事件序列化的问题。
- **采样、计数和延迟都有现成实现。** `src/sdk.ts:95–107` 使用官方采样器；`src/metrics.ts:78–150` 有 token、操作耗时、提示词/回合/工具计数，指标惰性创建；`src/spans.ts` 用显式 span parent 维护 interaction → turn → chat/tool 树，不需要 AsyncLocalStorage。

### 当前必须解决的具体问题

| 位置 | 当前行为 / 证据 | 合理的改法 |
| --- | --- | --- |
| `src/sdk.ts:261–279`、`index.ts:208`、`src/metrics.ts:69–72` | 注册并读取 OTel **全局** tracer/meter，关闭时 `disable()` 全局注册。两个独立 API 实例仍会互相影响，见下面的实验。 | 从各自 `sdk.tracerProvider.getTracer()` / `sdk.meterProvider.getMeter()` 获取句柄，向 tracker/metrics 注入；不调用全局 set/disable。根 span 使用明确 root context，避免被其他插件的 active context 关联。 |
| `shared/src/load-config.ts:13,46–50` | 合法的 `/extensions/config/pi-otel.json` 读完后，还无条件检查 `/vault/.pi/pi-otel.json`；`existsSync` 在 try 外，桥的越界拒绝会直接终止配置加载。 | 共享库支持注入配置或跳过项目文件；Piem 用私有 JSON 投影。不扩大 filesystem 权限，也不把拒绝伪装成文件不存在。 |
| `shared/src/resolve-secret.ts:1,38–51` | 静态导入 `node:child_process.execFileSync`，支持 `cmd:` secret；当前通用编译器已实际报未审计的 Node 依赖。 | 上游拆开 Node-only secret provider；手机入口接收已解析 headers 或仅使用明确的受控 secret 来源。只让一个 stub 抛错会被库捕获并退回字面量 `cmd:...`，不是可靠配置成功。 |
| `index.ts:9,79` | 无条件导入并调用 `os.hostname()`；当前 `src/extensions/node/os.ts` 无该导出。 | 让 host attributes 可注入/省略；保留随机 `service.instance.id` 即可区分实例。不编造手机 hostname。此项为静态缺口，编译目前在更早阶段失败。 |
| `index.ts:188–192` | 无条件订阅 `session_before_tree`，当前宿主仅支持 `session_tree`；未知事件会令整个扩展加载失败。 | 真正实现兼容的 before-tree 事件，或上游改为可选观察事件。不能只给事件改名：before 和 after 的数据/时机不同。此前缺失的 provider events 和 `session_compact` 已补齐，不能继续列为缺失。 |
| OTel 依赖图 | 本轮真实编译两种入口均失败：带点相对路径、包内 browser 重定向、全局访问限制，以及上述 `child_process`。 | 修复通用编译器的审核解析，并保持能力隔离。只选 browser exporter 入口不足以把 core/resources 内部也转成 browser 路径。 |

**更正旧判断：`active` / `inflight` 不是当前串会话问题的充分证据。** 当前 `scripts/pi-scoped-factories.mjs:20–64` 会把捆绑后的模块 body 放进每个 `createFactory` 的闭包，模块变量因此可以按工厂隔离。真正仍共享的是 OTel API 的 `globalThis[Symbol.for("opentelemetry.js.api.1")]` 注册表。

无网络实验：在一个 VM realm 中分别加载两份官方 `@opentelemetry/api@1.9.1` 浏览器构建，注册两个简单假 provider。结果：A 的 trace/meter 注册均为 `true`；B 均为 `false`；B 的 `getTracer` 和 `getMeter` 返回 **A** 的句柄；B 调用 disable 后，注册表仅剩 `version`。这证明全局冲突，不是完整扩展已运行。`src/sdk.ts:261–263` 没有检查这些注册返回值，原厂扩展会忽略冲突。

配置问题也有独立无网络实验：使用真实 `loadPiConfig` 和当前 `createExtensionPlatform`，即使投影提供合法 endpoint，读完 `/extensions/config/pi-otel.json` 后仍因 `/vault/.pi/pi-otel.json` 抛出 `reads outside extension JSON snapshots`。没有启动 SDK 或网络。

### 手机成本和默认数据

- 正文开关默认全关（`src/config.ts:54–59`），但仍对完整请求、响应、工具参数和工具结果执行 **JSON 序列化 + 同步 SHA-256**（`src/spans.ts:253–275,325–335,363–368`；`src/content.ts:49–56,69–87`）。这发生在事件回调里；关闭 capture 或降低采样并不会自动跳过这些调用。比逐 token 缓存少一类成本，却不能等同于低开销已验证。
- 哈希无盐、稳定可关联，不应沿用 README 的“不会泄露内容”保证；可猜的短输入仍可能被字典匹配。错误文字照样可能进入 span status（`src/spans.ts:307–314`）。原生 CLI 还默认读取 hostname/USER，手机桥没有真实 USER，hostname 则尚不支持。
- 每个 SDK 创建 **10 秒 metrics 周期任务**，没有只开 traces 或调整周期的配置（`src/sdk.ts:88,196–219`）。采用 cumulative metrics，既有指标可能继续定期导出。已初始化的并发会话越多，这类工作越多；这不是实际电量测量。
- `BatchSpanProcessor` 未传队列和时间参数（`src/sdk.ts:213`），对应固定 SDK 默认最多 **2048 个完成 span**、每批最多 512、延迟 5 秒、导出预算 30 秒。这个上限不是 JS 总堆内存上限；手机需要合适的批量和关闭策略。
- `shutdown()` 用 `Promise.allSettled` 关闭两个 provider（`src/sdk.ts:239–243`）；Piem 的关闭预算约 1 秒。必须实测慢网、切后台、reload 和多会话，不能据有 shutdown 函数就宣称尾批全到达，也不能直接断言泄漏。

### 通用 OTLP 不代表 GenAI 语义已经齐全

原厂字段以 `gen_ai.*` 和 `pi.*` 为主，明显少于 Langfuse 的平台绑定，但有确定的规范差异：

- `src/attrs.ts:31` 仍使用 `gen_ai.system`；当前[官方 GenAI spans 规范][genai-spans]要求 `gen_ai.provider.name`，且仍处于 Development 状态。`beginChat()` 创建的名字仅为 `chat`，没有规范建议的模型后缀。
- `src/metrics.ts:166–170` 的 `gen_ai.client.token.usage` 只有 token type / request model / 旧 system，缺当前[官方指标规范][genai-metrics]要求的 `gen_ai.operation.name` 和 `gen_ai.provider.name`。`operation.duration` 只打 operation，chat 已知的 provider/model 也没带入。
- `SpanTracker.beginNestedAgent()` 有实现（`src/spans.ts:387–409`），**发布入口没有调用**。它不是已接通的子代理追踪。Piem 子代理另建 Agent，当前未有自己的 CommunityHost，因此主聊天看见 `spawn_subagent` 工具不等于看见子代理内部请求和 token。

这些缺口使 mammothb 成为需要上游改动或持续维护 fork 的候选，而非把 amaster 换个包名就完成的方案。

## 对照路线：Piem 自己接官方 OTel SDK

这条路线可以不带 Langfuse / Phoenix SDK，也不靠全局 provider：官方 BasicTracerProvider 支持实例 `getTracer()`，`Tracer.startSpan()` 可显式传 parent context。需要导出时使用官方浏览器 OTLP exporter，并通过 Piem 的受控 transport 和生命周期管理。保留手机统一桥，不因此开放完整 Node。复用官方 SDK 的 OTLP 编码、批量和重试，不另造一份。

但 **已有的 `@earendil-works/pi-telemetry` 不是可安装的 OTel exporter**。本地 Pi 0.84.3 的 README `7–13` 明说只是后端中立的 TelemetryContext / schema / in-memory 实现；`391` 说明不依赖 AsyncLocalStorage。应用仍要写 adapter 和事件接线。当前 Piem 使用 `new Agent`，其已发布 AgentOptions 没有 telemetry/context 参数；另一个 AgentHarness 虽有 context 类型字段，当前发布实现的 prompt/compact/resume 都未实现。不能为了遥测迁移到它，更不能宣称已经有“一行配置启用”的官方埋点。

需要自维护的范围是具体的：

1. 在主 Agent 的事件和 provider wrapper 中记录模型、tokens、耗时、错误、工具结果；使用流的最终 `message_end` / `result()` 判断完成。Pi 会把一些失败变成 `stopReason: error/aborted`，仅包住 `agent.prompt()` 的 promise 可能误记为成功，返回 stream 对象也会过早结束 span。
2. 通过子代理 runner 的 onEvent 和真实父子 run/tool 关系传播 context；处理后续消息、孙代理和停止。Piem 子代理另建裸 Agent，不经过主会话 CommunityHost；任意普通扩展都不会自动补齐这部分。压缩、分支摘要、quick actions 和 extension complete 也有独立模型调用路径，需明确覆盖范围。
3. 处理安全的 header/endpoint 配置、批量、失败重试、请求限额、切后台、卸载和慢网。官方 browser exporter 的 fetch 不会自动经过 Obsidian requestUrl，SDK 也不会自动继承现有 bridge 的资源归属。
4. 做真实 Collector 收包、双会话隔离、停止/retry、子代理关联和手机生命周期验证；语义字段与内容政策另验，不以“能收包”代替。

官方 Pi contract 可以参考其被动记录/业务不受遥测失败影响的约定和 conformance tests，但当前 Agent 不消费它，不应为了用上接口再造一层没有调用方的抽象。首期若只需元数据 traces，可先接这些真实事件；metrics 有明确用途时再接官方 metrics SDK。这是范围建议，不是已获授权的实施或已完成交付。

## 本轮证据和验证边界

- 发布包和无网络探针：`/tmp/piem-mammothb-verify-20260912/`，含 `package-verification.json`、`global-provider-probe.mjs` / `global-provider-result.json`、`config-bridge-probe.ts` / `config-bridge-result.json`。两个行为探针的断言均通过。
- 真实依赖图编译：`/tmp/piem-otel-recompare-20260912-wf4esudp/mammothb/build-results.json`。15 包固定依赖组，默认 ESM 与显式 browser exporters 均失败；诊断清单有版本/文件哈希，但不是已完成安全审核的生产清单。
- 规范来源固定在官方仓库 commit `0c87594975195608dc91b3f702e250a7b240c151`，同时保留下载副本；不把“能收 OTLP”替代规范核验。
- 本轮没有安装仓库依赖、修改产品源码或启用上报。没有 Collector 收包、真机性能或完整扩展运行结果。探针进程均已退出。

[mammothb-package]: https://registry.npmjs.org/@mammothb/pi-otel/-/pi-otel-0.2.1.tgz
[shared-package]: https://registry.npmjs.org/@mammothb/pi-shared/-/pi-shared-1.6.0.tgz
[genai-spans]: https://github.com/open-telemetry/semantic-conventions-genai/blob/0c87594975195608dc91b3f702e250a7b240c151/docs/gen-ai/gen-ai-spans.md
[genai-metrics]: https://github.com/open-telemetry/semantic-conventions-genai/blob/0c87594975195608dc91b3f702e250a7b240c151/docs/gen-ai/gen-ai-metrics.md
[registry]: https://registry.npmjs.org/%40mammothb%2Fpi-otel
[downloads]: https://api.npmjs.org/downloads/point/2026-08-13:2026-09-11/%40mammothb%2Fpi-otel
[devkade-package]: https://registry.npmjs.org/@devkade/pi-opentelemetry/-/pi-opentelemetry-0.1.3.tgz
[agency-package]: https://registry.npmjs.org/@the-agency/pi-observability/-/pi-observability-0.4.0.tgz
[phoenix-lite-package]: https://registry.npmjs.org/pi-phoenix-otel/-/pi-phoenix-otel-0.2.0.tgz
[pi-telemetry-otel-package]: https://registry.npmjs.org/pi-telemetry-otel/-/pi-telemetry-otel-0.1.1.tgz
