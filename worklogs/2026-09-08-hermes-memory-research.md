# Hermes Agent 记忆机制：源码核验与 Piem 借鉴边界

查询开始：2026-09-08 16:53 UTC；报告收尾：2026-09-08 18:20 UTC（中间会话曾中断）。官方仓库经 GitHub API 确认为 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)，仓库主页指向 `https://hermes-agent.nousresearch.com`。本报告固定在查询开始时 `main` 的 [c8aa5608c24e3636e77c267650c0f1f52e44adb0](https://github.com/NousResearch/hermes-agent/commit/c8aa5608c24e3636e77c267650c0f1f52e44adb0)；提交时间为 2026-09-08 14:30:44 UTC。

方法：读取官方仓库树及选定源码、官方文档；未运行 Hermes，未测试模型实际遵循率、检索精度或性能。以下“硬逻辑”指已读取的实现分支，“提示词规则”指模型收到的文字指引。后者不等于确定性校验器，也不代表行业统一标准。

## 结论

Hermes 的内置记忆并不是“日志 → 跨天计数 → 人工批准 → 长期记忆”的固定流水线。代理可以直接调用 `memory` 保存事实，长期价值由模型判断；工具负责容量、更新匹配、持久化和可选审批。后台复盘另有调用频率，它不构成每条记忆的晋升资格。具体依据见下表及后文。

对 Piem 可借鉴的是：把事实、会话记录、可复用流程分开；让明确的记忆请求和更正立即生效；复用现有文件工具，避免反复问批准。Piem 按用户确认的纯 SKILL 方案实现，规则集中在两份 `SKILL.md`。Hermes 的自动注入、宿主文件系统、后台模型副本、固定字符数字都不能直接等同于 Piem 的设计选择。

用户给出的 [claude-skills self-improving-agent 原文](https://github.com/alirezarezvani/claude-skills/blob/19392f7a08264ed00486a251f5b2098321771f94/engineering-team/self-improving-agent/skills/self-improving-agent/SKILL.md)将“重复 2–3 次、用户批准”用于从记忆晋升到 `CLAUDE.md` 或 `.claude/rules/`。Piem 借鉴事实与流程分层、按范围存放、清理过期内容；按本项目的宽松要求，不把该仓库的规则晋升流程套在普通记忆保存上，也不将记忆升级为系统指令。

## 实际机制与原文

| 问题 | 已核实行为 | 性质与证据 |
| --- | --- | --- |
| 事实与偏好放哪里 | `MEMORY.md` 保存跨任务事实；`USER.md` 保存用户信息和稳定偏好。默认总上限分别为 2200、1375 **字符**，不是字节或准确 token 数；配置可覆盖。 | 硬逻辑：[MemoryStore 构造与字符计数](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L66-L93)、[计数](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L172-L183)、[初始化配置](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/agent_init.py#L1253-L1271)。 |
| 什么值得保存 | 最新 schema 倾向仅保存适用于各次会话的事实；任务步骤、特定任务的偏好和纠正进入技能；进度、完成日志、临时 TODO 留在会话历史。 | 提示词规则：[memory schema](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool.py#L215-L239)。没有此语义的代码分类器。 |
| 有没有跨天、重复次数门槛 | 已核读的 `memory` 调用链没有日期、观察次数或置信分数参数；满足写入校验即可写入。复盘 prompt 说发现值得记的用户信息就存；纠正、有效技巧、过期步骤任一信号便可触发技能更新建议。 | 工具硬逻辑：[分发](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool.py#L129-L158)、[add/replace](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L214-L245)；模型判断：[memory review](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L299-L308)、[skill signals](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L376-L387)。这不排除独立外部 provider 有自己的规则。 |
| 保存还要问用户吗 | 默认不需要。`memory.write_approval` 和 `skills.write_approval` 均默认 `false`。开启后，前台 memory 尝试交互 CLI callback；没有交互通道则暂存。后台 memory 与所有 skill 写入暂存等待审阅。不是默认调用 `ask_user`。 | 硬逻辑：[默认解析](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/write_approval.py#L43-L59)、[gate](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/write_approval.py#L164-L211)、[memory 接入](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool.py#L64-L108)、[skill 接入](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/skill_manager_tool.py#L735-L753)。 |
| 会自动带进模型上下文吗 | 会。初始化读取文件，快照块加入 system prompt。普通写入不会逐次修改快照；上下文压缩后的 prompt 重建会重新读盘。准确说法是“重建边界刷新”，不是“会话内永远不刷新”。 | 硬逻辑：[载入快照](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L111-L133)、[拼入 prompt](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/system_prompt.py#L459-L468)、[重建重读](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/system_prompt.py#L677-L695)。 |
| 原始会话怎么找 | `session_search` 使用 SQLite/FTS5，返回实际 DB 消息，不调用 LLM 做摘要；支持搜索、按会话读、锚点前后翻阅、最近列表。普通发现默认 3 条、限制 1–10 条，初始 FTS 扫描最多 300 行；自动化来源降权，子代理等内部来源隐藏。 | 硬逻辑：[工具模式与来源](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/session_search_tool.py#L1-L34)、[搜索](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/session_search_tool.py#L261-L295)、[分发与上限](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/session_search_tool.py#L497-L530)。未验证其 DB 底层查询计划与文档速度数字。 |
| 流程怎么沉淀 | `skill_manage` 新建、修改、定点 patch、删除技能及支持文件；技能索引进入 prompt，正文及参考文件用 `skill_view` 按需读。`/learn` 将用户材料转成普通代理任务，先寻找现有技能，优先更新。 | 硬逻辑：[skill_manage](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/skill_manager_tool.py#L735-L777)、[索引生成](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/prompt_builder.py#L1301-L1327)、[正文返回](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/skills_tool.py#L547-L595)；prompt：[learn 优先更新](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/learn_prompt.py#L159-L190)。 |

## 真实护栏与没有的能力

**去重与矛盾处理。** 完全相同的字符串不再追加。`replace/remove` 通过唯一子串定位；匹配多条不同内容会报错，让调用者缩小目标。没有看到内置语义矛盾解析器、来源优先级图或“已验证事实”状态机。模型自行判断过期事实、合并条目；这与自动识别真假是两回事。[唯一匹配](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L57-L63)、[去重和容量](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L214-L234)、[替换与歧义](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L253-L274)。

**容量满不会自动偷偷丢旧记忆。** add/replace 超限报错；`operations` 批次在内存中应用，按最终结果验上限，任何一项失败不写入。这样可一次“缩短旧条目 + 保存新条目”，避免为腾空间先删后加。当前批次还拒绝把非空库整体清空，但单条 remove 能删除最后一条。[批次实现](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L299-L338)。容量边界不代表 Piem 必须照抄两份极小字符配额；应按自己读取和上下文预算确定。

**写入防丢数据。** 内置修改先锁文件、重读最新内容，再修改并原子替换；现存文件读失败时不当空文件覆盖，无法安全往返解析时保留备份并拒绝覆盖。[读失败/格式漂移](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L35-L54)、[锁后重读](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L190-L212)、[原子写入](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L394-L417)。Piem 应用 Vault API 的能力实现同类目标，不能搬入 Python 文件锁或宿主路径。

**不要把历史偏好升级成永久命令。** Hermes 提示词要求写“用户偏好简短回复”这类事实，避免写“永远简短回复”这类会盖过当前请求的命令；技能更正要求原地修错，不在旧规则后追加相反的 UPDATE。这些是值得借鉴的语义约定，不是写入硬校验。[事实语气](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/prompt_builder.py#L183-L197)、[重复与原地修错](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L327-L339)。

**注入防护只是一道启发式边界。** 写入前和加载快照时扫描威胁模式；加载时从 prompt 移除可疑内容，但保留原文件方便处理。扫描是正则、Unicode 检查，不可称“阻止所有注入”。它也不是事实矛盾检测。[写入扫描](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L25-L28)、[加载扫描](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L111-L133)、[扫描算法](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/threat_patterns.py#L116-L144)。

## 谁能写，后台怎么跑

- 前台代理可通过 `memory` 写入；专用后台复盘 fork 绑定父代理的 memory store，并在 dispatch 白名单里允许 memory、skills、只读文件工具。普通委派子代理工具集中明确屏蔽 `memory`。这些是**工具边界**，不能据此声称通用文件工具或宿主权限形成了完整安全沙箱。[fork 绑定](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L852-L876)、[白名单](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L937-L961)、[delegate 排除](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/delegate_tool_toolsets.py#L13-L21)。
- 后台技能更新不能修改用户自有、pinned、external、bundled 或 hub 技能；需在本次 review 实际读过目标文件才可改写。前台 pinned 的一般规则主要限制删除，不能把后台规则泛化到所有写入。[所有权与读取护栏](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/skill_manager_guards.py#L143-L238)。
- 默认 memory review 每 10 用户回合检查，skill review 按累计工具迭代默认 10 次检查；前台任务正常完成后才考虑启动后台复盘。**这是调度频率，不是同一条记忆必须被观察十次。** 前台工具随时能写，不必等周期。[默认配置](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/agent_init.py#L1234-L1271)、[skill interval](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/agent_init.py#L1305-L1309)、[memory 计数](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/turn_context.py#L572-L581)、[结束触发](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/turn_finalizer.py#L592-L621)。
- 后台 review 默认最大 16 迭代，累计输入预算默认 600000 tokens；预算在下一轮开始处检查，已经越过预算的请求会先完成，因此不是精确 token 截断。新前台输入会取消 review，等待确认最多 2 秒再放行前台。不能把这套成本搬到 Obsidian 移动插件。[预算](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L146-L184)、[检查时机](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/conversation_loop.py#L104-L113)、[取消](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L119-L143)。
- 托管本地模型另有 idle queue：每会话只保留最新复盘快照，空闲后执行；默认最长等待 30 分钟后即使不空闲也运行。它仍有线程和模型调用，不是“零负载记忆”。[队列说明与常数](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/review_idle_queue.py#L1-L33)、[合并与调度](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/review_idle_queue.py#L95-L139)。
- 技能 curator 的默认 7 天检查、30 天 stale、90 天 archive 是另一套不活跃生命周期，LLM consolidation 默认关闭。这些天数不能当成事实记忆晋升门槛。[curator 常数](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/curator.py#L1-L32)、[转换实现](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/curator.py#L191-L237)。

## 过度防御的直接启示

Hermes 自身源码记录了一次“保护把通路堵死”的修复：后台要求修改前读取技能，但最初没有允许 `read_file/search_files`，造成反复拒绝；当前白名单已放开这两个只读工具。这里的历史事故数量仅出自维护者注释，本次没有复现。这说明一个护栏若存在，应同时提供可达、低摩擦的满足方式。[白名单与问题说明](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L937-L961)。

内置存储还计数连续合并失败：前三次仍给修复建议，第四次起返回 `done=true`，要求停止重试、先回答用户。成功会重置计数。注意这主要是工具结果信号；单看这些方法，并没有让后续所有 `memory` 调用在 dispatch 层不可执行。[失败预算](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L71-L109)、[成功结果](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool_store.py#L345-L355)。Piem 更应直接给明确的一次性结果，让记忆维护不会拖住正常任务。

不能因此全盘认定 Hermes 的全部策略都是最佳实践：其 review prompt 强烈鼓励“多数会话至少一个技能更新”，可能增加无价值沉淀；这是 prompt 倾向而非质量保证。可保留“没有新信息就不写”，不应为追求更新次数制造记忆。[review 开头](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L368-L375)、[允许不保存](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/background_review.py#L446-L451)。

## 给 Piem 开发方案的建议

以下是设计建议，不是声称 Hermes 已经提供这些完整能力。

1. **宽松记，清楚改。** 用户明确“记住”、纠正偏好或确认稳定事实时，可以直接记入长期事实；记录出处和作用范围即可，不额外要求跨日、凑次数或再次批准。模型推断不冒充用户原话；没有足够把握的事实留在带来源的日志中，不强迫全局晋升。
2. **晋升是压缩和归位，不是授予命令权。** 相关日志变成一条可检索、可更新的事实；流程进入对应技能。避免把临时环境失败固化成永久“不能做”。当前请求始终能覆盖旧偏好。
3. **纠正后只有一个当前版本。** 用户新的明确更正替代旧值；保留必要的历史或恢复记录，而不是让相反事实永远并列。只有实质歧义影响当前工作时才询问。Hermes 的 replace/原地修错思路可借鉴，但它没有现成语义冲突引擎可直接拿来。
4. **使用现有工具，规则留在技能。** `find`、`ls`、`grep`、`read` 负责定位和读取；`write` 创建文件，`edit` 精确修改已有内容。技能要求先读后改、保留无关内容、读失败不覆盖、写后检查结果。沿用普通工具的 Vault 路径边界，不新增 memory 模块、专用工具、备份库或晋升计分器；这些指引也不等于新的原子写入或跨设备事务保证。
5. **兑现纯 SKILL 的按需读取路线。** 技能描述提供触发条件，正文通过 `read_skill` 加载，再按需 `read` 记忆。把日志和长期索引做得容易读、容易更新，不把记忆正文或流程写入系统提示词代码。
6. **本期不复制后台反思。** 不新增模型副本、常驻线程、计时扫描或向量库。前台完成任务时顺带完成有价值的记改，后续如有实际漏记数据再讨论低频维护。保存成功后用简短结果反馈，用户能查看、修改、撤销；宽松不等于不透明。

## 文档漂移与未核实边界

- 官方 memory 文档仍称快照会话内绝不改变；源码在压缩重建时重读。报告采用源码行为。[文档 L57](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/website/docs/user-guide/features/memory.md#L57)、[源码](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/agent/system_prompt.py#L677-L695)。
- memory 文档把 completed work 列为保存项，最新 schema 则明确不存 completed-work logs。报告采用最新模型实际收到的 schema。[文档 L114](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/website/docs/user-guide/features/memory.md#L114)、[schema L237–239](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/memory_tool.py#L237-L239)。
- README 仍写 session search 有 LLM summarization，当前 session_search 源码已明确没有 LLM 调用。报告不沿用 README 的这一描述。[README L26](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/README.md#L26)、[工具源码](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/session_search_tool.py#L1-L8)。
- 未运行多进程写入、未验证所有文件工具绕行行为、未测审批失效场景。尤其 `write_approval` 读取失败默认放行、`stage_write` 写盘失败仍返回 record，不能当成 Piem 高可靠审批/持久化的模板。[默认放行](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/write_approval.py#L43-L59)、[暂存异常路径](https://github.com/NousResearch/hermes-agent/blob/c8aa5608c24e3636e77c267650c0f1f52e44adb0/tools/write_approval.py#L73-L92)。
- 外部 memory providers 有独立实现，本文只读取核心接线，不对 Honcho/Mem0/Hindsight 等的抽取、矛盾消解、时效性或效果作结论。本文所有判断是此固定 SHA 的源码审计；未安装依赖、未启动服务、未跑 Hermes 测试或性能基准。
