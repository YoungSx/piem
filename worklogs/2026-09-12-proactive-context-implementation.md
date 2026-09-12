# 原生引用卡片与主动上下文菜单

2026-09-12。承接 [API 调研](2026-09-11-obsidian-proactive-context-audit.md)。用户要求一次完成入口，并明确选择用 Pi 原生消息结构实现可展开卡片。

## 交付行为

- 接通 Obsidian 原生文件、文件夹、多选文件、外链菜单；编辑器有选区时引用选区，无选区时引用整篇笔记。事件由 `registerEvent` 清理。
- 文件、文件夹、网址和选区成为输入区内的可展开、可移除卡片。用户问题保持原样，添加引用不会请求模型或抓取网页。长期固定仍独立使用。
- 每条问题最多 64 个引用，序列化资料合计 20,000 字符；选区最多 2,000 个 Unicode 字符。重复引用合并，超额或不可用目标明确反馈。卡片只承诺路径或捕获的选区，不声称已读取文件全文。
- 发送时采用 Pi 原生 `CustomMessage`，`content` 是模型可见文字，`details` 是带版本的渲染资料。只在两者一致时画卡片，损坏资料不会掩盖不同的模型正文；路径与 URL 在读取存档时重新校验。
- 草稿文字与卡片一起存储。成功加入首个引用会保存新会话身份，以便重启后找回；未使用的空白聊天仍不落盘。并发引用和首次发送共享同一个会话创建过程。
- 等 Pi 接收问题或本地队列接收后，才移除已发送内容。期间新加的文字和卡片保留；拒绝、A→B→A 切换、关闭重开面板不会覆盖或重复提交。接收前防重同时落在界面和服务层。
- 排队撤回先检查文字与卡片预算，失败时保留队列。重试、编辑重发、会话重载、崩溃继续以及 Markdown 导出均保留引用。
- 保留原有草稿存储上限：写盘保存文字前 20,000 字符，打开的编辑器保持全文；存储订阅不会把截短值回填编辑器。损坏卡片元数据不会清空正常问题，并记录原因。
- 草稿加载时输入框只读；手机加入引用会展开并聚焦输入框。按路径匹配打开的编辑器，以读取未保存的最新正文；没有编辑器时使用 Vault 内容。
- 中英文使用说明同步更新，无新增依赖。采用 esbuild 原生 `charset: "utf8"`，避免中文转义放大体积；撤销早期提高打包上限的改动。

## 回归与审查

Bun 使用与 CI 相同的 1.4.0，路径 `/tmp/piem-context-runtime-20260912/package/bin`；构建与测试串行、低优先级运行。

最终卡片版在同步最后两条上游提交前，`npm run verify` 为 **3,805 pass / 0 fail，253 个测试文件**，包含生产构建、bundle/skills/copy/css/version 门禁与 lint。日志 `/tmp/piem-cards-persist-verify.log`。

已实际观察红转绿的缺陷包括：首次引用丢失、慢草稿预填覆盖、未保存正文、长正文回灌截断、重复提交、引用 custom 尾消息无法崩溃恢复、首个未发送草稿失去会话身份。单独文件检查还修复了 ChatApp 测试静态导入早于 Obsidian stub 的次序问题。

规范和需求双轴只读审查发现的实质问题已逐项修复复核，包括关闭重开面板绕过界面锁、预算上调违反 CONTRIBUTING 等。没有改测试断言来掩盖缺陷。

## 真实 Obsidian 证据

隔离 Vault `/tmp/piem-cards-smoke-20260912/vault`，独立 profile、Xvfb、Obsidian 1.13.7 arm64；没有操作用户 Vault。HTTP 只使用本地确定性服务，没有调用外部模型。

此轮成品 **1,958,678 B**，SHA-256 `e3282735cce548f432e49f8b9ab67bbccfbc4e083eca3ccb2207da146e7253f5`。下面所有卡片验收均针对该成品：

| 验收 | 证据 |
| --- | --- |
| 冷启动文件夹菜单、四类卡片与原问题存储，尚无模型请求 | `staged-final.json` |
| 实际退出重启后，四张未发送卡片与同一会话问题恢复 | `reloaded-final.json` |
| 移除、重新加入、切换会话、整篇笔记及选区菜单，原问题不变 | `final-desktop.json`、`final-desktop.png` |
| CDP 原生鼠标选中 20 个 Explorer 文件并点击真实多选菜单，全部成为卡片 | `real-multiselect.json`、`real-multiselect.png` |
| 阅读视图外链右键菜单带入 URL | `real-link.json` |
| 点击实际发送按钮，25 个引用、原问题和最新编辑内容到达本地 HTTP；卡片元数据不发给模型；接收后草稿清空 | `model-request.json`、`final-http-output.json` |
| 发送后实际退出重启，25 张卡片恢复，Markdown 导出含目标与选区 | `restored-transcript.json` |
| 官方手机模拟，390px；折叠输入框展开并聚焦、选区可展开阅读、卡片和面板无横向溢出 | `final-phone.json`、`final-phone.png` |

截图已经查看。手机布局检查等待宿主侧栏动画稳定后测量；一次过早测量的坐标越界不是最终布局。没有实体 iOS/Android 软键盘或长按手势测试。确定性 HTTP 只证明实际传输与模型消息转换，不证明真实模型理解质量或任意网站可访问。

本次 Linux 软件渲染宿主在完成手机验收后出现 `GPU process isn't usable` 并退出，故未把该轮插件 unload 探针计为成功。监管脚本回收了 Obsidian、Xvfb 和收养的 Electron 子进程，`cleanup.json` 为 `allExited: true`，CDP 端口关闭。早期截图与固定引用方案的记录不作为最终卡片版证据。

## 交互审计与统一

用户要求比较技能包装的气泡内展示与引用的气泡外展示，并统一。按 `impeccable` 的 Operate、交互一致性、可访问性与响应式检查：

| 方案 | 归属与阅读 | 结论 |
| --- | --- | --- |
| 问题气泡外独立显示引用 | 同一条用户输入被拆成两段，未标角色的引用容易像系统记录；与技能包装不一致 | 不采用 |
| 问题气泡内显示引用 | “这条问题所带资料”直接可见；与技能折叠包装、图片附件同一归属 | 已实现 |

- **P1，归属不清**：引用与所属问题的相邻 native custom 消息只在界面合并，Pi 原生持久化和模型输入结构不改。原索引仍用于重试、编辑和分支。隐藏、损坏或失去所属问题的资料不会错贴给别的问题，仍用原始系统记录兜底。
- **P2，展开语言不一致**：引用与技能共用行高、字号、颜色、箭头、键盘焦点、展开正文和减少动态效果规则；触屏命中区至少 44px。草稿内保留可移除操作，已发送消息只读。
- **P2，链接样式被宿主覆盖**：原 `.reference-open` 被 Obsidian 的按钮规则画成表单控件，改用与宿主相同特异性的元素选择器，恢复正常文字链接。
- 多项引用维持有界列表，长选区保持可滚动，问题始终可读；若引用本身保存失败，所属问题的警告与抢救复制也包含引用内容。

这是本次引用与技能展示面的审计，不是整个插件或 WCAG 认证。机械扫描 `impeccable detect --json src/ui/MessageList.tsx src/ui/ReferenceCards.tsx` 返回 `[]`；与消息气泡归属有关的判断来自源码、实际界面和交互证据，扫描器不判断这类语义。

最终统一成品 **1,959,426 B**，SHA-256 `c530f02db5e3fe0ece03614b251eb814043f0828c1396afc09bfe2b516cd5e74`，已包含最新上游 `67b9c74`。证据目录 `/tmp/piem-unified-smoke-20260912`：

- 实际调用 vault 中的 `context-audit` skill、四种引用并点击发送；本地 HTTP 收到真实技能标签、引用和最新编辑正文，没有卡片渲染元数据。`http-result.json`、`model-request.json`。
- 一个用户气泡里同时有四种引用、解析后的技能包装和用户问题；无气泡外引用重复行。桌面 Enter 激活两个原生 summary 均可展开。`desktop-report.json`、`desktop-light.png`、`desktop-expanded.png`、`desktop-dark.png`。
- 官方手机模拟 390px，重载后同样归组；两类展开行高度均 44px，无横向溢出。文字最小对比度：浅色 6.19，桌面深色 7.03、手机深色 7.95。`mobile-report.json`、`mobile-light.png`、`mobile-dark.png`。截图已查看，实体键盘/读屏/长按未测。
- 本轮切换手机时宿主图形进程退出过一次；监管脚本回收全部进程后单独重启，完成手机验证。最终插件 unload 成功：`runtimeCount: 0`、`removed: true`；`cleanup.json` 记录进程全部退出，CDP 端口关闭。

## 同步上游与 PR

已 rebase 至 `67b9c74`，仅打包预算记录有冲突，完整采用上游 `scripts/check-bundle.mjs`（本 PR 不提高门槛）。最终统一实现的 `npm run verify`：**3,819 pass / 0 fail，256 个测试文件**，build、所有门禁与 lint 通过；日志 `/tmp/piem-unified-reference-verify.log`。本分支修改的 9 个测试文件已各自单独运行通过，记录 `/tmp/piem-final-independent.json`。PR CI 在交付时补记。


## 发送前技能卡片与逻辑 SSOT

用户进一步明确：技能也在发送前的文字输入框内渲染为同款卡片，并保证逻辑单一来源。

- `AttachmentCard` 统一技能与引用在发送前后的图标、名称、类型、展开、正文、移除结构与样式。卡片和原生 textarea 放在同一 `composer-input` 框内，工具栏在框外；textarea 不再绘制第二条边框。
- 技能卡片从唯一草稿字符串推导。菜单选择或完成的技能命令成为卡片，textarea 仅编辑问题；`projectComposerDraft`、`withComposerText`、`syncComposerEditor` 统一显示投影、写回与光标。未增加 selectedSkill 状态、第二份草稿或正文缓存。
- 命令目录类型由模型命令模块统一定义，技能项引用服务已加载的 Pi Skill 对象；预览与发送读同一来源。与模板同名时保留原命令优先级。发送仍由 Pi 原生 formatter 包装技能。
- 扩展 setText/paste 和异步 completion 使用同一投影与 raw/visible 光标换算；编辑已发送技能时保留原包装和捕获的正文。移除卡片只移除技能，原问题和引用保留。
- 第一张技能卡片会保存新会话身份；技能草稿能够跨切换和重载恢复。所有输入材料共用有界滚动区域，不把问题挤出视野。

这一阶段初始完整验证：`npm run verify` **3,829 pass / 0 fail，257 文件**。最后只读需求复核发现“扩展在问题开头粘贴技能命令后光标跳到末尾”，已用 `Tail` 光标 0 的回归复现（错误为 4），修为按粘贴前原始坐标再投影；单文件 7 项通过，复核通过。8 个修改测试文件也各自运行通过。

真实 Obsidian 证据在 `/tmp/piem-draft-skills-20260912`；此阶段成品 **1,961,541 B**、SHA-256 `cee3bde81f5dd1229102f5e0436d2559d3f602acf93cf5555470098e130d89c2`：

- 实际选中技能 completion、读取已加载指令、问题单独输入、移除技能、显式技能命令折叠、加入四类引用、切换与恢复均通过（`staged.json`）。
- 桌面和 390px 官方移动端模拟、深浅主题中，技能与引用都在同一个文字输入框内；仅一个输入边界，问题区没有第二条 border/shadow，无横向溢出（`desktop-report.json`、`mobile-report.json` 及对应 PNG）。截图已查看。
- 从该草稿点击实际发送按钮，本地 HTTP 恰好收到一个 native `<skill>` wrapper 和四类引用，用户可见问题对应同一份 stored prompt，卡片 renderer details 不发给模型，发送后材料和问题清空（`http-result.json`、`model-request.json`）。
- 实体手机键盘与读屏未测；这轮监管时限到达后宿主退出，进程全部回收、端口关闭，未把退出后调用的 unload 探针算作成功。最后光标修正及同步上游后成品另记，不混称同一 SHA。
