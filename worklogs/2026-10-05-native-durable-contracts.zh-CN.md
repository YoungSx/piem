# 阶段 0：Durable 原生迁移的行为契约

## 范围与证据

本表逐项读取 `9a3211f12091d6e3a822b530d2d77562b478cb6d` 的生产实现与现有测试，并对照 `pi-durable 1.0.2` 发布包的声明及执行源码。发布包审计目录为 `/tmp/piem-native-audit-20261005/package`，上游提交为 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`。这是静态契约清单，不是本轮运行验证；未运行全量测试、真实模型请求或 smoke。

“已有测试”表示旧实现已有行为断言，不表示这些断言已经覆盖原生路径。阶段 2 起须通过同一行为测试驱动原生执行，不能只保留旧路径的绿灯。

## 必须保留的行为

| 契约 | 当前生产证据与已有测试 | 1.0.2 映射及验收缺口 |
| --- | --- | --- |
| 接纳后消息不会消失；保存失败不能发请求 | `DurableAgent.ts` 的 admission；`DurableAgent.test.ts` 的 failed prompt admission、Stop after admission | `Conversation.submit` 持久接纳、`Submission.status/wait`。接纳和最终回答是两个状态；UI 必须在接纳后即显示，不能等 `wait`。测试应再次覆盖 Stop 抢在请求启动前。 |
| 发送中排队默认等整次运行结束；afterTurn 一次送出全部 | `ObsidianAgentService.ts` 的 finishTurn、steeringMode=all；`ObsidianAgentService.test.ts` queued prompts；`queueStrategy.test.ts` | `whenBusy: followUp/steer`、`followUpMode/steeringMode`。旧 afterRun 是新运行并重新冻结上下文和登记操作，不是旧 Agent.followUp；新的 inbox 放置边界需验证这些业务动作只发生一次。 |
| 点 steer 立即截断当前回复，只发送选中的一条，其余保留原时机 | `steerQueuedPrompt`；服务测试 sends one queued message now、steers one message alone、steered cutoff | 原生 steer 是边界放置，不等于立即中断 HTTP；`Conversation.abort` 又会撤回整个输入队列。不能直接 abort+submit，丢掉其余队列。此项是迁移前必须解决的公开 API/产品语义差异。 |
| 撤回返回文字和图片；Stop 清空队列；出错时保留待发项 | 服务测试 takes one chip back、clears queued chips、leaves the queue alone when the run died on a provider error | `Submission.abort` 返回 aborted/already_placed/settled，撤回竞态不能假装成功。UI 草稿可留本地，已接纳输入由 inbox 权威管理；错误终态的 inbox 行为另测。 |
| Stop 意图先落盘；关闭保留恢复；只读查看不能接管任务 | `SessionExecution.ts`、`DurableAgent.ts`；`DurableAgent.test.ts` Stop survives a restart、unloading、reader；`sessionExecutionSync.test.ts` | `Conversation.abort/abortTask` 与 Harness.close。Conversation.abort 等整个普通所有权范围排空，按钮响应不能等待后才更新。必须测试标记提交后、排空前复制数据重启。 |
| 写入完成但结果未保存，不自动重复写；旧取消凭证不会被同步复活 | `DurableAgent.test.ts` reopens a tool checkpoint；`sessionExecutionSync.test.ts` terminal/Stop/Continue 竞态 | ToolTask 执行前保存 intent；仅历史和当前策略都 safe 才重放，默认 unsafe。执行顺序 parallel/sequential 与重放 safe/unsafe 是不同概念；纯读取也必须审计才设 safe。原生完整任务树不能塞进旧单运行快照。 |
| 扩展 context 过滤先执行，随后注入冻结引用和实时笔记正文；注入不落历史 | `ObsidianAgentService.ts:6938` transformContext；服务测试 injected block、context/selection/skills 相关断言 | `GenerationHooks.beforeRequest` 每次请求尝试及恢复执行，替换 messages 仅供该请求。需要耐受重试重复调用，持久化冻结 refs，正文仍按请求重读。压缩不能把临时注入保存到摘要。 |
| 网络扩展能改实际 HTTP payload，并在内容前看到响应；Stop/换会话不能串回调 | `ObsidianAgentService.ts:6892` onPayload/onResponse；`extensionProviderEvents.test.ts` 四组实际传输断言 | 留在 Models/传输桥；beforeRequest 处理 Message，afterResponse 处理 AssistantMessage，均不是 HTTP hook。回调继续绑定原请求 signal 和宿主身份。 |
| 工具拦截能修改经过验证的参数、拒绝调用、替换结果；历史仍保留模型原始参数 | `ObsidianAgentService.ts:7004`；`extensions/toolInterception.test.ts` | ToolHooks.beforeTool 返回 arguments/block，throw 会阻止调用；原生还在 hook 后再次验证参数。afterTool 返回替换结果。需验证参数不污染历史、details/usage/isError 不丢，以及旧扩展依赖的非法参数修改是否应拒绝；不能绕开原生二次验证。 |
| turn_end 扩展链看到前一处理器的预览条目，统一提交一次；事件不能执行两次 | `extensions/extensionBoundary.test.ts` native boundary handlers chain previews；`communityHost.finishTurn` | `afterTools` 发生于结果都已终态后；`onYield` 在最终 assistant entry 提交前发生。旧扩展此时能取得 messageEntryId，新 onYield 尚无该持久 ID。仅用 watchEvents 转发会改变时机，不能保留可写 boundary 契约。 |
| 扩展可回合后结束，或无新增用户消息继续 | `ObsidianAgentService.ts:7042` extensionStopAfterTurn/extensionContinue；`extensionBoundary.test.ts` continue=true 自定义条目 | afterTools 返回 void；onYield 的 continue 强制追加 UserEntry。ToolControl.terminate 要该轮每个 slot 都请求终止，且属于工具返回控制，不等价于回合后的扩展决定。此项没有已证明的直接映射，禁止伪造用户消息或把正常结束改成取消来凑等价。 |
| 模型/思考等级切换在下一请求边界生效，当前请求仍用旧配置 | prepareNextTurn、服务测试 pending thinking level/运行中模型变化；`streamFn.ts` | 原生 configure 更新会话；GenerationTask prepare 固定 model/thinkingLevel 到 checkpoint，request/recovery 读取该 checkpoint。需要测试工具中切换、切到不支持等级的模型、恢复旧请求。Models.getModel 必须能解析自定义模型；当前 createProvider models=[] 不能沿用。 |
| 重试预算实时读取设置，Stop 能打断等待，不双重重试 | withTurnRetry；`net/streamRetry.test.ts`、`retrySettings.test.ts` | 原生 GenerationTask retry 接管同一职责时删除外层 withTurnRetry；确认 provider 内部重试的剩余预算与状态提示。仅改依赖版本没有删除旧重试。 |
| 手动、阈值、溢出压缩；扩展可取消/自定义摘要；保存失败不替换历史 | `agent/compaction*.test.ts`、`extensionCompaction.test.ts`；服务 mid-run compaction T1–T6 | CompactionTask+beforeCompact 的 decline/summary 可接取消/摘要；原生 manual compact 是后台计算、边界放置，不能把 admit task ID 当完成。旧 firstKeptEntryId、来源、一次通知、并发不同 instructions 拒绝、失败重试观察器需逐项覆盖。 |
| 团队成员是可独立打开继续的真实会话，不抢焦点；宿主保留/释放资源 | `createTeamMemberSession/replaceMemberAgent/memberSessionHandle`；`extensions/communityTeamHost.test.ts` | 保留独立产品生命周期，不机械改成普通 task-owned 临时子会话。成员当前仍用 DurableAgent；在阶段 4 单独验收中断恢复和无焦点抢夺。 |
| 临时子代理隔离历史，父取消/kill/teardown 传递；错误工具结果可反馈后继续 | `subagent/runner.ts:368` new Agent；`subagent/extension.test.ts` run/abort/kill/partial report/compaction | 普通 ownership 传播取消，background 为显式边界；需要同一个 Harness 支持的所有权关系。外部文件 parentSessionId 不构成 SDK task ownership。保留部分报告、子工具顺序执行、嵌套和并发限制、逐回合 progress；不能用主聊天的“错误后结束”策略统一子代理。 |

## 阶段顺序的硬门槛

1. 阶段 1 必须先实现原生条目读取、完整状态保全/冲突分叉、自定义模型解析与 unsafe 工具桥；不得把已接纳原生任务失败回退到旧引擎重发。
2. 阶段 2 只能试点契约已覆盖的完整会话类型。若主聊天扩展 boundary 和立即 steer 尚无实现，不能把全部主聊天切换后再在阶段 3 补。
3. 阶段 3 的直接阻碍是扩展可写回合边界、无用户消息继续、立即 steer。优先核实可公开组合的事务操作；不足则提出上游 API 需求，或明确隔离旧兼容会话。禁止修改 vendor、调用 private 方法、另写 GenerationTask 循环来宣称最薄适配。
4. 阶段 4 前核实任务所有权与多会话存储结构；独立成员和临时子代理各自验收，不能只复用单聊天 smoke。

## 每步共同验收

- Sub-agent 对照以上契约审查实际 diff，发现项闭合后才进入下一阶段。
- 原生执行必须新增或复用行为测试驱动真实 GenerationTask/ToolTask；仅对适配器 mock 的测试不能证明恢复、取消或调度。
- 同一最终构建在真实 Obsidian Runtime 完成桌面及 390×844 手机受限 smoke，记录原始/覆盖后的 Platform 标志，保留官方加载器拒绝 Node/Electron 的负对照、产物 SHA、截图与进程清理。
- 原生 partial 提交增加 Vault 写入的风险须记录提交次数、字节、长流峰值内存。UI 节流不能代替存储负载证据；不能吞 durable commit 或提前声称落盘成功。
- 原有 build/lint/全量测试、改动测试独立运行与 PR 当前 SHA 的 CI 全绿；未经执行不得复用以前的通过数字。

## 官方源码锚点

相对于上述 1.0.2 发布包：`dist/harness/types.d.ts` 的 SubmissionDraft、Conversation、GenerationHooks、ToolHooks、CompactionHooks；`generation.js` 的 prepare/request、answer、finishToolRound；`tool.js` 的 call/execute。`answer` 中 onYield 在 appendAssistant 之前，且 continue 构造 role=user；`finishToolRound` 中 afterTools 返回值未参与控制。这些是本次不等价判断的直接依据。

## 阶段 0：扩展审计门禁复核

升级后的构建被 `scripts/pi-extensions.mjs` 的版本门禁正确阻止。本轮从 npm 获取原版 `pi-coding-agent 1.0.1` tarball，逐字节比较配置列出的 **28 个审计文件**与已安装的原版 1.0.2，并先验证旧文件 SHA-256 全部匹配现有 pin。结果：**28 个文件全部不变**，包括 loader、runner、工具 wrapper、session-manager、压缩、主题及文件发现桥依赖。

因此 `scripts/pi-extension-packages.json` 只把 pi-coding-agent 的审计版本从 1.0.1 更新到 1.0.2；全部文件 hash、允许导入范围、Node 桥、动态加载拒绝及 onEnd 剪枝验证保持原样。没有改写 node_modules，也没有放宽构建检查。

旧包 SHA-256：`99c2e1958ac6d4c6a36e7f1c3690ae38778bb397c63e9d611d2c09521be735c5`。本机复核包：`/tmp/piem-native-extension-audit-20261005/pi-coding-agent-1.0.1.tgz`。此结论仅覆盖扩展审计图，不代表整个 Pi 版本无行为变化；最终构建与手机受限 smoke 仍由阶段 0 验收执行。
