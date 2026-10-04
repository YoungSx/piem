# Pi 1.0.1 升级与 durable 迁移调研

调研日期：2026-10-03。本文是官方发布与接口调研，不代表文中方案已经实现或通过测试。用户已选择完整迁移到新版实验性 `pi-durable`；继续遵循“使用原版，只在 Obsidian/手机平台边界写兼容桥”的规则。

## 已核实的版本

当前项目基线为 `0.99.1`。npm registry 实时返回 `pi-ai`、`pi-agent-core`、`pi-codemode`、`pi-coding-agent`、`chord` 的 `latest` 均为 **1.0.1**；新增的 `pi-durable` 也为 **1.0.1**。`pi-coding-agent` 从基线之后发布的稳定版本只有 `0.99.2`、`1.0.0`、`1.0.1`。最新版包发布于 2026-10-03 12:29–12:35 UTC，GitHub release 发布于 16:14 UTC。[npm 元数据][npm-coding]、[最新版 GitHub release][release-101]、[durable npm 元数据][npm-durable]

**1.0.1 是 Pi 的稳定发行版本，但 `pi-durable` API 仍明确标为 Experimental，可在不同版本间改变。** 不应把这两件事混为一谈。[durable README][durable-readme]

## 三个版本分别带来什么

| 版本 | 与 Piem 相关的变化 | 原版继承范围与平台边界 |
| --- | --- | --- |
| 0.99.2 | 新 `pi-ai/models` 轻入口；Anthropic 不支持的 strict schema 自动降级；无效 `Retry-After` 回到退避；Z.AI CN overflow 识别修正。 | 模型层升级即可继承；不是本地重新实现 provider 协议的理由。[AI changelog][ai-log] |
| 0.99.2 | Codemode `image()` 校验真实 PNG/JPEG/GIF/WebP 签名及 base64，拒绝污染后续请求的错误图像。 | Piem 已使用原版 prelude，应自动继承并覆盖真实 VM 回归。[codemode changelog][codemode-log] |
| 0.99.2 | MCP 默认 codemode exposure 改为按需发现；新增 `describeNamespace()`、namespace instructions；首轮无需等待非 direct MCP；名称的 `-` 归一为 `_`，冲突工具加 hash，冲突 server 名被拒绝。 | CLI 的连接调度不会因依赖升级自动进入 Piem 自有 MCP manager；复用原版命名/发现能力前须对接 Piem host。[0.99.2 release][release-0992] |
| 0.99.2 | MCP 增加 `description`、`oauth.clientName`、provider token 身份验证；修复扩展命令非法注册、模型目录查找性能。 | loader 校验可继承；MCP OAuth 和目录调度要核对 Piem 是否实际走该模块。[0.99.2 release][release-0992] |
| 1.0.0 | `pi-agent-core` 删除旧 experimental harness、session/storage、ExecutionEnv、skills、compaction 等导出，移除 `./node`、`./harness/*` 等路径。 | **必须迁移，不能只改 package 版本。** 新 `pi-durable` 是新事务/会话模型，不是旧符号换一个包名。[agent changelog][agent-log] |
| 1.0.0 | Codemode prompt 缩短；访问不存在的工具或全局成员直接报错并给相近名称；工具探测改用 `"name" in tools`；增加 `models.generateImages()`。 | missing-member 行为来自原版 prelude；生图 global 来自 coding-agent host，Piem 要显式接入原版 Models API 才能提供。[codemode changelog][codemode-log]、[1.0.0 release][release-100] |
| 1.0.0 | 修复 OpenAI Responses 跨 provider 重放 grammar tool call 时 `ctc` ID 错误；Anthropic 增加 copy-code OAuth。 | 请求重放修正可继承；浏览器/回调登录需要 Obsidian 平台桥。[AI changelog][ai-log] |
| 1.0.0 | MCP OAuth 增加 issuer 校验、metadata URL、每 server 名和 URL 独立凭据、追加 scope 保留已授权范围。 | 属于 MCP 客户端实现变化；不能把 Piem 自有 MCP 配置当成已经同步具备。[1.0.0 release][release-100] |
| 1.0.1 | Codemode 限制单脚本输出为 16 Mi 字符或 100000 项，超限抛 `RangeError`。 | 在原版 prelude 内执行，手机桥应原样继承，防止打印循环拖垮宿主。[codemode changelog][codemode-log]、[prelude][codemode-prelude] |
| 1.0.1 | 扩展新增 `pi.registerToolRenderer()`，可渲染尚未注册的工具；runner 新增 renderer 解析链。 | 原版 loader/runner 可继承；Obsidian 渲染桥须调用 `resolveToolRenderers()` 才真正生效。[extension runner][extension-runner]、[extension types][extension-types] |
| 1.0.1 | Anthropic 使用 `inline-tools-2026-09-15`，同名工具重定义仍保留 prompt cache；SDK 升至 0.129.0；`hasToolRedefinitions()` 弃用。 | 必须重审 Piem SDK shim 实际调用面，协议逻辑继续原版；废弃不是删除。[AI changelog][ai-log] |
| 1.0.1 | 增加 Cloudflare Clef/Clef Flash classifier；修复 capacity 重试、Cloudflare Claude ID、Bedrock thinking 签名和长上下文计价、Together DeepSeek 模型名。 | 已纳入的 provider 可直接继承；新增 catalog 不等于产品已接通全部 provider。[AI changelog][ai-log] |
| 1.0.1 | MCP 增加项目 override、CIMD；移除 npm-shrinkwrap；固定 `brace-expansion` 5.0.12。 | lockfile 应重新核验；CLI 的项目设置与登录不自动替换 Piem 设置。[1.0.1 release][release-101] |

CLI 专属的 fullscreen 默认值、终端图片、主题、快捷键、Nix 安装、`pi update` 提示等，不应移植到 Obsidian 产品界面。上游宣称 codemode 示例请求约 5300→3300 tokens、长终端消息内存约为原来的五分之一；这些是上游场景数据，**不是 Piem 的测量结果**。[1.0.0 release][release-100]、[1.0.1 release][release-101]

## 原版 API 应该如何分层接入

| 旧用法/职责 | 新版原版入口 | Piem 需要保留的桥 |
| --- | --- | --- |
| `Agent`、agent loop | `@earendil-works/pi-agent-core` 仍提供 Agent/loop/proxy/types；完整 durable 执行则使用 `Harness`。 | 切换执行入口时避免两个循环同时驱动同一会话。[agent index][agent-index]、[durable index][durable-index] |
| `JsonlSessionRepo`、`StorageBackedSession` | `JsonlStorage.open(directory, fs, context)` + `createSession(storage)`，或 `Harness.open(storage, options, context)`。 | 注入 Vault FileSystem；新格式目录不是旧单文件格式。[JSONL storage][durable-jsonl]、[Session][durable-session] |
| `MemorySessionRepo` | `new MemoryStorage()`，交给上述 Session/Harness。 | 测试使用原版内存存储，不重造 repository。[durable index][durable-index] |
| `BACKGROUND_CONTEXT`、取消 context | `@earendil-works/chord/context`。 | 将宿主 AbortSignal 接入 Chord Context。[durable README][durable-readme] |
| `ExecutionEnv`、`FileError`、`ok/err/getOrThrow` | `@earendil-works/pi-durable/env`。 | Vault 地址空间与 Obsidian 错误映射。[env][durable-env] |
| 桌面 `NodeExecutionEnv` | `@earendil-works/pi-durable/env/node`。 | 仅桌面延迟加载；手机路径不得载入其 `node:fs`、`node:child_process`、`node:crypto`。[node env][durable-node] |
| `appendMessage`、`mutate/commit` | `Session.commit(tx => tx.appendEntry(...), ctx)`；正常输入用 `Conversation.submit()`。 | 旧消息结构转换；输入不能用裸 append 代替 durable admission。[types][durable-types] |
| `branchTip/laneConfig/laneState` | `Conversation`、`ConversationRecord.parent`、`AgentDoc`、`LiveDoc`、`InboxDoc`。 | Piem lane 名到 conversation ID 的产品映射；避免重造原版任务状态机。[types][durable-types]、[harness types][durable-harness-types] |
| 普通名称、标签、旧 ID、产品元数据 | `defineDoc()` / `defineDocFamily()` + `tx.doc()`。 | 自己的 `piem.*` document，不修改原版 `pi.*` 内部 schema。[documents][durable-documents] |
| 原版 read/write/edit/bash | `@earendil-works/pi-durable/tools`，`CodingTools` 或四个工厂。 | Vault FileSystem、允许的平台 shell；该新版 read 尚不读图片，保留现有 Piem 图像能力。[durable README][durable-readme]、[tools index][durable-tools] |
| 工具执行和事件 | `defineTool`、`GenerationTask`/`ToolTask` hooks、`watchEvents()`。 | Piem 工具参数、UI、ExtensionRunner 事件转换，见下节。[harness types][durable-harness-types]、[events][durable-events] |
| 自动/手动 compaction | `Conversation.compact()`、`CompactionTask`、Harness `settings.compaction`。 | UI 与策略输入；原版负责后台摘要、放置边界、stale 判定、overflow 重试。[compaction][durable-compaction] |
| skills | 新 durable 没有 skills loader。coding-agent 仍有 `loadSkills()`、`loadSkillsFromDir()`、`formatSkillsForPrompt()`。 | 原版 loader 依赖同步 fs/path；可异步读取 Vault 后提供范围受限、只读的同步快照桥。不要把异步 ExecutionEnv 冒充 fsSync。[skills][coding-skills]、[durable exports][durable-index] |
| `convertToLlm`、summary message helpers | coding-agent `dist/core/messages.js`。该模块运行时没有外部依赖。 | 小范围 deep import 纳入 source/hash 审核。summary factory 的 timestamp 参数是 ISO 字符串，需适配旧数字。[messages][coding-messages] |
| 截断与估算 | coding-agent `dist/core/tools/truncate.js`；`pi-ai/utils/estimate`。 | truncate 使用 Buffer，复用既有 UTF-8 桥；不要为单个估算函数引入整个 coding-agent compaction/session-manager Node 图。[truncate][coding-truncate]、[estimate][ai-estimate]、[coding compaction][coding-compaction] |

以上路径按 1.0.1 的 npm `exports` 和 tag 源码核对。`pi-coding-agent` 并未公开所有内部 subpath，现有项目使用 npm 安装目录里的受审计模块；继续使用时要随 pin 一起核验，而不是把 deep import 误称为稳定公开 API。[npm metadata][npm-coding]

## Durable 执行与事件契约

- `Harness.open(storage, { models, registry, env, settings }, context)` 后，以 `root()` / `createConversation()` 获取 conversation。`submit({ type: "input", content, requestId })` 返回可查询、等待的 durable submission；`whenBusy` 支持 steer/followUp/reject。相同 conversation 的 `requestId` 用于去重。[harness types][durable-harness-types]
- 工具签名是 `execute(args, api, context)`；用 `api.callId` 对接 tool call ID，`context.abortSignal` 对接取消，`api.output()` / `api.details()` 对接流式输出。`replay` 默认 unsafe；崩溃后的工具不应被桥一律标记 safe，否则写文件等操作可能重放。[harness types][durable-harness-types]
- 原版 `watchEvents()` 是先 snapshot、后按 commit 分批派发。消息更新为 `changes[]`；工具输出支持 trim+append 或 set；`run_start/run_end` 与旧 agent 事件命名不同。消费落后超过 100 批次会再次给 snapshot，UI 必须能重新投影。[events][durable-events]、[README][durable-readme]
- `GenerationTask` hooks 包括 beforeRequest/afterResponse/onYield/afterTools；ToolTask 有 beforeTool/afterTool。桥应把已支持的 Pi ExtensionRunner 生命周期接到这些原版入口，不能只保证扩展加载但悄悄跳过事件。[harness types][durable-harness-types]
- 手动 compaction 返回 task ID；task 完成时可能只产生 summary submission ID，仍需等待其放置结果。忙碌会话在回合边界放置摘要；旧摘要可能因覆盖范围落后被判 stale。不能把“摘要请求完成”当作“上下文已经切换”。[README compaction][durable-readme]
- `Session.commit` 的 table reads 必须在 table writes 前完成；写后读会抛 `ReadAfterWrite`。导入/配置时先收集引用，写入后使用返回的 ID；document 的 `tx.doc()` 有独立规则。[types][durable-types]、[spec][durable-spec]
- 卸载需停止 watches、await close/abort 及释放 Worker。新 API 的“取消等待”不等于“取消后台任务”，主动停止会话要调用原版 abort。[README][durable-readme]

## 旧会话迁移：建议的可验证路线

**不要将旧 v4 JSONL 直接交给新 JsonlStorage，也不要只替换 header。** 旧版是字符串 ID、parentId、lane/value mutation 的单文件；新版是会话级数字 ID、不可变 entry、document/task 表和带提交标记的多文件日志。官方提供 document/task schema migration hooks，但已审阅的新版公开 API 没有旧 `JsonlSessionRepo` 文件导入器。[旧 codec][legacy-codec]、[旧 storage types][legacy-storage-types]、[新版 types][durable-types]、[新版 JSONL][durable-jsonl]

推荐把迁移放在 Piem 存储边界，原版 Session/Harness 负责写出新格式：

1. **完整读取并校验旧图。** 使用现有 legacy normalization/codec 入口，读取所有 entry、parentId、lane tip、配置、名称、标签、custom data、compaction retainedTail 和 operation 记录。不能只读取当前可见主分支；中间损坏、缺失 parent 和同 ID 不同内容必须明确处理，不静默吞掉。旧原文件保持只读备份。[旧 codec][legacy-codec]、[旧 storage types][legacy-storage-types]
2. **先创建独立新目录。** `JsonlStorage.open(newDirectory, vaultFs, ctx)` 加原版 Session/Harness。存储范围可保持“一份旧会话对应一个新存储目录”，避免一次启动汇总整个 Vault。不要手写 `main.jsonl` 的提交行与 sidecar。[新版 JSONL][durable-jsonl]
3. **保存身份映射。** 原版 numeric ID 由 transaction 创建；在 `piem.*` metadata document 中记录旧 session UUID、旧 entry UUID→新 EntryId、lane→ConversationId、旧路径与时间。旧 UUID 不强转数字；新 `EntryRecord` 本身没有独立 timestamp 字段，需要保留消息 timestamp 与宿主元数据。[types][durable-types]、[documents][durable-documents]
4. **迁移完整分支。** 同一线性路径 append；遇到旧图分叉，在对应原版 entry 上 `forkConversation(parentConversationId, at, { ownership: { kind: "ownerless" } })`，再 append 子路径。将旧 lane 当前 tip 映射到 conversation/entry。不能用一个平面数组覆盖所有分支，也不能把旧 parentSessionId 伪造成实际运行的 task owner。[types][durable-types]
5. **逐类转换 entry。** 普通消息使用 `pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` 的 `model: [message]`；tool result 的 typed data 包含 diagnostics。旧 custom/UI-only 数据保留为 `piem.*` entry/document，只有原来进入模型上下文的内容才设置 model。旧 model/thinking/tool 配置应迁到 AgentDoc，并保留可审阅的历史关联。[entries][durable-entries]、[harness types][durable-harness-types]
6. **显式迁移 compaction。** 新 `CompactionEntry` 的 `model` 是包裹后的 summary user message，`head` 指向首条保留 entry；旧 retainedTail 是嵌入消息列表，不必然逐一对应原图节点。需要按旧上下文投影重建 summary 与 retained messages，同时保留原始 compaction 元数据；断言迁移前后模型可见消息一致，特别防止保留尾巴重复或丢失。旧 branch summary 也应保留。[entries][durable-entries]、[context derivation][durable-context]、[messages][coding-messages]
7. **不恢复旧未完成工具为可执行任务。** 旧 operation ledger 作为历史元数据导入；只有新版 Harness 创建的合法 task/checkpoint 才能交给 resume。缺少执行契约的旧记录不能自动补成“可重放成功任务”。[task types][durable-types]、[README recovery][durable-readme]
8. **成功后才切换入口。** 导入完成记录与 metadata 在原版事务内写出；关闭、重新打开新存储，核对每个分支投影、标签、自定义数据、配置、统计，再登记迁移完成。中途失败保留旧文件和新暂存目录，重试不得重复导入。此步骤是 Piem 迁移设计建议，不是上游已有功能。

### 不能漏掉的同步边界

官方明确：**一个 storage 同时只能由一个进程拥有，没有跨进程锁。** `MemoryStorage` 的全局 ID 从 2 递增，JSONL 复用这个分配器；两个设备从相同快照继续写会分配相同数字 ID。JSONL 同时还有 `main.jsonl` 和多个 sidecar，Vault 同步可能分批传到。因此，Piem 现有“单文件 UUID union merge”不能直接用于新格式。[README storage][durable-readme]、[MemoryStorage][durable-memory]、[JSONL][durable-jsonl]

需要在 Piem 同步桥中明确落地“独占活动副本 + 完整快照传递/重建”或等效一致性协议，并验证外来文件变化、sidecar 延迟与冲突恢复。不能靠进程内 promise 锁宣称解决多设备问题，也不能把出现 corruption 时清空目录当成恢复。原版 JSONL 对缺失已提交 sidecar 会报错，对未确认尾部可能截断修复；桥必须保留这个原版语义。[JSONL recovery][durable-jsonl]

### 后续候选：原版 MemoryStorage + Vault 单文件持久化桥

主代理提出更贴近现有 Vault 同步的候选：`VaultStorage extends MemoryStorage`，仅覆盖持久化 commit，把原版预处理得到的写集存为 Piem 单行提交帧，成功后交由原版 apply；上层使用原版 `createSession()`。**源码审查确认这符合公开 prepare/apply 契约，但此处仍是候选方案，不代表实现或验证完成。** 此方案替换上文多文件 JsonlStorage 的落盘方式，不能把 Piem v5 文件称为上游 JsonlStorage 的原生文件格式。[MemoryStorage][durable-memory]、[JSONL commit][durable-jsonl]

上游 `PreparedMemoryCommit` 的公开契约是：完整验证、脱离输入引用的冻结写集，`apply()` 不再做可能失败的准备。官方 JsonlStorage 自己也执行 `memory.prepareCommit(writes)` → 持久化 `prepared.writes` → `prepared.apply()`；因此无需复制原版 storage 逻辑或修改 prototype。[MemoryStorage][durable-memory]

| 审查点 | 上游实际行为 | 单文件桥必须遵守 |
| --- | --- | --- |
| prepare 对状态的影响 | clone 输入、冻结结果、检查 ID 归属和 document 约束；未推进可见状态或 nextSeq。 | 预验证成功前不写盘，不把 prepared 暴露给产品层绕过持久化。[MemoryStorage][durable-memory] |
| 持久化哪个写集 | prepare 把 `document.copy` 解析成含完整 base 的 `document.create`。 | 写 `prepared.writes`，不能写原始 writes；这样 fork 不依赖未来可能已回收的父 document。[MemoryStorage][durable-memory]、[spec][durable-spec] |
| sequence 分配 | prepare 默认取当前 nextSeq，但不预留；apply 才设 nextSeq=seq+1。seq 必须严格递增，可以有空号。 | 一次 prepare 后必须完成落盘/apply 才开始下一次；不要并发准备两个批次。重放传入已验证的原 seq。[MemoryStorage][durable-memory]、[spec][durable-spec] |
| numeric ID 分配 | `mintId()` 提前递增；commit callback 失败也没有 ID 回滚。apply 依实际记录抬高 nextId。 | 允许空号，不回拨分配器。重启从已提交记录恢复会丢掉未提交 ID 预留，这些 ID 不应曾被对外认定为成功记录。[MemoryStorage][durable-memory]、[Transaction][durable-transaction] |
| apply 幂等边界 | 同一个 prepared 对象第二次 apply 直接返回原 seq，不再应用；不会检查另一个 prepared 是否已抢先生效，也不会再检查 closed。 | 只允许一个 Session 拥有存储；同步重建/close 必须等待该 Session 排空。不把幂等 apply 当作跨进程或跨批次锁。[MemoryStorage][durable-memory]、[官方测试][durable-memory-test] |
| 提交后通知 | Session 等待 Storage.commit，随后 `tx.adopt(seq)`，最后 publish。存储内部 apply 本身不产生 Session publication。 | append 成功→apply→返回 seq；桥不要另发模拟成功事件。重放应在创建 Session/绑定观察者之前完成。[Session][durable-session] |
| 取消 | Session 对已经受理的 Storage.commit 使用 `withoutAbortSignal(context)`。 | 不让调用方取消把已开始的 append 打断后继续使用旧内存状态；让受理中的提交完成，再关闭。[Session][durable-session] |
| 预验证失败 | 只有 `StorageRejected` 表示确定没有任何 durable effect；Session 可继续。 | prepare/编码阶段明确未写任何字节的失败可以转为 StorageRejected；不要把所有异常都这样包装。[spec][durable-spec] |
| append 失败 | 普通异常代表提交状态不确定；Session 丢弃 staged document 并进入 poisoned 状态，必须 reopen。 | 包括“写了一半后报错”和“整行写完后报错”。不能继续 apply 或简单重试同一日志批次。[Session][durable-session]、[JSONL 故障测试][durable-jsonl-test] |
| 解码安全 | Storage 信任拥有它的 Session 提供语义合法记录，MemoryStorage 的 clone 不是磁盘格式验证器。 | 读取 Piem v5 时验证帧版本、write discriminant、ID/seq 的安全整数范围、完整 JSON shape/引用约束；不能只 `JSON.parse(...) as StorageWrite[]`。[spec][durable-spec] |

候选落盘顺序可表示为 `prepareCommit(writes)` → 将 `{ kind: "durable_commit", seq: prepared.seq, writes: prepared.writes }` 编码成一行 → `await vault.append(...)` → `prepared.apply()`。这是 Piem 自己的格式边界；不需要新造事务核。完整 UTF-8 损坏行必须报错，只有末尾未完成帧可以按已声明恢复规则处理；单行 append 也不提供跨设备锁或断电 fsync 保证。[原版提交/恢复的参照实现][durable-jsonl]

**重放与同步的可行边界：**

1. 每个来源日志分别新建原版 MemoryStorage，按顺序 `prepareCommit(frame.writes, frame.seq).apply()`，再读取领域记录。严格递增 seq、immutable ID 冲突由原版检查；重复日志帧不能重放到已经含该帧的内存存储。
2. 两个设备的 numeric IDs 只在各自来源内有意义。用保留下来的 Piem UUID 比较/合并领域数据，再通过新的原版 Session 重新分配 numeric IDs、重建所有引用和 document；不能把两个来源的原始 writes 直接 union 后重放。
3. 当前 Session 的 Chord tracker、订阅和 fork/document 引用属于旧存储实例。同步重建先排空/关闭旧 Session，再替换文件和重开；不能只换 MemoryStorage 的 Map 后继续使用旧 Session。
4. UUID 合并必须保留参与产品语义的完整图、标签、配置、自定义数据、压缩上下文等。若以后真正持久化了 Harness task/submission，重建还必须处理这些记录的身份和生命周期；只合并聊天 entry 不能宣称保留了 durable 任务恢复。

这些约束由原版 ID、immutable record、Session 持有 document tracker 的实现推导；具体 UUID 合并/单文件重建协议是 Piem 负责的兼容桥，仍需实际故障测试。[MemoryStorage][durable-memory]、[Session][durable-session]、[spec][durable-spec]

验证这条路线时应直接接入公开的 `registerStorageConformance()`（`@earendil-works/pi-durable/testing`），再补 Vault 特有的 reopen、prepare 后原输入变动、fork copy、失败 ID 空号、append 前失败、半行失败、完整行后报错、重复/倒退 seq、两设备 numeric ID 冲突、关闭与重建竞态。上游已有 prepared 写集不可变与 apply 幂等测试，JSONL 也有上述类别的持久化故障测试，可作为预期依据；本调研未运行这些测试。[conformance][durable-conformance]、[memory test][durable-memory-test]、[JSONL test][durable-jsonl-test]

## 这次手机桥需要重点重审的地方

1. **Durable 文件系统。** 需要支持 `id`、`truncateFile()`、`renameFile()`、line reader 等新 FileSystem 契约。JSONL 恢复会截断 torn/unconfirmed tail；sidecar 回收会 write+rename。`fsync` 默认 false，Obsidian 不提供 fsync 时不要假装提供断电持久化承诺。[env][durable-env]、[JSONL][durable-jsonl]
2. **Codemode Worker。** 上游 host 和 worker 仍直接依赖 `node:worker_threads`；保留 Piem Web Worker transport，原样嵌入上游 prelude/QuickJS。新增输出上限和图像检查发生在 prelude，不能在更新字符串时绕过。缺失属性探测测试要从 typeof 改为 in。[host][codemode-host]、[worker][codemode-worker]、[prelude][codemode-prelude]
3. **扩展 loader 依赖图。** 0.99.1→1.0.1 的 runner 主要新增 `resolveToolRenderers()`；loader 新增 registerToolRenderer、命令参数校验、`mcpNamespace` 导入与冲突检测。检查受审计模块清单、Node shim 和 mock exports，而不是只更新 hash。[loader][extension-loader]、[runner][extension-runner]
4. **SDK 薄桥。** 重审 Anthropic 0.129.0 调用面与 inline tool 序列化；不要让替身遗漏新版调用参数，也不要为了模型 catalog 全量导入 Node SDK/OAuth 服务器。[AI changelog][ai-log]、[npm AI metadata][npm-ai]
5. **Skills 同步桥。** 新版原版 skill shape 是 sourceInfo；Vault 需要预加载快照，桌面可保留延迟 Node 路径。快照桥只模拟需要的 fs API，不修改 Pi loader 函数体。[skills][coding-skills]

## 验证范围建议

必须至少覆盖：旧 v3/v4 导入、完整分支和空分支、标签/名称/custom entry、compaction retainedTail、工具结果配对、模型/思考配置、导入中断后重试、新存储 reopen、UTF-8 截断、缺失 sidecar、同步并发冲突、卸载中止与 watcher 清理、扩展 renderer 和 command 校验、Codemode 超限/无效图像/缺失工具提示，以及无 Node 全局的手机 bundle load。随后运行项目 build、lint、全部 Bun tests；受改动测试单文件独立运行。真实 iOS/Android 结果只能以实际设备/引擎运行记录为依据。

## 补充审核：原版 skills、prompt templates 与摘要模块的打包边界

按工作树实际安装的 `@earendil-works/pi-coding-agent` **1.0.1**，从 `skills.js`、`prompt-templates.js`、`compaction/compaction.js`、`compaction/branch-summarization.js` 四个入口递归检查静态 import。内部原始图共 14 个文件；相对检查当时的 `scripts/pi-extension-packages.json`，最少新增以下 8 个受审计文件，其余 6 个已在清单中，但仍须更新版本及 hash。[skills][coding-skills]、[prompt templates][coding-prompts]、[compaction][coding-compaction]、[branch summary][coding-branch-summary]

| 新增文件（相对 pi-coding-agent 包根） | 静态依赖 |
| --- | --- |
| `dist/core/prompt-templates.js` | fs、path、config、frontmatter、paths、source-info |
| `dist/utils/frontmatter.js` | yaml、utils/text |
| `dist/core/messages.js` | 无运行时 import |
| `dist/core/session-manager.js` | pi-ai、crypto、fs、fs/promises、path、readline、string_decoder、config、paths、messages |
| `dist/core/usage-totals.js` | 无运行时 import |
| `dist/core/compaction/compaction.js` | pi-ai、pi-ai/compat、messages、session-manager、usage-totals、compaction/utils |
| `dist/core/compaction/branch-summarization.js` | pi-ai、messages、compaction、compaction/utils |
| `dist/core/compaction/utils.js` | pi-ai 的 contentText |

既有 6 文件是 `dist/core/skills.js`、`dist/config.js`、`dist/utils/paths.js`、`dist/core/source-info.js`、`dist/utils/child-process.js`、`dist/utils/text.js`。直接使用上述入口不需要新增 `dist/core/compaction/index.js`；若调用方改用该 barrel，则它也必须纳入审核。这里的“最少”指这些入口的原始静态图，不代表可以跳过实际进入最终 bundle 的其他 source graph 检查。

**Session projection 可以安全复用，但需要精准剪掉模块里没用到的 IO 边。** `sessionEntryToContextMessages()`、`buildContextEntries()`、`buildSessionProjection()` 及它们调用的私有 helpers 只做数组/Map/消息转换；没有 fs、process、Buffer、终端或网络调用。该模块其余的 `SessionManager` 类与文件读取/旧版迁移函数确实使用 Node，但没有必须执行的顶层 IO。不能因为文件名含 SessionManager 就整体替换，也不能直接向 bundle 放开所有 Node imports。[session-manager][coding-session-manager]

候选 esbuild 规则：**只针对 importer 为该 `session-manager.js` 的边**，把 `crypto`、`fs`、`fs/promises`、`path`、`readline`、`string_decoder`、`../config.js`、`../utils/paths.js` 标为 `external: true, sideEffects: false`，并交给项目既有的 metafile `onEnd` 检查拒绝任何实际残留。保留 `./messages.js`；pi-ai 可以作为受审计原版依赖。这样不用给 fs 桥捏造 `createReadStream`、`StringDecoder` 等永远不应被调用的 API。**规则不可推广到整个项目的 fs/path/config**，因为 skills 与 prompt loader 真实依赖它们。

对此已进行独立内存探针（`write:false`，结束后调用 `esbuild.stop()`）：

- 单独导出两项 projection API，最终 `externalImports=[]`，在不提供 `require`、`process`、`Buffer` 的 VM context 成功执行，得到输入的两条 user 消息。
- 导出 `prepareCompaction`、`compact`、`generateBranchSummary`，在暂将 pi-ai/compat 视为外部依赖的前提下，内部仅保留 messages、session-manager、usage-totals、三个 compaction 文件；无 config、CLI、Node 外部导入。

探针说明纯函数图可以裁剪，**没有证明完整 provider 图或项目发布 bundle 已验证**。原版 projection 输入仍是 coding-agent 的 SessionEntry schema（ISO timestamp、firstKeptEntryId、context_edit 等）；Piem retainedTail 与 custom entry 应在边界转换，不能直接类型断言成上游 entry。[session-manager][coding-session-manager]

### 两个真实的新增打包条件

1. **Skills 与 prompts 的文件发现变成可达代码。** 现有 `discoveryOnly` 把 skills 的 `ignore` 与 frontmatter 作为不可达外部依赖，这次必须取消。为 skills 的 `ignore` 和 frontmatter 的 `yaml` 加精确依赖许可；`yaml` 应走 npm 包自带的 browser export。快照 fs 至少要实现 exists/readFile/readdir(`withFileTypes`)/stat，提供 isFile/isDirectory/isSymbolicLink，paths 的 canonicalizePath 还会使用 realpath。技能忽略文件是 `.gitignore`、`.ignore`、`.fdignore`，快照需包含它们；不应自行改写忽略规则或 YAML 解析器。[skills][coding-skills]、[frontmatter][coding-frontmatter]、[prompts][coding-prompts]
2. **`pi-ai/compat` 不是轻量工具入口。** `completeSummarization()` 虽然优先使用调用方注入的 StreamFn，但 fallback 静态引用 `completeSimple()`。compat 顶层创建 `builtinModels()`、注册全套 lazy API，并引用 provider catalogs；即使 Piem 每次传 StreamFn，普通 tree-shaking 也无法证明该运行时分支永不进入。不能将 compat 标为 external 后当作手机已兼容，也不能认为它会因使用单一 completeSimple 自动消失。[compaction][coding-compaction]、[AI compat][ai-compat]

摘要应继续走已配置 Models/Obsidian transport 的原版 StreamFn。在最终实现中需明确选择并验证：使用完整原版 compat 图且桥接其所有平台边，或为这个 importer 提供窄的宿主模型调用适配，并用测试保证调用方始终接入已配置的原版 stream。若采用不可达 fallback 哨兵，其异常只能用于发现 host 接线错误，不能冒充支持默认 CLI provider 环境。compaction/branch-summarization 的函数体无需修改。

`config.js` 本身有顶层 package.json 读取，skills/prompts 活跃使用 `CONFIG_DIR_NAME`，所以保留现有虚拟 `/pi/package.json`、process/os/url/path 桥；不要将其全局当无副作用模块删除。Windows `cross-spawn` 与 paths 的 shell 操作仍应保持现有不可达检查，不为摘要或技能加载开放终端能力。[config][coding-config]、[paths][coding-paths]

本调研进行了 npm/GitHub 只读请求、源码与声明文件比对，以及上述短暂内存打包/纯函数探针；没有安装依赖、运行项目构建、调用真实模型或留下后台进程。实现和测试结果应另附实际记录。

[npm-coding]: https://registry.npmjs.org/@earendil-works/pi-coding-agent
[npm-ai]: https://registry.npmjs.org/@earendil-works/pi-ai/1.0.1
[npm-durable]: https://registry.npmjs.org/@earendil-works/pi-durable/1.0.1
[release-0992]: https://github.com/earendil-works/pi/releases/tag/v0.99.2
[release-100]: https://github.com/earendil-works/pi/releases/tag/v1.0.0
[release-101]: https://github.com/earendil-works/pi/releases/tag/v1.0.1
[ai-log]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/CHANGELOG.md
[agent-log]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/agent/CHANGELOG.md
[codemode-log]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/codemode/CHANGELOG.md
[agent-index]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/agent/src/index.ts
[durable-readme]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/README.md
[durable-index]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/index.ts
[durable-types]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/types.ts
[durable-entries]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/entries.ts
[durable-documents]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/documents.ts
[durable-session]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/session/session.ts
[durable-transaction]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/session/transaction.ts
[durable-env]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/env/index.ts
[durable-node]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/env/node.ts
[durable-jsonl]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/storage/jsonl/storage.ts
[durable-memory]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/storage/memory.ts
[durable-memory-test]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/test/memory-storage.test.ts
[durable-jsonl-test]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/test/jsonl-storage.test.ts
[durable-conformance]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/testing/storage-conformance.ts
[durable-tools]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/tools/index.ts
[durable-harness-types]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/harness/types.ts
[durable-events]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/harness/events.ts
[durable-compaction]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/harness/compaction.ts
[durable-context]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/src/harness/context.ts
[durable-spec]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/durable/docs/spec.md
[extension-loader]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/extensions/loader.ts
[extension-runner]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/extensions/runner.ts
[extension-types]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/extensions/types.ts
[coding-skills]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/skills.ts
[coding-prompts]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/prompt-templates.ts
[coding-frontmatter]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/utils/frontmatter.ts
[coding-config]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/config.ts
[coding-paths]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/utils/paths.ts
[coding-session-manager]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/session-manager.ts
[coding-branch-summary]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/compaction/branch-summarization.ts
[coding-messages]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/messages.ts
[coding-compaction]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/compaction/compaction.ts
[coding-truncate]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/tools/truncate.ts
[ai-estimate]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/src/utils/estimate.ts
[ai-compat]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/ai/src/compat.ts
[codemode-prelude]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/codemode/src/runtime/prelude-source.ts
[codemode-host]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/codemode/src/runtime/host.ts
[codemode-worker]: https://github.com/earendil-works/pi/blob/v1.0.1/packages/codemode/src/runtime/worker.ts
[legacy-codec]: https://github.com/earendil-works/pi/blob/v0.99.1/packages/agent/src/harness/session/jsonl/codec.ts
[legacy-storage-types]: https://github.com/earendil-works/pi/blob/v0.99.1/packages/agent/src/harness/session/jsonl/types.ts

## 2026-10-04 实施与验证记录

已将 Pi 依赖固定到本调研核实的版本。会话写入改用原版 `createSession()` / `MemoryStorage.prepareCommit()`；Piem 仅持久化已准备写集，并保留 UUID、标签及分支指针。旧格式先重建、读回校验，再替换原文件并保留 `.legacy` 备份。半行故障会在重开或空闲检查时备份、重建；固定发布备份可恢复两次重命名之间的进程中断，同一 Vault adapter 的发布与恢复按文件排队。

运行执行仍使用原版 Pi Agent，未声称提供 Harness 任务自动恢复。同步继续沿用原有主分支线性合并规则；数字 ID 按来源解码后重建，不直接合并写集。该边界不提供跨设备锁或 fsync 断电保证。

技能和模板调用原版同步 loader，由一次调用专属的只读平台快照按需提供目录元数据与文件内容；不扫描原版跳过的依赖树，不预读技能参考资料。摘要算法及 retry 仍是原版 coding-agent，认证与传输从 Obsidian 已配置的 Models 注入。

实际验证：

- 完整 `npm run verify` 通过：4,419 项测试、15,716 个断言，以及 build、bundle、skills、copy、CSS、version、lint。
- 随后增加的跨仓库发布/恢复并发回归通过；最新代码重新 build。
- 最新代码全部 299 个测试文件逐个单独运行通过；包含手机无 Node realm 的发布 bundle 测试、存储故障恢复和原版存储契约。
- 提交前 Standards/Spec 两路复核发现的半行恢复、悬空引用、过度扫描和发布中断问题已修正。

未调用真实收费模型，也未运行 iOS/Android 真机验证。CI 结果以 PR 当前提交的检查为准。
