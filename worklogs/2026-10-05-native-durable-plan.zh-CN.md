# Durable 原生对齐：审计与渐进迁移计划

## 审计基线与结论

本次为架构审计和开发计划，不是实现或运行验证。

- 初次计划审计时工作区：`356a072`，接入前；阶段 0 实施前已快进到 `9a3211f`。
- 实时查询确认 PR #548 已合并；审计读取最新 `origin/master` 的 `9a3211f`，其前一提交为 `92f13da`。
- 项目固定 Pi 家族依赖为 `1.0.1`。npm latest 为 `pi-durable 1.0.2`，发布包对应上游提交 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`。
- 阅读了新版发布包 README、声明和生成/工具执行源码；1.0.2 CHANGELOG 记录的是持久化 provider session UUID 修复，不是一次执行架构重写。

结论：让官方内置任务拥有执行状态；Piem 保留 Vault、传输、扩展语义和界面适配。最薄不以文件行数判断，而以谁决定排队、重试、恢复、取消、压缩和终态判断。每项只能有一个权威。

## 已核实的迁移障碍

| 现状及证据 | 意义与处理 |
| --- | --- |
| `DurableAgent.execute` 调用 `super.prompt/continue`；`SessionExecution.run` 创建 `piem.run.*` 自定义任务 | 仍是旧循环执行、Harness 包裹调度。目标改为 `Conversation.submit` 驱动内置 GenerationTask/ToolTask，不在外面再套一个运行任务。 |
| `SessionExecution.recoverMessages` 手动补工具中断结果 | 官方 ToolTask 在调用前保存执行意图；只有历史和当前策略都为 `safe` 才重放，默认 `unsafe`。迁移后删除这套重复恢复逻辑；不要承诺外部副作用恰好一次。 |
| `piTranscript.transcriptEntry` 依赖 Piem 的 `data.type`，PiemSession 维护 UUID 索引 | 官方产生的消息不能假设天然符合旧数据形状。需先让读取端识别原生条目，保留旧链接、分支和历史身份，禁止通过观察事件再复制写一份消息。 |
| `snapshotExecution/restoreExecution` 与 `mergeExecutions` 保存、重建单个自定义任务 | 不能用这份快照承载原生生成、工具、压缩、子任务、inbox 和 memo。数据方案必须先于执行切换落地。不能按数字 ID 拼接两台设备的任务树。 |
| `ObsidianAgentService` 的 finishTurn 同时处理扩展、队列、压缩 | `afterTools` 返回 void；`onYield` 仅处理最终回答后的继续，并会追加用户输入。不是一对一重命名，需覆盖调用时机、终止与是否新增消息的契约。 |
| beforeProviderRequest/afterProviderResponse 作用于网络 payload/response | 不能错误映射到作用于模型消息的 beforeRequest/afterResponse；应留在 Models/传输桥。 |
| `src/net/streamFn.ts` 注册的自定义 provider 使用空模型列表；旧循环直接传 Model 对象 | 原生生成通过 `models.getModel(provider, modelId)` 查找。必须确保自定义端点的选中模型可解析；可复用现有 Models 工厂，不另建 provider 框架。 |
| `withTurnRetry`、队列派发和压缩恢复仍在服务中 | 原生 retry、inbox、CompactionTask 接管时同步移除旧路径，防止重试叠乘和重复派发。SDK 内部重试与 durable attempt 重试分别定义预算。 |
| 主聊天/团队成员使用 DurableAgent，但 `src/subagent/runner.ts` 仍创建 Agent | 迁移范围不只主聊天。团队成员是可独立继续的会话，临时子代理是被任务拥有的工作，不能不加区分地改成相同所有权。 |
| 官方 generation 每约 100ms 节流提交 partial；当前 Vault 存储按提交追加 | 原生流式持久化可能增加移动端写入、日志体积和同步负载。必须实测；UI 合并渲染不能解决磁盘写放大，不能吞提交或先报成功后异步落盘。 |

以上是源码支持的迁移风险，不宣称都是已复现的现有故障。

## 目标结构

`界面命令 → Conversation.submit/configure/abort/compact → 官方内置任务 → Vault 工具及 Models 传输桥`

`官方已提交状态 → viewState → 界面投影`

兼容旧扩展事件可短期使用 `watchEvents`，但它仍标为 experimental，必须隔离且处理 snapshot 重置；事件只通知，不反向决定或补写执行状态。

保留：Vault 存储与同步策略、网络和凭据注入、工具业务实现、笔记引用及冻结上下文、扩展旧契约转换、界面投影和诊断展示。执行真相属于 durable；诊断账本只作记录。

## 六个阶段

### 0. 基线和兼容契约

从最新主分支开发。核对 Pi 包与 overrides 的版本约束，将兼容的一组升级到 1.0.2；不要只升级 durable 并让 overrides 强行保留不兼容底层版本。

建立行为清单：发送接纳、steer/follow-up、扩展停止/继续、模型热切换、工具参数和结果修改、压缩、停止/关闭、恢复、分支、同步、团队和子代理。把不可映射的行为明确列出。

交付：独立依赖升级 PR 和契约回归。验收：原有 verify 全绿，provider session 身份在原生小实验中跨重启稳定、分支独立。单纯升级不能宣称旧循环已获得新版原生生成能力。

### 1. 先打通数据与宿主适配

用官方 MemoryStorage 和 VaultStorage 做最小 submit → tool → reopen 实验。复用现有 Models 工厂，补齐模型解析；适配工具入参、signal、details/output、结果和 executionMode；写入及未审计外部工具保持 unsafe。

让历史读取识别原生条目；确定旧 UUID 链接映射、分支和迁移格式。同步必须保留完整原生状态；先研究可用的公共持久化能力，不预设有官方任务图导入接口。外部冲突无法安全合并执行时，保存分叉和证据，禁止把旧执行重建成可重跑任务。

旧 pending 不可直接冒充 GenerationTask 检查点。优先只让新会话使用新格式，旧格式保留隔离的兼容读取/恢复；待迁移契约通过后，在静止状态迁移，并保留可回退原件。

验收：纯原生条目可见、旧历史与链接不丢、Stop 凭证和 task-only 同步保留、故障前后工具不重复写入。跑公开 storage conformance 并确认 Bun runner 兼容性。测量 partial 带来的写入次数、字节、峰值内存和事件积压。

### 2. 切换一条完整执行链

选择一类新会话，完整采用 submit → GenerationTask → ToolTask → 已提交状态；不按“先模型、再工具”拆成两个同时控循环的系统。

通过开发测试及预发布渠道推进，不新增面向用户的能力开关。每个会话只允许一个执行引擎；已接纳任务不得因错误回退到旧引擎重发。

可用小型外观保持调用处稳定，但不能继续继承 Agent 并调用旧循环。同一 PR 删除该路径的手工消息落盘、补中断结果、busy/terminal 权威和自定义运行包装。

验收：发送后立刻 Stop、保存失败、请求重试、结果落盘前中断、只读查看不启动、关闭后恢复。端点、OAuth、移动传输和模型切换均走真实配置桥。

### 3. 对齐扩展、队列和压缩

将 transformContext 映射到 beforeRequest，保留冻结引用和实时笔记正文规则；工具钩子按官方返回协议转换。finishTurn 的完整语义须在本阶段得到明确实现证据；如公共接口不足，保留局部兼容或推动上游扩展，不能假称完全等价。

将用户已发送队列接到 submission/inbox，UI 只保留草稿、排序和撤回投影；核对 afterRun 需要重新冻结上下文和登记操作的行为。采用官方 retry 和 CompactionTask，删除对应旧重试、压缩停机/继续和队列派发循环。

验收：扩展逐项契约通过；工具后与最终回复后的继续行为正确；排队期间 Stop 不误发送；压缩与 steer 交错、溢出和自定义摘要通过；同一逻辑请求不双重重试。该阶段通过前，不把原生路径替换所有主聊天。

### 4. 统一团队、子代理和后台生命周期

迁移剩余执行入口。临时前台子代理使用 task ownership；持久后台工作显式使用 background 所有权；独立团队聊天保留产品生命周期。以稳定 requestId 和已有任务/子会话记录消除恢复后的重复提交。

界面任务树、使用量和恢复提示读取官方状态；移除剩余的重复任务注册、取消传播和完成判断。官方拥有的子会话需要同一 Harness 所支持的所有权关系，不能把分散文件的逻辑父子链接当作已经满足它。

验收：父任务停止对子任务的作用正确，后台任务按约定保留，插件卸载无悬挂调用，重载不双报结果，成员会话仍能独立打开继续。

### 5. 收口和删除旧引擎

默认全面使用原生路径；保留最少旧格式读取/迁移代码，删除 DurableAgent、SessionExecution 自定义运行和手工恢复、重复队列/重试/压缩及诊断账本驱动执行的分支。只在迁移和旧恢复契约已覆盖时删掉旧恢复执行器。

最终搜索所有 new Agent、prompt/continue 及执行入口，逐一说明剩余用途；不要求删除仍被类型或官方扩展合法使用的依赖。

验收：verify、改动测试独立运行、PR 当前 SHA 的 CI 全绿且无冲突；同一最终产物完成真实 Obsidian 桌面与手机受限 smoke，保存产物哈希、截图、负对照和清理记录。测移动端写入/内存/长流式表现。受限模拟仍不等于 iOS/Android 真机。

## 推进与回退规则

- 阶段表示验收里程碑，可拆为小 PR；不能只以合并数量计算进度。
- 每个实现 PR 写清：由官方接管的职责、删除的旧路径、行为证据、数据兼容和回退边界。
- 阶段 1 的存储/同步实验与阶段 3 的扩展契约验证，是全面切换的前置门槛。
- 回退代码不意味着可降级读取新存储。新格式需显式版本识别；回退使用迁移前原件，不允许旧引擎接管未知 pending。
- 本轮没有运行全量测试、smoke 或模型请求，没有修改运行代码，也没有复用交接记录的测试数字作为当前验证。

## 可复核依据

- 当前实现：[PR #548](https://github.com/YoungSx/piem/pull/548)，已合并。
- [固定版本 README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md)：Quick Start、Hooks、Storage、Abort and Subagents、Agent Events。
- [固定版本生成任务](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/src/harness/generation.ts)。
- [固定版本工具任务](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/src/harness/tool.ts)。
- 本机审计发布包：`/tmp/piem-native-audit-20261005/package`；主分支源码读取固定于本报告基线。
