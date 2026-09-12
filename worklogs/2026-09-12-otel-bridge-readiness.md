# OTel 扩展接入就绪性

日期：2026-09-12。核对 Piem `6c1a58fa9efb17d4608588a6a6693a8db9fbb0ab`，目标是手机可用的统一桥。对象仅为上次首选 **`@amaster.ai/pi-telemetry`**。

**尚不能原样接入。事件、基础 Node 接口和后台资源桥已具备，但真实 SDK 依赖图仍有确定的编译阻塞。** 这不否定之前的扩展选型，也不需要改走桌面 Node；先补下面三个通用构建缺口，再验收真实导出。

## 版本与来源

- 2026-09-12 03:40 UTC 查询 [npm registry][registry]：最新仍为 **0.1.15**，发布于 `2026-09-11T06:36:43.510Z`；没有更新的扩展版本。
- [固定发布包][tarball] SHA1：`d9ea14ea0768462c3164e5f4f4095989a839fe24`；SHA512 与 registry `integrity` 相符。复用的 `/tmp/otel-candidate-research-remaining/amaster/package/` 全部 **56 个文件**与 tarball 逐字节一致。
- 扩展的依赖含 `^` 范围；“扩展仍是同一版”不等于“依赖仍是同一版”。下文区分昨日已读版本和本次新解析版本，不把旧依赖组的结果套到新组。

扩展源码引用以下固定发布包内的路径；依赖源码引用对应版本 npm 包的路径。它们是发布源码证据，不是根据 README 推断实现。

## 已补齐的部分

| 能力 | 本轮源码核对 |
| --- | --- |
| 事件注册 | 发布入口 13 个 `pi.on(...)` 全部位于 [当前支持集合](../src/extensions/extensionEvents.ts:5)，缺失数为 0。`before_provider_request`、`after_provider_response` 已连接 [实际主会话请求](../src/agent/ObsidianAgentService.ts:4525)；`session_compact` 在保存后发送（同文件 5366、5388 行）。扩展仅读 `fromExtension`，不访问不受支持的 `firstKeptEntryId`。 |
| 配置文件 | [私有 process](../src/extensions/node/scopedProcess.ts:31) 默认提供 `PI_CODING_AGENT_DIR=/extensions/config`。`@amaster.ai/pi-shared@0.1.15/dist/settings.js:69–107` 据此读取 `settings.json` 的 `"pi-telemetry"` 部分，可对应 [扩展自己的配置命名空间](../src/extensions/extensionPlatform.ts:178)。对全局/项目真实文件路径的读取被桥拒绝，其非 strict 读取会捕获并返回空配置。 |
| 基础接口 | `node:crypto` 的 UUID、随机字节、SHA-256，Buffer，私有可写 env，`timers/promises` 都已有实现和 [编译映射](../scripts/pi-scoped-factories.mjs:224)。不能再把这些列为完全缺失。 |
| 后台资源 | [每工厂资源](../src/extensions/extensionResources.ts:34) 管理请求与定时器；[生产服务](../src/agent/ObsidianAgentService.ts:682) 注入 `requestUrl` 和物理请求名额。正确编译后，直接 `globalThis.fetch` 可被绑定到该能力；这不表示任意 global alias 也已支持。 |

这些是当前源码核对；没有把上一轮 3752 项测试或手机模拟当成本轮真实 OTel 验证。

## 已复现的编译阻塞

使用现有 `buildScopedFactory`，把固定依赖安装到临时目录，生成包含版本、文件 SHA256、入口和依赖边的**诊断清单**。这份清单用于让实际编译器遍历依赖，**不是已完成逐文件安全审核的生产清单**，也没有加入仓库。

1. **SDK 的全局访问写法被桥拒绝。**
   - `@langfuse/tracing@5.10.1/dist/index.mjs:112–131` 使用 `const g = globalThis` 保存全局状态；[编译器 176–191 行](../scripts/pi-scoped-factories.mjs:176)明确拒绝这种别名，报 `Indirect extension platform access is unavailable.`。
   - `@langfuse/core@5.10.1/dist/index.mjs:8–12` 的 `getEnv(key)` 回退读取 `globalThis[key]`；[205–209 行](../scripts/pi-scoped-factories.mjs:205)拒绝动态键，报 `Dynamic extension platform access is unavailable.`。
   - 通用 OTLP 仍静态导入 Langfuse：扩展 `dist/langfuse/exporters.js:3–8`。仅把配置里的 Langfuse 关闭，不能消除构建阶段的这些路径。不能为了通过而直接删除隔离检查。
2. **包内的浏览器重定向尚未纳入审核解析。** OTel 包的 `browser` 字段把 `build/esm/platform/index.js` 重定向至 browser 实现；当前 [解析器 266–272 行](../scripts/pi-scoped-factories.mjs:266)对包入口使用 `audit.exports`，对相对导入却直接走 `relativeSource`，不执行该重定向。真实结果仍走到 `@opentelemetry/core/build/esm/platform/node/index.js` 和 `resources/.../platform/node/HostDetector.js`。只显式选择 browser exporter 入口仍不能修正其余包内路径。
3. **带点但省略 `.js` 的相对导入被误判。** `@opentelemetry/core@2.10.0/build/esm/utils/merge.js:6` 导入 `./lodash.merge`，发布包实际有 `lodash.merge.js`，诊断清单也登记了它。但 [relativeSource 140–149 行](../scripts/pi-scoped-factories.mjs:140)把 `.merge` 当作扩展名，不再尝试补 `.js`，报 `Unaudited extension source: .../utils/lodash.merge`。

## 配置与运行语义仍需接线

- **产品尚未登记该扩展。** [工厂清单](../src/extensions/communityFactories.mjs)、[审核清单](../scripts/pi-extension-packages.json)均无 amaster telemetry；没有遥测接收端设置。已有官方 `@earendil-works/pi-telemetry` 是另一包，不能当作它已经安装。
- **可复用私有配置，不必开放真实文件系统。** 未来给合法扩展 ID（如 `pi-telemetry`）提供 `settings.json`，内容为 `{"pi-telemetry":{"otel":{"enabled":true,"endpoint":"https://collector.example"},"includePayloads":false}}`。原厂 factory 使用文件配置（`dist/extension.js:203–211`），不会自动调用另一个标准 OTEL 环境变量解析器（`dist/otel.js:60–80`）。这里只说明映射，没有写入或启用该配置。
- **子代理不会自动串进 trace。** 扩展以 `PI_TELEMETRY_*` 与真实父子进程 PID 推断关联（`dist/extension.js:179–193,218–220`）；Piem 的 [PID 是私有虚拟编号](../src/extensions/node/scopedProcess.ts:63)，env 不跨工厂继承。更关键的是 [子代理直接创建 Agent](../src/subagent/runner.ts:374)，使用 [原始 streamFn](../src/agent/ObsidianAgentService.ts:874)，没有自己的 CommunityHost。主会话能看到 `spawn_subagent` 工具，不等于看到了子代理内部的模型请求、工具和 token。完整追踪须用真实的父子运行关系接线，不能靠伪造 OS 进程继承。
- **关闭预算仍不同。** 扩展 `dist/langfuse/exporters.js:86–103` 会结束开放 span 并 shutdown；请求预算 15 秒，`456–457` 用 30 秒 `Promise.race` 等待。宿主 [shutdown 只给 1 秒](../src/extensions/extensionHost.ts:715)，随后撤销后台请求和计时器。不能保证断网/慢网时最后一批全部送达，也不能仅凭此断言有幽灵任务。`requestUrl` 的物理 IO 不能强行取消，现有桥会保留名额直到真实结束。
- **实例 provider 是优点，全局 SDK 行为仍须实测。** 扩展 `dist/langfuse/exporters.js:52–54,371–406` 使用自身 `BasicTracerProvider`，没有注册全局 provider；`LangfuseSpan` 只包装已有 span，constructor/end 不读取 global tracer（`@langfuse/tracing@5.10.1/dist/index.mjs:158–178,242–245`）。但依赖含全局状态，构建器接通之后仍须测多会话和 reload。OTel browser processor 的 document 监听在 shutdown 开始时移除（`@opentelemetry/sdk-trace@2.10.0/build/esm/platform/browser/export/BatchSpanProcessor.js:14–41`），不是等网络 flush 成功才移除。

## 手机成本与数据边界

默认 `includePayloads:false` 的修复仍在：`dist/config.js:2–5` → `dist/otel.js:37–39` → `dist/langfuse/utils.js:87–108`。它在生成 span 名称和属性之前去掉正文、工具参数/结果、模型输入/输出及流事件。

仍保留**工具名称和调用 ID、随机 UUID 会话 ID、模型、用量/费用、状态、错误文字**（`dist/langfuse/metadata.js:3–58,72–84`）。入口的会话 ID 来自 `randomUUID()`（`dist/extension.js:190–192`），不读取 Piem 会话文件路径；metadata-only 也先移除 `args.path`，不会把它加入工具 span 名称。不过工具失败时，`dist/extension.js:59–70` 可能把工具结果文本作为 `error`，其中的路径或笔记片段仍会发送。不能把“默认不发正文”说成“绝无敏感内容”。

关闭正文导出也**没有关闭正文处理成本**：`dist/extension.js:389–406` 仍逐流事件转换、`JSON.stringify`、`Buffer.byteLength`，每次 generation 最多累计 1,000,000 字节的序列化事件预算；达到上限后仍做转换和序列化。这个数字不是整个 JS 对象堆的内存上限。应测手机长回复成本，优先让 metadata-only 从入口就跳过不需要的内容捕获。

该包通用导出仅为 **OTLP/HTTP JSON traces**：`@opentelemetry/exporter-trace-otlp-http@0.221.0/build/esm/platform/browser/OTLPTraceExporter.js:5–14` 使用 `JsonTraceSerializer`；不提供独立 metrics/logs，属性仍偏 `langfuse.*`。接收端能收 OTLP，不等于自动得到标准 GenAI 看板。

## 本轮证据与未验证部分

临时根目录 `/tmp/piem-otel-readiness-20260912-6d79y45i`。依赖安装使用 Bun `--ignore-scripts --omit peer --network-concurrency 2`，不运行安装脚本；仓库的 package.json、bun.lock 和 node_modules 均未修改。

| 依赖组 | 实际版本 | 本轮编译结果 |
| --- | --- | --- |
| 复核之前已读的版本 | 扩展/共享配置库 0.1.15；Langfuse 5.10.1；OTel stable 2.10.0、experimental 0.221.0；API 1.9.1；semantic-conventions 1.43.0，共 17 包 | `build-results.json`：ESM 默认入口、显式 browser exporter 均失败。 |
| 只固定扩展 0.1.15，按今天的范围重新解析 | Langfuse 5.11.1；sdk-trace-base 2.11.0（内含 core/resources/sdk-trace 2.11.0）；其余 OTLP 0.221.0、顶层 core/resources/sdk-trace 2.10.0；API 1.9.1；semantic-conventions 1.43.0，共 20 包 | `current/build-results.json`：两种入口仍失败，命中相同三类缺口。没有把 OTel 0.221 的兼容范围错误升级为 0.222。 |

两组 `build-probe.mjs`、`probe-audit.json` 与 Bun 锁文件保留在各自目录，可复核来源和入口选择。额外的 `minimal-root-causes.json` 用四个本地最小包分别复现带点相对路径、global 别名、动态 global 属性、包内 browser 重定向，**4/4 重现**。

对照的标准 esbuild `platform: "browser"` 构建，两组都能正确选择 OTel browser 文件并解析 `lodash.merge.js`，见 `reference-build-results.json`；它把扩展的 `node:crypto/fs/os/path/timers/promises` 留为 external，**仅用来定位解析差异，不是可交付的手机 bundle，也未执行**。这说明不能把本轮失败解释成“OTel 必须完整 Node”；缺口位于当前自定义解析与绑定规则。

原厂图未能编译，所以**未运行原厂扩展，没有向任何 Collector 发送遥测**；没有开启配置或部署。真实 Collector 收包、慢网 shutdown、手机 WebView 生命周期、完整子代理树和新增生产成品体积均未验证。下一步仍选择 amaster：补通用构建缺口、登记固定且经审核的包，再逐项完成接入验收。

[registry]: https://registry.npmjs.org/%40amaster.ai%2Fpi-telemetry
[tarball]: https://registry.npmjs.org/@amaster.ai/pi-telemetry/-/pi-telemetry-0.1.15.tgz
