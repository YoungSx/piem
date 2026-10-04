# Pi Codemode 的官方设计：并存与仅脚本

核查日期：2026-10-04。问题：官方是否要求 agent 只能暴露 `codemode`，还是明确支持它与其他工具并存？

**结论：官方明确支持两种模式；启用 codemode 后，默认是 `on`，即与普通工具并存。这个设计在首次落地时就已存在。Piem 提供“并存 / 仅脚本”的方向与官方一致，但 Piem 的 `only` 比官方过滤得更彻底，不能把完整行为说成完全相同。**

## 核查范围

- 本项目 `package.json` 与已安装包：`@earendil-works/pi-codemode`、`@earendil-works/pi-coding-agent` 均为 `1.0.1`。
- 官方仓库：`earendil-works/pi`；核查时 `main` 为 `200387122ca450d6387f033949423114a270b96c`，`v1.0.1` 指向 `a7229ddc21810d6245105978033b7df645ecc2f7`。
- 直接获取 GitHub 官方文档、源码、测试源码、原始 PR 和首次落地提交。安装包内的 `codemode.md`、`settings.md`、`cli.md`、`extensions.md`、`mcp.md` 与上述 main 快照逐字节相同。
- 本次是文档与源码核查，没有运行官方测试、真实模型对照实验或本项目构建。文中关于测试的表述指已读取的断言，不表示本次执行通过。

## 1. 首次设计已经包含两种模式

作者 `mitsuhiko` 在 2026-09-25 创建的 [PR #10040](https://github.com/earendil-works/pi/pull/10040) 正文中写道：

> The `codemode` tool in coding-agent is compatible with Codex's `exec` tool, and `codemode.mode` works like Codex's tool modes (`on` or `only`).

PR 本文关于初衷的原话是：

> The main motivation is models like Jev, which work much better with a sandbox that composes tools than with plain tool calls.

这是作者对设计动机的陈述，不是本次测出的模型效果结论，也不等于所有模型都应采用 `only`。

该 PR 的 API 显示 closed 且 `merged_at` 为空；不能因此认定它没落地。作者在 [关闭评论](https://github.com/earendil-works/pi/pull/10040#issuecomment-5885486904) 明确说明 squash 到 `8562bcf66`；对应 [2026-09-29 落地提交](https://github.com/earendil-works/pi/commit/8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e) 也写明 `Closes #10040`。

直接读取该提交的文件可确认：

- [最初 settings.md 第 41 行](https://github.com/earendil-works/pi/blob/8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e/packages/coding-agent/docs/settings.md#L41) 已列出 `"on" | "only"`，默认 `"on"`。
- [最初扩展源码第 22–24 行](https://github.com/earendil-works/pi/blob/8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e/packages/coding-agent/src/extensions/codemode/index.ts#L22-L24) 已实现 `mode === "only" ? "only" : "on"`。
- [最初 agent-core 示例第 35–37 行](https://github.com/earendil-works/pi/blob/8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e/packages/agent/examples/mcp-codemode/main.ts#L35-L37) 已同时注册 MCP 工具和 codemode。

因此，“官方原本只准一个工具，后来我们自行加了并存”不符合首次落地的证据。PR 正文可以编辑，本文不推断其创建瞬间的逐字内容；关于首次落地的结论以固定提交为依据。

## 2. 当前官方文档与示例明确鼓励这种接法

[Codemode 文档第 51 行](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/codemode.md#L51) 写道：

> With `on` (default) declared tools stay declared, and their descriptions say how to call them from scripts.

| 情况 | 模型可如何调用 |
| --- | --- |
| codemode 尚未启用 | 使用已有工具；`codemode.mode` 的默认值本身不负责启用工具。 |
| 已启用，`mode: "on"`（默认） | 已声明的普通工具仍能直接调用，也能通过 codemode 脚本调用。 |
| 已启用，`mode: "only"` | 隐藏普通 active `direct` 工具的顶层声明，把调用入口和目录转交给 codemode；下文说明特殊 exposure 的边界。 |

[官方 CLI 入门示例](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/cli.md#L148-L164) 用 `"defaultTools": ["+codemode"]`，并明确说明保留 `read`、`bash`、`edit`、`write`，再加入 codemode。单次命令是 `pi --tools read,bash,edit,write,codemode`。

[官方 agent-core 示例](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/agent/examples/mcp-codemode/main.ts#L35-L37) 更直接：

```ts
// The model can call the MCP tools directly or batch them in one codemode script.
agent.state.tools = [...mcpTools, createCodemodeTool(mcpTools, createNestedToolRunner(agent))];
```

[官方 SDK 示例](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) 使用 `createCodemodeExtension({ mode: "on" })`，并通过 `+codemode`、`+tool_search` 增加工具。

[独立沙箱包 README](https://github.com/earendil-works/pi/blob/a7229ddc21810d6245105978033b7df645ecc2f7/packages/codemode/README.md) 则说明包本身没有 Pi 依赖，可把任意宿主函数提供给脚本。它不要求宿主 agent 只能保留一个顶层工具；工具如何呈现属于宿主集成层的选择。

## 3. 源码和请求测试相互印证

[官方 `prepareCodemodeLoadout()`](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/extensions/codemode/tool.ts#L319-L363) 实现：

- 默认 `options.getMode?.() ?? "on"`。
- `on` 给可从脚本调用的已声明工具补充脚本调用说明，`hiddenDeclarations` 为空。
- `only` 将 active、callable 且 exposure 为 `direct` 的工具加入 `hiddenDeclarations`。
- 工具仍留在可调用集合里；隐藏模型声明不等于删除工具的实际能力。

[官方测试 `presents callable tools per codemode.mode`](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/test/suite/agent-session-codemode.test.ts#L118-L158) 检查发送给 provider 的工具列表：`on` 包含 `read`、`echo`、`codemode`；切到 `only` 后保留 codemode，移除 read、echo 的顶层声明，并同步检查系统提示。

## 4. 两个容易混淆的边界

### `only` 不保证任何配置下都只有一个顶层工具

[官方 exposure 文档](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/extensions.md#L153-L165) 规定 `model-only` 工具由模型直接调用、不可由其他工具调用，适用于询问用户或编排其他工具的工具。codemode 本身也使用 `model-only`，以阻止脚本套脚本。

结合上面的过滤实现可知，codemode 的 `only` 不会隐藏这些特殊工具；它只筛选 callable `direct`。同理，该条件也不是“把所有非 codemode 的声明一律删除”。因此，不能把模式名解释为不带例外的单工具约束。

### MCP 默认走 codemode，不等于全部工具必须走 codemode

[MCP exposure 文档](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/mcp.md#L189-L228) 区分：

- MCP 默认 `codemode`：不把整个工具目录直接声明给模型，脚本按需发现和调用。
- `direct`：直接声明，也可以从脚本调用；文档举例用于小而常用的工具集。
- 可按 server 或单个工具配置 exposure，同一个 agent 可以混合使用。

`codemode.mode` 是编排工具的呈现策略，MCP `exposure` 是服务器或工具的入口策略；两者不能混为一个“全局仅脚本”开关。

## 5. 与本项目的对应关系

- `src/settings.ts` 定义 `on | only`，`DEFAULT_CODEMODE_MODE` 为 `on`；另有 `codemodeEnabled` 控制启用。
- `src/agent/ObsidianAgentService.ts` 的 `buildTools()` 在 `on` 保留原工具并添加脚本说明，与官方并存方向一致。
- 同一函数在 `only` 用工具名过滤，所有非 codemode 的工具都不向模型提供；完整工具集留给脚本执行。本地 `src/agent/multiSession.test.ts` 明确断言最终工具名为 `["codemode"]`。
- `src/extensions/extensionRegistry.ts` 的 `toolInfoList()` 当前统一报告 `exposure: "direct"`，不是官方完整的多 exposure 工具呈现系统。

因此，可以确认“我们的并存选项符合官方设计”。不能据此确认“我们的所有工具呈现与官方完全一致”，也不能仅凭官方默认值断言并存在本项目里一定更省 token、效果一定更好；后者需要实际任务对照测量。

本次只新增这份调查记录，未修改产品实现。
