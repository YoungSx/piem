# Pi 扩展兼容桥

[← 扩展 Piem](extending.zh-CN.md) · [English](pi-extension-bridge.md)

Piem 把审核过的 Pi 原版工厂编译进发布包。书签与社区扩展使用同一套宿主实现，
沿用现有代理和由 Vault 保存的会话。它是可复用的扩展宿主，支持明确列出的
接口；不是完整 Node 环境，也不是任意代码的沙箱。

内置扩展包括原版 `b1tank/pi-otel` Git 包。它的后台工厂经过同一个静态兼容桥，
只在用户配置 Collector 后发送。兼容桥不增加默认模型请求；现有 Quick actions
的生成方式和点击即发送行为保持原样。

## 支持范围

| 接口 | 实际行为 |
| --- | --- |
| 加载 | 原版 `loadExtensionFromFactory`，只加载静态源码 |
| 执行 | 原版 `ExtensionRunner` 和工具包装器，工具串行执行 |
| 注册 | 命令、工具、快捷键、处理器和内部事件总线；不支持事件或名称冲突时跳过该扩展；忽略的渲染器和 Markdown 变换有日志；flag 保留注册默认值 |
| 上下文 | 按顺序运行原版 `context` 管线；处理器失败则终止请求 |
| 工具拦截 | 通过 pi 自带的 agent 钩子调用原版 `tool_call` / `tool_result`；被拦截的调用不执行，就地修改 `input` 会传给工具，处理器失败只让该次调用报错 |
| 会话 | 从所属 Vault 会话及分支刷新读视图；自定义条目和标签保存后返回成功，摘要分支通过可等待的 Vault 适配发布 |
| 模型 | 已配凭据且标识唯一的模型；目录及 `complete` 使用 Piem 网络通道，真实密钥和认证头不进入回调；已审核搜索/改写工厂另外可解析当前服务商凭据 |
| 消息 | 操作内的 `sendMessage`，要求 `triggerTurn` 和 `followUp`，最多 16 条待发消息；内部 `/acm` 不发给模型 |
| 界面 | Obsidian 原生弹窗、支持的组件工厂、草稿、组件及状态、补全和快捷操作；面板连接时为 `rpc`/`hasUI:true`，未连接时为 `print`/`false` |
| Node | 虚拟路径、URL、环境、EventEmitter、浏览器 Buffer、Web Crypto 随机数、同步 SHA-256、不可变 UTF-8 包资源 |
| 生命周期 | 每段聊天拥有独立宿主；停止使待执行工作失效，重载使旧接口失效，自有定时器和请求跟踪到结束 |

`fs` 不访问 Vault。已审核的独立工厂可以读、写、删除 `/extensions/config` 下
属于自己的 JSON 配置，操作成功前等待插件设置保存。宿主把 `clarify.json` 和
`/clarify model` 接到同一设置保存流程。任意文件路径、监听和进程执行仍明确
失败，其他上游可选文件不挂载。桌面用户技能仍走原有的独立 Node 路径。

`pi-scoped-factories.mjs` 在构建时编译已审核的源码图，把平台导入绑定到各自
宿主，纯函数依赖仍用静态导入共享。不在运行时求值代码，不替换全局网络或
定时器，也不下载扩展代码。Bun 测试预载使用同一编译器，单文件测试无需前次产物。

搜索使用 Obsidian `requestUrl`，改写使用 Piem 已配置的模型传输。平台让调用者
及时收到取消，同时跟踪自己发起的异步工作。已经发出的原生 `requestUrl` 无法
中止，但迟到结果不能覆盖草稿或继续任务。摘要跳转先保留条目编号，再在唯一
复用的暂存通道保存，最后切换选中位置。停止时已开始的 Vault 写入可能完成；
旧宿主不发起回滚，运行状态以保存结果为准。暂存失败时仍选中旧分支。

两种适配提供不同的会话读视图：书签扫描整份权威日志，保持上游规则；社区扩展
可读取已存日志及所属会话当前分支。Pi 的同步动作先由适配层收集，服务等待真实操作完成后才
报告成功。模型切换保存记录、按模型能力收敛思考档位，并通过 Pi 的
`prepareNextTurn` 钩子从下一次请求生效。

`pi.appendEntry(customType, data)` 把 JSON 扩展状态保存为 `custom` 条目。
同一处理器可以立即通过 `getEntries`、`getBranch`、`getLeafEntry` 读回。
它不进入模型上下文，也不显示在聊天记录中；自定义消息使用另一套接口。
宿主在命令、启动、事件和工具返回前等待条目写入，保存失败会报错。停止会取消
排队写入；已开始的 Vault 写入可能完成，清理时会等待它结束。
空白会话的条目先留在内存，首次发送消息时随会话一起保存，沿用会话延迟落盘
规则。离开尚未发送消息的空白聊天，可能丢弃这些临时状态。

`registerFlag` 保留 Pi 声明的默认值，`getFlag` 可读到该值。未知或尚无值的
flag 返回 `undefined`；Obsidian 不提供命令行参数。消息/条目渲染器及
Markdown 变换目前只注册、不实际渲染，扩展加载报告会记录降级诊断。

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
终端引擎。`getAgentDir()` 返回虚拟路径，只有前述已审核、属于该扩展的 JSON
配置可以写入；它不提供通用文件系统访问。

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
`message_update`、`message_end`、三种 `tool_execution_*`、`tool_call` 和
`tool_result`，以及 `context`、`input`、`model_select`、`thinking_level_select`、
`before_provider_request`、`after_provider_response`、`session_tree`、`session_compact`、
`session_compact_failed`、`session_before_fork`、`session_before_switch`。
首次连接面板或执行时启动一次。原版 Runner 负责处理器顺序和结果合并。
`before_agent_start` 的系统提示只用于该轮；自定义消息和 `message_end` 改写
走现有持久化流程。`agent_settled` 等排队续跑和自动整理完成后触发。流式增量
不会读取 Vault，没有订阅的事件不会额外执行处理器。

`thinking_level_select` 在保存后报告之前和实际应用的思考档位。运行中选择
的新档位等本轮结束后生效；再次选择原档位可撤回待应用的变更。模型能力引起的
档位收敛走同一事件；保存失败或模型切换回滚时不发成功事件。事件始终属于
发起变更的聊天，后台聊天也一样。

`before_provider_request` 接在 Pi 原生的请求体序列化回调上，Runner 在发出 HTTP
前按序应用替换和原地修改。处理结束后再复制请求体，保留的扩展引用无法迟到
修改它。处理失败或停止会阻止请求。`after_provider_response` 在收到 HTTP
响应、读取响应流之前提供状态码和响应头，不代表模型已经生成完毕。两种事件
都不提供请求头或提供商密钥；停止后重发时，旧回调仍绑定旧请求的取消信号。
这些回调覆盖普通 Agent 模型请求；压缩摘要和 `ctx.modelRegistry.complete`
额外调用是独立路径。

`session_compact` 在手动或达到阈值的整理成功保存后触发。`compactionEntry`
包含真实保存的 ID、摘要、token 数、ISO 时间和 Piem 的 `retainedTail`。
Piem 没有 CLI 的 `firstKeptEntryId` 游标：直接读取该成员会明确报错，序列化
条目则只包含真实字段。观察者失败不能回滚已保存的整理。成功和失败事件都在
释放单次整理占用后发出，观察者可以再次整理，不会等到自己卡住。

`session_compact_failed` 覆盖手动和达到阈值的整理失败或取消。取消时
`aborted:true`，不带错误文字。Piem 没有溢出恢复或扩展提供摘要的压缩路径，
所以 `willRetry`、`fromExtension` 均为 false。`ctx.compact({onError})` 能收到
真实失败；成功事件、`session_before_compact`、自定义指令和结果回调仍不支持，
其完整契约需要能在真实日志中定位的压缩切点。

`session_tree` 在扩展摘要跳转、重试或编辑重发保存后触发，携带真实的新旧叶子
编号，以及这次创建的摘要条目。跳转失败不发成功事件。`session_before_fork`
在复制回复前触发，`position:"at"`；`session_before_switch` 在新建或打开
聊天前触发，`reason` 为 `"new"` 或 `"resume"`。返回 `{cancel:true}` 或抛错
都会阻止该操作，用户后来的选择会取代仍在等待的处理器。这些事件不代表通用
`ctx.fork`、`ctx.switchSession`、`ctx.newSession` 或 `session_before_tree`
已支持；摘要导航仍只允许选中本次准备的摘要编号。

`tool_call` 和 `tool_result` 是拦截而非观察，因此走代理自身的工具调用路径，
不走 `tool_execution_*` 三兄弟所用的事件流。`tool_call` 处理器返回
`{ block: true, reason }` 会阻止工具执行，该 reason 成为这次调用的错误结果，
模型能读到并据此调整，本轮其余部分继续。按上游约定，原地修改 `event.input`
会改写工具实际收到的参数：交给处理器的对象正是 Pi 传给工具的单次调用副本，
所以聊天记录里仍是模型真正发出的那次调用。修改后不会按工具 schema 重新校验，
与上游一致；vault 工具本身仍会检查自己的路径，被改过的路径无法离开 vault。
`tool_result` 处理器返回的 `content`、`details`、`isError`、`usage` 会整字段
替换已执行结果的对应字段，不做深合并。处理器抛错时只让它自己那次调用失败，
不放行：装来审查工具调用的扩展一旦崩溃，就等于什么都没批准。两个事件不在
每次调用前刷新 Vault；处理器写了自定义条目或标签时，返回前会等待保存，
只读处理器不增加存储工作。

停止和新提问会取消未完成的扩展工作。被取消处理器已捕获的接口始终失效，
完成启动的回调可继续服务该会话后续回合。共享的 `pi.sendMessage`、`pi.appendEntry`、`pi.setLabel`、
`pi.setModel` 写操作必须在处理器第一次 `await` 前启动；异步界面和模型调用使用
带所属关系的 `ctx` 能力。已静态审核的研究扩展另有每会话独占操作，统一拥有
延迟定时器，因此可保留上游异步 `pi.*` 动作，同时检查取消状态。其他工厂继续
遵循较严格的上下文契约。释放宿主立即撤销旧接口和订阅，最多给
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

### 静态依赖和后台工作

独立工厂的审计记录声明 `entry`、`version`、`virtualRoot` 和 `files` 内每个
源码文件的 SHA-256。可选 `dependencies` 映射使用相同结构，逐个列出确切
npm 依赖。可选 `exports` 把确切的 `./子路径` 映射到同一依赖 `files` 中已审核
的文件；未声明的子路径会被拒绝。可选 `browser` 把包内确切的 `./source.js`
选择器映射到同包已列入 `files` 的 `./browser/source.js`，作用于入口、声明的
子路径和相对导入。选择器不要求把 Node 源码也纳入审计，但目标必须通过相同
的哈希和路径检查；拒绝跨包、通配符和 `false` 替换。`package.json` 的
main/browser/exports 不能选中未审核文件。相对导入也能将 `./lodash.merge`
解析为已审核的 `lodash.merge.js`；先检查代码文件后缀，再检查目录 index。
构建前检查版本、全部登记源码和文件边界。

编译器把裸引用和支持的显式全局引用中的 fetch、process、Buffer、定时器
绑定到各自工厂的平台，依赖代码也一样。后台工厂中的 `globalThis`、`window`、
`self`、`global`，包括别名和动态属性访问，都指向同一个私有对象。SDK 的
`Symbol.for` 注册留在该对象内，不改宿主或其他工厂。它只提供选定的 Web/JS
基础能力和已有归属的 fetch、process、定时器，没有宿主全局属性回退。未知
导入和运行时加载仍使构建失败；仅前台工厂不能取得这份后台全局视图。这是
审核过的静态源码图，不是 JavaScript 安全沙箱；任意代码和共享内建原型仍须审查。

浏览器 SDK 通过有限的自有 `document` 接收真实页面生命周期通知：
`visibilityState`、`visibilitychange` 和 `pagehide`。事件目标指向该视图，
不暴露宿主 DOM。保留监听器身份、capture、once 和取消信号语义；每份视图最多
64 项注册。关闭时立即移除监听器，坏工厂或清理超时也会回收；重复移除已失效
的监听器仍安全。其他 DOM 能力不可用。只用直接 fetch/定时器的工厂不会创建
这些全局或 document 视图。

宿主可用 `{ id, createFactory }` 注册审核过的后台工厂。它有私有、可写的
虚拟环境和 PID，不读取操作系统的环境或进程身份。环境最多 64 个键，单值
最多 4096 UTF-8 字节，总计 16 KiB；只能列出自己的平面 JSON 配置空间。
Buffer 复用浏览器 `buffer` 包；crypto 支持同步 `randomBytes`、`randomUUID`
和 SHA-256。其他算法、异步随机字节回调和 crypto 选项明确拒绝，没有原生
Node 回退。

后台请求和定时器属于会话，不占用聊天操作，所以不会让输入框一直忙碌，
停止当前回合也不会销毁它们。HTTP(S) 使用 Obsidian `requestUrl`，调用者
最多等待 15 秒，每个代理服务最多四个实际在途请求，替换会话后仍共用上限。
取消后物理 IO 仍占名额，直到真正结束；`requestUrl` 无法物理中断请求。

每个工厂最多 64 个定时器或未完成回调占用。timeout/interval 句柄是数字，
不支持 Node 定时器对象的 `unref` 等方法；异步 interval 回调不重叠执行。
`timers/promises.setTimeout` 支持取消信号，接受 `ref`，但 WebView 没有
对应的进程保活效果。关闭时先停 interval，保留原有一秒清理窗口供最后发送，
之后撤销剩余定时器、延迟、请求和环境访问。坏工厂的资源会被清理，其他扩展
仍能加载。已注册的 `pi-otel` 工厂在未配置 Collector 时不启用发送。

关闭时，会话 ID、文件名、名称、模型、思考级别等安全信息使用最后有效快照。
此时服务可能已关闭所属会话；清理过程不会重新打开会话或提供密钥。旧上下文
和所有修改能力仍已失效，不额外复制整份历史或会话树。

### 内置 OpenTelemetry 工厂

`pi-otel` 是未经修改的 [b1tank Git 包](https://github.com/b1tank/pi-otel)，不是
npm 上的同名包。`package.json` 固定完整 Git 提交，`bun.lock` 锁定其官方 OTel
依赖。原版入口经 `pi-scoped-factory:pi-otel` 编译，并作为后台 `createFactory`
注册。Piem 源码没有复制上游埋点或导出器。

`otelConfig.ts` 校验可选插件设置 `otelEndpoint`，再把
`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME=piem`、来自 manifest 的插件
版本 `PI_OTEL_SERVICE_VERSION`，以及 `OTEL_METRIC_EXPORT_INTERVAL=60000`
投影到这个工厂的私有环境。它不继承宿主环境变量或服务商凭据。无地址就不
发送；上游在工厂加载时读配置，所以任何更改都需重载插件。地址须为 HTTP(S)
基地址，不带信号路径后缀、账号密码、查询参数或片段。

浏览器导出器向 `/v1/traces`、`/v1/metrics`、`/v1/logs` 发送 OTLP/HTTP JSON。
正文开关沿用上游默认关闭，但模型原始错误文字仍可能进入追踪状态和异常事件。
扩展接收主对话支持的事件，没有完整子代理埋点。关闭沿用已有一秒清理窗口，
无法保证慢网或不可用 Collector 上的最后发送。参见[设置](settings.zh-CN.md#extensions)
和[数据披露](security.zh-CN.md#opentelemetry-发送)。

### 接入清单

1. 审核包源码、间接依赖、注册接口、文件路径、网络、界面和生命周期，选择
   手机可用、许可明确的工厂。
2. 用 Bun 锁定 npm 版本或完整 Git 提交；在 `scripts/pi-extension-packages.json` 登记全部会编译
   的源码摘要和虚拟根目录。构建拒绝注册包内未审核的文件，以及包引入的未知依赖。
3. 在 `communityFactories.mjs` 和声明文件引入原版入口，在 `communityHost.ts`
   注册。新增宿主能力必须配真实适配；不支持的操作明确拒绝。浏览器依赖按
   `bun.lock` 审核，不赋予通用 Node 能力。
4. 在 `licenses/pi-extension-bridge.txt` 保留上游许可。同步补两种语言的使用说明，
   并在设置里说明对用户有影响的行为。
5. 验证原版执行、失败与取消、两段聊天隔离、重载和 Node 隔离；通过构建、lint、
   单文件测试和全量测试。用临时真实 Obsidian 笔记库跑
   `scripts/smoke-community-obsidian.mjs` 和
   `scripts/smoke-research-extensions-obsidian.mjs`，覆盖桌面及官方手机模拟。

`scripts/smoke-extension-ui-obsidian.mjs` 在成品服务中用本地测试工厂验证原生弹窗、
输入补全、生命周期和模型请求。使用 `scripts/smoke-generic-bridge-obsidian.mjs`
验证通用包导入、组件工厂、原生选择、取消、快捷操作及导入的模型 completion。
它使用 `scripts/fixtures/native-extension-contract.mjs` 中的本地契约样例；样例
不注册为生产扩展。这些检查验收宿主契约，不代表所有社区包都已兼容。

`scripts/smoke-background-bridge-obsidian.mjs` 临时给测试 Vault 的生产包副本
添加静态测试工厂，结束后还原。它验证依赖导入、真实 requestUrl 流量、两段
聊天、周期工作、模型事件、最后一次关闭发送和资源失效。

运行验收使用本地确定性模型端点，经过真实协议、模型切换和上下文处理，并非
真实模型质量评测。官方手机模拟及始终没有 Node 的 VM 验证受限宿主契约；
iOS/Android 硬件、系统后台恢复和实际 WebView 仍需真机测试。
