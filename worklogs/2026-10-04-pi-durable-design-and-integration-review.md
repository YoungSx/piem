# Pi Durable 设计意图与 Piem 接入审核

核查日期：2026-10-04。问题：最新 Pi durable 为什么存在，Piem 当前的用法是否正确？

**结论：Piem 确实使用了 durable 的 Session、事务、原生分支、AgentDoc 和存储协议；这部分有合理的平台适配依据。模型执行仍由 pi-agent-core 的 Agent 驱动，没有接入 durable Harness 的提交、任务调度及检查点恢复。因此，这是 durable 存储加普通 Agent 执行，不能称为已完成完整的 durable agent 迁移。**

## 版本与来源

- npm `@earendil-works/pi-durable` 的 `latest` 为 **1.0.2**，发布时间 `2026-10-04T00:52:08.576Z`。[npm latest](https://registry.npmjs.org/@earendil-works%2Fpi-durable/latest)
- 官方 `v1.0.2` 对应 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`；核查时 main 为 `200387122ca450d6387f033949423114a270b96c`，在该发布后新增 Unreleased 节。
- 本项目 `package.json`、已安装 durable 包均为 **1.0.1**。本次未升级依赖。
- 1.0.2 的 durable 变更是持久化每段 conversation 独立的 provider session UUID，并传给模型层以保持 prompt cache/session affinity。[Changelog](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/CHANGELOG.md)
- API 仍明确为 **Experimental**，发布号为 1.x 不代表 API 稳定。[README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L1-L7)

## 官方要解决的问题

[README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L1-L7) 将它定义为 durable agent harness：对话、模型回合、工具调用及应用状态先提交到存储，再对外展示；进程中断后可以从存储恢复工作。

[规范](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#L41-L78) 的核心要求：

1. 一次提交可以原子保存 transcript entries、task records 和 Chord documents。
2. 观察者只能看见已经提交的状态，包括可见执行进度。
3. 外部副作用在事务外执行；先提交执行意图，再执行工具，最后提交结果或下一阶段。
4. 存储提交结果不确定时，当前 Session 不能继续假装正常，必须关闭并重开恢复。

完整 Harness 把模型请求和工具调用本身建成持久任务：`pi.generation` 管模型回合，`pi.tool` 管工具调用。任务有阶段检查点、父子所有权、等待关系、取消规则；用户输入通过 `Conversation.submit()` 持久受理，`requestId` 可避免同一输入重复提交。[概念](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L78-L123)

这超出了保存聊天记录：运行到哪一步、等待谁、输入有没有被受理，也成为可恢复的数据。

## 官方恢复能力的实际边界

- `Harness.open()` 后的 `resume()`，或 submit/wait，会启动调度并继续未完成任务。[恢复说明](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L101-L123)
- 恢复的是已提交的任务阶段，并非原进程的 JavaScript 栈，也不是从模型断开的那个 token 原地继续。规范说明：中断的流式 partial 被记录为 aborted assistant entry，再用固定的上下文和模型参数重新请求。[Generation 规范](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#L3418-L3430)
- 工具只在持久意图和当前声明都允许 `replay: "safe"` 时自动重跑；否则记录 `interrupted`，而非擅自重复外部副作用。不能据此承诺外部写入 exactly-once 或自动回滚。[工具说明](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L168)、[副作用与重放规范](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#L2999-L3018)
- 子任务/子会话的生命周期由所有权管理；普通子工作跟随父级中止，background 边界有不同语义。[子 agent](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#L399-L439)
- 一个 storage 同时由一个进程拥有，官方不提供跨进程锁。进程崩溃恢复和断电不丢失也不同；后者取决于存储实现的刷新策略。[存储说明](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md#storage)

## 当前接线：已使用的部分

### Session 和原生分支

`src/session/PiemSession.ts:32` 调用原版 `createSession(storage)`，通过 `native.commit()` 与 `tx.doc()` 操作自己的 `piem.session` document；`forkAt()` 调用 `tx.forkConversation()`。`src/session/piTranscript.ts` 通过 Pi entries 存放模型内容，使用原版扫描遍历祖先分支，并通过 `configure()` 写入模型与思考等级。

这是实际使用原生事务和分支能力，并非仅改 import。官方也公开独立 Session 层，规范明确区分普通 Session 与 Harness 所创建的 conversation；后者额外建立 live/inbox/usage/provider 等执行文档。[官方分层](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#L651-L675)

### Vault 存储桥

`src/session/DurableVaultStorage.ts` 继承原版 MemoryStorage，用 `prepareCommit()` 做原生准备，成功追加完整 JSONL frame 后才 `apply()`。已检查的关键路径包括：

- 成功写入后再采用内存状态。
- 完全没写入时报告 `StorageRejected`；半写或未知结果使实例不可继续使用。
- append 虽报错但完整 frame 已落盘时，读回确认后采用该提交。
- 尾部半行不作为已提交状态重放。
- 文件指纹改变时检查内容，阻止把另一个版本当成自己的旧文件继续追加。

`src/session/SessionRepository.ts` 负责暂存迁移、读回校验、备份、恢复发布中断。适配保留单文件同步和 Vault 地址空间；官方允许自定义 storage，并提供共享一致性测试。这种适配本身不是违背官方设计，但它仍由 Piem 负责正确性，不等同于直接使用官方 JSONL 后端。

该桥的观察和追加不是跨设备原子锁，Vault API 也未提供 fsync；当前不能承诺并发跨设备写入安全或突然断电绝不丢失。

### 文件工具复用

`src/vault/harnessAdapter.ts` 将 durable 的 read/write/edit 适配成普通 AgentTool，提供 VaultExecutionEnv。核对安装包源码，三个工厂使用 `requireEnv(api)`，只需要 `api.env`。官方规范也明确这些工具只使用 `api.env`。[规范](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#L3016-L3022)

因此，固定版本下这是有依据的窄适配；它没有创建 ToolTask，也不附带 durable 的重放、checkpoint 或 owned subagent 能力。不能把仅有 `{ env }` 的适配 API 扩展为任意 durable 工具的通用宿主。

## 当前接线：尚未使用的核心执行能力

| 能力 | 官方完整 Harness | 本项目现状与证据 |
| --- | --- | --- |
| 执行入口 | `Harness.open()`、`Conversation.submit()` | `ObsidianAgentService.ts:6863` 仍 `new Agent()`，运行经 `prompt()` / `continue()`。 |
| 持久输入队列与去重 | submission + inbox + requestId | 当前为自有 PromptQueue 和 run ledger，没有 durable submission admission。 |
| 模型/工具任务检查点 | GenerationTask / ToolTask，由调度器恢复 | 本地没有将模型与工具运行注册为这些任务。 |
| 对外显示进度前提交 | watch/watchEvents 基于 committed state | `handleAgentEvent()` 在 message_end 保存消息，流式 delta 与工具进度保存在运行时并通知 UI；不是 committed-only publication。 |
| 重启恢复 | 从持久任务阶段和调用策略恢复 | 本地关闭孤立 run ledger，判断对话末尾是否可继续，提示用户调用普通 Agent.continue。 |
| 多 agent 生命周期 | task/conversation ownership、等待、级联取消 | 仍由现有 subagent/workflow 服务管理，没有 durable task 所有权链。 |

直接证据：

- `src/agent/ObsidianAgentService.ts:7580` 仅 message_end 进入消息持久化；`7684` 起明确保留每次流式通知，但不为 delta 持久化。
- `src/agent/SessionRuntime.ts:153` 的未保存消息集合，以及 pendingToolNames/progress，属于进程内运行时状态。
- `src/agent/ObsidianAgentService.ts:2577` 的 run ledger 是 best-effort；日志失败可能没有中断运行记录，但仍允许发送。
- `settleInterruptedRuns()` 关闭上次进程未结束的操作；`resumeRuntime()` 最终调用 `agent.continue()`。
- `src/workflow/workflowTool.ts` 的重放日志仍为内存 Map，接入 durable 会话存储没有自动改变它。

这些是执行层尚未迁移的证据，不等于现有“继续”功能无效。它确实能根据已保存的上下文继续对话，但不能恢复工具正在执行的 durable phase，也不承诺保留所有已经显示的流式文字。

## 如何判断“使用正确”

- **若目标是替换旧会话/存储模块：方向合理。** 原生事务、分支和配置继承已经接通；针对性测试通过。
- **若目标是完整采用 durable agent 的执行与恢复模型：尚未完成。** 模型循环、工具运行、队列、取消、流式展示都还在旧 Agent 层。
- **不能仅升级到 1.0.2 就获得缺失能力。** 这个补丁修复的是 Harness provider identity；本项目仍自行向 Agent 传递 sessionId，升级存储包不会把执行自动迁到 Harness。
- **不应让两个执行器同时驱动同一对话。** 若后续要求完整迁移，应以 Harness 接管输入受理和模型/工具任务，再把已有 UI、工具、扩展与 Vault 桥接到它；验证崩溃和不安全工具的恢复行为后，删除对应的重复状态管理。

与前两问的关系：Codemode 负责用代码组合调用，Workflow 负责描述和组织多步骤工作，Durable 提供执行状态的提交与恢复基础。Workflow 可以建立在 durable tasks 之上，Codemode 也能作为一个工具运行于 durable Harness；仅依赖同一个 npm 包，不会让整段脚本或现有 Workflow 自动拥有跨重启检查点。

## 本次验证与限制

实际执行：

```sh
bun test src/session/DurableVaultStorage.test.ts src/session/PiemSession.test.ts src/session/SessionRepository.test.ts
bun test src/agent/ObsidianAgentService.test.ts --test-name-pattern 'interrupted run recovery|streaming refresh cost'
```

- 存储一致性（含官方共享 conformance cases）、重新打开、故障追加、迁移、原生分支与配置：**42 pass，0 fail，229 assertions**。
- 现有中断恢复与流式刷新成本：**7 pass，0 fail，17 assertions**。
- 共 **49 项**针对性测试通过。未运行全量 verify；本次没有产品代码修改。
- 测试使用内存 Vault adapter 与模拟模型，不代表已验证真实 Obsidian 进程强杀、断电或多设备并发同步。
- 本报告评估设计和当前接线，未将未接入的 Harness 崩溃恢复写成已验证能力。

## 补充：官方 Coding Agent 是否已经采用 Harness

同日进一步核对 **v1.0.2** 固定提交 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`，结论是两条路径并存，必须区分正式 CLI 与实验版。

### 正式 CLI / createAgentSession SDK

- [`main.ts`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/main.ts#L838) 经 `createAgentSessionFromServices()` 进入普通 SDK。
- [`agent-session-services.ts:214`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/core/agent-session-services.ts#L214-L223) 调用 `createAgentSession()`。
- [`sdk.ts:387`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/core/sdk.ts#L387-L437) 创建 pi-agent-core 的 `Agent`，再交给 `AgentSession`；使用 coding-agent 的 `SessionManager`。
- [`agent-session.ts:1110`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/core/agent-session.ts#L1110-L1135) 先向扩展和公共监听者发送事件，再在 `message_end` 调用 `sessionManager.appendMessage()`。并未采用 durable Harness 的 committed-only 流式展示与任务恢复模型。
- [`package.json`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/package.json#L29-L55) 依赖 agent-core，没有直接依赖 pi-durable；发布文件排除 `dist/experimental`。

### 官方 experimental/durable 编码代理

[官方实验版 README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/experimental/durable/README.md) 明确称为一个基于 pi-durable 的小型本地 coding agent，复用 Pi 的模型、凭据、设置、提示词和 TUI 组件，但执行引擎是 Harness，存储为 SQLite。

- `runtime.ts:138` 调用 `Harness.open()`。
- `runtime.ts:167` 使用 `Conversation.viewState()`；界面从已提交视图更新。
- `runtime.ts:252` 经 `Conversation.submit()` 受理输入。
- `runtime.ts:332` 调用 `harness.resume()` 继续中断工作。
- README 第 20–25 行明确：流式 partial、工具输出、队列、回合均提交；恢复不由 TUI 实现，TUI 仅渲染会话视图。
- README 第 66 行明确缺少：会话列表/恢复选择器、fork/tree navigation、扩展、prompt templates、图片和 `/login`。这是实验版产品集成的缺项，不表示 durable 底层完全没有 fork 或自己的 extension API。

该实验版由 [2026-10-01 官方提交](https://github.com/earendil-works/pi/commit/5609b0d6c07cd3bf8014429123086f6da0a5e14e) 引入，提交作者 Mario Zechner，标题为 `experimental TUI coding agent on pi-durable`。这证明官方自己在探索 durable 编码代理，不能说 durable 只供外部开发者使用；但当前证据也不足以承诺正式 CLI 必然迁移或某个迁移时间表。

检索到的 [#10386](https://github.com/earendil-works/pi/issues/10386) 询问 durable 与 coding-agent 扩展兼容，但只有用户正文及自动关闭评论，没有维护者路线承诺。不能把自动关闭解释为官方否决，更不能把用户的性能数据当作官方保证。

**对本文结论的限定：Piem 保留普通 Agent 不构成偏离正式 Pi Coding Agent 架构，也不因未使用 Harness 而自动成为错误。是否迁移取决于产品是否需要跨重启的任务执行保障；“完整 durable 执行迁移未完成”只在这个目标下成立，不能当成官方要求所有宿主迁移的证据。**

本节为固定版本文档与源码核查，没有启动实验 CLI、调用模型或修改产品代码。
