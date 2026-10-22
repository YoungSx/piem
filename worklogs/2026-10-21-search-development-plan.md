# grep 分页与笔记检索开发计划

日期：2026-10-21。基线 `886fe8221527368a8d43ea43ea862ea5fd00f9b5`，默认分支经 GitHub 查询为 `master`，本轮 fetch 后与 HEAD 一致。依据：[官方接口调研](2026-10-21-grep-search-research.md)。本文是实施与验收契约，计划审查通过后直接执行；不发布版本、不合并 PR。

## 要解决的行为

现有 grep 先按路径排序，再累计 100 条匹配行后停止；靠前文件可占满结果，后续文件无法在本次调用参与。恰好达到上限也会误报截断，字节预算还能隐藏已计入 count 的记录。修复精确搜索的可继续性，同时新增笔记发现工具；不把 regex 行搜索改变成不确定的笔记相关性排名。

## grep 契约与实现

- 保留工具 ID、literal/regex、默认不区分大小写、text extension 范围和 file/folder scope。新增零基匹配记录 `offset`，默认 0；`maxMatches` 为每页正整数，默认 100，上界 1000。schema 与 execute 均验证整数/范围，offset 为非负安全整数。无服务端分页状态，无文件内容缓存或持久索引。
- 使用明确的 UTF-16 路径比较（`a < b` / `a > b`）和递增行号，避免默认 locale 不同导致顺序变化。offset 在相同 query/case/regex/scope 和未变化 vault 上稳定；文件变化不承诺跨调用快照，工具说明与文档披露。
- 编译 matcher 一次，即使空候选也验证 regex。纯行 iterator 从正文顺序遍历，保留原 CRLF/行号行为；不要为每个文件重新编译 regex，也不为一次搜索保留所有正文。既有 `grepContent` 若仍有消费者，复用相同 iterator，不复制 matcher。
- 顺序 cachedRead，各次读取前后检查 AbortSignal。扫描每批约 1000 行/16 文件主动让出事件循环，随后再次检查取消；使用 window timer 并清理 abort listener/timer。不改变 Pi agent 生命周期，单次 cachedRead 无底层取消能力如实说明。
- 跳过 offset 条命中，然后收集一页。额外发现第一条未交付匹配即可确认 `hasMore=true`；扫描到末尾则 false。页大小之外不必计算全库总匹配数。读取失败按既有 throw 契约失败，取消不返回 complete 结果。
- 行显示继续复用 Pi truncateLine 的 500 字符限制。收集时按 UTF-8 字节累计完整输出行，为摘要保留固定小预算，结果总量不超过共享 50 KiB；不要先收集100再把70条切掉。若单条包含异常长路径导致完整记录无法放入预算，明确失败，不产生无法推进的空页。
- 最终 content 与 details 同时包含：实际返回 count、offset、hasMore、nextOffset、候选文件数、已读文件数、完整扫描文件数、行文本是否缩略及输出预算原因。页中途停止的文件不算完整扫描；不报告假的 totalMatches。nextOffset 按实际交付条数推进。采用已有 skillContentPage 的直接 AgentToolResult 构造方式：按截短后的显示串计 UTF-8 字节、摘要放在行记录之前，整体不超过50KiB，不再经过 textResult 二次截断。完整路径不能裁后冒称可定位；单条完整路径无法放入预算时明确失败。
- 拆出 grepTool/grep scanning 模块；searchTools 保留 ls/find 的职责。共享 scope/候选排序只提取真实共享的部分，不动 vaultFiles.compareFiles（task工具仍用localeCompare）或通用 maxResultsParameter。显式非空 scope 用getFolderByPath/getFileByPath核实存在，不存在抛错；存在但无可搜索类型可正常空结果。

## search_notes 契约与实现

- 新增直接 AgentTool `search_notes`，默认可用，executionMode=parallel。接口 query（trim 后非空）、可选 path（file/folder，沿用 vault guard）、maxResults（默认20，正整数1..100）。query 不超过1000字符、不超过32个去重的空白分隔词项；先 trim、折叠空白、统一小写再去重，完整query也使用该归一化形式；连续中文视为一个文字片段，无 stemming、同义词、embedding 或内置 Search operators。
- 候选为范围内全部 getMarkdownFiles()，按明确路径顺序。逐笔记读取 cachedRead，不先按 metadata 或文件序裁到前100。getFileCache 缺失仍以 basename/正文参与，结果披露 metadata 缺失数量；不自己重写 Markdown/YAML parser。
- 平台 helpers：parseFrontMatterAliases、getAllTags；headings 来自 cache。匹配用确定性不区分大小写 literal 子串，避免猜测 prepareSimpleSearch 隐含词法或 SearchResult.score 方向。现有平台 matcher 并不提供全库排名，因此笔记 rank 由本地显式定义。
- 每笔记一条。rank tuple 依次比较：不同查询词项的总覆盖数、标题/alias 完整 query 命中、标题/alias 词项覆盖、headings/tags 词项覆盖、正文词项覆盖；最后稳定路径打破平局。重复同词不会无限增加分数。首版允许部分词项命中，结果说明覆盖词项/总词项，便于模型判断。
- 只保留 maxResults 个最佳笔记与短摘要，所有候选都必须完成评分后才返回。正文逐个释放，返回路径/标题、匹配字段与词项覆盖、一条有行号的正文证据（若只有 metadata 命中可无正文 snippet）。定位是实际文件内容，不能把 metadata offsets 当正文行号。
- 结果 content 与 details 都写 candidateFiles/scannedFiles/matchedNotes/returnedNotes、metadata 缺失数、排序方法、截断情况。受50 KiB预算限制可能少于maxResults，但说明实际数和matchedNotes；该工具首版用于发现，无分页，提示缩小query/scope获取更多。所有候选都评分的覆盖不因输出截断改变。
- 与 grep 同样在每次读取前后查 signal、每批文件/正文行让出，扫描中 abort 不返回成功；读失败保持 throw 契约，不静默跳过后冒称全覆盖。无需增加部分成功协议或 failedFiles。取消只能在读取/行批次边界生效，单个同步正则/子串调用无法硬取消。
- 不创建背景索引、配置开关、网络服务、新的数据导出或 Node/Electron 依赖。

## 完整接入面

1. createObsidianTools 注册新工具；现有主代理/子代理共用工厂，不改平行执行策略。tool catalog 添加使用既有 search 类别的新条目与图标，en/zhCN 文案同时更新。
2. tool descriptions 声明 grep 精确行/分页与 search_notes 笔记发现职责；当前实际 systemPrompt 补一句检索选择策略。不给直接 AgentTool 添加无消费者的 promptGuidelines。
3. Code Mode 根据真实工具 schema 自动生成声明；补测试证明新schema和工具可达。更新依赖精确工具集合的 tests，避免漏掉子代理、catalog或parallel inventory。
4. 测试替身 obsidianStub 与 pluginLoader 同步补 parseFrontMatterAliases；string/array/null 语义先在真实host探测，再落stub行为测试。所有会走yield的独立测试使用stubWindowTimers而非installDom。
5. docs/tools 英/简中一起更新；同步现有繁中/日文工具说明段。README 不增加参考内容。新增search smoke注册到双语rig inventory。UI无布局改动，已有宣传截图不受影响。

## 验证与审查顺序

### 计划审查

独立 subagent 阅读本文、调研、当前生产调用链和 AGENTS。必须指出具体触发输入和最小修正，判断覆盖/排名/取消/预算/兼容/性能。所有 must fix/should fix 先修订，若有实质变更再新一轮 delegate_task；没有未解决阻断后开始编码。每轮记录独立 taskId 与结论。bundle 当前368B余量，实施后按实测新增生产字节及既有notch惯例调整门限、注明来源，不通过删除门禁闭环。

### 单元与集成验收

- grep：跨文件超过100，分页拼接无重无漏；刚好N与N+1；offset beyond end；字节先耗尽时游标只推进可见行；长行/cjk/CRLF/regex/case/scope；非法数字/regex；取消发生在cachedRead与长扫描时；读失败不能返回完整结果。
- ranking：前面日志重复词、末尾标题/alias更相关；正文独有命中；多词跨字段；中文；大小写重复词项与多空格归一化；cache=null；string/array aliases与正文/frontmatter tags；平分稳定顺序；每笔记一项；全部候选被读；无命中与budget截断信息；读失败与扫描中取消（包括长正文）不能报成功。
- 接入：实际工具 inventory、纯读 executionMode、catalog/i18n、Code Mode声明/调用、主代理和子代理工具工厂；含CJK与大小写路径的明确顺序回归。
- 所有新增/受影响测试文件独立运行；再 `npm run verify`（build、bundle/skills/copy/css/version、全量bun test、lint）。新增非平凡逻辑都有行为测试，不添加重复实现的测试。

### 实现复审与真实 runtime smoke

- 完成实现与针对性测试后，独立subagent使用pony-tail review标准审完整diff与关联源码，只读报告。修复确认的问题并按需回归；实质修正后新一轮review，最终无未解决发现。
- 新增 scripts/smoke-search-obsidian.mjs，遵循现有real-plugin/local-fixture/CDP方式。不得改主bundle或把测试算法注入插件。直接通过已加载service agent.state.tools执行并通过本地确定性SSE provider跑真实回合，检查provider实际收到的content、主/子工具声明和Code Mode可达性。
- 使用 scripts/obsidian-rig.py 在独立新vault/profile与专属空闲port/display启动Xvfb和真实Obsidian；使用已完成门禁的同一main.js，记录SHA256。桌面与官方phone emulation 390×844均跑：真实Vault/MetadataCache、前缀分页、字节不漏行、末尾标题/alias、正文独有、scope、模型content、取消、reload后工具仍可用及Node negative controls。
- 查看真实截图，报告native版本、设备模式、检查数、artifact SHA、结果路径；finally清理fixture/CDP/Obsidian/Xvfb，只处理本轮PID。真机iOS/Android不在本机可验证范围，不把官方模拟说成真机。取消smoke从CDP临时包cachedRead在首次读取后abort，finally还原；pre-abort不替代扫描中验证。

### PR 收尾

- fetch实际默认分支并检查基线；移动则rebase/处理冲突，重新验证变更受影响的门禁。git status只包含本轮源代码、文档、测试与smoke脚本，生成artifact不提交。
- 提交到当前独立工作树分支、push、创建PR，立即link_pull_request；描述最终行为与精确验证证据。
- CI失败修复并重新push；只有当前head SHA所有checks通过且mergeable无冲突才算交付。若等待CI需要跨回合，使用T3 watch_pull_request唤醒，最终unwatch并核验list_thread_pull_requests。无需另问用户权限。

## 风险与验收边界

无状态offset后页会重复读前缀；大库首个全文查询会有读开销，首版通过scope、顺序读、事件循环yield和小top-k约束，不虚构性能数字。文件修改会使跨页结果漂移；ranking是解释性文字匹配，不能保证语义最相关。50KiB为字节预算而非token预算。公有API、真实host与测试stub语义分开记录。

## 计划审查记录

- r1：Codex服务429失败；r2：跨Azure资源400失败；r3：因用户要求优先DeepSeek/GLM而取消，没有有效报告。
- r4（DeepSeek v4.1 Flash / high）：完成只读审查，6项Must fix已补机制与范围：bundle notch、两个alias stub、直接结果预算、notes取消/yield、window timer自足测试、独立路径comparator。
- Should fix采纳：归一化词项、scope存在性、顺序回归、smoke扫描中abort。读错误选择延续throw：失败不输出假的完整结果；极端长路径选择明确失败：裁掉路径会使结果无法read定位。
- Nice to have采纳：不重复scannedToEnd字段，不新增已有search类别。正则单步无法硬取消、大库查询无固定完成时间、跨页变化、真机边界均披露。
- 这些均为审查给出的最小修正或明确错误契约，没有架构分歧；按审查“修完即可进入编码”的结论开始实施。
- r4 taskId：`node:delegated-task:command%3Amcp%3Aa42660e3-ced5-4a4a-968a-963b9681f20d%3Adelegate-task%3Asearch-plan-review-20261021-r4`。
