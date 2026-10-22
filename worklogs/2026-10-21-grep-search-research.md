# grep 完整性与笔记相关性：Pi / Obsidian 官方接口调研

调研日期：2026-10-21。本文核对第一方源码、发布包和公共 API，并给出架构建议；不代表建议已实现。当前 checkout 为 `886fe8221527368a8d43ea43ea862ea5fd00f9b5`，`package.json` 固定 `@earendil-works/pi-agent-core` / `pi-coding-agent` 为 **1.3.0**、`obsidian` 为 **1.14.4**。只新增本文，未修改生产代码、测试或版本，未提交或推送。

## 结论

用户的核心分析成立：**按路径扫描并在累计 100 条匹配行时停止，只能得到扫描前缀，无法代表最相关的笔记。** 一篇靠前的长日志可以占满全部名额；之后的笔记不会进入当前结果。100 是输出预算，不是相关性模型，也不是“最多 100 篇笔记”。本地 `createGrepTool` 的早停和原版 Pi 的早停都符合这一类行为，但两者排序方式不同，不能混说。[本地依据见下文]、[Pi grep 源码][pi-grep]

最小且职责清楚的改进是两条独立契约：

1. **保留 `grep` 的精确行匹配，补可继续的分页和真实覆盖信息。** 默认页大小可继续为 100；结果明确说按路径、行号排序，并告诉模型如何继续。不要把行 grep 悄悄改成相关性排序。
2. **需要“找最相关笔记”时，另加笔记级检索工具。** 使用 Obsidian 的文件、元数据和缓存读取 API，让范围内的所有候选笔记参与确定性的词项评分，再截取 top-k；每篇笔记只占一条。标题、aliases、headings、tags 与正文各有明确作用。这是 lexical 检索，不宣称 semantic 检索。

不建议直接换成 Pi 的 `createGrepTool({ operations })`、读取 `app.internalPlugins` 的 Search 插件、建立 embedding 服务，或为首版增加持久化检索任务/游标状态机。前两者分别没有满足 Vault 搜索边界、没有核实的公共调用契约；后两者不是解决本次问题的必要条件。[Pi operations][pi-grep]、[Obsidian 公共接口][obs-types]

## 版本与来源核验

本轮先读取仓库 `AGENTS.md`，按现有 `worklogs` 的中文研究记录惯例组织本文。下载资料到 checkout 外的临时目录，没有安装 `node_modules`。

| 资料 | 核实结果 | 可复核来源 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent@1.3.0` | npm `repository` 指向 `earendil-works/pi` 的 `packages/coding-agent`；不是把旧 `badlogic/pi-mono` 的 0.x 文档当当前版本 | [npm 版本元数据][npm-coding]、[精确版本 tarball][tar-coding] |
| `@earendil-works/pi-agent-core@1.3.0` | 同一官方仓库，目录 `packages/agent` | [npm 版本元数据][npm-core]、[精确版本 tarball][tar-core] |
| Pi `v1.3.0` | GitHub tag 指向 `71023aec1546d6d677a65669c5665c0927ce0dd0`；npm provenance 的 `resolvedDependencies.gitCommit` 为同一 SHA | [tag API][pi-tag]、[npm provenance][pi-provenance] |
| Pi 实际发布内容 | npm source map 的 `sourcesContent` 与该 SHA 的 `grep.ts`、`tool-definition-wrapper.ts`、`extensions/types.ts`、`system-prompt.ts`、`agent-session.ts`、agent `types.ts` / `agent-loop.ts` 逐字一致 | 本轮下载后的字符串比较；下文 GitHub 链接固定此 SHA |
| `obsidian@1.14.4` | npm 是 API 类型声明包，`main` 为空，没有可执行的 native 搜索实现；`repository` 指向 `obsidianmd/obsidian-api` | [npm 版本元数据][npm-obs]、[精确版本 tarball][tar-obs]、[精确版本声明][obs-types] |
| Obsidian 文档 | 阅读官方 developer-docs 仓库，固定本轮文档树 `1c26772ac13d6e9870c865936d389fdfe694e742`；文档并不保证与 npm 声明同期 | [官方 Vault 文档源码][obs-vault-doc]、下文逐项链接 |

三个 tarball 的 SHA-1 均与 npm `dist.shasum` 一致：coding-agent `a52ed0ef8ba4fd03de221ec52b0996855bf5bf4d`、agent-core `aec4d26bf7cdab5bca2a129f6a6dffc606c892db`、Obsidian `e4d4c91df3184c6d8cd0ecccc0a6565c0ada99bb`。这只是本轮下载完整性检查，不是额外的签名验证。

Obsidian npm 元数据的 `gitHead` 为 `1087bb073fa88bfad5fba88d9f500072827abecb`，对应 GitHub raw 请求返回 **404**。本轮读取到的公开 `master` SHA `9abd9605ce081383674aae1ed111c456edde0688` 的 `obsidian.d.ts` 与 npm 1.14.4 内容不同。因此 **Obsidian 的版本事实以 npm 1.14.4 声明为准**，不把当前公开 master 冒充该版本。`unpkg` 与 jsDelivr 的 `obsidian@1.14.4/obsidian.d.ts` 均与已校验 tarball 逐字相同。[npm 元数据][npm-obs]、[精确声明][obs-types]、[公开 master 快照][obs-public-head]

## Pi 1.3.0 的 grep 实际提供什么

以下行号为固定 SHA 的 `packages/coding-agent/src/core/tools/grep.ts`，不是 Piem 本地实现。[完整源码][pi-grep]

| 项目 | 版本事实 | 源码位置 |
| --- | --- | --- |
| schema / 默认值 | `pattern` 必填；可选 `path`、`glob`、`ignoreCase`、`literal`、`context`、`limit`。`limit` 描述为默认 100，代码 `DEFAULT_LIMIT = 100`，执行取 `Math.max(1, limit ?? DEFAULT_LIMIT)`。schema 的 Type.Number 描述默认值，未用 JSON Schema `default` 实际填参 | `grep.ts:21–41, 135–136` |
| 匹配语义 | 默认 regex、默认区分大小写；`literal: true` 才传 `--fixed-strings`，`ignoreCase` 才传 `--ignore-case`。与当前 Piem 默认 literal / 不区分大小写不同，不能直接替换而不处理兼容性 | `grep.ts:25–28, 162–166` |
| 扫描 / 排序 | 固定启动 `rg --json --line-number --color=never --hidden ... -- pattern searchPath`，接收 `match` 事件即加入数组；没有相关性分数，也没有排序步骤或 `--sort`。输出是 rg 事件到达顺序，不应声称 Pi 保证路径字典序或跨运行稳定顺序 | `grep.ts:162–168, 217–239, 262–278` |
| 匹配条数 | `matchCount` 按 rg `match` 事件递增，未逐个累计 `submatches`；可见输出为匹配行。不能理解成文件数，也不能把同一行多个词出现次数算成多条返回记录 | `grep.ts:227–236` |
| 提前截断 | 计数达到 `effectiveLimit` 立即 `stopChild(true)`；未等待确认还有第 N+1 条，不知道剩余文件/行数量。`matchLimitReached` 表达已到达上限，不是已核实的全库总匹配数 | `grep.ts:234–236, 287–291` |
| 文本预算 | 格式化后再 `truncateHead`，grep 关闭通用行数限制，但仍应用 50 KiB 字节预算；每行先限制为 500 字符。输出匹配行数可能小于已经收集的匹配数 | `grep.ts:209, 271, 280–302`；[truncate.ts:11–13][pi-truncate] |
| 模型可见提示 | `content` 尾部写上限/字节/长行提示，建议增大 `limit` 或收窄 pattern；`details` 保存相应机器字段。增大 limit 是重新运行并扩大前缀，不是分页 | `grep.ts:285–307` |
| 上下文 | `context` 默认 0；大于 0 时通过 `readFile` 读取命中位置前后行，匹配行用 `path:line:`、上下文行用 `path-line-`。相邻命中的上下文可能重复；没有文件级相关性 | `grep.ts:135, 147–159, 197–215, 262–277` |
| 分页 / relevance | 本工具 schema 没有 offset、cursor、page、相关性模式，执行也没有续传协议或笔记评分 | `grep.ts:21–33` 及完整 execute |
| 取消 / 更新 | 接收 `signal`，开始时检查取消；运行中 abort handler kill 子进程，结束移除 listener；第四参数名为 `_onUpdate`，grep 本身不发进度更新 | `grep.ts:100–107, 174–192, 245–249` |

### operations 不是可替换的搜索后端

`GrepOperations` **只有** `isDirectory(absolutePath)` 与 `readFile(absolutePath)`；后者明确用于 context lines。它没有枚举文件、执行匹配、启动子进程或返回搜索结果的注入点。即使传入 operations，执行仍先 `ensureTool("rg")`，再使用 Node `spawn(rgPath, ...)`。接口注释说可委托 remote systems，但本版本实际实现没有提供把匹配委托给 Vault API 的方法，不能只读那句注释就认定具备该能力。[grep.ts:49–67, 117–129, 147–168][pi-grep]

因此当前 Obsidian 桥保留 Vault API 匹配实现有理由：可以遵循 Pi 的 tool/result 协议并复用其截断常量，但不必复制它的桌面文件系统执行方式，也不能声称简单注入 operations 就获得移动端兼容或相关性排名。

## Pi 的模型输出、取消与 prompt 元数据边界

### 哪些结果模型真的能看到

`AgentToolResult` 官方注释明确：`content` 为送给模型的 text/image；`details` 为日志或 UI 的结构化信息；`structuredContent` 为匹配 outputSchema 的程序调用结果，不送给模型。agent loop 把最终 `content` / `details` 存入 toolResult message，实际 provider 转换再读取 `content`；例如当前 OpenAI Responses adapter 的 `convertToolResultOutput(model, msg.content)`。保存进 transcript 不等于详情自动进入 provider 文本。[agent types.ts:423–445][pi-agent-types]、[agent-loop.ts:930–943][pi-agent-loop]、[OpenAI Responses 转换:356–370][pi-response]

对分页的直接含义：**`hasMore`、覆盖范围、继续调用参数不能仅写 `details`。** 模型必须在 `content` 里读到简短摘要与续页参数；`details` 可保存对应结构供 UI/脚本使用。结果经过扩展 `tool_result` / 自定义 context hook 时可能被宿主显式改写，不能把上述默认协议理解成“details 永远不可能通过自定义代码转为 content”。

`AgentTool.execute(id, params, signal?, onUpdate?)` 是当前直接工具契约。`onUpdate` 转成 `tool_execution_update` 事件；最终返回才形成 toolResult message。callback 在本次 execute Promise 完成后被忽略，不能作为后台长寿命搜索通道。[agent types.ts:458–487][pi-agent-types]、[agent-loop.ts:779–787, 821–856][pi-agent-loop]

Obsidian `cachedRead(file)` 的公开签名不接收 AbortSignal；搜索工具可以在每次读取前后、每批扫描之间检查 signal，但不能宣称正在进行的一次读取已被底层取消。单个同步长文件扫描也需要给事件循环取消机会；首版不需要为此写自己的 agent loop。[cachedRead 声明][obs-types]、[公共文档][obs-cached]

### promptSnippet / promptGuidelines 不能盲加给 AgentTool

- Pi coding-agent 的 `ToolDefinition` 有 `promptSnippet` / `promptGuidelines`，分别用于默认 system prompt 的 Available tools 与 Guidelines；直接 `AgentTool` 没有这两个成员。[extensions/types.ts:579–589][pi-extension-types]、[agent/types.ts:465–487][pi-agent-types]
- `wrapToolDefinition()` 只投影 executable 字段，没有把这两个字段拷到 AgentTool；`createToolDefinitionFromAgentTool()` 也不会恢复 prompt 元数据。[tool-definition-wrapper.ts:8–29, 46–56][pi-wrapper]
- 原版 `AgentSession` 从 **definition registry** 建立 snippets/guidelines map，再传入自己的 system prompt builder；默认 builder 对可见/活跃工具合并规则，使用 customPrompt 时又走另一分支。因此这是 coding-agent 的 prompt composition 机制，不能泛化成 agent-core 自动读取 AgentTool 上的额外字段。[agent-session.ts:1705–1730, 3559–3574][pi-session]、[system-prompt.ts:118–121, 150–161][pi-prompt]
- **当前 Piem 有自己的桥，但只核实了 extension 路线**：`src/extensions/extensionHost.ts:738–742` 从 runner 的注册 definition 暴露 `toolPromptMetadata()`；`communityHost.ts:257–266` 取活跃 extension tools 的 guidelines；`ObsidianAgentService.ts:2591–2595` → `skillLoader.ts:225–235` 把这些写入自组装 prompt。snippet 被桥读取，但这一汇入方法只使用 guidelines，未在该链路发现其默认列表输出。
- **当前 Vault grep 是直接 AgentTool 路线**：`createObsidianTools` 返回工具数组，`ObsidianAgentService.ts:1161–1172` 的 `createVaultTools` → `src/subagent/extension.ts:158–164` 组装 → `ObsidianAgentService.ts:6258–6294` 设置可执行/可见 tools；没有把本地 grep 注册成上述 runner definition。`src/extensions/extensionRegistry.ts:61–76` 的元数据投影也明确不提供 AgentTool 的 promptGuidelines。

首版应将“grep 返回行、按路径排序、可分页；笔记发现用 relevance 工具”的契约写入 **tool description / parameter description**，让现有 direct/codemode 工具声明管道携带它。如果需要跨工具选择策略，可修改当前实际生效的 Piem system prompt；如果选择统一 definition-first 注册，则要把元数据桥完整贯穿，不能只添加两个无消费者字段。本文不建议为了这一个工具先迁移整个注册架构。

## Obsidian 1.14.4 公共 API 能提供什么

以下行号来自 **npm tarball 内 `obsidian.d.ts`**；GitHub 公开声明分支可能有不同的行号，精确内容可从 [versioned declaration][obs-types] 复核。

| API | 已核实语义 | 对检索的意义 |
| --- | --- | --- |
| `Vault.getFiles(): TFile[]` | 列举所有 Vault 文件；没有排序保证 | 行 grep 可继续保留当前 text extension 范围，调用方明确排序；不能把返回顺序当相关性。`obsidian.d.ts:10420–10424` |
| `Vault.getMarkdownFiles(): TFile[]` | 列举 Markdown 文件 | 笔记检索的自然候选集；无需把 JSON/代码/日志所有行都当笔记。`:10414–10418` |
| `Vault.cachedRead(file): Promise<string>` | 读取 plaintext 的缓存内容，显示/只读场景优先；修改后写回应使用 read/process 等合适写契约 | 查询时按需读正文，复用宿主缓存；不是反向索引或搜索调用。`:10274–10290`；[Vault 指南][obs-vault-doc] |
| `MetadataCache.getFileCache(file): CachedMetadata \| null` | 返回已缓存 metadata；未缓存为 null | 重用 Obsidian 的解析结果，但 null 不代表文件无 tags/headings/alias，更不代表正文不匹配。`:6462–6469`；[官方 reference][obs-cache] |
| `CachedMetadata` | 有可选 `headings`、`tags`、`frontmatter`、`frontmatterPosition` 等 | 标题可来自 `TFile.basename`，H1/其他标题属于 headings；无需重新手写完整 Markdown parser。`:2391–2435, 2505–2527` |
| `parseFrontMatterAliases(frontmatter)` | 从 frontmatter 取 aliases；支持数组和字符串，返回 string[] 或 null | aliases 用平台 helper，而不是假定属性总是字符串数组。`:6945–6956` |
| `getAllTags(cache)` | 合并 frontmatter 与正文标签为 string[] 或 null | 这是导出的 helper，需要一个文件的 CachedMetadata；不是 `metadataCache.getAllTags()`，也不是全库标签查询。`:5016–5035`；[官方 reference][obs-tags] |
| `prepareSimpleSearch(query)` | 构造 `(text: string) => SearchResult \| null`；query 注释为“space-separated words” | 对调用方给的 **单个字符串** 匹配，可以作为 deterministic lexical matcher 的平台原语。不是 Vault query engine；未声明支持内置 Search 的 operators。`:7578–7584`；[官方 reference][obs-simple] |
| `prepareFuzzySearch(query)` | 同样只匹配一个 target string；官方提示运行几千次以上可能有性能问题，建议改用 simple | 可用于标题/alias 的宽松候选匹配；不宜无证据地对整个大库正文默认 fuzzy 扫描。`:7568–7576`；[官方 reference][obs-fuzzy] |
| `SearchResult` | `{ score: number; matches: [number, number][] }`，ranges 指给定字符串的 offsets；`:8085–8095` | 单字符串的匹配质量/位置，不能直接称全库笔记相关性分数，拼接各字段还需要映射 offsets |
| `sortSearchResults(results)` | 公开函数，原地排序 SearchResultContainer[]，返回 void；`:9466–9471` | 需要使用平台分数时优先用它，避免手写猜测的 score 比较器。见下一段 |

Vault 官方指南特别说明：Vault API 只访问应用可见文件，hidden folders 需 Adapter API；`cachedRead` 外部修改刚发生且文件系统通知尚未到达时可能暂时陈旧，通知后或 Obsidian 内保存后缓存会刷新。不能把 `getFiles` 称为包含任意隐藏目录的完整 OS 枚举，也不能保证跨读取的事务快照。[官方 Vault 指南][obs-vault-doc]

### score 的排序方向：本轮没有官方版本证据，不猜

1.14.4 的 `SearchResult.score` 注释只有 **“The score.”**；官方 `SearchResult/score` 页面只有 number 签名；`sortSearchResults` 也未写数值升降方向。npm 包没有 runtime，Obsidian 应用内的实现本轮未运行。因此 **本轮无法从已读取的第一方公开资料证实“越大越相关”或“越小越相关”**，也不承诺其具体算法、权重、中文分词、词序、同义词行为。[精确声明][obs-types]、[score reference][obs-score]、[sort reference][obs-sort]

当前 `src/testUtils/obsidianStub.ts:706–741` 使用自定义分数，并写了 descending 排序；其中 matcher 注释明确其不是 Obsidian real scoring。stub 通过不能证明 native 分数方向。项目现有 `src/ui/extensionAutocomplete.ts:15–19` 直接调用 `sortSearchResults`，可以复用该公共调用方式，而不是沿用 stub 的数值公式。

若实现需要比较 numeric score，应在目标 Obsidian host 实际调用两个 matcher 和 sort helper，记录版本与输入输出后再下结论。更小的首版可只用平台 matcher 判断是否命中，并由 Piem 定义清晰的笔记级 lexical rank tuple，完全不依赖未声明的分数方向。

### 有没有公开复用内置全文索引/搜索引擎 API

在本轮查阅的 **Obsidian 1.14.4 全部公共类型声明、官方 developer-docs reference 树与 Vault 指南**中，未发现可从插件调用的内置 Search 全库全文 query/index API。公开的 `prepare*Search`、`SearchComponent`、`MarkdownView.showSearch` 分别是单字符串匹配、输入组件、显示编辑器搜索条，不能当作返回全库结果的接口。公共 MetadataCache 确实暴露结构化 metadata 与 resolved/unresolved links，但没有核实的正文全文查询入口。[精确公共声明][obs-types]、[官方 reference 树][obs-doc-tree]

准确措辞是 **“当前核验版本未发现公开、文档化的复用接口”**，不是“Obsidian 不存在内部全文索引”，也不是关于所有未来版本的证明。`app.internalPlugins` 未出现在这里的公共 App 契约中；经它调用内置 Search 私有对象或抓取其 UI/DOM，不适合作为本次官方 API 方案。

## 对当前 Piem 问题的判断边界

以下为本轮读取本地源码确认的静态事实：

- `src/tools/searchTools.ts:25–33, 127` 将 `maxMatches` 默认设为 100；schema 未表达正整数上下界。
- `getSearchableFiles():154–159` 对 `getFiles()` 的 text extension/路径候选调用 `compareFiles`；`src/tools/vaultFiles.ts:45–47` 为 `path.localeCompare`，不是相关性评分。
- `searchTools.ts:130–143` 按该顺序读取，每个文件只收集剩余名额，达到上限即 break；`src/vault/search.ts:28–45` 为匹配行扫描，不是笔记聚合。
- 当前 `count` 是已收集行数，不是全库总匹配数；`truncated: matches.length >= maxMatches` 在恰好只有 100 行且已穷尽时仍为 true，没有通过下一条匹配确认 hasMore。Pi 原版也使用 limit reached 提示，但不能用它证明 Piem 的 total/count 语义正确。
- 当前工具没有分页参数、上下文参数或相关性排序；`formatGrepMatches` 还复用 Pi 的 500 字符行截断，外层 `textResult` 再有字节/行预算。分页必须同时处理“匹配记录预算”和“模型可见文本预算”，不能只扩大 maxMatches。

由此可以判断，用户对**当前默认调用的前缀偏差**的描述属实。没有相关性不是 grep 定义下的实现错误；将其作为“找最相关笔记”的主要检索手段才是能力契约缺口。

### 本地生产模块隔离复现

运行 `bun /var/tmp/piem-grep-primary-51hjv3ln/build-probe.ts`，四组断言全部通过。探针使用 Bun.build 打包当前 checkout 的真实 `src/tools/searchTools.ts`、`src/vault/search.ts`、`src/tools/toolResult.ts` 和 `src/vault/truncate.ts`；仅把不可解析的依赖导入重定向到精确 npm 发布包，把 Obsidian 的 `TFile/TFolder/getFiles/cachedRead` 替换成内存 fixture。Pi 截断函数来自 `pi-coding-agent@1.3.0` / `pi-durable@1.3.0`，后者依赖 `chord@1.3.0`；TypeBox 来自 `typebox@1.4.2`。这是生产逻辑复现，不是重新写一份搜索算法，也不是真实 Obsidian/Vault 烟测。

| 输入 | 实测结果 |
| --- | --- |
| `getFiles()` 故意先列 `Z-relevant.md`，后列 `A-log.md`；A 有 100 行 `needle`，Z 有 1 行 | 实际只调用 `cachedRead(A-log.md)`，返回 100 行，Z 完全未读，`count=100, truncated=true` |
| 只有 `Only.md`，恰好 100 行匹配 | 返回 100 行，仍为 `truncated=true`，证明没有额外命中也会标记截断 |
| 第一组输入指定 `maxMatches=200` | 两文件均读取，返回 101 行，`truncated=false`，证明 100 是可改的默认值 |
| 只有 `Only.md`，100 行，每行是 `needle ` 加 493 个 `中`，未超过 500 字符行上限 | 已收集 `count=100`，实际模型文本仅显示 **34 条**命中，`truncatedBy=bytes, totalLines=102, outputLines=34` |

临时探针和下载包没有写入 checkout；路径可能随后被系统清理。上述输入、输出和断言用于记录本轮证据，不作为已提交的回归测试。实际用户库是否有目标笔记因此漏检、缓存及时性与移动端性能仍未验证。

## 建议一：保留行 grep，补稳定分页与覆盖

这是建议，不是 Pi 或 Obsidian 已提供的分页协议。

1. **保留名称与匹配默认语义。** 继续返回 `path:line: text`，保留 literal / regex、现有大小写默认和 scope。description 明确“精确匹配行，按路径与行号，分页结果不是相关性排名”。`maxMatches` 明确是每页匹配行，限制为受控正整数；offset/cursor 等也在 schema 声明可预知的边界。
2. **首版用无服务端状态的分页。** 最小可用形式是明确零基 `offset`，重新按固定顺序扫描、跳过前 offset 条匹配，再返回一页；无需在插件中保存 opaque search session。页码在 Vault 内容未改变、同一 query/scope/排序契约下稳定，代价是后页重复扫描。若实测后页 I/O 已成为问题，再使用带 query 绑定的 `(path, line)` 续点跳过前面文件；这仍是位置，不需要任务状态机。跨设备/运行稳定排序应有明确比较规则与最终路径 tie-break，不能仅凭默认 locale 假定全环境一致。
3. **真正探测下一条。** 收集页大小之外的第一个匹配用于 hasMore，或者扫描至耗尽；恰好 N 条且已穷尽时 `hasMore=false`。只是达到 N 条又未探测，最多报告“达到上限，剩余未知”。继续位置从最后一个**实际交付**的记录计算。
4. **把覆盖摘要交付给模型。** 最小摘要含实际返回数、hasMore/nextOffset、候选文件数与已读取范围，明确是否已扫描至末尾。若停止在某文件中途，不能把它算成完整检查过；必要时直接给最后检查的 path/line。提前停止时不报告 totalMatches，不把已读取文件数等同完整覆盖。无需为了显示一个 total 强制每页读完整个 Vault。
5. **字节截断不能吃掉续传契约。** 预留摘要/nextOffset 的文本预算，按完整记录选择可见结果；文本预算先耗尽时也要返回可继续的位置。如果收集 100 条而实际输出 30 条，nextOffset 应推进 30，而不是跳过另外 70 条。长行仅展示缩略时另说明“行文本已截断，可 read 定位”，不要与缺失匹配记录混成一个 `truncated` 布尔含义。
6. **变化与失败诚实报告。** 无状态分页没有跨调用一致性快照；文件新增/删除/修改会让 offset 前后页变化。把这一限制写入工具契约，关键操作重新验证命中位置。需要跨变化保证时再增加版本检测，首版不承诺无重无漏。读失败可以按明确既有错误契约终止，或报告部分覆盖与失败路径；不能安静跳过再说全库完成。signal 检查与已有宿主清理机制保留。

上下文行是有用的后续增量，可仿 Pi `context` 并设小上界，但不是消除文件前缀偏差的手段。每文件只返几行、去重成文件路径、随机化/按修改时间排序，都可能提高首屏多样性，却不能建立相关性或完整性保证。

## 建议二：最小笔记级 lexical 检索

另立一个直接、默认可用的 `search_notes` 类工具，description 说明“按文字与元数据匹配排序，无 semantic 推断”。首版接口只需要 query、可选 scope、受控 top-k；是否增加分页由笔记发现的实际需要决定，不把全文搜索产品的每个选项搬进来。

### 数据与顺序

1. 以 `getMarkdownFiles()` 得到范围内的候选。所有候选都经过同一评分流程，**不要先按文件序/metadata 前 100 篇截断再评分**。
2. 使用 `TFile.basename` 作文件标题；`getFileCache(file)` 提供 frontmatter / headings；`parseFrontMatterAliases(cache?.frontmatter ?? null)` 取 aliases；`getAllTags(cache)` 合并标签，cache=null 时安全处理。正文通过 `cachedRead(file)` 按需读取。缺 metadata 的笔记仍有文件标题和正文参与，不把 null 当无相关性。
3. query 首版定义为空白分隔、去重的词项/短语；连续中文可作为一个文字片段，明确不提供中文语义分词、同义词扩展或 Search operators。可对词项与字段统一大小写，再使用 `prepareSimpleSearch(term)` 判断命中，复用公共 matcher；不要猜其未文档化的完整查询语言。多词项跨 title/alias/body 的覆盖由 Piem 自己定义。
4. 每篇只保留一个候选，使用明确 rank tuple：先比较命中的不同 query 词项数量；再比较完整 query 命中文件标题/alias、标题/alias 的词项覆盖、headings/tags 的覆盖、正文覆盖；最后以稳定路径打破平局。字段优先级是本地产品策略，不是 Obsidian 官方权重。重复命中同一个词不能无限加分，防止长日志按重复次数挤掉集中讨论主题的笔记。
5. **所有候选评分完成后**才取 top-k；可只保存固定 k 个最佳候选与小摘要，逐文件释放正文，不需要一次 `Promise.all` 读入全库全部文本。输出路径、标题、命中字段/词项和一小段带定位的证据，再用 read 打开目标笔记。原始 metadata/body 分数只保存 details 会让模型失去排序理由，应把短理由放入 content。

这条路线复用 Obsidian 的解析和读缓存、Pi 的 AgentTool/result/取消契约，新增的是本来就没有公开提供的**笔记级聚合与选择规则**。不需要把自己写的 lexical rank 包装成平台原生 relevance，也不需要先有 embedding 才能让后排路径里的高相关标题出现在首屏。

### 性能和准确性的限度

- 首版按查询扫描，首个未缓存全库正文查询仍需读许多文件；没有公开全文 query API 就不能假装零 I/O。让出事件循环、限制读取并发、按 scope 收窄，复用已有工具 signal 即可。没有实测需求前不另建持久化索引或后台平台。
- 只对 metadata 排 top-k 再读这些正文会再次饿死“正文相关、标题普通”的笔记。若为了速度提供 metadata-only 结果，必须清楚标出检索范围/阶段，不能称完整的正文 top-k。
- lexical 方案不能保证理解自然语言意图、同义词、跨语言关系，也不保证最相关笔记是第一条。它能保证所有成功扫描的候选有相同参与机会、排名规则可解释可重复。
- 缓存更新与读取之间没有事务一致性；cache=null 可暂时缺失 alias/tag/heading 加分。首版说明 snapshot/coverage 边界，正文仍参与。不能凭 mock 数据或模拟 native SearchResult.score 证明实际 Obsidian 排名质量。

## 实施后应验证的最小行为

以下是后续实施的建议验收点；本轮四组探针只验证现有行为，没有验证尚未实现的分页或排名。

- 路径靠前的一篇文件超过 100 条匹配，后面的独立命中能通过续页取到；末页恰好页大小时没有虚假 hasMore。
- 同一未变化 Vault 连续页拼接无重无漏；只有字节预算先耗尽时，续点仍指向第一条未交付记录，coverage 摘要仍可见。
- 精确 regex/literal/case/scope 行 grep 保持既有语义，正整数预算边界明确；取消/读错误不伪装 complete。
- 前面长日志重复同词，最后一篇标题/alias 集中匹配 query 的笔记仍参与 top-k；一篇笔记只占一项。
- 正文独有命中、cache=null、frontmatter string/array aliases、frontmatter 与正文 tags、多词项跨字段、相同评分的稳定路径顺序均符合已声明规则。
- 请求真实进入模型的文本包含页状态/排序理由；仅 details 字段存在不算通过。仅给 AgentTool 增加 promptGuidelines 字段也不算提示策略生效。

本轮完成了发布包/源码对照、公开 API 阅读和上述四组生产模块隔离探针。未执行 Piem 完整 build/lint/tests、真实 Vault 烟测、移动端性能或 native Obsidian score 实验。没有依赖搜索引擎返回的二手文章建立版本事实。

[npm-coding]: https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.3.0
[npm-core]: https://registry.npmjs.org/@earendil-works%2fpi-agent-core/1.3.0
[npm-obs]: https://registry.npmjs.org/obsidian/1.14.4
[tar-coding]: https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.3.0.tgz
[tar-core]: https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-1.3.0.tgz
[tar-obs]: https://registry.npmjs.org/obsidian/-/obsidian-1.14.4.tgz
[pi-tag]: https://api.github.com/repos/earendil-works/pi/git/ref/tags/v1.3.0
[pi-provenance]: https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-coding-agent@1.3.0
[pi-grep]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/tools/grep.ts
[pi-truncate]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/tools/truncate.ts#L11-L13
[pi-agent-types]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/agent/src/types.ts#L423-L487
[pi-agent-loop]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/agent/src/agent-loop.ts
[pi-response]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses-shared.ts#L356-L370
[pi-extension-types]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/types.ts#L579-L589
[pi-wrapper]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
[pi-session]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts
[pi-prompt]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/system-prompt.ts
[obs-types]: https://unpkg.com/obsidian@1.14.4/obsidian.d.ts
[obs-public-head]: https://github.com/obsidianmd/obsidian-api/blob/9abd9605ce081383674aae1ed111c456edde0688/obsidian.d.ts
[obs-doc-tree]: https://github.com/obsidianmd/obsidian-developer-docs/tree/1c26772ac13d6e9870c865936d389fdfe694e742/en/Reference/TypeScript%20API
[obs-vault-doc]: https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/Vault.md
[obs-cache]: https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache/getFileCache
[obs-cached]: https://docs.obsidian.md/Reference/TypeScript+API/Vault/cachedRead
[obs-tags]: https://docs.obsidian.md/Reference/TypeScript+API/getAllTags
[obs-simple]: https://docs.obsidian.md/Reference/TypeScript+API/prepareSimpleSearch
[obs-fuzzy]: https://docs.obsidian.md/Reference/TypeScript+API/prepareFuzzySearch
[obs-score]: https://docs.obsidian.md/Reference/TypeScript+API/SearchResult/score
[obs-sort]: https://docs.obsidian.md/Reference/TypeScript+API/sortSearchResults
