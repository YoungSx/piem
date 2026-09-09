# Skill 标准核对与实现修复

2026-09-09。初始代码基线 `ff8bf0a`；实际依赖 `@earendil-works/pi-agent-core` 为 `0.84.3`。

## 标准核对

**技能核心直接使用 Pi，模型上下文采用渐进式披露。** 发现时预缓存正文、模型按名称调用专用工具取得正文，均是官方客户端指南明确允许的实现方式。[格式规范][spec] [客户端指南][client]

| 环节 | Pi 接口 | Piem 接线 |
| --- | --- | --- |
| 内置与笔记库解析 | `loadSkills` | [skillLoader.ts](../src/agent/skillLoader.ts) |
| 用户级解析 | `loadSourcedSkills`、`NodeExecutionEnv` | [userSkills.ts](../src/skills/userSkills.ts) |
| 首层目录 | `formatSkillsForSystemPrompt` | 只包含 name、description、location，不包含正文 |
| 显式激活 | `formatSkillInvocation` | `/name`、`/skill:name` |
| 按需激活 | Pi `Skill.content` | Piem `read_skill`，继续使用同轮快照 |
| 压缩与持久化 | `prepareCompaction`、`compact`、`createCustomMessage`、Pi JSONL | 保留已加载技能内容，仍由 Pi 执行摘要和会话编码 |

上游实际源码：[skills.ts][pi-skills]、[system-prompt.ts][pi-prompt]、[compaction.ts][pi-compaction]、[compaction/utils.ts][pi-compaction-utils]。可选的实验字段 `allowed-tools` 不等于权限系统；Pi 目前仅提取其 `Skill` 类型支持的字段。宿主不提供 shell 是能力边界，不是格式不兼容。[规范][spec]

## 已落实的修复

### 正文和引用资源

- 原 `read_skill` 经通用工具输出限制截断，且无法续读。现按 UTF-8 字节分页，每页最多 50 KiB，返回下一 offset 和内容指纹；中文、表情、超长单行也能完整取得。续读必须携带同一指纹，内容变化即要求重新读取。
- `read_skill` 增加相对资源路径，按需读取笔记库和桌面用户级技能的 UTF-8 文本。发现阶段不读取引用正文。目录绑定在加载的 `Skill` 对象上，不再把正文路径假定为笔记库路径。
- 资源上限 1 MiB；绝对路径、隐藏路径、`..` 和越界符号链接会被拒绝。用户级目录在发现时固定真实根路径，后来替换根目录为符号链接也不能扩大范围。
- 用户级读取继续经 Pi 的 Node 环境；每次资源请求新建的环境在 `finally` 清理，没有文件监视器、定时扫描或常驻子进程。普通 Vault 工具不扩大范围。

实现：[skillContent.ts](../src/skills/skillContent.ts)、[skillResources.ts](../src/skills/skillResources.ts)、[skillTools.ts](../src/tools/skillTools.ts)。测试：[skillTools.test.ts](../src/tools/skillTools.test.ts)、[skillResources.test.ts](../src/skills/skillResources.test.ts)。

### 压缩后保留

旧实现把 `read_skill` 当普通工具结果处理；Pi 摘要序列化会截短工具结果，且压缩输出只保留摘要与最近消息。现收集已经进入当前对话的技能正文、资源页和显式命令块，将未留在最近消息中的内容保存为 Pi 原生 custom 消息。

只保留已加载内容；同一页去重，新版本替换旧版本。失败读取不变成长期指令。保留内容经 Pi JSONL 写入已有会话，主代理、子代理和会话重开共用此逻辑，不创建第二套会话或技能引擎。`display: false` 在聊天渲染中生效，避免重复显示大段正文。

实现：[skillContext.ts](../src/agent/skillContext.ts)、[compaction.ts](../src/agent/compaction.ts)。测试覆盖重复压缩、分页、版本替换、真实会话编码与重开，以及主代理/子代理下一次实际请求上下文：[skillContext.test.ts](../src/agent/skillContext.test.ts)、[compaction.test.ts](../src/agent/compaction.test.ts)、[ObsidianAgentService.test.ts](../src/agent/ObsidianAgentService.test.ts)、[extension.test.ts](../src/subagent/extension.test.ts)。

### 导入与更新

- 单个技能文件夹、仓库根技能、技能集合均保留所属 Markdown 附件。技能目录内的嵌套 `SKILL.md` 示例不再成为重复技能。
- 脚本及其他非 Markdown 文件在下载前过滤。超过 10 个技能、40 个 Markdown 文件或单文件 256 KiB 会报错，不以遗漏 Markdown 资源的半套包充当成功；下载后也校验实际字节数。
- 检查 Pi 文件操作返回的 `Result`，写入/删除失败会抛出错误，不再继续登记成功的来源记录。
- 更新比较文件集合和摘要，远端 tree 未变也能补回旧导入器漏掉的资源。旧版单文件夹安装目录可按唯一技能名匹配，仍写回原目录，不额外创建副本。

实现与回归：[skillImport.ts](../src/skills/skillImport.ts)、[skillImport.test.ts](../src/skills/skillImport.test.ts)。

## 验证范围

发现问题时执行的离线审计探针已被正常回归测试替代并删除，避免让“复现旧缺陷”的断言长期要求缺陷存在。上述回归先验证失败场景，再在修复后通过。

```bash
bun test src/tools/skillTools.test.ts
bun test src/skills/skillResources.test.ts
bun test src/skills/skillImport.test.ts
bun test src/agent/skillContext.test.ts
bun test src/agent/compaction.test.ts
bun test src/agent/ObsidianAgentService.test.ts
bun test src/subagent/extension.test.ts
```

使用真实 Pi/Piem 逻辑、临时文件或模拟 Vault，以及确定的模型响应；没有真实模型费用。提交前通过 `npm run build`、`npm run lint`、全部 3,250 项测试（199 个文件），以及 `check:bundle`、`check:skills`、`check:copy`、`check:css`、`check:version`。十个相关测试文件独立运行也通过，包体积为 1.65 MiB，低于原有 1.66 MiB 上限。未以这些测试冒称 Obsidian 或 iOS/Android 真机验收。

保留边界：资源读取仅支持 UTF-8 文本，笔记库图片走原生 `read`；没有 shell 执行。非常大的已激活技能仍占用模型上下文，因此作者应遵守官方“短入口、细节放引用”的建议；预读优化与模型是否主动选对技能不在本次修复的验证结论中。

[spec]: https://agentskills.io/specification
[client]: https://agentskills.io/client-implementation/adding-skills-support
[pi-skills]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/skills.ts
[pi-prompt]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/system-prompt.ts
[pi-compaction]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/compaction/compaction.ts
[pi-compaction-utils]: https://github.com/earendil-works/pi/blob/v0.84.3/packages/agent/src/harness/compaction/utils.ts
