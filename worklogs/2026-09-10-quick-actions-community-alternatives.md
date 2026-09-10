# Quick actions 的 Pi 社区替代调研

日期：2026-09-10。Piem 核对基线：`63cc317`。第一轮只读调研；第二轮经用户授权继续评估，并独立补齐通用原生界面桥。未安装 `pi-suggest` 或替换 quick actions；只在隔离 VM 执行它的纯逻辑文件，见下方复现。

**有功能相近的社区扩展，其中 `pi-suggest` 最接近回复后的建议按钮；目前没有核实到能在 Piem 原样安装、完整替代空屏与回复两种 quick actions 的包。** 当前差距主要在 Pi 终端 UI、事件、模型调用和配置文件接口，不是缺一个 npm 包名。

## 比较的基准

Piem 的 quick actions 包含两种场景：空屏立即提供 3 个默认操作，模型建议可随后替换；助手回复后最多提供 6 个动态后续提示。按钮有简短标签和完整 prompt，点击后发送。空屏建议的依据是笔记路径、同文件夹笔记、其他标签页和最近笔记；不会为建议读取笔记正文。回复建议截取最新助手消息正文的前 4,000 字符；若该条只有工具调用、没有正文，则不出建议。[请求与上下文](../src/agent/quickActionSuggestionRequest.ts)、[默认操作与条数](../src/ui/quickActionSuggestions.ts)、[按钮](../src/ui/QuickActions.tsx)

固定的快捷提示词另有现成的 `Piem/prompts/`；它与“读当前回复、动态推荐下一步”是两种能力。[扩展说明](../docs/extending.zh-CN.md)

## 最相关的三个候选

| 扩展及本次固定版本 | 实际行为 | 与 Piem 的差别 | 判断 |
| --- | --- | --- | --- |
| **[pi-suggest][suggest-readme] 0.1.2** | `agent_end` 后另调模型，最近 8 条 user/assistant 消息合计最多 12,000 字符；默认生成 3 条，配置接受 1–5 条但当前解析器仍最多保留 3 条。终端编辑框上方用文字绘制 chips，另有 Tab autocomplete、picker、Alt+数字选取 | 新空会话不出建议；接受后只填入编辑框，不发送。原包依赖 Node `fs/path`、终端 widget/autocomplete、模型鉴权；仍使用旧 `@mariozechner` 包名 | **功能最接近，优先作为替代评估对象。** 已有 `title/prompt/description` 结构和多条建议，但不是现成的 Obsidian 按钮组件 |
| **[@sanif/pi-chat-suggest][sanif-readme] 0.1.0** | `agent_settled` 后用最新回答、压缩摘要及草稿生成默认 3 条建议；在编辑框以淡字显示，↑↓轮选，Tab/Enter 接受；通过会话条目保存状态 | 接受只填入编辑框；需要包装 Pi editor、`modelRegistry.complete`、事件、`appendEntry`。配置使用 Node `fs/os/path/url` | **第二候选。** 新 `@earendil-works` 包名、开发依赖 Pi 0.84.0 较接近我们，但界面呈现是编辑器补全 |
| **[@guwidoe/pi-prompt-suggester][guwidoe-readme] 0.3.10** | 助手完成后，根据近期会话和项目意图生成单条下一步 prompt；默认在空编辑框显示淡字，Space 接受。另有 widget 模式、自定义指令、独立 suggester/seeder 模型 | 需要自定义终端 editor、快捷键、模型鉴权、文件配置和日志；项目意图处理还调用 Git、`rg`、文件读取，依赖 `child_process`。不是多项按钮 | **确实相似，但为目前这项需求引入的接入工作最多。** 不推荐只为替代 quick actions 而整包接入 |

### 直接源码证据

- `pi-suggest`：[入口][suggest-entry] 的 `agent_end` 自动刷新、`setWidget` 展示、`setEditorText` 接受、`complete` 请求都已核读；[纯逻辑 helper][suggest-core] 定义默认 3 条、5 秒超时、结构化输出和条数上限。npm 发布物 SHA-1 `f0407c9ddb6e5cc647ae0bc016f7532801f8fbe2` 已与 registry 比对；源码链接固定到该版本元信息中的 `gitHead`。README 明确写了空会话不建议、只插入不发送。
- `pi-chat-suggest`：[入口][sanif-entry] 的 `agent_settled`、`refreshSuggestions`、编辑器轮选、`appendEntry` 与 [建议生成][sanif-generation] 的 `ctx.modelRegistry.complete` 均已核读；[配置][sanif-config] 默认开启、3 条、回答最大 12,000 字符、输出 600 tokens。默认是否开启不等于 Piem 已提供该能力。
- `pi-prompt-suggester`：[入口][guwidoe-entry] 安装 GhostSuggestionEditor 并注册 F2；[事件适配][guwidoe-events] 订阅 session/agent/input；[组合根][guwidoe-root] 实例化文件配置、日志、seed 和 Git 服务；[Git 客户端][guwidoe-git] 使用 `execFile("git", …)`；[模型客户端][guwidoe-model] 使用 `completeSimple`、读取 API key、执行 seeder 的 `rg` 和 `fs.readFile`。这些是源码依赖，不是根据仓库简介推断。

## 其他候选和边界

- [@mrclrchtr/supi-prompt-suggestions 6.4.0][supi-npm]：确有模型生成的单条回复后建议，`agent_settled` 触发、`completeSimple` 调用；默认模型配置为 `disabled`，开启后取最后助手回复尾部最多 8,000 字符，20 秒超时。依赖自定义 TUI editor 和随包分发的 `supi-core`，后者含 Node 文件与路径模块。可作为另一个参考，但未优于上面的多条建议候选。本次读的是固定 npm 发布物；registry 没有 `gitHead`，没有拿仓库 main 冒充该版本。
- [@chat-suggestion/adapter-pi 0.1.3][chat-readme]：主要是在用户打字暂停时补全当前 prompt，Tab 接受；不是助手回复后给出操作列表。[入口][chat-entry] 直接要求 `mode === "tui"`，不符合时不安装 editor；[生产入口][chat-production] 还使用 Node `createRequire` 读取版本。因此不列作 quick actions 的直接替代。
- [@0xkobold/pi-suggest 0.5.0][kobold-npm]：读取并校验固定 npm tarball 后发现，`dist/index.js` 的 `generateSuggestion`/`inferNextPrompt` 用提示词关键词规则返回固定文本，源码明写 `Simple heuristic-based suggestion generation`。虽然也是回复后淡字提示，但不能当作同等的模型动态推荐。它与 `mujuni88/pi-suggest` 是两个不同包。

## 原始基线为什么不能直接替换

基线 `63cc317` 的 [extensionHost.ts](../src/extensions/extensionHost.ts) 注册门禁只接受 `context` 事件；其他生命周期事件、终端快捷键或 renderer 会明确失败。UI 除 `notify` 外都拒绝，包括 `setWidget`、`get/setEditorText`、`custom` 和 `setEditorComponent`；运行器为 `print` 模式。模型目录只桥接 `getAvailable`，没有候选需要的 `getApiKey`/`complete`；`appendEntry` 也未开放。上述三个候选都超出这份契约。第二轮另发现原文档把 `print` 推断为 `hasUI:false` 不准确：Pi 的 `hasUI()` 取决于是否绑定自定义 UI 对象，基线虽只有 `notify` 仍绑定了对象。通用桥应准确报告是否连接了原生交互界面。

所以，“采用现成扩展”仍需要补齐它使用的宿主接口，并明确终端 UI 如何在 Obsidian 呈现。仅替换包名、忽略不支持的事件或让文件写入假装成功，不能得到可用替代。若保留现有点选即发送和空屏入口，至少这部分 Piem 界面及上下文处理仍须保留。复用候选纯逻辑也可以评估，但那与原版扩展直接接入应分别说明。

用户已明确：通用桥无论是否替换都要建设，目标是 **Obsidian 原生界面**。因此，不能把“需要补桥”本身当作不替换的理由；下面独立比较候选生成逻辑的收益。对只想增加固定快捷提示词的需求，现有 prompt templates 已能承担，不需要这些模型建议扩展。

## 第二轮：原生界面不变时，替换生成逻辑是否值得

**当前建议保留现有 quick actions，完成通用桥后也不自动换成 `pi-suggest`。** 它证明社区有同类功能，但其纯逻辑并未消除我们已经处理的空屏上下文、语言、取消、请求用量和会话隔离。可以参考“最近多条对话”和去重；整包引入仍要维护一套适配，收益尚不足以抵消差异。

这不是要在 Obsidian 里模拟终端。Pi 的 `select/input/confirm/editor`、文本内容、补全数据可以映射到 Obsidian 原生控件；候选的 `setWidget(factory)` 则只返回 ANSI 文字行，没有 DOM 按钮或点击动作。要沿用现有可点击按钮，须保留原生渲染，并让生成器交回结构化 `title/prompt` 数据。现有 Pi 类型把 `hasUI` 用于 TUI 和 RPC 两种交互，候选仅检查 `hasUI` 后调用终端 factory，不足以判断它支持原生 UI。

### 固定源码和纯逻辑复现

原包 `extensions/suggestions.ts` 无运行时 import。用 esbuild 仅转译该文件，在不提供 `process/require/fetch/setTimeout` 的 Node VM 中执行；没有运行入口工厂、安装脚本或任何模型请求。固定 SHA-256：`af66e37539ac58256fc2ee320aa8e9222d72cb060cd7904976f38b24ed767a8e`。

可复现脚本：[probe-pi-suggest.mjs](../scripts/probe-pi-suggest.mjs)。它接受解包目录，校验包名、版本和源码摘要，再执行确定性检查：

```bash
timeout 15s node scripts/probe-pi-suggest.mjs /tmp/pi-quick-actions-20260910-root/pi-suggest-0.1.2/package
```

| 检查 | 实际结果 | 对选型的意义 |
| --- | --- | --- |
| 配置 `suggestionCount:5`，模型返回 5 项 | 配置为 5，解析输出为 3 | `parseJsonSuggestions` 调用 `normalizeSuggestions` 时未传配置；后续 `slice` 无法恢复被丢弃项目。不是完整可用的 1–5 项支持，更不能覆盖我们现有最多 6 项 |
| 同一回复的两个调用同时等待生成 | `generate` 实际调用 2 次 | 缓存只存完成结果，不共享进行中的 Promise。自动生成与 Tab/picker 重叠时没有合并机制；这里只证明请求层可重复，不给未实测的费用数字 |
| 生成未结束时 `clear()`，随后旧调用完成 | 旧结果重新填入已清空缓存 | 清空没有代次或取消控制。入口另检查最新回复 id，可挡住一部分旧 UI 回填，所以不把这条直接夸大成跨会话内容泄漏 |

源码依据：[helper 177–201 行][suggest-store]、[JSON 解析 259–279 行][suggest-parse]、[入口生成路径][suggest-entry]。

### 模型、资源和维护

- 候选完整入口直接 import 旧 `@mariozechner/pi-ai` 根入口的 `complete`。我们固定的 `@earendil-works/pi-ai` 根入口已无此导出，现代宿主提供 `ctx.modelRegistry.complete`。仅替换包名不够；调用应走现有 Piem 的鉴权、网络传输和用量统计。
- 候选 `complete` 参数只有 key/headers/signal，未设置输出 token 上限，也未汇总请求用量。5 秒默认 timeout 会限制等待时间，但不是输出 token 上限。Piem 现有生成请求按场景限制 512/1024 输出 tokens，记录 billed usage。不能声称候选更便宜。
- 候选默认 prompt 没有明确指定界面语言，且会把完整 prompt 截到 240 字符；我们现有短标签与完整 prompt 分开，并明确要求当前语言。中文实际质量还需真实模型比较，本次没有质量或延迟测试。
- npm 声明 MIT，但固定发布物和对应仓库 tree 没有 LICENSE 正文；GitHub license API 也为空。若以后再分发，应先补核许可归属与正文，不能仅把元数据抄进第三方声明就称已核清。
- 2026-09-10 查询时，主分支最新提交仍为 2026-05-07 的发布提交 `f7e0a51`；仓库 `pushed_at` 更新来自其他推送，不能当作主线维护证明。当前 6 个开放条目均为依赖更新 PR。它有 helper 测试，但不覆盖本次三个复现。

这轮尚未比较真实模型的建议质量，也未把原包带入 Obsidian。通用桥的实现与验收另行记录；任何原生 bridge 测试通过都不等于这个旧版扩展已被原样集成。

## 调查范围与验证边界

本次使用 GitHub 仓库/代码搜索、npm registry 包元信息和 [Pi 官方目录的 suggest 搜索][gallery] 发现候选，再读取固定 commit 或 npm 发布物。官方目录当时列出了 sanif、supi、guwidoe、next-prompt、chat-suggestion；该过滤页未列出 `mujuni88/pi-suggest`，它的存在与行为由 npm 和作者源码证明。目录收录也不是 Obsidian 兼容认证。

第一轮网络只做限时读取；第二轮仅运行上面的纯 helper VM 探针，没有安装候选、调用真实模型或启动候选服务。没有穷尽全部 GitHub/npm 包，结论是“已找到接近者，尚未核实到完整即装即用替代”，不是证明社区不存在其他实现。原生桥接的代码、PR 与产品验证不混算为候选运行验证。

根代理保存的 `pi-suggest` 只读材料位于 `/tmp/pi-quick-actions-20260910-root/pi-suggest-0.1.2/package/`，元信息位于 `/tmp/pi-quick-actions-20260910-root/pi-suggest-meta.json`；临时文件可能被清理，固定链接和版本保留在本文。

[suggest-readme]: https://github.com/mujuni88/pi-suggest/blob/f7e0a519960ed035b29f01a03779c39c10ecb1bd/README.md
[suggest-entry]: https://github.com/mujuni88/pi-suggest/blob/f7e0a519960ed035b29f01a03779c39c10ecb1bd/extensions/next-step-suggestions.ts
[suggest-core]: https://github.com/mujuni88/pi-suggest/blob/f7e0a519960ed035b29f01a03779c39c10ecb1bd/extensions/suggestions.ts
[suggest-store]: https://github.com/mujuni88/pi-suggest/blob/f7e0a519960ed035b29f01a03779c39c10ecb1bd/extensions/suggestions.ts#L177
[suggest-parse]: https://github.com/mujuni88/pi-suggest/blob/f7e0a519960ed035b29f01a03779c39c10ecb1bd/extensions/suggestions.ts#L259
[sanif-readme]: https://github.com/sanif/pi-chat-suggest/blob/d035fd949a6eef52fe58bb56cfbbdf7b78d6ca95/README.md
[sanif-entry]: https://github.com/sanif/pi-chat-suggest/blob/d035fd949a6eef52fe58bb56cfbbdf7b78d6ca95/index.ts
[sanif-generation]: https://github.com/sanif/pi-chat-suggest/blob/d035fd949a6eef52fe58bb56cfbbdf7b78d6ca95/suggestions.ts
[sanif-config]: https://github.com/sanif/pi-chat-suggest/blob/d035fd949a6eef52fe58bb56cfbbdf7b78d6ca95/config.ts
[guwidoe-readme]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/README.md
[guwidoe-entry]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/src/index.ts
[guwidoe-events]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/src/infra/pi/extension-adapter.ts
[guwidoe-root]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/src/composition/root.ts
[guwidoe-git]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/src/infra/vcs/git-client.ts
[guwidoe-model]: https://github.com/guwidoe/pi-prompt-suggester/blob/3de69887a23edf973ec6c303a8696802d62a67fe/src/infra/model/pi-model-client.ts
[supi-npm]: https://registry.npmjs.org/@mrclrchtr/supi-prompt-suggestions/6.4.0
[chat-readme]: https://github.com/nguyen-ta-cuong/chat-suggestion/blob/02f16531821e6256c298a5016b2994790737c134/README.md
[chat-entry]: https://github.com/nguyen-ta-cuong/chat-suggestion/blob/02f16531821e6256c298a5016b2994790737c134/src/pi-extension.ts
[chat-production]: https://github.com/nguyen-ta-cuong/chat-suggestion/blob/02f16531821e6256c298a5016b2994790737c134/src/production-extension.ts
[kobold-npm]: https://registry.npmjs.org/@0xkobold/pi-suggest/0.5.0
[gallery]: https://pi.dev/packages?name=suggest
