# To do 跨轮空卡片：复现、根因与修复

用户报告版本为 Piem 1.7.1。诊断基线为 `a52abc9f3b526e07eb77ae8d995d0e77596ed067`，依赖锁定 `@juicesharp/rpiv-todo@2.12.0`。在修改业务代码前，源码集成测试和真实 Obsidian 桌面均复现了空卡片与无可见效果的切换按钮。

## 复现条件

1. 首轮调用 `todo` 创建任务，再以 `update` 把该任务改为 `completed`。
2. 等待首轮结束，确认展开的面板已经显示完成项。
3. 在输入框发送第二条消息；固定模型响应在入口等待，使断言发生在模型回复或执行新工具之前。
4. 面板内容消失，只剩空壳；点击切换按钮后仍为空壳。

对照组将任务更新为 `in_progress`，面板内容和切换功能均正常。直接调用服务发送也能复现，不依赖磁盘延时、预热计时器或发送按钮的事件实现。

## 证据链

- 上游 `node_modules/@juicesharp/rpiv-todo/docs/overlay.md` 的 “Completed tasks fading out” 明确规定：已经展示的完成项在下一轮开始时隐藏，重新加载或压缩会话会重置该显示状态。
- 上游 `index.ts:287` 在 `agent_start` 调用 `hideCompletedTasksFromPreviousTurn()`。`todo-overlay.ts` 将任务 ID 加入显示隐藏集合，触发 `requestRender()`，没有删除任务数据。
- `renderWidget()` 在没有可见任务时返回 `[]`，且这一步发生在读取折叠状态之前。因此切换折叠状态仍得到空内容。此路径没有调用 `setWidget(key, undefined)`，组件继续注册。
- Piem 的 `nativeComponentUI.ts` 原先只在注册时把组件送入 UI adapter，没有随后续空渲染更新挂载状态。`TodoCard` 对无法解析的模型保留卡片，`hasExtensionEntry` 按注册项判断入口是否存在，两者同时残留。
- 真实 Obsidian 中对同一故障组件观测得到：`getSnapshot()` 为 `{ kind: "text", text: "", paddingX: 0, paddingY: 0 }`；组件 `disposed` 为 `false`；adapter 和 surface 身份均未变化；点击按钮实际触发一次渲染，输出仍为空。
- 故障期间 `/todos` 仍返回 `1/1 completed` 和 `✓ #1 Keep task`。因此排除了任务数据丢失、组件提前释放和快捷操作未执行这三种解释。

空卡片 DOM 内仅剩 `aria-hidden="true"` 的字符宽度测量节点 `0000000000`；该节点没有可见文本，不是丢失任务的替代内容。

## 修复

在通用组件挂载边界订阅 surface 的内容变化：无可见内容时撤下 adapter 中的面板，有内容时重新挂载同一 surface。只在可见性变化时发布挂载状态。

空文本、带样式的空白和空容器均不占据面板；选择器等原生控件保留自身的空状态。暂时无内容不会释放组件，后续 `requestRender()` 可以恢复面板。已有的 dispose 路径清除订阅；切换面板后旧组件不能重新挂回。

没有更改上游完成项隐藏策略、任务存储、To do 按钮处理函数或 CSS。

## 验证

- `bun test src/ui/ChatAppRealService.test.tsx -t 'todo panel'`：修复前完成项案例失败，断言得到 `{ card: true, entry: true }`；进行中案例通过。修复后两者通过，并覆盖 `/todos` 保留历史任务、新建任务恢复面板、恢复后展开/收起正常。
- `bun test src/extensions/nativeComponentHost.test.ts -t 'without leaving an empty panel'`：三个空渲染案例修复前全部失败，修复后通过；同时检查隐藏期间不释放组件、重新显示复用 surface、面板切换释放旧组件。
- `npm run verify`：构建、bundle/skills/copy/CSS/version 检查、4,468 个测试和 lint 全部通过。
- 两个修改过的测试文件各自独立运行通过：UI 文件 14 项，组件宿主文件 23 项。
- 同一套真实 Obsidian 重放脚本在基线构建退出 1，在修复构建退出 0。完成项全部隐藏后卡片和入口均消失；`/todos` 保留任务；新任务恢复面板；按钮可收起并重新展开。

本地诊断证据保存在 `/home/ubuntu/piem-todo-smoke-20261008-85e48072/`，使用独立测试 vault 和本地固定模型响应：

- `repro.mjs`：实际点击发送和切换按钮的重放脚本。
- `before-fix/repro.json`、`before-fix/probe.json`：修复前 UI 状态和存活组件探针。
- `before-fix/during.png`、`after-fix/during.png`：第二轮开始时的真实截图。
- `after-fix/repro.json`：修复后的数据保留、面板恢复和按钮交互结果。
- `before-fix/artifact.json`、`after-fix/artifact.json`：实际加载的 bundle SHA-256。
- `environment.json`、`verify.log`：实际环境版本和完整项目检查输出。

验证边界：真实 UI 验证为桌面 Obsidian；未在 iOS/Android 上运行，未调用真实模型供应商。修复保留在工作区，未发布新版本。
