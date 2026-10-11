# present_ui 生命周期：A2UI、OpenAI UI 与 MCP Apps 调研

调研日期：2026-10-11。本文是官方资料核验与设计建议，不代表方案已经实现。范围是常驻仪表盘、工具返回、后续交互和资源释放；未运行这些项目的 renderer 或验证 Piem 接入。

## 结论

推荐把 **工具调用、界面实例、用户动作** 分开管理。`present_ui` 可以完成，界面继续存在；用户之后的点击是新的动作，不是再次完成旧工具调用。等待某次提交仍可作为一次性表单的流程，但不能成为所有界面的存活条件。

这来自下述一手资料的共同设计，并非某个标准要求我们必须增加 `mode` 或拆出 `await_ui`。对当前 Piem，保留一个工具、兼容旧调用、重构内部所有权，是比完整迁移协议更小且完整的修复。

## 名称与版本核验

- 未在 `developers.openai.com`、`platform.openai.com`、`learn.chatgpt.com` 检索到确切名为 **Intelligent UI** 的独立官方项目。本文比较能核实的两条 OpenAI 路线：Apps SDK 所属的 ChatGPT 插件 UI / MCP Apps，以及 ChatKit widgets / actions；不把名称近似视作同一产品。
- Google 发起的 A2UI 当前首页将 **v0.9.1** 标为 current production、v0.9 标为 previous stable、v0.8 标为 legacy、v1.0 标为 candidate。本文锁定 v0.9.1，不混用旧版消息名或候选版 `actionResponse`。[A2UI 版本表][a2ui-home]
- OpenAI 当前 UI 文档推荐新实现优先使用 MCP Apps 共享字段与桥接方法，`window.openai` 用于兼容入口或标准以外的 ChatGPT 扩展；不能只按旧 Apps SDK 教程设计。[OpenAI UI 指南][openai-ui]
- MCP Apps 生命周期核验采用标记 Stable 的 `2026-01-26` 规范。AG-UI 是 agent 与前端的事件层，不能与 UI 描述格式或组件库混为一谈。[MCP Apps 规范][mcp-spec]、[AG-UI 概述][agui-intro]

## 其他方案实际如何工作

| 方案 | 界面与数据 | 后续交互 | 与本次问题的关系 |
| --- | --- | --- | --- |
| A2UI v0.9.1 | Agent 发送声明式 JSON，宿主以预注册 catalog 渲染；surface 有自己的标识 | 客户端发 `action`，服务端可继续更新结构或数据，显式 `deleteSurface` 移除 | UI 不是待决工具 Promise；协议不决定 agent 何时等待 |
| OpenAI 插件 UI / MCP Apps | 工具关联 UI resource，结果数据交付给独立界面实例 | UI 可再次调用工具、向对话发消息，或更新模型上下文；宿主独立 teardown | 最直接的“初次工具已完成，界面仍可反复使用”参考 |
| OpenAI ChatKit | Widget 是对话条目，动作可以由客户端或服务端处理 | 按钮或表单触发 action，可更新 widget、调用业务逻辑或启动推理 | 用户点击之后才产生新工作，不需一直占用原工具调用 |
| AG-UI | 运行事件与共享状态事件分开 | 客户端工具、状态更新和下一轮输入由 agent/frontend 连接承载 | 可借鉴事件语义；不是现成的 Obsidian 组件宿主 |

### A2UI：surface 生命周期与任务状态分开

v0.9.1 定义 `createSurface`、`updateComponents`、`updateDataModel`、`deleteSurface`。结构和数据可以分别更新；删除才明确移除相应 surface。客户端事件名是 `action`，不是 v0.8 的 `userAction`。[A2UI 协议][a2ui-spec]、[Actions][a2ui-actions]

输入先更新本地数据模型，显式动作再携带已解析的 context 回传；这允许改筛选条件、重复点击等交互，不必把每次按键都送给模型。组件与函数来自宿主提供的 catalog，不能把 `functionCall` 理解成执行 agent 生成的任意 JavaScript。[Actions][a2ui-actions]、[Catalogs][a2ui-catalogs]

协议是传输无关的 UI 消息契约，没有定义 Piem 的 broker Promise 或用户等待超时，也没有“任务完成即删除 surface”的规则。由此可以设计跨回合展示，但不能据此声称协议保证跨重启恢复或永久挂载。[A2UI 传输契约][a2ui-spec]

### OpenAI / MCP Apps：工具完成后仍有独立交互阶段

MCP Apps 规范的生命周期明确包含：工具调用与 UI 初始化并行、向 UI 交付工具结果、反复交互、最后独立 `ui/resource-teardown`。交互期间可 `tools/call`、`ui/message`，或 `ui/update-model-context`；最后一种供未来回合读取，不等同于马上启动一次模型推理。[MCP Apps 生命周期与通信][mcp-spec]

**初始化握手不是首帧绘制回执。** `ui/initialize` 与 `ui/notifications/initialized` 表达通道能力与就绪；规范没有要求服务端等待像素已绘制才返回工具结果。宿主可在初始化后的任意时刻释放视图，独立生命周期也不等于永不卸载。[MCP Apps 生命周期][mcp-spec]

OpenAI 文档推荐区分数据工具与渲染工具，并给出界面直接再次调用数据工具、避免重挂载的例子。业务数据、临时 UI 状态和跨会话持久化各有所有者；widget 状态不能替代业务存储。[OpenAI UI 与状态指南][openai-ui]

ChatGPT 还提供请求关闭、切换展示方式等宿主能力；文档明确用 picture-in-picture 承载对话继续时仍保持可见的活动。这些是宿主展示能力，不是某个通用“工具超时时长”参数。[OpenAI UI 指南][openai-ui]、[UI runtime reference][openai-reference]

### ChatKit：action 与展示分开

ChatKit 的 widget action 默认发到服务端，也可指定客户端处理。处理器可以更新 widget、执行业务逻辑或启动新的推理；表单提交也属于 action。`loadingBehavior` 控制某次动作期间按钮或容器的 loading/inert 状态，不是整个 widget 的存活期限。[ChatKit actions][chatkit-actions]

### AG-UI：可借鉴的事件层

AG-UI 分别描述 run 生命周期与 `STATE_SNAPSHOT` / `STATE_DELTA`；不能把 `RUN_FINISHED` 直接解释成销毁组件。`TOOL_CALL_END` 指工具调用参数流结束，也不能误读成工具执行已完成。[AG-UI events][agui-events]、[State][agui-state]

当前 events 概念页还包含标记 Draft 的 interrupt 扩展；采用时需核对具体版本和 adapter。本文不以该扩展作为修复依赖，也没有从 AG-UI 文档获得统一 widget TTL 或 teardown 的契约。[AG-UI events][agui-events]

## 对当前 Piem 的具体建议

以下是本地设计推论，接口名为建议，不是已实现功能或行业规范。

1. **保留一个 `present_ui`，用明确模式兼容旧行为。** 可增加 `mode: "input" | "display"`，缺省 `input` 保持已有表单调用。`display` 创建界面后返回 `uiId`，不等待用户提交，并允许后续多次交互。这里的 display 不等于只读。避免组合多个 `blocking` / `persistent` / `autoClose` 布尔参数。
2. **内部替换 pending-only broker 的所有权模型。** 建立按 `ownerId` 隔离的 UI 实例记录；每个实例有标识、原始 toolCallId、内容/状态和生命周期。等待提交只是可选 waiter。完成 waiter 不应是核心层删除实例的唯一途径；旧 input 的“commit 后关闭并留下回执”由兼容流程组合完成。
3. **动作与关闭各司其职。** 新界面的 action 可反复触发，关闭单独处理。筛选、展开等本地变化留在界面；需要 agent 的动作进入所属会话的已有调度路径。复用排队/中断机制，不另写 agent loop 或通用消息总线。
4. **事件必须绑定创建它的会话。** 当前 `sendPrompt()` 取聚焦 runtime，不能直接作为常驻界面的无参发送入口。需要为事件明确携带 owner，并复用接收流程：忙时排队，空闲时发起后续工作；不能误投到用户刚切换的新会话。来自已关闭实例或旧挂载的异步回调应丢弃。
5. **渲染依据实例存在，而不是工具 pending。** `MessageList` 的完成结果应能定位仍存活的界面，不再一律变成静态 receipt；多张常驻界面不能占住当前单一 pending 队列、把后续表单挡在后面。React 重渲染不应重跑初始化。
6. **把超时和清理分开定义。** input 可配置等待用户的 deadline，超时须有明确结果；display 不因用户长时间观看而过期。初始化等待与某次 action 的 deadline 各自处理，不能复用为 UI TTL。若返回语义是“初始化成功”，可以有限等待宿主初始化回执；若只完成创建，就只报告 created，不能虚报已经呈现。这是 Piem 自身的契约。
7. **首版常驻定义为跨回合保留。** 视图隐藏/卸载时释放 DOM、监听器、计时器等资源，保留所属会话的实例描述和需要恢复的 JSON 状态；重挂载恢复受支持的状态。实例显式关闭、会话删除或插件卸载时最终释放。复用现有 cleanup 契约，不把任意脚本闭包当作可持久化状态，也不承诺跨重启恢复。

### 本地依据

- `src/tools/interactionTools.ts:104`：当前参数只有 code/title；`:169–187` 为 sequential 且 await broker。
- `src/tools/uiBlockBroker.ts:144–165`：完成 Promise 与移除实例耦合；`:85–97` 每 owner 只暴露一个 pending。
- `src/ui/ChatApp.tsx:288–310`：按当前 owner 读取 pending；`:1079–1083` 将 commit/dismiss/fail 转发给 broker。文件含 NUL，搜索需 `rg -a`。
- `src/ui/MessageList.tsx:709–719`：仅 pending 时挂载界面；`:1835–1845` 完成结果一律呈现 receipt。
- `src/ui/UIBlockCard.tsx:79–87`：commit 仅一次；`:131–138` 已有卸载 cleanup。
- `src/agent/ObsidianAgentService.ts:1506–1550`：发送使用聚焦 runtime；`:1880` 附近已有运行中排队路径。

## 采用完整标准的边界

**本次建议借鉴生命周期设计，不直接安装一整套框架。** 若产品目标变成承载第三方 MCP 工具返回的 UI，则应真正实现 MCP Apps 的资源、桥接与隔离契约；仅补一个 mode 不算兼容。若目标变成由模型生成可校验的原生 UI 结构，则 A2UI 的 catalog 与 Obsidian renderer 值得单独评估，代价是定义组件集并改变现有 code 契约。AG-UI 的采用取决于是否需要标准化连接多种 agent 后端。

这些路线可以组合，不是名称相近的互斥组件库。现有代码在宿主中执行生成 JS，与 A2UI 的声明式 catalog、MCP Apps 的隔离 HTML 都不等价。

## 实施时必须验证的行为

- 展示完成后 agent 继续，界面依然可以多次交互；提交一次性表单仍保持旧结果语义。
- 常驻界面不会挡住后续界面/表单；同一界面正常重渲染不重复初始化。
- 忙时 action 排队、闲时启动下一轮，始终发往创建界面的会话；关闭后的延迟回调不生效。
- 初始化失败、用户等待超时、action 失败、显式关闭各有清晰结果，不错误报告成功或吞掉动作。
- 切换会话、关面板、重挂载和插件卸载都正确清理；展示工具的旧 AbortSignal 不在之后误删已交付界面。
- 对话历史能区分活跃界面与静态回执；恢复行为不依赖之前的 DOM 或脚本局部变量。

本次仅新增调研记录，没有修改实现。上一轮独立运行的 `bun test src/tools/uiBlockBroker.test.ts` 为 7/7 通过；它验证现有 broker，不证明上述方案已实现。未运行 SDK 接入、真实 Obsidian 长时间或移动端验证。

[a2ui-home]: https://a2ui.org/#specification-versions
[a2ui-spec]: https://a2ui.org/specification/v0.9.1-a2ui/
[a2ui-actions]: https://a2ui.org/concepts/actions/
[a2ui-catalogs]: https://a2ui.org/concepts/catalogs/
[openai-ui]: https://developers.openai.com/plugins/build/chatgpt-ui
[openai-reference]: https://developers.openai.com/plugins/reference
[chatkit-actions]: https://developers.openai.com/api/docs/guides/chatkit-actions
[mcp-spec]: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
[agui-intro]: https://docs.ag-ui.com/introduction
[agui-events]: https://docs.ag-ui.com/concepts/events
[agui-state]: https://docs.ag-ui.com/concepts/state
