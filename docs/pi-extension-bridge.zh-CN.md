# Pi 扩展兼容桥

[← 扩展 Piem](extending.zh-CN.md) · [English](pi-extension-bridge.md)

Piem 把审核过的 Pi 原版工厂编译进发布包。书签与社区扩展使用同一套宿主实现，
沿用现有代理和由 Vault 保存的会话。它是可复用的扩展宿主，支持明确列出的
接口；不是完整 Node 环境，也不是任意代码的沙箱。

这次通用兼容层只增加宿主能力，不安装 `pi-suggest` 或其他新社区扩展，也不
增加默认模型请求。现有 Quick actions 的生成方式和点击即发送行为保持原样。

## 支持范围

| 接口 | 实际行为 |
| --- | --- |
| 加载 | 原版 `loadExtensionFromFactory`，只加载静态源码 |
| 执行 | 原版 `ExtensionRunner` 和工具包装器，工具串行执行 |
| 注册 | 命令、工具、快捷键、生命周期及上下文处理器、内部事件总线；不支持的注册及重复名称直接失败 |
| 上下文 | 按顺序运行原版 `context` 管线；处理器失败则终止请求 |
| 会话 | 从所属 Vault 会话及分支刷新只读视图；书签标签写入现有日志 |
| 模型 | 已配密钥且标识唯一的模型；目录及导入的 `complete` 使用 Piem 网络通道，真实密钥和认证头不进入回调 |
| 消息 | 命令内的 `sendMessage`，要求 `triggerTurn` 和 `followUp`，每条命令最多 16 条 |
| 界面 | Obsidian 原生弹窗、支持的组件工厂、草稿、组件及状态、补全和快捷操作；面板连接时为 `rpc`/`hasUI:true`，未连接时为 `print`/`false` |
| Node | 虚拟路径、URL、环境、EventEmitter、不可变 UTF-8 包资源 |
| 生命周期 | 每个代理持有一个宿主；释放时令旧接口失效并清理事件订阅 |

`fs` 不访问 Vault。未知路径返回 `ENOENT`，`existsSync` 返回 false；写入、监听和
进程执行会明确失败。上游可选配置文件有意不挂载。以后要支持可写资源，应提供
可等待完成、能检查所属会话及取消状态的 Vault 适配，不能用全局状态或同步内存
副本冒充真实笔记库。桌面用户技能仍走原有的独立 Node 路径。

两种适配提供不同的会话读视图：书签扫描整份权威日志，保持上游规则；社区扩展
可读取已存日志及所属会话当前分支。Pi 的同步动作先由适配层收集，服务等待真实操作完成后才
报告成功。模型切换保存记录、按模型能力收敛思考档位，并通过 Pi 的
`prepareNextTurn` 钩子从下一次请求生效。

## 包导入

审核过的社区源码可以保留 `@earendil-works` 或旧 `@mariozechner` 命名空间的
包根导入。构建时，两者都会解析到同一组浏览器兼容入口，不改写扩展函数；
不支持的导出或包内子路径会让构建失败。

| 两个命名空间下的包根 | 运行时导出 |
| --- | --- |
| `pi-ai` | `complete` |
| `pi-tui` | `Container`、`Text`、`SelectList`、`Key`、`matchesKey`、`parseKey`、`getKeybindings`、`visibleWidth`、`truncateToWidth` |
| `pi-coding-agent` | `BorderedLoader`、`DynamicBorder`、`theme`、`getSelectListTheme`、`getAgentDir` |

支持范围以此表为准，不包含 `stream`、`completeSimple`、任意 CLI 辅助函数或
终端引擎。`getAgentDir()` 返回虚拟路径，不会让同步配置文件变得可读或可写，
`fs` 仍只读取前述包资源。

## 原生界面与生命周期

桥接把意图映射到 Obsidian：`select`、`confirm`、`input`、`editor` 打开原生弹窗；
`getEditorText`、`setEditorText`、`pasteToEditor` 操作所属聊天的草稿，粘贴会替换
选中文字。每段聊天同时允许一个弹窗；取消信号、有限超时、停止、关闭面板或
切换聊天都会关闭待回答的弹窗。超时弹窗显示倒计时，关闭后释放计时器。

`setWidget` 在输入框上方或下方显示文本行或支持的组件工厂，`setStatus` 在下方显示状态。
`addAutocompleteProvider` 扩展原生补全数据；用户输入或选择 **显示建议** 后，
可以触摸或用键盘选择。建议只填入草稿，不会自动发送。原有斜杠菜单和 Tab 焦点
导航保留。重新打开面板会恢复扩展文本与补全，不重复发送 `session_start`。

工厂使用兼容层的 `Container`、`Text`、`SelectList`、`DynamicBorder` 和
`BorderedLoader` 时，会映射为原生布局、文字、可选择条目、边框和可取消进度。
`ctx.ui.custom(factory)` 在 Obsidian 弹窗中展示它们；`done(value)` 返回结果，
用户关闭弹窗返回 `null`。触摸和键盘选择都会调用组件自己的回调。加载组件提供
取消信号，不创建转圈计时器。关闭或替换界面会撤销其回调并清理资源；保留的
组件工厂在面板重新连接时重新挂载。

标准组件的渲染结果会把原生结构附在返回的行数组上。例如
`render: width => container.render(width)` 这样的包装可以保留结构；复制数组或
重新格式化内容会丢失结构。任意渲染字符串只显示为纯文本，不当作 HTML，也不
根据文字猜测按钮。自定义弹窗没有支持的交互组件却依赖输入处理器时，会明确拒绝。
桥接不会把原始键盘数据转发给任意终端处理器。

`ctx.ui.theme` 及导出的主题支持已列入兼容范围的 Pi 颜色名，以及 `fg`、`bg`、
`bold` 等文字格式函数；返回值是纯文本。原生控件沿用 Obsidian 的颜色和样式。
`tui.requestRender()` 刷新原生界面；终端光标操作、切换终端主题、自定义编辑器、
原始终端输入和浮层定位及句柄仍不支持。传入 `overlay` 标记也会打开原生弹窗。
仅检查 `hasUI` 不能证明兼容。

注册的快捷键还会出现在输入框下方可折叠的 **扩展操作** 菜单里，手机可以直接
触摸使用。输入框获得焦点时，明确带修饰键的快捷键也可触发；文字输入、输入法
组词、Enter、Tab、导航及标准编辑快捷键保持原有行为。规范化后重复的快捷键
会在注册时失败；旧面板的操作和并发快捷操作会被拒绝。

支持事件：`session_start`、`session_shutdown`、`before_agent_start`、`agent_start`、
`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、
`message_update`、`message_end`、三种 `tool_execution_*`，以及 `context`。
首次连接面板或执行时启动一次。原版 Runner 负责处理器顺序和结果合并。
`before_agent_start` 的系统提示只用于该轮；自定义消息和 `message_end` 改写
走现有持久化流程。`agent_settled` 等排队续跑和自动整理完成后触发。流式增量
不会读取 Vault，没有订阅的事件不会额外执行处理器。

停止和新提问会取消未完成的扩展工作。被取消处理器已捕获的接口始终失效，
完成启动的回调可继续服务该会话后续回合。共享的 `pi.sendMessage`、`pi.setLabel`、
`pi.setModel` 写操作必须在处理器第一次 `await` 前启动；异步界面和模型调用使用
带所属关系的 `ctx` 能力。释放宿主立即撤销旧接口和订阅，最多给
`session_shutdown` 一秒时间清理。

取消范围包括宿主管理并等待的处理器、工厂、弹窗和模型请求。标准组件的选择和
取消回调是同步 `void` 回调；扩展如果在里面自行启动异步任务，应通过组件的
`dispose()` 和 `AbortController` 取消。浏览器桥接无法追踪任意 Promise 或闭包。
成功结束的 `session_start` 上下文本就允许在同一聊天重新打开面板后继续使用，
不能据此保证扩展自建后台任务的所有迟到写入都会被拦住。不同聊天仍受所属关系
检查隔离。

## 模型请求

`ctx.modelRegistry` 提供 `getAvailable`、`getAll`、`find`、`hasConfiguredAuth`、
`complete`、`getApiKey` 和 `getApiKeyAndHeaders`。扩展可保留常见的
`complete(model, context, options)` 导入调用，将注册表返回的 `apiKey` 和
`headers` 原样传入。`getApiKeyAndHeaders` 成功时返回
`{ ok: true, apiKey, headers }`；模型未配置时返回 `{ ok: false, error }`，此时
`getApiKey` 返回 `undefined`。

这里的 key 是宿主发出的不透明凭据，headers 是空对象，真实服务商密钥始终留在
Piem 内部。凭据绑定所属聊天、模型及捕获的回调作用域，经过 `await` 也不会
换成另一个回调。模型元数据可以重新读取或浅复制；只用 provider/id 选择模型，
宿主会重新解析配置中的地址和凭据。已知属于其他聊天的模型快照、不同模型、
已撤销凭据或自定义请求头会明确失败。没有“当前全局宿主”回退，也不直接
绕过宿主请求服务商。

取消回调会撤销它的凭据；停止、面板连接变化及释放宿主会清理该宿主全部凭据。
成功结束的回调可以保留凭据，每段聊天最多保留 128 个不同“回调与模型”组合。
同一回调重复读取时复用凭据，达到上限明确报错，不悄悄挤掉仍有效的凭据。

两种 completion 调用都沿用聊天网络通道，把返回的用量计入所属聊天。
支持参数是 `signal`、`maxTokens`、`temperature`、`reasoningEffort`、
`cacheRetention`、`sessionId` 和
字符串形式的 `toolChoice`；未知参数会失败，不能绕过宿主路由。

每段聊天最多同时进行两次模型请求，60 秒超时。输出默认采用模型配置上限，
没有有效上限时为 4096 tokens，调用者可选更小值。Obsidian 的 `requestUrl` 无法
物理中断网络 IO：停止会立即结束调用者等待，但在途请求仍占用名额，直到网络
真正结束。没有新增轮询或常驻计时器。

## 接入新扩展

1. 审核包源码、间接依赖、注册接口、文件路径、网络、界面和生命周期，选择
   手机可用、许可明确的工厂。
2. 用 Bun 锁定 npm 版本；在 `scripts/pi-extension-packages.json` 登记全部会编译
   的源码摘要和虚拟根目录。构建拒绝注册包内未审核的文件，以及包引入的未知依赖。
3. 在 `communityFactories.mjs` 和声明文件引入原版入口，在 `communityHost.ts`
   注册。新增宿主能力必须配真实适配；不支持的操作明确拒绝。浏览器依赖按
   `bun.lock` 审核，不赋予通用 Node 能力。
4. 在 `licenses/pi-extension-bridge.txt` 保留上游许可。同步补两种语言的使用说明，
   并在设置里说明对用户有影响的行为。
5. 验证原版执行、失败与取消、两段聊天隔离、重载和 Node 隔离；通过构建、lint、
   单文件测试和全量测试。用临时真实 Obsidian 笔记库跑
   `scripts/smoke-community-obsidian.mjs`，覆盖桌面及官方手机模拟。

`scripts/smoke-extension-ui-obsidian.mjs` 在成品服务中用本地测试工厂验证原生弹窗、
输入补全、生命周期和模型请求。使用 `scripts/smoke-generic-bridge-obsidian.mjs`
验证通用包导入、组件工厂、原生选择、取消、快捷操作及导入的模型 completion。
它使用 `scripts/fixtures/native-extension-contract.mjs` 中的本地契约样例；样例
不注册为生产扩展。这些检查验收宿主契约，不代表所有社区包都已兼容。

运行验收使用本地确定性模型端点，经过真实协议、模型切换和上下文处理，并非
真实模型质量评测。官方手机模拟及始终没有 Node 的 VM 验证受限宿主契约；
iOS/Android 硬件、系统后台恢复和实际 WebView 仍需真机测试。
