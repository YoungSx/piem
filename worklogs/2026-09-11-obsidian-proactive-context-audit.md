# Obsidian 主动上下文入口调研

日期：2026-09-11。范围：用户主动把文件、文件夹、选区或链接交给 Piem 的入口；本轮只调研。

Piem 核验基线：`2dfe8251bfad6647da0a5cd978f86d8536cc08c6`。**最值得补的是文件夹右键、多选右键、外链右键；另有一个小补充：无选区时的编辑器右键“询问这篇笔记”。** 三种菜单都能使用已有工具，但固定引用的首次打开时序和数量反馈须先补齐。

## 官方 API 与验证边界

本地 `node_modules/obsidian/package.json:3` 为 **1.13.1**，`manifest.json:5` 声明最低 Obsidian **1.13.0**。本地 `obsidian.d.ts` 与官方 [1.13.1 提交][api-131] 的文件逐字相同，SHA-256 为 `250cb2e990a34735b89a209ae9dc31c2f38acadceff1d59803ec94d506e3860b`。另直接读取官方 [1.13.0 提交][api-130]，下表所列入口在这个最低版本中均已存在；本次没有升级依赖。

下表行号均对应本地 `node_modules/obsidian/obsidian.d.ts`，官方链接固定到同一 1.13.1 提交。版本列记录第一方 `@since`，不把类型包版本误当成 API 首次提供的版本。

| 入口 | 官方提供的上下文与用途 | 版本及本地证据 | 本次判断边界 |
| --- | --- | --- | --- |
| `file-menu` | 回调为 `(menu, file: TAbstractFile, source: string, leaf?)`；`TAbstractFile` 可以是 `TFile` 或 `TFolder` | 0.9.12；[8104–8109 行][file-menu]、[6932–6957 行][abstract-file] | 是文件/文件夹菜单能力的公开契约。**没有 `subpath` 参数**；`source` 没有公开枚举，不能据此声称搜索、反链、书签、内部链接等界面都已覆盖 |
| `files-menu` | `(menu, files: TAbstractFile[], source: string, leaf?)`；注释明确为 File Explorer 多选后打开右键菜单 | 1.4.10；[8110–8115 行][files-menu] | 最直接的批量上下文入口。类型接受文件夹，但混合文件/文件夹选择、各平台具体菜单行为仍须真实点击验证 |
| `url-menu` | `(menu, url: string)`；外部 URL 的右键菜单 | 1.5.1；[8117–8122 行][url-menu] | 适合“询问此链接”。API 只交付 URL，不负责读取网页、限制协议、处理下载或加入 Piem 会话；也不承诺所有插件自绘链接都触发 |
| `editor-menu` | `(menu, editor, info: MarkdownView \| MarkdownFileInfo)`；选区可从 `Editor` 读取 | 1.1.0；[8123–8128 行][editor-menu]，`getSelection/getRange/listSelections` 为 0.11.11，见 [2446–2480 行][editor-selection] | 适合选中文本后提问；多选区是已有 `Editor` 方法的用法，不是另一个菜单事件。`info.file` 可为 null（3962 行） |
| `editor-paste` / `editor-drop` | 编辑器收到 `ClipboardEvent` / `DragEvent`，同时带 `Editor` 与文件信息 | 1.1.0；[8136–8151 行][editor-input] | 作用域是 Obsidian 编辑器；不能据此推断 Piem 自绘输入框会收到事件。处理前尊重 `defaultPrevented`，只在实际接管后 `preventDefault()` |
| `registerObsidianProtocolHandler` | 处理 `obsidian://<action>?...`，收到解码后的键值参数 | 0.11.0；[5020–5028 行][protocol]，参数类型 4741–4751 行 | 可作为外部应用、链接或自动化把路径/问题交给 Piem 的入口；没有现成 Piem 会话或发送函数不代表 API 不可行。参数及会话行为仍需产品定义 |
| `registerCliHandler` | 注册 CLI 命令；回调接收键值参数并返回 `string \| Promise<string>`，命令 ID 须全局唯一 | 1.12.2；[5035–5048 行][cli]、[1593–1640 行][cli-types] | 可用于外部自动化。最低 API 版本已满足，但用户仍须具备 CLI 安装和运行条件，详见下文；本轮没有 CLI 实机调用 |
| `registerHoverLinkSource` / `hover-link` | 把插件视图注册为 Page preview 的悬停事件来源；`defaultMod` 控制是否要求修饰键 | 1.1.0；[4975–4980 行][hover]、[3443–3457 行][hover-type] | 是预览集成，不是把内容交给模型的现成动作。公开类型没有 `Workspace.on('hover-link', ...)` 专用负载契约；通用 `Events.on/trigger` 可接受字符串，不等于任意事件负载已受官方保证 |
| `registerEditorSuggest` | 用户打字时提供建议；`onTrigger` 取得光标、编辑器与文件，可由用户选定某项后发起操作 | 注册方法标 0.12.7；类标 0.12.17，当前 `onTrigger` 标 1.1.13；[5030–5034 行][editor-suggest-register]、[2685–2731 行][editor-suggest] | 可行，但需要设计编辑器内的触发语法和接受动作，不属于漏接的右键菜单。类型标注不足以断定整套现用签名的最早可用组合；1.13.0 中已核实存在 |
| `registerMarkdownPostProcessor` / `registerMarkdownCodeBlockProcessor` | 接收渲染段落或指定代码块，可以插入自定义控件；上下文含 `sourcePath`，`getSectionInfo()` 可返回 null | 注册方法均标 0.9.7；[4986–5001 行][markdown-register]、[3996–4023 行][markdown-context] | 渲染本身是被动过程；若添加明确按钮，按钮才是主动入口。适合“询问此段/运行此提示”，需要维护渲染生命周期与重复渲染，不能直接按 API 存在算成现成菜单 |
| `addRibbonIcon` / `addCommand` | Ribbon 点击只给鼠标事件；命令可使用全局回调或 `editorCallback/editorCheckCallback` 获得编辑器 | 注册方法均为 0.9.7；[4930–4955 行][commands]，编辑器回调为 0.12.2，见 [1776–1821 行][editor-command] | 都是主动入口，但 Ribbon 不自动附带文件；命令可承载当前笔记/选区操作。是否已有合适命令须看 Piem 源码 |
| `css-change` | 应用 CSS 变化通知，没有文件或用户选区参数 | 0.9.7；[8097–8102 行][css-change] | 与主题/样式刷新有关，**不属于主动上下文入口**；是否漏接不能直接升级成当前任务的功能缺口 |

### 不能从公开签名推出的结论

- **`file-menu` 没有携带标题/块位置。** 第一方同时提供 `parseLinktext()`（4792–4807 行）拆分路径与 `subpath`，以及 `resolveSubpath()`（5496–5500 行）解析标题/块/脚注引用，但前提是调用方已经拥有原始链接。二者没有 `@since`，最低引入版本本次未核实；在 1.13.0 文件中已确认存在。[链接拆分][parse-link]、[子路径解析][resolve-subpath]
- **`handleLinkContextMenu()` 是填充链接菜单的方法，不是额外的链接上下文订阅。** 它接收 `linktext/sourcePath`（8045–8050 行，0.12.10），也不能让 `file-menu` 自动多出 `subpath`。具体内部链接菜单如何转发，仍需真实 Obsidian 行为证据。[官方契约][link-menu-helper]
- **没有核实到公开的 Explorer 选择集合 getter，或把内部拖放直接解包为 `TFile[]` 的辅助函数。** 检索完整本地公开类型中的 `FileExplorer`、`getSelectedFiles/selectedFiles`、`dragManager`、`DataTransfer` 等未发现相应契约；`files-menu` 是有明确选中对象数组的入口。`getLeavesOfType()` 返回通用 `WorkspaceLeaf[]`，不授权依赖 Explorer 内部字段；DOM 拖放事件的存在也不保证内部拖放载荷格式。[公开 Workspace 契约][workspace]、[公开事件契约][editor-input]
- **菜单覆盖要按界面实测。** 官方 [Context menus 指南][context-guide] 演示 `file-menu/editor-menu` 注册，但没有承诺 Explorer、搜索、反链、书签、标签页、内部链接的完整覆盖矩阵。文件菜单的 `source: string` 与可选 `leaf` 也不提供这种证明。

### CLI 的实际边界

`registerCliHandler` 已在最低支持版本内；这只解决插件注册接口。第一方 [CLI 使用说明][cli-help] 还要求用户更新安装器（安装步骤写 1.12.7+）、在 **Settings → General → Command line interface** 启用并注册 CLI，且依赖 Obsidian 应用运行；未运行时，首次命令会启动应用。说明书将无桌面应用的 Headless Sync 单列为其他产品。因此，CLI 是桌面应用的外部自动化入口，不能仅因 `manifest.minAppVersion` 已满足就称随处即用，也没有在本轮证明移动端 CLI 可用。

官方 CLI 还能调用插件已注册的普通命令；自定义 handler 的增量是自定义参数与文本返回，是否值得新增应看实际自动化需求，而不是为凑齐 API 清单。[CLI 普通命令说明][cli-existing-commands]

本轮只读取本地类型、最低版本第一方源码及官方文档；没有启动 Obsidian、安装依赖、运行构建、发起模型请求或产生常驻进程。接口存在、Piem 当前接线状态、实际界面触发与最终模型行为，是四种不同的证据；本部分只证明第一种。

## 当前 Piem 源码与综合判断

### 已经接入什么

- **单文件右键**：`main.ts:521` 订阅 `file-menu`，`fileMenuEntry.ts:26` 只接受 `TFile`，点击后经 `askPiemAboutFile()` 固定路径并打开面板。它没有按 `source` 过滤；这证明回调收到文件就处理，不证明所有 Obsidian 界面都会触发这个事件。[注册与过滤][piem-menus]、[目标判断][piem-file-target]、[点击路径][piem-ask-file]
- **编辑器选区右键**：`main.ts:501–503` 已订阅 `editor-menu`，没有文件或没有非空选区就不加菜单项。选区会连同笔记路径、可用时的行号预填入草稿，超过 2,000 个 Unicode 码点会截断并提示。[菜单][piem-menus]、[选区收集][piem-note-command]、[预填格式][piem-note-reference]
- **命令和 Ribbon**：已有 `ask-about-selection`、`ask-about-note`，后者显式传 `selectionOnly: false`；Ribbon 打开聊天。[命令注册][piem-commands]
- **自动跟随上下文**：已有 `active-leaf-change`、`file-open`，并跟踪 Vault 的重命名和删除；它们维护当前笔记和固定路径，属于已接入的自动上下文。[监听][piem-active-watch]
- **输入框图片粘贴/拖放**：`ChatComposer` 有自己的 DOM 处理器，实际只取 `DataTransfer.files` 中的图片。`handleDrop` 一律 `preventDefault()`，所以注释所写“笔记拖入落到原生处理”不成立，不能将它计为已完成的笔记拖入上下文。[实际处理][piem-composer-drop]

本轮检索整个 `src/` 的生产调用，没有找到 `files-menu`、`url-menu`、`editor-paste/drop`、`registerObsidianProtocolHandler`、`registerCliHandler`、`registerEditorSuggest`、Markdown processor 或 `registerHoverLinkSource` 的接入。测试替身、注释中的名字未算成生产接入。

### 建议顺序：三个主入口和一个小补充

| 顺序 | 用户动作与目前缺口 | 最小可行接法 | 必须说清的边界 |
| --- | --- | --- | --- |
| 1 | **右键文件夹 → 询问 Piem**。已有事件，却被 `TFile` 过滤排除 | 复用 `file-menu`，识别 `TFolder`；将明确标为“文件夹”的 Vault 相对路径追加到草稿。模型已有 `ls` 列目录、`grep` 按目录搜索；`find` 可按完整路径模式找文件 | 无需新增目录工具、递归读取整目录或扫描全库。文件夹不要伪装成“固定笔记”；第一次打开面板时仍要等会话/草稿归属就绪 |
| 2 | **多选文件 → 一次询问 Piem**。`files-menu` 完全未接 | 新增一个事件回调，处理返回的对象数组。若使用现有固定引用，批量加入并显示实际加入、重复、超额数量；也可把一次性路径清单预填入草稿 | 8 个是现有“长期固定”预算，不是 Obsidian 多选限制。须处理已有固定项、重复、文件夹混选；不能悄悄只保留前 8 个，却表现成整批已加入 |
| 3 | **右键外部链接 → 询问 Piem**。`url-menu` 完全未接 | 添加事件回调，将 URL 作为“外部链接”预填；已有无开关的 `web_fetch` 可以在用户提问后请求网页 | 菜单应只接纳可抓取的 HTTP/HTTPS 链接；打开菜单本身不请求网页。当前工具返回响应文本，不保证登录页、动态网页、PDF 都能读懂；URL 不进入 Vault 文件引用 |
| 小补充 | **没有选区时，右键询问整篇笔记**。当前直接隐藏 Piem 菜单项 | 已有 `editor-menu` 按有无选区切换文案和请求，复用 `ask-about-note` 的 `selectionOnly: false` 路径 | 这是补齐已接 API 的行为，不是新增 API。没有文件时仍不提供无目标动作 |

支撑前三项的工具均已注册：`createObsidianTools()` 直接注册 `ls`、`find`、`grep`、`read`、`write`、`edit` 和 `web_fetch`。[实际工具注册][piem-tools]。`ls` 使用 `getFolderByPath()`/根目录的 `children`；`grep` 的 `path` 接受文件或文件夹；`find` 的 `pattern` 匹配完整 Vault 相对路径。[目录工具][piem-search]。`web_fetch` 返回 HTTP 状态和响应文本，显示上限为 50KB，未使用 Range 时仍可能完整下载响应；本轮没有发起真实网页或模型调用。[网页工具][piem-web-fetch]

现有 `deliverReference()` 会打开面板，再预填并聚焦；`ChatInputController` 能等待 React 处理器挂载，`appendToDraft()` 会保留已有草稿。这些可以复用，但**等待组件挂载与等待会话/草稿就绪不是同一件事**，不能据此直接承诺冷启动安全。[投递入口][piem-deliver]、[控制器][piem-input-controller]、[草稿归属][piem-session-draft]、[预填绑定][piem-prefill]

### 先补齐的现有缺口

**1. 首次打开时，单文件菜单就可能丢掉固定请求。**

`askPiemAboutFile()` 先执行 `service.pinContextRef(path)`，再 `activateChatView()`；实际固定逻辑先查 `current()`，没有 `currentPath`/runtime 立即返回。聊天组件挂载之后才从 effect 调用 `service.initialize()`。因此，面板尚未初始化的路径上，固定操作发生得太早；面板后来打开并不会重试它。[调用次序][piem-ask-file]、[当前 runtime][piem-current]、[固定实现][piem-pin]、[初始化入口][piem-chat-init]

`main.ts:732–738` 注释仍称固定引用归服务所有、无需等会话，已经与实现不符。`ObsidianAgentService.test.ts:1461–1463` 也明确记录初始化前固定是 no-op。菜单测试用一个总能收下路径的服务替身，因此不能证明真实服务的冷启动行为。[相关测试][piem-service-test]、[菜单测试替身][piem-file-test]

本轮用已安装的 TypeScript compiler API 抽取当前 `askPiemAboutFile/current/pinContextRef/contextRefList` 方法，去掉类型后在 Node VM 中直接执行；只替换面板初始化、runtime 和通知等外围协作者，没有重写待验证的方法体。结果如下，进程退出码为 0：

| 源码探针情形 | 实际观察 |
| --- | --- |
| 无当前会话，面板激活时模拟建立 runtime，然后首次询问文件 | 面板打开 1 次、聚焦 1 次，固定数组仍为空 |
| 同一服务已存在 runtime，再询问另一个文件 | 该文件进入固定数组 |
| 空固定数组连续加入 20 个不同路径 | 只有 8 个进入数组，`contextRefList()` 同样返回 8 个，每次调用返回 `undefined` |

这是**源码隔离探针**，没有启动真实 Obsidian；它证明调用顺序及预算分支，不证明各界面具体如何触发菜单。后续实现宜将会话就绪和请求交付放到同一个共享路径，避免单文件和多选分别出错。

**2. 多选不能直接把旧的 boolean 返回值拿来用。**

`ContextRefs.pin()` 虽然返回 boolean，但该类的实例化目前只出现在测试中；运行时使用 `SessionRuntime.pinnedNotes`，`ObsidianAgentService.pinContextRef()` 返回 `void`、满 8 个静默返回。上一轮把前者直接当成现有服务契约不准确。[纯类][piem-refs]、[实际固定实现][piem-pin]

也不能反过来说“必须改返回签名才能计数”：可以通过公开快照比较前后固定路径。批量结果由服务统一提供通常更直接，但这属于实现选择；需要的是可靠的反馈，不是指定一种签名。当前引用文案写 `Pinned note`，点击又经 `getFileByPath()` 打开，所以现有模型不能直接承载文件夹或外部 URL。[快照构造][piem-ref-list]、[模型中的文案][piem-context-render]、[引用点击][piem-context-open]

**3. 即时编辑内容另有风险，尚未做实机复现。**

活动正文注入和 `get_active_note(includeContent)` 都使用 `vault.cachedRead()`，没有读取 `editor.getValue()`。这不能保证与尚未保存的编辑器缓冲完全相同；也不能仅凭源码就声称必然落后“两秒”。官方 `cachedRead()` 契约是文件缓存读取，`Editor.getValue()` 才直接取得编辑器内容。[注入读取][piem-read-active]、[工具读取][piem-active-tool]、[Vault 契约][cached-read]、[Editor 契约][editor-value]

已有 `resolveWorkingEditor()` 展示了编辑器解析办法，但它是 `messageActions.ts` 的私有函数，并且追随当前活动文件。若用于一次运行中冻结的笔记路径，必须按目标路径匹配，避免用户切换笔记后读错内容；不能照搬成“改三行就完”。优先调查直接读取 live editor 的路径，不为此先引入 `quick-preview` 加缓存。[现有解析][piem-working-editor]

### 其他入口：可行性与本次优先级

| 入口 | 当前判断 |
| --- | --- |
| **Obsidian URI** | 可做“从其他应用把路径、选区或问题带到 Piem”。普通 Vault 路径加预填文本即可有用，不要求先暴露会话 ID；“尚无发送方”只是尚无功能，不能证明 API 无价值。排在三种菜单后，等有明确跨应用流程再做；复用同一交付路径并验证目标 Vault/路径 |
| **CLI handler** | 可做脚本传路径/问题、查询或返回结果；普通已注册命令本就能从 CLI 调用。只有需要额外参数或文本返回时，自定义 handler 才有明显增量。本次不把它列成移动端通用入口 |
| **EditorSuggest** | 可通过显式触发词出现“把此处交给 Piem”的建议；选择后打开现有面板即可，不要求新增无界面的模型会话。`selectSuggestion()` 返回 void 不等于无法发起异步动作。但需要与现有编辑器补全协调，优先级低于原生菜单 |
| **Markdown processor** | 可以给阅读视图段落或显式代码块增加“询问”按钮；点击后走预填即可。无需一渲染就调模型，也无需自动把答案写回笔记。渲染本身不是主动意图，不能自动运行；源码中还已有 `write/edit`，上一轮“缺少一切正文写入能力”的依据也不成立。适合有明确段落/提示块需求时再做 |
| **悬停预览** | `registerHoverLinkSource` 可用于聊天内笔记链接的原生预览，但它不是模型上下文的接收器。悬停时自动提问不属于本次建议；没有内容提供回调也不代表预览集成本身毫无用途 |
| **编辑器 paste/drop** | API 可用，但触发点在笔记编辑器；接管每次粘贴/拖入并不等于用户要问 Piem。若以后实现“拖到聊天里作为上下文”，应研究聊天自己的 drop 目标和真实载荷，不能注册 workspace `editor-drop` 就称完成 |
| **`quick-preview/layout-change/window-open/window-close/css-change`、状态栏** | 前几项是被动维护事件，状态栏是额外界面，不提供所选文件/选区。当前已有跟随笔记监听；跨窗口组件已在使用 `onWindowMigrated`。它们不列入这次缺失的主动入口清单，出现具体功能需求时再评估 |

标题/块链接、阅读视图的选区、Canvas 节点、PDF 页码/选区、搜索结果集合，均不能从 `file-menu` 的一个文件路径推成已支持。尤其文件菜单没有 `subpath`；本轮未核实到相应的专用公开菜单负载，先保留为独立调研项，不依赖私有 `dragManager` 或 Explorer 字段作承诺。

### 对前轮异常输出的核验

核读原始 JSONL 后发现，`agent-ae87fd01d02941383.jsonl` 的第 **72 行**是一条 `type: assistant` / `role: assistant` / `content.type: text` 记录，其中自行包含两段 `Tool results: [Bash]` 文本，并声称读到了 `theme-dark` 和 `buildEnvironmentPrompt()`。它不是带有对应 `tool_use_id` 的工具返回。第 76 行的结构化报告又引用了这段文字并称其为注入；那也是报告自己的判断，不能反过来充当来源鉴定。

本轮重新读取真实 `environmentPrompt.ts`、`contextProbe.ts`，并检索整个 `src/`：没有上述主题读取或 `buildEnvironmentPrompt` 函数；环境事实只有 Vault 名称、应用版本、平台及语言。因而“系统提示缓存了主题，需要接 `css-change`”这条具体线索不成立。[真实环境事实][piem-environment]、[实际读取][piem-environment-probe]

证据足以剔除那两段假工具结果，**不足以判断其文字究竟是模型自行生成、上游转写还是外部插入**。文本中自称“安全测试”的提醒也没有更高权威；未据此执行操作。前轮文件夹验证节点还记录过流中断失败，所以不能沿用“所有验证员均已完成”的说法；本轮结论改以当前源码和第一方契约为依据。

原始记录仅用于核验这次报告来源，不是 Obsidian API 的证据：

- `/home/ubuntu/.claude/projects/-home-ubuntu--paseo-worktrees-12wur2jj-normal-kangaroo/4dced2c4-d356-47a6-8b9f-125c4c3ac30a/subagents/workflows/wf_d456652e-6c5/agent-ae87fd01d02941383.jsonl`，第 72、76 行。
- `/tmp/claude-1001/-home-ubuntu--paseo-worktrees-12wur2jj-normal-kangaroo/4dced2c4-d356-47a6-8b9f-125c4c3ac30a/tasks/wsjoyjraq.output`，文件夹验证节点状态与综合输出；临时文件可能被清理。

### 本轮验证与实施验收边界

- 已完成：当前源码调用链、生产接入检索、第一方固定版本类型比对、源码隔离探针、报告引用核查。只有本调研文档新增，未改产品代码、依赖或配置。
- 未完成的运行验证：尝试 `timeout 40s bun test src/fileMenuEntry.test.ts`，返回退出码 **127**，因为当前 PATH 无 `bun`，现存 `bunx` 还指向缺失的 `/home/ubuntu/.bun/bin/bun`。因此**项目测试未运行**，不以旧代理测试或纯类测试代替。没有为只读调研安装运行时或跑全量构建。
- 尚未验证：真实 Obsidian 首次打开、会话切换/草稿载入期间点击；有 0/7/8 个固定项时多选；重复文件、文件夹混选和不支持的文件类型；手机长按及搜索、反链、书签、内部链接菜单覆盖；真实网页抓取与模型是否正确使用目标。
- 后续实现宜先修共享交付路径，再完成三种菜单及无选区补充。验收应同时看到菜单、草稿或引用中的明确目标、最终请求中的同一目标；输入框已有草稿不能丢失，超额或不支持的目标不能静默消失。实现阶段另按仓库要求完成测试、无冲突 PR 和当前提交的绿色 CI。

## 补查：Pi 官方的信息包装（2026-09-12）

按项目锁定的 `@earendil-works/pi-agent-core` / `pi-coding-agent` **0.84.3** 核验，npm 元信息的 `gitHead` 均为 `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`；已直接读取该官方提交。

- **技能**：`formatSkillInvocation()` 输出 `<skill name="…" location="…">…</skill>`，后面可以追加用户问题。Piem 已通过 `parseSkillInvocation()` / `SkillInvocationPill` 折叠显示它。[官方格式](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/skills.ts#L38-L41)
- **文件**：CLI 的 `@file` 处理器输出 `<file name="绝对路径">\n文件正文\n</file>`。图片另用 `ImageContent` 传字节，标签只放路径及处理提示。这是 CLI 附件的实际格式，不是已定义完整目录/网址/选区语义的通用协议；不能把空标签当成文件正文已经送达。[官方处理器](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/coding-agent/src/cli/file-processor.ts#L51-L79)
- **通用上下文与自定义展示**：`CustomMessage` 提供 `role: "custom"`、自定义 `customType`、`content`、`display`、`details`、`timestamp`。官方 `convertToLlm()` 将 `content` 转成 user message，不发送 `details` 或 `customType`。`display: false` 仍参与模型上下文。一次纯函数探针已验证这三个行为。[官方类型和转换](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/messages.ts#L31-L38)
- **渲染扩展点**：`pi.registerMessageRenderer(customType, renderer)` 可用 metadata 渲染自定义消息，但返回的是终端 `Component`。`pi.appendEntry()` 加 `registerEntryRenderer()` 则适合持久化的界面专用内容，不参与模型上下文。[官方说明](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/coding-agent/docs/extensions.md#L1398-L1419)、[官方 renderer 示例](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/coding-agent/examples/extensions/message-renderer.ts)

如果后续把所选文件、目录、网址显示成可点击的结构化附件，官方 `CustomMessage` 的 `content/details` 分工适合复用；`customType` 名称和 `details` 内的引用 schema 仍由 Piem 定义。需要同时处理发送前的草稿附件和发送后的消息渲染、持久化及重放，不是换一层标签即完成。上述为调研时的实现快照。后续按用户选择已实现 Piem 自有引用类型的原生 `CustomMessage` 卡片，见 [实现与验证记录](2026-09-12-proactive-context-implementation.md)。第三方 `registerMessageRenderer` 仍是终端组件接口，未在本次实现通用 React 消息桥。

## 固定来源

- Obsidian API 1.13.1：`28a6b8607927249cb549ab3053f5f36f9287aab8`，与本地 d.ts 逐字一致。
- Obsidian API 1.13.0：`3b873bb77d206ed9dc6354df322b3aa2c662b23d`，用于核实当前最低版本已有所列契约。
- Obsidian developer docs：`c56c7e770ba25dd0ea392aacf4588f9425970d36`。
- Obsidian Help CLI：`0c95e6c2dc1f76ac429cce8b37e4937a81980b69`。

[api-131]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts
[api-130]: https://github.com/obsidianmd/obsidian-api/blob/3b873bb77d206ed9dc6354df322b3aa2c662b23d/obsidian.d.ts
[file-menu]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8104-L8109
[abstract-file]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L6932-L6957
[files-menu]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8110-L8115
[url-menu]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8117-L8122
[editor-menu]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8123-L8128
[editor-selection]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L2446-L2480
[editor-input]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8136-L8151
[protocol]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L5020-L5028
[cli]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L5035-L5048
[cli-types]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L1593-L1640
[hover]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L4975-L4980
[hover-type]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L3443-L3457
[editor-suggest-register]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L5030-L5034
[editor-suggest]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L2685-L2731
[markdown-register]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L4986-L5001
[markdown-context]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L3996-L4023
[commands]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L4930-L4955
[editor-command]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L1776-L1821
[css-change]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8097-L8102
[parse-link]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L4792-L4807
[resolve-subpath]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L5496-L5500
[link-menu-helper]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L8045-L8050
[workspace]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L7741-L8164
[context-guide]: https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Plugins/User%20interface/Context%20menus.md#L42-L80
[cli-help]: https://github.com/obsidianmd/obsidian-help/blob/0c95e6c2dc1f76ac429cce8b37e4937a81980b69/en/Extending%20Obsidian/Obsidian%20CLI.md#L11-L33
[cli-existing-commands]: https://github.com/obsidianmd/obsidian-help/blob/0c95e6c2dc1f76ac429cce8b37e4937a81980b69/en/Extending%20Obsidian/Obsidian%20CLI.md#L261-L286
[piem-menus]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/main.ts#L500-L529
[piem-file-target]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/fileMenuEntry.ts#L16-L54
[piem-ask-file]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/main.ts#L725-L755
[piem-note-command]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/noteReferenceCommand.ts#L12-L42
[piem-note-reference]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/noteReference.ts#L1-L74
[piem-commands]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/main.ts#L483-L499
[piem-active-watch]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/activeNoteWatch.ts#L16-L47
[piem-composer-drop]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/ChatComposer.tsx#L277-L310
[piem-tools]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/tools/obsidianTools.ts#L79-L122
[piem-search]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/tools/searchTools.ts#L11-L132
[piem-web-fetch]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/tools/webFetchTools.ts#L38-L125
[piem-deliver]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/main.ts#L757-L764
[piem-input-controller]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/ChatInputController.ts#L1-L98
[piem-session-draft]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/useSessionDraft.ts#L31-L140
[piem-prefill]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/ChatApp.tsx#L702-L717
[piem-current]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/ObsidianAgentService.ts#L966-L969
[piem-pin]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/ObsidianAgentService.ts#L3900-L3908
[piem-chat-init]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/ChatApp.tsx#L188-L200
[piem-service-test]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/ObsidianAgentService.test.ts#L1450-L1475
[piem-file-test]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/fileMenuEntry.test.ts#L60-L112
[piem-refs]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/contextRefs.ts#L31-L119
[piem-ref-list]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/ObsidianAgentService.ts#L3975-L3998
[piem-context-render]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/contextInjection.ts#L329-L339
[piem-context-open]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/ChatApp.tsx#L884-L900
[piem-read-active]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/ObsidianAgentService.ts#L4109-L4132
[piem-active-tool]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/tools/noteTools.ts#L12-L48
[piem-working-editor]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/ui/messageActions.ts#L78-L111
[piem-environment]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/environmentPrompt.ts#L43-L104
[piem-environment-probe]: https://github.com/YoungSx/piem/blob/2dfe8251bfad6647da0a5cd978f86d8536cc08c6/src/agent/contextProbe.ts#L26-L50
[cached-read]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L7405-L7420
[editor-value]: https://github.com/obsidianmd/obsidian-api/blob/28a6b8607927249cb549ab3053f5f36f9287aab8/obsidian.d.ts#L2415-L2420
