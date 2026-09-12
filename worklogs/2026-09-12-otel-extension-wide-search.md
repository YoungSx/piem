# 可适配 Piem 的 OTel Pi 扩展：扩大搜索

日期：2026-09-12。Piem 基线 `645917e6ad7e285e244da7bf03c3816060f5762a`。要求：手机与桌面共用兼容桥、通用 OTLP、避免不必要的服务平台绑定；这次继续寻找现成扩展，不以自建 SDK 代替候选调查。

**这轮有新的优先适配对象：[b1tank/pi-otel][b1tank]。** 它只通过 Git 分发，不能与 npm 的同名 `pi-otel` 混淆。原始源码使用官方 OTel 浏览器可用的依赖，三种信号、实例 provider、正文默认关闭；本轮已通过标准浏览器构建和双实例无网络运行探针。它仍不能原样通过当前 Piem scoped compiler，且模型耗时、默认指标频率和错误内容还有需要修正的地方。

较强 npm 备选为 **`@keegancodes/pi-otel`**；若优先严格的内容边界，**`@damngamerz/pi-otel`** 也值得保留，不应仅凭其依赖表含 `sdk-trace-node` 就彻底排除。两者均需适配，不是已经可装可用。

## 搜索覆盖

| 来源 | 本轮实际覆盖 | 不能由此推出的结论 |
| --- | --- | --- |
| [Pi 官方目录](https://pi.dev/packages) | 35 个关键词、36 个结果页，234 行、140 个去重目录条目；其中新增潜在导出扩展 19 个，其余包括旧候选、本地看板、查询工具和无关命中 | 不是 140 个可用 OTel 扩展，也不是下载整个目录的源码 |
| [npm 官方搜索](https://registry.npmjs.org/-/v1/search) | 20 组查询、9000 行、5046 个去重命中；精选 44 个新增或邻近包读取精确版本/manifest/README，20 包查固定窗口下载 | 不把搜索命中数当扩展数；两条大关键词查询仅覆盖 4250/9653、250/4653，未穷尽 |
| GitHub | 12 次仓库搜索、10 页代码搜索、3 份生态目录；27 条带身份/固定 SHA/审阅深度的记录，含非导出库、仅设计稿和本地记录工具 | 同名仓库不是同一 npm 包；搜索不涵盖私有、未索引仓库或全部分支 |

关键词覆盖 OTel/OTLP/telemetry/tracing/observability/GenAI，也包括 Grafana、Jaeger、Honeycomb、Laminar、Langfuse、Braintrust、LangSmith、Logfire、Opik、MLflow 等后端名称。目录名称只作发现线索，协议判断追到真实源码或明确保留为待审。

npm 搜索曾返回 429，降速后停止进一步翻页；原始失败和覆盖记录保留。Pi 目录真实 GET 表单和 Next 链接均已读取，没有猜造隐藏 API。三个来源有重叠，数字不能相加当总候选数。完整逐项数据见[清单](2026-09-12-otel-extension-wide-inventory.json)。

## 优先清单

T/M/L 分别指 traces（请求链路）、metrics（指标）、logs（日志）。下载窗口为 **2026-08-13～09-11 / 09-05～09-11**；Git-only 包没有可比较的 npm 下载量。

| 候选与获取方式 | 信号 / 实际协议 | 本轮证据与优点 | 主要剩余工作 |
| --- | --- | --- | --- |
| **[b1tank/pi-otel][b1tank]，Git-only，0.2.0** | T/M/L；HTTP JSON | 无直接 Node 内置模块导入、无 gRPC/Langfuse；本地 provider；13 个订阅事件当前全支持；标准浏览器构建与双实例探针通过 | 当前桥的共同构建缺口；LLM span 结束时机；默认每秒 metrics；错误文字和多会话指标资源身份；Piem 实际接线 |
| **[@keegancodes/pi-otel][keegan] 1.0.0** | T/M/L；HTTP JSON 或 gRPC | 三种 provider 实例使用；无直接文件/进程依赖；事件名均已支持；月/周 131/10 | 拆开静态 gRPC；默认工具路径仍出站；模型失败状态；固定 10 秒指标周期与每轮 flush；声明的公共仓库本轮返回 404 |
| **[@damngamerz/pi-otel][damn] 0.1.6** | T/M；HTTP JSON | 基础遥测不传正文/工具结果；不 hash 整段正文；不注册全局 provider；在 message_end 结束模型请求；正文评估默认关 | NodeTracerProvider 静态依赖；真实 settings 文件路径；失败 stopReason 判断；评估功能拆分；peer Pi 范围与当前版本不同 |
| [@mammothb/pi-otel][mammoth] 0.2.1 | T/M；HTTP JSON | 纯 OTel、正文默认关、无逐 token 缓存；这次已找到并匹配公共源码 | 全局 provider、配置/命令取密钥、hostname、before-tree、完整内容 hash、10 秒指标周期；见[前轮实测](2026-09-12-otel-extension-recomparison.md) |
| [@desek/pi-opentelemetry][desek] 0.1.1 | T/M/L；HTTP 实际 JSON，另有 gRPC | 正文默认关、事件名支持、信号/间隔可配；月/周 315/46 | 发布版把 JSON 称 protobuf；静态 gRPC/Git 进程；endpoint 重复补路径；旧事件字段；全局注册及顺序 flush |
| [@senad-d/observme][observme] 0.1.9 | T/M/L；HTTP protobuf | 内容开关默认关闭；信号配置/清理设计完整；实例 tracer；月/周 214/17 | Node 网络、文件、fork 配置 helper；全局清理所有权；Node provider；手机改造面较大 |
| [stnly/pi-otel][stnly]，Git，0.3.1 | T/M/L；HTTP/gRPC 多协议 | 实例 provider、协议/采样/关闭配置较完整；源码 09-10 仍更新 | 默认完整内容；Node os/http agents/process signals/hrtime；动态加载；当前不支持的事件；约 3500 行生产 TS |
| [jcpowermac/pi-otel][jcp]，Git 源码，0.2.0 | T；OTLP + 文件/console/memory | 正文默认关、事件名均已支持；源码 09-11 更新 | NodeTracerProvider.register、静态 file exporter、配置路径；未确认 npm 分发与独立 LICENSE 文件 |
| [@latitude-data/pi-telemetry][latitude] 0.0.3 | T；手写 HTTP JSON | 无遥测 SDK、factory 独立、12 个事件已支持、可关闭正文、有 10 秒请求超时；月/周 27/7 | Node 身份/Git/文件读取；固定服务形状认证；错误文字绕过 no-content；shutdown/inflight 与晚过滤正文；保留为轻量改造路线 |

这是按当前手机适配成本和证据排序的清单，未承诺任何一个完整接入已经通过。

## b1tank 的真实验证

源码固定在 [`337d1390571dacc4b07e6500ecbadabf585c19d9`][b1tank]，最后提交日期 08-26；09-10 的仓库 push 时间不能充当源码维护日期。MIT、GitHub 查询时 0 stars、README 自称早期发布，`package.json` 标记 `private: true`。不能借用 npm `pi-otel` 的下载量。

上游锁文件：OTel API 1.9.1；core/resources/trace/metrics SDK 2.10.0；HTTP exporters/log SDK 0.221.0；semantic-conventions 1.43.0。五个生产 TS 文件没有直接 fs/child_process/net/async_hooks 导入；`process.env` 是配置入口。三种 provider 都直接通过自身 getTracer/getMeter/getLogger 获取句柄（[telemetry.ts][b1-telemetry]）。

| 本轮检查 | 结果与解释 |
| --- | --- |
| 原始源码与参考构建输入 | 五个 TS、package、锁文件、LICENSE，共 8 文件逐字节一致，未打源码补丁 |
| 标准 esbuild `platform: browser`，按上游锁定版本 | **136,065 字节、0 external imports**。这是独立参考产物，不是最终 Piem 体积增量 |
| VM 环境 | 无 require/Buffer/Bun/真实 process；只注入测试用 process.env、数字 timer、document 监听计数器和内存 fetch；没有系统 Node 模块访问 |
| 两个原厂 factory 实例 | A 产生 3 个 span，B 两轮产生 6 个；关闭 A 后 B 可继续。三种信号走 `/v1/traces`、`/v1/metrics`、`/v1/logs`，观测 Content-Type 为 `application/json` |
| 内容检查 | 正常成功路径的 prompt、system、provider payload/header、工具参数/结果、回答中放入专用 sentinel，导出的 JSON 不含这些 sentinel；不代表异常文字已脱敏 |
| 收尾 | 两实例 shutdown 后，探针记录的 interval、timeout、document listener 均为 0 |
| 当前 Piem `buildScopedFactory` | **仍失败**。上游锁定依赖与今天按范围解析依赖两组，各试默认 ESM 和显式 browser exporters，均卡在包内 browser 映射、`./lodash.merge` 相对路径、OTel 全局访问/误入 Node 图 |

**该实验没有真实 Collector、Obsidian、手机或慢网。** fetch 在内存中记录真实 SDK 生成的 JSON 并立即回应；用于验证原厂浏览器执行、基础双实例行为和清理，不等于端到端接入。实验将 metrics 间隔配置为 60 秒、export timeout 100ms；没有把这当原厂默认值的性能证明。

原厂还需处理的具体问题：

1. **LLM 耗时包含工具执行。** [index.ts][b1-index] 在 before_provider_request 开始 chat、turn_end 才结束；当前 Pi 的 turn_end 发生在工具执行之后。应按最终模型消息结束 LLM span，并校准工具父节点，而不是把工具时间记成模型耗时。
2. **默认指标频率偏高。** [config.ts][b1-config] 每 1 秒 metrics、1 秒导出超时；trace/log 每 500ms 批量。metrics 可用环境变量调慢，但没有独立信号开关。手机后台、并行会话和实际关闭预算仍需测试。
3. **关正文仍扫描结构。** index.ts 的 capture 先调用 sanitizeForCapture，再进入 content 的关闭早退；仍复制/遍历部分回答与工具对象。可在入口先判断 capture，避免无用工作。
4. **错误仍可能带文字。** provider errorMessage 被直接构造成 Error，再写 exception/status；测试只证明正常内容没有出站。工具错误分类较克制，但不能外推到所有错误。
5. **资源和父上下文需按宿主确定。** 根 span 回退 context.active()；没有生成 service.instance.id。私有 provider 不会自动保证多会话 cumulative metrics 的资源身份正确，需要明确合并或区分策略。
6. **Piem 特有子代理仍需接线。** 普通 spawn_subagent 工具记录不等于子代理内部模型请求；此次没有改变这个边界。
7. README 声称 HTTP protobuf，但固定发布依赖和本轮运行均为 **HTTP JSON**。配置/文档应按实际行为解释。

因此下一步最有价值的是让 **这个具体原厂扩展**通过现有桥并修正上述语义，而不是继续凭抽象的小工厂测试声称“通用桥已兼容所有 OTel”。

## 其他发现：用途、服务绑定和实现边界

| 类别 | 新发现的候选 | 保留或排后原因 |
| --- | --- | --- |
| 只需要指标时 | `@mobrienv/pi-otlp`、`claude-code-opentelemetry` | 前者已读源码：仅 metrics、默认 60 秒，仍有 debug 文件流/全局注册/同名工具计时冲突；后者仅 metadata/README 核验。不能代替调用链 traces |
| 只需要日志时 | `pi-codex-otel`（mkusaka） | OTLP logs，不提供同等模型 span 树；已读部分源码会尝试 OAuth SQLite/auth.json、Git email、hostname。月/周 954/202；不能凭热度当通用追踪器 |
| 平台 SDK，但确有 OTLP | `@grafana/agento11y-pi`、`@lmnr-ai/pi-extension` | Grafana 原厂必须同时配置自有 generation API；Laminar 可自定义 OTLP 地址，但要求 key，默认完整正文，Node context/关闭路径有负担。均已读固定源码 |
| 可换 endpoint 的小型实现 | `@latitude-data/pi-telemetry`、`@ramarivera/pi-langfuse` | 两包均已核源码，手写 OTLP JSON、无 Langfuse SDK；Latitude 保留为轻量改造路线；Ramarivera 缺正文开关/超时/收尾且有默认外部地址，排后 |
| 有可换 endpoint 的线索，需继续核实 | `@traceroot-ai/pi-extension` | README 允许自定义 Collector；仍有 Node provider 和 API key，未完成完整源码审阅，保留待审 |
| 热门平台方案 | `@braintrust/pi-extension`、`@langchain/langsmith-pi-extension`、`@raindrop-ai/pi-agent`、`@respan/instrumentation-pi`、`@posthog/pi` | 包与 Pi 入口真实存在；本轮多数只核 metadata/README。Braintrust 文档需要本地 tracing daemon；其余尚未证明有符合目标的轻量通用 OTLP 路径 |
| GitHub 源码移植参考 | `yuta24/pi-harness/extensions/otel.ts`、`woxQAQ/otelpi`、`@oh-my-goose/pi-otel-genai`、`markacianfrani/pi-signoz` 等 | 有真实埋点实现，仍有手写协议、Node 网络/文件/进程、许可不明或宿主 API 差异；详见逐项清单，不作为已经可装候选 |
| 明确不是同类成品 | `@introspection-sdk/introspection-pi`、`@earendil-works/pi-telemetry`、`robobryce/pi-local-otel`、`Saturate/pi-telemetry-pi` | 依次是需宿主注入 tracer 的库、无 exporter 的契约库、本地 JSONL、仅 SPEC。不能拿来凑可用扩展数量 |

`gattjoe/pi-otel-minimal` 也已读源码：默认外部服务地址、整份会话 JSONL 发 Loki、提示词/命令进入 span 名、打印 headers，明显不符合这次元数据优先目标。没有执行这些代码。

### 两个名字带平台、实际没有平台 SDK 的轻量候选

**Latitude 0.0.3** 的扩展入口约 34KB 源码，手写 OTLP JSON；CLI 依赖不在扩展图里。`LATITUDE_BASE_URL` 可指普通 Collector，只有 `/v1/traces` 请求，没有第二条私有 API。它仍要求非空 key/project，固定 Bearer 与 X-Latitude-Project。`LATITUDE_PI_NO_CONTENT=true` 能在序列化时过滤正文属性，span 名不拼提示词，这些是优点。

确定缺口位于发布包 `dist/extension.js`：1–5 的 Node imports 和 137–146 的无条件身份采集；879 行原错误文字经 270–273 行无条件写 status.message，绕过 no-content；1005–1007 的 shutdown 只 reset，不 flush 活动 run；导出有 10 秒 AbortController，但未记录所有 inflight 供卸载等待。关闭正文也仍先缓存/序列化完整请求再过滤。它是可以评估的轻量改造对象，不能称为已兼容或隐私问题已解决。

**Ramarivera 0.1.1** 的主源码约 20KB，也没有 Langfuse SDK，可用标准 traces endpoint 覆盖目标。发布包 `src/extension.ts:99–100` 缺省指向作者的外部地址；没有 capture 开关，`455–475` 不检查 HTTP 状态、没有请求超时，入口也没有 shutdown。默认会发完整对话、工具、host/路径；没有执行它。这些实际行为比“零依赖”的标签更影响选型。

### damngamerz：更正仅凭 Node 依赖表筛除的做法

固定 [0.1.6 发布源码][damn]：`dist/telemetry/providers.js:6,32,57–58` 虽使用 NodeTracerProvider，却没有调用 register，tracer/meter 直接按实例使用；换 browser provider 是可定位的上游接缝。`dist/index.js:110–120` 在真实模型消息结束时收口，message_update 只记首次 token，没有正文缓存。`dist/telemetry/traces.js` 仅记录安全标识、用量、时间和有界错误类型；评估默认关闭时不扫描并导出整段对话。

但 `dist/config.js:143–153,299–313` 固定读取真实 home/project settings；桥拒绝会变成 ConfigError。远端 endpoint 需要单独允许，且仅支持无 path 的 base URL。provider 图仍静态绑定 Node，另有不需要的 LLM 评估入口；错误响应仅判断显式 errorType/HTTP status（traces.js:130），没有把 message.stopReason:error/aborted 计为失败。npm 0.1.6 内部仍报 VERSION 0.1.2，peer Pi 限 `>=0.80.10 <0.81.0`，当前 Piem 是 0.84.3。它是值得保留的适配候选，但不能说只换一个 import 就完成。

### mammothb：已找到公共源码

真实仓库为 [mammothb/pi-extensions][mammoth-source]。对照 npm 0.2.1：16 个文件中 14 个同路径逐字节一致，包含全部生产源码；LICENSE 与仓库根文件一致；package.json 的区别是 workspace/catalog 在发布时解析为固定依赖和字段顺序变化。

包路径最近变更为 08-25 的 `fa7583e75b6e293a78e226bd227669325536e1d8`；仓库 09-01 的 push 不代表该包 09-01 又修过。此前“没找到公共仓库”的结论到此更新，前轮已复现的运行问题仍然成立。

## 证据与后续使用

完整清单保留来源、版本/commit、审核深度和阻塞；未读源码的条目不会升级为“兼容”。原始搜索 HTML/API JSON、tarball 校验、下载源码分别保存在：

- `/tmp/piem-otel-wide-npm-20260912/`：20 组查询/44 个精确元数据、20 包下载窗口、keegancodes/desek/mobrienv 发布源码与无网 emitter 片段探针。
- `/tmp/piem-otel-wide-catalog-20260912-szmm85sv/`：35 关键词官方目录、逐项分类、Grafana/ObservMe/Laminar 等固定发布源码与来源。
- `/tmp/piem-otel-wide-github-20260912/`：仓库/代码搜索、固定 tree/source、27 条身份清单、mammothb 匹配证据。
- `/tmp/piem-wide-otel-20260912-xb2phspk/`：damngamerz 固定发布包；b1tank 的两组依赖解析/scoped compiler 失败；`b1tank-locked-probe/browser-run.mjs` 与结果、锁文件、metafile、源码一致性记录。

独立参考 bundle SHA256 为 `36cc04d286a973c72ae60cdc3d7019149ddfb78db63ad23e4adbfc93fe066ee2`。产品源码/仓库依赖没有改动，没有启用遥测，没有真实设备性能或 Collector 收包声明。工具进程在本轮结束时核对清理。

[b1tank]: https://github.com/b1tank/pi-otel/tree/337d1390571dacc4b07e6500ecbadabf585c19d9
[b1-index]: https://github.com/b1tank/pi-otel/blob/337d1390571dacc4b07e6500ecbadabf585c19d9/src/index.ts
[b1-telemetry]: https://github.com/b1tank/pi-otel/blob/337d1390571dacc4b07e6500ecbadabf585c19d9/src/telemetry.ts
[b1-config]: https://github.com/b1tank/pi-otel/blob/337d1390571dacc4b07e6500ecbadabf585c19d9/src/config.ts
[keegan]: https://registry.npmjs.org/@keegancodes/pi-otel/-/pi-otel-1.0.0.tgz
[damn]: https://registry.npmjs.org/@damngamerz/pi-otel/-/pi-otel-0.1.6.tgz
[mammoth]: https://registry.npmjs.org/@mammothb/pi-otel/-/pi-otel-0.2.1.tgz
[mammoth-source]: https://github.com/mammothb/pi-extensions/tree/78d58654432d26a63545b9428a336eb3e3c99af1/packages/pi-otel
[desek]: https://registry.npmjs.org/@desek/pi-opentelemetry/-/pi-opentelemetry-0.1.1.tgz
[observme]: https://registry.npmjs.org/@senad-d/observme/-/observme-0.1.9.tgz
[latitude]: https://registry.npmjs.org/@latitude-data/pi-telemetry/-/pi-telemetry-0.0.3.tgz
[stnly]: https://github.com/stnly/pi-otel/tree/398d40a72a1ba3a599e8596f26c3f148df1e7296
[jcp]: https://github.com/jcpowermac/pi-otel/tree/898387d631d469cf13a0bed6bd7ab1cffb4747ab
