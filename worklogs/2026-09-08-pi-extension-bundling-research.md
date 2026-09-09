# 直接引用 Pi 官方库：选定扩展的内置可行性与开发方案

2026-09-08 取证，2026-09-09 整理交付 · 调研快照，尚未实现扩展接入。

## 结论

**直接依赖官方原版库是开发方向。Pi 的核心能力已经适合这样使用；现有 `ExtensionAPI` 扩展宿主的拆分还不足以直接放进 Piem 的跨平台包。** 最新版另外发布了独立的 Chord 组合运行库，实际可按需打包，但它运行的是新的 `Facet` 协议，不能代替旧扩展宿主。[核心入口][core-index] [扩展入口][coding-index] [Chord][chord-readme]

Piem 应继续由官方库负责工具执行、会话和扩展生命周期，只编写 Obsidian 的文件、界面、网络和事件接线。选定扩展也从固定版本的依赖包直接引用，保留原实现。本文不把复制示例、重写扩展、实现一个兼容 `ExtensionAPI` 的自有运行器列为开发路线。

具体判断：

- **可以立即继续复用：** 已在用的官方 `Agent`、原生文件工具、技能加载和会话 API；需要时单独评估新的公开子入口。
- **可以直接引用，但解决另一层问题：** Chord 的静态加载、服务依赖装配、启动/卸载。它适合本身采用 Facet 协议的插件。
- **已有公开 API，但跨平台嵌入尚未打通：** `pi-coding-agent` 的 `DefaultResourceLoader`、`ExtensionRunner`、`wrapRegisteredTools`。普通 Node SDK 支持原版扩展；Piem 的单文件加载方式、手机环境和现有会话实现还需要合适的官方边界。
- **建议下一步：** 优先补齐官方静态扩展入口，再以一项原版扩展完成 Piem 接线。若先验证桌面，单独验收原版 SDK 的打包与宿主桥接，不把“桌面有 Node”当成已经能装入 Obsidian。

## 核对范围与证据等级

| 对象 | 本次核对 |
| --- | --- |
| Piem | 默认分支 `ba21b37c73115da53eb3821692b4dff7348689f4`；锁文件与安装包中的 `pi-agent-core` / `pi-ai` 均为 **0.84.3**。 |
| 已用 Pi 版本 | 官方 tag `v0.84.3`，commit `4e58f324fae8ebfa98a3d45181fb248072a2afac`。读取源码，并下载对应 coding-agent npm 包核对实际导出。 |
| 最新发布版 | npm 现场查询为 **0.85.1**，`gitHead` 为 `d981de1229ef899957bbe968bc8dcda02a21f477`；核对 coding-agent、core、Chord 的真实 tarball。 |
| 上游主分支 | 现场 HEAD `6160683a4a8012f0d1cd30c145df18b4ca6f5176`；核对三个 package.json，本文关心的扩展入口缺口仍存在。没有把主分支当作已发布 SDK。 |

tarball 均比对 registry 的 `dist.shasum`，只解包文本到临时目录，未安装依赖或运行安装脚本。固定包元数据见 [coding-agent][npm-coding]、[core][npm-core]、[Chord][npm-chord]；主分支快照见 [coding-agent package][main-coding]、[core package][main-core]、[Chord package][main-chord]。

证据分开计算：发布物/源码能说明入口与依赖；打包探针能说明指定入口的解析和产物；运行探针只能说明所执行路径。它们都不能代替 Obsidian 和 iOS/Android 真机验收。

## 1. 官方库拆到了什么程度

以下子路径均相对于表中包名。版本不能混用：新版本的会话接口已经变化。

| 官方包/入口 | 现成职责 | 拆分与使用判断 |
| --- | --- | --- |
| `@earendil-works/pi-agent-core` 根入口 | `Agent`、`AgentHarness`、文件工具工厂、技能/模板、会话等 | Piem 已直接使用。具备注入执行环境、工具、传输的边界；`AgentHarness` 的 hooks/resources 不等于旧 `ExtensionAPI`。 |
| core `./node` | `NodeExecutionEnv` 等 Node 能力 | 已由 Piem 的用户技能桥延迟初始化。不能把它交给手机或用作越过 Vault 的模型工具。 |
| core `./harness/context`、`./harness/session`、`./harness/runtime/reducer` | 取消/调用上下文、会话、界面快照归约 | **0.85.1 相比现用版本多出的细入口**；官方文件存在，可以直接依赖。它们没有导出旧扩展注册器/运行器。 |
| core `./harness/env/nodejs`、`./harness/session/testing` | 更窄的 Node 环境、会话一致性测试 | 新入口有利于按需依赖；测试入口从现用版本的 `./session/testing` 发生变化。 |
| `@earendil-works/pi-ai` 根及 `./api/*` | 模型、传输及 API 实现 | Piem 已直接使用。加载器给旧扩展的 `pi-ai` 根会别名到 `pi-ai/compat`，普通静态 import 不自动享有此兼容行为。 |
| `@earendil-works/pi-coding-agent` 根入口 | `createAgentSession`、`DefaultResourceLoader`、`ExtensionRunner`、`createExtensionRuntime`、`wrapRegisteredTools` | **官方公开且已发布**，但根还导出 CLI、TUI；不能仅凭一个 named import 断言其他部分都能裁掉。 |
| coding-agent 内部 `loadExtensionFromFactory` / `loadExtensions` | 原版工厂初始化、动态扩展加载 | 发布包包含实现，内部 barrel 有导出；**包根没有再导出，也没有对应 public subpath**。 |
| coding-agent `./experimental/plugin` | 新架构的 Pi 服务契约 | **当前 npm 不可用**：只有 `source` condition，tarball 同时缺 `src/experimental/plugin.ts` 和对应 dist。 |
| `@earendil-works/chord` 根入口 | `createFacetHost`、`createStaticFacetLoader`、`defineFacet`、`defineService` | 官方团队在 Pi monorepo 开发的独立通用库；没有 Pi workspace 依赖。可直接使用完整原版生命周期，协议是 Facet。 |
| Chord `./context`、`./delta`、`./node`、`./bundler` | 上下文、状态差分、Node 加载、构建工具 | Node/构建入口独立；根包 `sideEffects: false`。`esbuild` 仍是安装依赖，**安装体积与运行时 bundle 体积要分开量**。 |

来源：[core 发布配置][core-package] [core 入口][core-index] [coding-agent 发布配置][coding-package] [根导出][coding-index] [内部导出][extension-index] [加载实现][loader] [Chord 发布配置][chord-package] [Chord API][chord-api]。

Piem 已经采用的原版复用方式，可作为新接线的标准：

```ts
import { Agent, createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
```

文件读写调用原版工具，`harnessAdapter` 只注入 `VaultExecutionEnv`。用户目录技能调用原版 `NodeExecutionEnv`，宿主桥只限制这条路径需要的能力、控制加载及回收。[工具装配](../src/tools/obsidianTools.ts) [参数桥](../src/vault/harnessAdapter.ts) [Node 桥](../src/skills/nodeSkillsEnv.ts) [延迟入口](../src/skills/nodeSkillsHost.ts)

## 2. 原版扩展接入卡在哪里

### 工厂可以静态提供，官方宿主仍有 Node 依赖

官方 SDK 确实支持 `new DefaultResourceLoader({ cwd, agentDir, extensionFactories })`。这允许把选定工厂在构建时打进包，由原版 loader 初始化，不必在用户设备上扫描并编译 `.ts`。[SDK][sdk-extensions] [ResourceLoader][resource-loader]

但目前不是一条独立的静态加载链：

- `createExtensionRuntime`、注册 API、`loadExtensionFromFactory` 与 jiti/磁盘发现同在 `loader.ts`；顶层有 Node 模块、TUI、兼容提供商入口，以及反向引用 coding-agent 根入口。
- `DefaultResourceLoader.reload()` 即使收到 factories，仍先 reload settings、resolve packages/resources。`noExtensions` 等选项不是“不初始化文件/包加载层”。
- `ExtensionRunner` 引用真实终端 theme；theme 又依赖 fs/config。`config` 顶层使用 `import.meta.url`，还读取包元数据。延迟调用不能自动消除这些初始化要求。
- Runner 的构造参数是 coding-agent 的 `SessionManager`、`ModelRegistry`。Piem 目前用的是 core 的异步 Session，两者既不是同一个对象，也不是同一种会话契约。

来源：[loader][loader] [resource loader][resource-loader] [runner][runner] [theme][theme] [config][config] [CLI session][cli-session] [Piem session](../src/session/ObsidianSessionManager.ts)。

### 私有文件的直接导入仍然是复用原码

不要把“没有 public export”误写成“只能复制实现”。构建时从依赖包解析内部文件，原文件不改、函数不重写，仍然符合原版复用。Piem 已有这种先例，例如 [sessionMutationLine](../src/session/sessionMutationLine.ts) 直接调用官方 codec。

区别在于维护约束：普通 `import "包名/dist/…"` 会被 `exports` 拦住；绝对文件路径或构建时解析可以绕到文件，但绑定了内部结构，须固定包版本、校验路径并实际打包。官方 `examples/extensions/*.ts` 虽随 npm 分发，也未开放包子路径；不能把源码目录误当成官方稳定功能包。[包配置][coding-package]

本次进一步做了**未经修改的内部文件**探针：`wrapper.js` 能单独打包并把宿主 context 传给 execute；`runner.js` 和 `loader.js` 仍解析到 Node 依赖。因此私有路径解决了入口可达性，尚未解决宿主可移植性。

### Desktop SDK 可用，不代表单文件 Obsidian 包已可用

普通 Node 进程可以用官方 SDK + factories；Piem 则由 Obsidian 读取 `main.js` 并加载，release 不附带 `node_modules` 或 npm 包目录。把 coding-agent 标为 external 会把依赖留给一个并不保证存在的运行时包；原样打进 CJS 还要解决 `import.meta`、包资源读取和启动副作用。[Piem 构建](../esbuild.config.mjs) [产物门禁](../scripts/check-bundle.mjs)

官方 `SettingsManager.fromStorage/inMemory`、新版本 `SessionManager.inMemory(..., entries)` 提供了一些可用接缝；它们没有令整个扩展宿主变成浏览器库，也没有解决与 Piem 现有 JSONL 的一致性。桌面优先可作为独立方案验证，不能用零散 polyfill、空 UI 或绕过 Vault 来掩盖接口缺口。[settings][settings-manager] [会话 API][cli-session] [发布说明][changelog]

## 3. Chord 是真正拆出来的原版库，但协议不同

本次从 **npm 原包**执行了下面的公开导入，没有改写库实现：

```ts
import { createFacetHost, createStaticFacetLoader, defineFacet, defineService } from "@earendil-works/chord";
```

浏览器 CJS 构建成功，选定入口的完整探针产物 **57,643 字节**，无 external imports，未带入 esbuild。随后在拒绝任何 `require` 的 VM 中运行：注册服务、依赖注入、先启动提供者再启动消费者、反向卸载、重复 dispose 均通过。

这是**独立探针大小**，不是 Piem 增量或启动性能；没有验证 Obsidian 界面、持久化、手机设备。Chord 声明 esbuild 为普通依赖仍会影响开发安装量，不能用本次 bundle 结果声称“安装不带构建工具”。[Chord README][chord-readme] [包配置][chord-package]

使用它的前提是扩展本身提供 `Facet`。旧的 `(pi: ExtensionAPI) => …` 工厂不能直接交给 `createStaticFacetLoader`。新 `experimental/plugin` 只导出 AgentController、PresentationUI、SlashCommands 服务契约；官方设计文档仍标记实验状态，写着 “TUI today, web later”，并列有未定的包边界。[实验入口][experimental-plugin] [设计状态][plugin-design]

**因此不建议为接入现有社区扩展，先做一次全项目 Chord 改造。** 真有适合的原版 Facet 扩展时再使用它；它不依赖 Pi 包，也不要求我们为了试验它先升级整套 core。

## 4. 扩展候选按“原样引用”重新筛选

这份表判断的是原版依赖可否接入，不是值得重写的功能清单。所有候选都还需要真实宿主验收。

| 候选 | 原版依赖形状 | 接入顺序 |
| --- | --- | --- |
| 官方 `model-status.ts` | 仅 type import coding-agent；`model_select`、notify/status，无自有文件 IO | **宿主验收探针**：验证原版事件分发与 Obsidian UI 接线。Piem 已显示模型，不把它算作新增产品价值。 |
| 官方 `bookmark.ts` | 仅 type import；命令、会话查询、label 持久化、notify | **首个有用的候选**：不依赖 TUI 组件，但要提供正确的官方会话契约及查看/搜索入口。原版逆扫全会话 entries，并不限定当前分支；不能声称已实现 Piem 想要的不同语义。 |
| 官方 `todo.ts` | 工具/命令/会话事件 + `pi-tui` renderer 与交互组件 | 宿主与 TUI 边界满足后再评估。原版 `/todos` 要求 `ctx.mode === "tui"`，删除这段或重写清单不属于“原版接入”。 |
| 官方 `plan-mode` | 命令/快捷键、tool hooks、上下文、持久化、UI 与固定工具名 | 后续。原版只移除 edit/write，保留其他活动工具；不能承诺 Piem 的 frontmatter、move/trash、MCP、子代理都因此只读。 |
| 官方 `question` / `subagent` / `interactive-shell` | 分别依赖 TUI、子 CLI/系统文件、真实终端进程 | 首批不选；Piem 已有 ask_user 和子代理。选中前必须满足原依赖，不能靠移植功能冒充接入。 |
| 社区 `@juicesharp/rpiv-todo@2.9.0` | 原包入口含 TUI overlay、配置包 Node fs/os/path；MIT | 不整包列为首批。原版状态管理较丰富，但拆取 reducer 自建产品已经偏离此轮要求。 |
| 社区 `pi-web-access@0.28.0` | Node 文件/进程、pi-tui/compat；视频需 ffmpeg/ffprobe；MIT | 首批不选。网页搜索有价值，整包不是现成的移动端依赖。 |

官方来源固定为 [model-status][model-status]、[bookmark][bookmark]、[todo][todo]、[plan-mode][plan-mode]、[question][question]、[subagent][subagent]、[shell][shell]。社区来源固定为 [rpiv-todo 源码][rpiv-todo]（commit `59100c75f256a004fe4bb0ce8eb6266d79f0791a`）及 [pi-web-access 源码][web-access]（commit `e55f78a6cf28e2ba5013e14c3dd7bb5eef2ac7c5`）。

官方 Pi 源码为 MIT；发布时保留依赖版权与许可。社区包须各自核对依赖，不把 Pi 的许可外推给社区。[Pi 许可][pi-license] [社区 todo 许可][rpiv-license] [社区 web 许可][web-license]

## 5. 最小开发方案

### A. 先做一个原版宿主接入验证，约 1–2 个工程日

固定现用 Pi 版本，从包内直接引用一个原版 `model-status` 工厂，宿主部分只使用原版 `DefaultResourceLoader` / `ExtensionRunner` / `wrapRegisteredTools`。核验顺序为：**公开入口 → 原文件内部入口 → 依赖图 → Obsidian 单文件加载 → 实际事件与卸载**。本次已完成前面的发布物与依赖检查；完整产品宿主尚未打通。

退出标准：可以装入真实 Obsidian、原版工厂注册并响应事件、卸载后不再触发；记录移动端能否使用同一路径。若依赖迫使修改官方源码、冒充 TUI 或自建 loader，就记录缺口转 B，不继续堆本地替代实现。暂不同时安装第二套 AgentSession 来写同一份日志。

### B. 补齐官方边界，合入官方后直接依赖

建议的上游拆分是**移动既有实现并开放接口**，不新造一套扩展机制。以下入口名均为提案，不是现有可 import 路径：

| 希望官方提供的边界 | 需要保留/分离的内容 |
| --- | --- |
| 静态扩展入口，如 `./extensions` | 原 `createExtensionRuntime`、工厂初始化/注册、Runner、工具包装及类型；静态工厂路径不引入 jiti、磁盘扫描、process 或 CLI 根模块。 |
| Node 加载入口，如 `./extensions/node` | 文件发现、包解析、jiti、exec。静态内置应用无需导入这条链。 |
| UI 与会话宿主参数 | 原 Runner 接收明确的界面/会话/模型服务契约；默认终端 theme 留在 TUI。Piem 不应通过类型强转伪装成 coding-agent 的具体类。 |
| 原版扩展入口 | 有用且足够小的扩展由官方包提供稳定子路径，或提供稳定的发布资产解析约定。 |

仅加一个 `./sdk` export 能避开部分根入口副作用，**不能单独消除 Runner 的 theme、loader 的 Node 及两套 Session 契约**。上游 [#9286][sdk-issue] 也提出 SDK 入口问题；它被机器人关闭，不代表已修复。当前 main 的配置仍缺这些边界。

上游拆分可预估 **3–5 个工程日做验证和 PR**，维护者评审及发布等待无法估期。这是后续开发建议；本轮没有向上游发 issue、评论或 PR。官方发布前，受阻扩展保持待接入；已有官方小模块照常复用。

### C. Piem 只做宿主接线，首项约 3–5 个工程日

在 B 的接口可用、且版本兼容后，以原版 bookmark 做首项。未来文件名可调整，边界先明确：

| Piem 落点 | 本地负责的差异 | 继续交给官方 |
| --- | --- | --- |
| `src/extensions/builtinExtensions.ts`（拟建） | 固定版本的原版工厂清单及来源元数据 | 扩展业务逻辑、工厂注册 |
| `src/extensions/ObsidianExtensionHost.ts`（拟建） | 把服务传入原版 Runner，绑定每个 SessionRuntime | 事件处理顺序、注册表、错误分发、工具包装 |
| `ObsidianAgentService` | 接 send/command、Agent hooks、会话切换与销毁；保留现有队列/压缩语义 | Agent 执行循环；通过 Runner 的 emit/bind 接口调用扩展 |
| `ObsidianSessionManager` | Vault 持久化、当前会话归属、同步与可见错误 | 官方会话查询/label/分支语义；不用另一个影子 SessionManager 同步猜测状态 |
| UI / `main.ts` | 以 Obsidian 命令、通知、状态展示原版结果；注册并清理监听 | 扩展行为；不实现终端模拟器 |

以上是宿主桥，不是一个仿 Pi 的 `ExtensionAPI`。原版需要的能力必须真实提供；不支持的扩展在选型时排除。扩展默认可用，边界与外发数据在工具/设置说明里披露。bookmark 本身不新增外部服务。

### D. Core 升级单独交付，不当作接扩展的快捷键

新 core 有更好的入口，但 **0.84.3 → 0.85.1 不是只改版本号**：

- harness-native 工具 execute 从当前五参数变成带 invocation/Context 的六参数；低层 `AgentTool.execute` 仍是四参数，两者不能混写。
- FileSystem/ExecutionEnv 操作改为显式 Context。现有 `VaultExecutionEnv`、用户技能桥、`harnessAdapter` 都需要核对。
- 原 Session/view/lane 接口变成 StorageBackedSession、Branch 与 mutation/value 模型；会话存储头、写入结构也变了。
- 本次给最新版官方 parser 输入当前 `{ kind: "header", version: 4, … }`，返回 `Unsupported JSONL session header`；新格式 `{ kind: "header", v: 4, storageVersion: 1, … }` 可解析。**只替换字段不能完成迁移**，后续记录格式和并发同步也须转换。

来源：[旧 Session header][old-header] [新 Session][new-session] [新 header][new-header] [新 parser][new-codec] [harness 工具/环境契约][new-harness-types]。本地 [sessionMutationLine](../src/session/sessionMutationLine.ts) / [sessionMerge](../src/session/sessionMerge.ts) 直接处理旧格式，升级必须连同恢复、分叉、压缩、断电恢复和多设备合并一起验收。迁移约 **另加 4–7 个工程日**，这是未实施的工程估算，不包含手机设备等待。

推荐顺序是 **A → B → C**；仅在选定官方版本要求时插入 D。Chord 是独立候选，不作为这条路线的强制前置。跨平台原版接入依赖 B，不能给出“几天后全部可交付”的承诺。

## 6. 验收与维护

- 发布物中的每个选定扩展和运行器都来自固定的官方依赖；无复制实现、patch-package 或运行时下载执行。私有原文件入口若暂用，记录版本/路径并用 build gate 检查。
- 真正执行原版注册→命令/工具→事件→状态恢复→销毁；不要只测工厂被调用。重复 reload、不再活跃的 context、后台会话归属和错误可见性都要覆盖。
- 会话切换、恢复、fork/retry、压缩和同步后，label/扩展状态仍符合原版语义；写盘失败不能显示“已保存”。子代理是否拥有实例须显式设计，不共享全局可变状态。
- hooks 接线保留现有 `transformContext`、`shouldStopAfterTurn` 的队列/压缩职责。完成通知使用 Piem 真正收尾边界，不能把底层 `agent_end` 等同于完整任务结束。
- 所有模型工具保持 Vault 范围。无新常驻进程、扫描或轮询；异步任务随 runtime 取消，监听随插件卸载。内置功能不是额外权限开关。
- 每个实现 PR 跑 `npm run verify` 和新增测试的独立文件运行；涉及布局做 Chromium/真实 Obsidian 检查，双语说明同步更新。手机模拟加载与 iOS/Android 实测分别记录。
- 对实际 Piem bundle 量体积和依赖组成；不拿下面的诊断数字当产品大小，不先抬体积门限给新依赖让路。

## 7. 本次实际验证

| 检查 | 结果与准确边界 |
| --- | --- |
| 原版 coding-agent 根 import `ExtensionRunner`，0.84.3 / 0.85.1 | 用本仓库 esbuild、browser/CJS/es2018、tree shaking。为定位包自身依赖，将非 Node 第三方包 external；两版均因 Node import 解析失败。这不是完整产品打包或桌面启动测试。 |
| 同入口依赖组成诊断 | 以 Node target、第三方包 external 生成 metafile；仍保留 config、theme、loader 与 runner 的贡献，0.84.3/0.85.1 分别有 108/118 个包内文件贡献字节。未装传递依赖，故不报告为整包体积。 |
| 普通包子路径 import | 两版 `dist/core/extensions/runner.js`、`examples/extensions/bookmark.ts` 被 exports 拒绝。0.85.1 `experimental/plugin` 无可匹配发布条件且实际缺文件。 |
| 绕过 exports，仅诊断原文件 | 0.85.1 runner/loader browser 构建仍遇 Node 依赖；wrapper 完整构建成功、无 external import。另对 0.84.3 原版 wrapper 做实际 execute，宿主 context 传入正确。未实例化完整 Runner。 |
| Chord 原版公开入口 | 完整浏览器探针 57,643 字节，无 external imports/esbuild；无 Node VM 中服务装配、依赖顺序及卸载验证通过。不是旧扩展兼容测试。 |
| 新旧会话头 | 实际调用 0.85.1 官方 parser，旧头拒绝、新头接受。未迁移用户日志。 |
| Piem 现有基线 | `npm run verify` 通过：build、bundle/copy/CSS/version gates、**3192 tests / 193 files / 0 fail**、lint；本地 Bun 1.4.2。产物 1,728,886 字节，现有门限 1.66 MiB。源码与依赖未改。 |

重现入口检查：取下方固定 registry metadata 的 `dist.tarball`，核对 `dist.shasum`，将原包放在一个临时 `node_modules/@earendil-works/` 下；用本仓库 esbuild 构建 `import { ExtensionRunner } from "@earendil-works/pi-coding-agent"; globalThis.probe = ExtensionRunner;`。诊断时明确区分 external 第三方包与 Node builtin；内部文件探针改为依赖包实际文件路径。保持 tree shaking 开启，不加 polyfill、源码 alias 或自定义 `sideEffects: false`，不以 external 标记消除失败后再称为可运行。

Chord 重现使用上文四项公开 import，`createStaticFacetLoader([consumer, provider]).load()` 后 `createFacetHost({ facets })`，最后分别 dispose host/loaded。两个本地 facet 仅声明一个服务及读取它，用来检查库本身；它们不是产品扩展。旧版示例的删改/TUI stub 探针不作为本文原版可行性的证据。

本次未改运行时功能、升级依赖或安装新扩展；没有完整原版 Runner 的 Obsidian 冒烟测试，也没有 iOS/Android 真机结果。调查工具均已退出，无本任务遗留的开发服务器或 watcher。

## 固定来源

[core-package]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/package.json
[core-index]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/index.ts
[coding-package]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/package.json
[coding-index]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/index.ts
[extension-index]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/index.ts
[loader]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/loader.ts
[resource-loader]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts
[runner]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts
[theme]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/interactive/theme/theme.ts
[config]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/config.ts
[cli-session]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts
[settings-manager]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/settings-manager.ts
[sdk-extensions]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#extensions
[changelog]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/CHANGELOG.md
[chord-package]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/package.json
[chord-readme]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/README.md
[chord-api]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/api.ts
[experimental-plugin]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/experimental/plugin.ts
[plugin-design]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/docs/plugins.md
[npm-coding]: https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/0.85.1
[npm-core]: https://registry.npmjs.org/@earendil-works%2Fpi-agent-core/0.85.1
[npm-chord]: https://registry.npmjs.org/@earendil-works%2Fchord/0.85.1
[main-coding]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/package.json
[main-core]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/package.json
[main-chord]: https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/chord/package.json
[model-status]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/model-status.ts
[bookmark]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/bookmark.ts
[todo]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/todo.ts
[plan-mode]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/plan-mode/index.ts
[question]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/question.ts
[subagent]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/subagent/index.ts
[shell]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/examples/extensions/interactive-shell.ts
[rpiv-todo]: https://github.com/juicesharp/rpiv-mono/tree/59100c75f256a004fe4bb0ce8eb6266d79f0791a/packages/rpiv-todo
[web-access]: https://github.com/nicobailon/pi-web-access/tree/e55f78a6cf28e2ba5013e14c3dd7bb5eef2ac7c5
[pi-license]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/LICENSE
[rpiv-license]: https://github.com/juicesharp/rpiv-mono/blob/59100c75f256a004fe4bb0ce8eb6266d79f0791a/LICENSE
[web-license]: https://github.com/nicobailon/pi-web-access/blob/e55f78a6cf28e2ba5013e14c3dd7bb5eef2ac7c5/LICENSE
[old-header]: https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/session/jsonl/types.ts
[new-session]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/session.ts
[new-header]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/types.ts
[new-codec]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/codec.ts
[new-harness-types]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/types.ts
[sdk-issue]: https://github.com/earendil-works/pi/issues/9286
