# Skill 标准与渐进式披露审计

核对日期：2026-09-09。代码基线：`ff8bf0a`；锁文件与实际安装的 `@earendil-works/pi-agent-core` 均为 `0.84.3`。本文交付审计和可重跑证据，列出的运行时缺口尚未修复。

## 结论

**确实直接使用 Pi 的技能模块，核心格式和按需向模型披露正文的方式符合 Agent Skills。不能据此宣称任意标准技能都能完整运行。**

模型看到的顺序是：**名称、描述、位置 → 选中技能的正文 → 需要的引用文件**。程序预先读入正文不等于把全部正文送给模型；官方客户端指南明确允许发现技能时缓存正文。[规范][spec] [客户端指南][client]

本地的文件环境、来源合并、安装/导入、设置页和 `read_skill` 是 Piem 的适配层。它们没有因使用 Pi 而自动获得完整的资源访问、长正文续读或压缩保护。

## 一手依据与规范边界

| 问题 | 官方依据 | 判断 |
| --- | --- | --- |
| 标准格式 | Specification：目录内 `SKILL.md`，YAML 的 `name`、`description` 加 Markdown 正文；允许附带其他目录和文件 | 当前七个内置技能采用该格式，Pi 解析无诊断 |
| 渐进式披露 | Specification 的 Progressive disclosure：metadata、instructions、resources 三层 | 判据是何时进入模型上下文；不要求磁盘只读文件头 |
| 发现时缓存正文 | 客户端指南 Step 2 / What to store：可以缓存 body，也可以激活时读取 | 当前 Pi 的预读行为符合指南；每轮重新扫描属于性能取舍 |
| 专用工具激活 | 客户端指南 Step 4：可以按名称调用专用工具；允许只返回 body，也允许带 frontmatter | 自有 `read_skill` 不构成非标准格式；`/name` 显式注入也符合指南 |
| 可选字段与脚本 | Specification：`compatibility`、`license`、`metadata` 可选；`allowed-tools` 为实验字段；脚本语言取决于宿主 | 不处理实验字段、不提供 shell，不足以判定格式不兼容；依赖它们的技能仍可能无法工作 |
| 长对话 | 客户端指南 Step 5 明确要求保护技能内容不被压缩清除；去重则使用 “Consider” 措辞 | 属于客户端生命周期完整性，不能混同为 `SKILL.md` 格式校验；当前没有落实专门保护 |

规范没有指定必须使用哪一个 npm 包，也没有要求复制 Pi CLI 的全部宿主。目录扫描位置和来源优先级由客户端决定；笔记库使用可见的 `Piem/skills` 不违反格式规范。[客户端指南 Step 1][client]

## 当前调用链

| 环节 | 实际实现 | 证据 |
| --- | --- | --- |
| 内置与笔记库加载 | 直接调用 Pi `loadSkills`，目录为 `/Piem/builtin-skills`、`/Piem/skills` | [skillLoader.ts](../src/agent/skillLoader.ts) 的 `loadBuiltinSkills` / `loadVaultSkills` |
| 用户级加载 | Pi `loadSourcedSkills` 加桌面端 `NodeExecutionEnv`；读取默认用户目录和可选目录 | [userSkills.ts](../src/skills/userSkills.ts)、[nodeSkillsEnv.ts](../src/skills/nodeSkillsEnv.ts) |
| 内容解析 | Pi 读取完整文件，拆分 frontmatter/body，缓存 `Skill.content`；此时不读引用正文 | [Pi skills.ts][pi-skills] 的 `loadSkillFromFile` / `loadSkillsFromDirInternal` |
| 同名覆盖 | Piem 合并内置、用户级、笔记库，后者优先；关闭项在合并后过滤 | [skillLoader.ts](../src/agent/skillLoader.ts) 的 `mergeSkillsWithSource`；[ObsidianAgentService.ts](../src/agent/ObsidianAgentService.ts) 的 `loadSkillFiles` |
| 模型目录 | Pi `formatSkillsForSystemPrompt` 只列 name、description、location，并过滤 `disable-model-invocation` | [Pi system-prompt.ts][pi-prompt]；[skillLoader.ts](../src/agent/skillLoader.ts) 的 `composeSystemPrompt` |
| 自动选择 | 模型依据描述调用 Piem `read_skill`，工具从本轮内存快照取正文 | [skillTools.ts](../src/tools/skillTools.ts)，参数只有 `name` |
| 显式选择 | `/name`、`/skill:name` 经 Pi `formatSkillInvocation` 注入正文和附加要求 | [ObsidianAgentService.ts](../src/agent/ObsidianAgentService.ts) 的 `sendPrompt`；[skillLoader.ts](../src/agent/skillLoader.ts) 的 `expandSkill` |
| 引用文件 | 笔记库内资源经原生 `read` 和 Vault 环境按需读取 | [obsidianTools.ts](../src/tools/obsidianTools.ts)、[VaultExecutionEnv.ts](../src/vault/VaultExecutionEnv.ts) |
| 子代理 | 使用相同的目录格式化方法和传入的技能集合 | [runner.ts](../src/subagent/runner.ts) 的 `runSubagent`；与主代理共用压缩封装 |

每个新的、非运行中追加的用户轮会刷新技能；正在执行的轮次保留原快照。该策略保持目录、`read_skill` 与命令展开一致，但没有实现仅重新读取发生变化的文件。[ObsidianAgentService.ts](../src/agent/ObsidianAgentService.ts) 的 `sendPrompt` / `reloadSkills` / `loadSkillFiles`

## 已复现的缺口

### 1. 长正文无法由 `read_skill` 完整取得

工具声称返回 complete instructions，但经通用 `textResult` 限制为 **51,200 字节或 2,000 行**。超过限额的部分有截断提示，却没有 `offset`、`limit` 或续读令牌。重复调用返回相同开头。笔记库文件可改用 `read` 分页；笔记库外的用户技能没有等价的内置文件读取入口。`/name` 展开保留完整正文，因此两条激活路径表现不同。

证据：[skillTools.ts](../src/tools/skillTools.ts)、[toolResult.ts](../src/tools/toolResult.ts)、[truncate.ts](../src/vault/truncate.ts)。探针用 51,201 个字符加末尾标记复现 `tailVisible: false`，同一正文的 slash 展开为 `slashTailVisible: true`。规范的正文长度是建议，不能假定所有合法技能都小于此限额。[规范 Body content][spec]

### 2. 用户级技能的笔记库外资源不可达

桌面加载器可以读宿主目录中的 `SKILL.md`；`read_skill` 只接收名称，返回正文。随后普通文件工具只认识 Vault 地址空间，不能读取该技能旁边的 `references/`、`assets/`。探针创建一个真实的宿主引用文件，Vault 环境读取返回 `not_found`；同样结构的笔记库引用读取成功。手机不加载用户级目录。

证据：[userSkills.ts](../src/skills/userSkills.ts)、[skillTools.ts](../src/tools/skillTools.ts)、[VaultExecutionEnv.ts](../src/vault/VaultExecutionEnv.ts)。[composeSystemPrompt](../src/agent/skillLoader.ts) 已告知模型这个限制，但这不能补全第三层资源访问。此结论限于 Piem 内置工具，未假定用户配置的 MCP 提供额外文件访问。

### 3. 压缩没有保留已激活技能的原文

Piem 将全部旧消息交给 Pi `prepareCompaction`，压缩后仅保留摘要和最近消息。没有技能激活登记或保护标记。更早的 `read_skill` 结果可进入待摘要部分；Pi `serializeConversation` 还把普通工具结果截为前 **2,000 个字符**，正文末尾可能连摘要模型都看不到。

探针确认旧技能结果被选入待摘要消息、末尾标记不在摘要输入中，并用固定摘要返回值完成真实压缩封装，原正文没有出现在压缩后的上下文。它证明原文没有强制保留，**不证明真实模型每次都会遗漏所有技能规则**。系统提示里的目录仍在，模型可以重新调用 `read_skill`；当前没有强制恢复步骤。

证据：[compaction.ts](../src/agent/compaction.ts) 的 `compactIfNeeded` / `toCompactedMessages`、[Pi compaction.ts][pi-compaction] 的 `prepareCompaction`、[Pi utils.ts][pi-compaction-utils] 的 `serializeConversation`。这是对客户端指南 Step 5 的实质缺口。[客户端指南][client]

### 4. 导入同一技能，URL 层级会改变附件是否保留

输入技能集合 URL（例如 `.../tree/main/skills`）时，其下技能的引用文件可随同导入。输入某个技能自身的文件夹 URL（例如 `.../tree/main/skills/example`）时，`dir === ""` 的分支只选择 `SKILL.md`，漏掉同目录的 `references/detail.md`。两种 URL 都经过真实 `SkillImporter.fetchSource`，差异已由离线 GitHub 响应夹具复现。

证据：[skillImport.ts](../src/skills/skillImport.ts) 的 `fetchGithubTree`，尤其 `wanted` 的 `included` 判断。这会让标准的多文件技能在导入后失去第三层资源。

### 5. 通用导入器没有落实文档原先承诺的 Markdown 白名单

通用导入器过滤已知二进制后缀，没有使用 `.md` 白名单。上述集合 URL 夹具中的 `scripts/run.py` 被选中并读取；内置技能发布包则确实只允许 Markdown。这是两条不同的实现，不能由内置包的验证推断导入器也受同样限制。

证据：[skillImport.ts](../src/skills/skillImport.ts) 的 `BINARY_EXTENSIONS` / `fetchGithubTree` / `isBinaryPath`，对比 [builtin-skills.mjs](../scripts/builtin-skills.mjs) 的资源路径校验。Piem 的 Vault 环境拒绝 shell 执行，本探针未执行任何导入脚本；下载文件不等于执行文件。本 PR 将两份扩展文档改为准确描述当前行为。

## 其他兼容边界

- Pi 返回的 `Skill` 保留 name、description、content、filePath、disableModelInvocation；`compatibility`、`license`、`metadata`、`allowed-tools` 没有进入这个记录。探针确认 compatibility 标记未保留。去掉 frontmatter 是指南允许的实现，但这些字段中的环境要求和工具声明不会自动生效。[Pi skills.ts][pi-skills] [客户端指南 Step 4][client]
- Piem 没有内置 shell 执行能力；需 Python/Bash 等本地脚本的技能不能仅靠安装文件就完成工作。[VaultExecutionEnv.ts](../src/vault/VaultExecutionEnv.ts) 的 `exec`；[规范 scripts][spec]
- 文件格式校验是宽容的：名字不符会警告但仍加载，缺失描述或无法解析则跳过。这与客户端指南推荐的兼容策略一致；内置发布包则在构建时严格校验。[Pi skills.ts][pi-skills] [builtin-skills.mjs](../scripts/builtin-skills.mjs) [客户端指南 Step 2][client]

## 验证与复跑

```bash
bun scripts/probe-skill-standard.mjs
bun test src/agent/skillLoader.test.ts
bun test src/tools/skillTools.test.ts
bun test src/agent/builtinSkills.test.ts
bun test src/agent/ObsidianAgentService.test.ts --test-name-pattern 'vault skills|memory through ordinary skills and file tools'
```

上述 35 项已有测试均通过。探针的发现阶段缓存正文、目录不含正文/引用内容、激活时不再次读盘、长正文截断、引用可达性、压缩和两种导入 URL 均已运行；网络请求为 0，临时目录在 `finally` 中清理。

[探针](../scripts/probe-skill-standard.mjs) 是针对该基线的历史审计，部分断言刻意复现缺陷，**不是要求未来保留缺陷的 CI 测试**。修复实现后应更新或归档这些断言，并为修复添加正常的回归测试。它使用真实 Pi/Piem 逻辑、假的 Vault 和固定摘要服务，不包含真实 Obsidian、iOS/Android 或模型行为验收。

完整本地门禁已通过：`npm run build`、`npm run lint`、`bun test`（3,223 项，197 个文件），以及 `check:bundle`、`check:skills`、`check:copy`、`check:css`、`check:version`。技能资源检查确认七项技能、25,043 字节，源文件、资源和 bundle 摘要一致。PR 检查结果见 PR 的当前提交状态。

## 后续修复优先次序

1. 修复通用导入器的目录边界与资源策略，增加单技能 URL 和集合 URL 的多文件回归。
2. 补全长正文读取契约，并使模型能预知读取限制；在既有 Vault 边界内支持引用，库外资源的接入需单独设计。
3. 在压缩边界保留或恢复已激活技能；覆盖主代理、子代理和会话重开，避免重复注入。

继续复用 Pi 的解析器与提示词格式化器。上述缺口分别属于导入、工具适配和上下文生命周期，不需要再写一套技能解析系统。

[spec]: https://agentskills.io/specification
[client]: https://agentskills.io/client-implementation/adding-skills-support
[pi-skills]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/skills.ts
[pi-prompt]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/system-prompt.ts
[pi-compaction]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/compaction/compaction.ts
[pi-compaction-utils]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/compaction/utils.ts
