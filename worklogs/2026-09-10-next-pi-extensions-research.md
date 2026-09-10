# 下一批 Pi 扩展候选

核对日期：2026-09-10。Piem 基线：`361b89e60cb860a7e41db859685aa27c873a2d09`（PR #402 已合并）。

**建议优先评估 `pi-web-search` 和 `pi-clarify`，再考虑 `pi-context`。** 前者补上搜索资料的能力，后者整理发送前的草稿；后者上游提示词偏编程请求，不能把它描述为已经适合所有笔记写作。此次是静态源码审查，没有安装、执行第三方代码或运行兼容性测试。

## 当前边界

已打包的扩展是官方 bookmark、`pi-assistant-provenance`、`pi-model-switch`、`pi-invisible-continue`。已有 `web_fetch` 能读取指定网址，尚无原生 `web_search`；Vault 任务扫描、技能、进程内子代理、远程 MCP 是现有能力，不能重复算成新扩展收益。[现有工具][tools] [扩展宿主][host]

宿主允许工具、命令及 `context` 处理器，但拒绝 `input`、`session_start` 等其他事件；只有少数会话及模型接口。`fs` 是只读打包资源，不能读写 Vault，网络也不会自动转为 Obsidian `requestUrl`。**以下五包均不能只加入白名单就原样可用**；保留原版工厂，需要先补它实际使用的宿主契约。[桥文档][bridge] [宿主源码][host]

## 候选排序

| 候选及本次核对版本 | 对 Piem 的新增价值 | 源码所需适配 | 建议 |
| --- | --- | --- | --- |
| `pi-web-search@1.5.0` | 用已有模型供应商搜索网络，并返回引用来源；Google 路径另提供 URL context。现有 `web_fetch` 仍负责读取已知网址。 | `session_start/session_tree/model_select`、`setActiveTools`、`modelRegistry.getApiKeyAndHeaders/find`；直接 `fetch`、`util` 编码器、可选配置读取、TUI renderer 依赖。需接既有网络/取消流程并保留供应商能力判断。 | **优先**。新收益明显；普通 OpenAI-compatible chat-completions 不能因名称相似就宣称支持搜索。[入口][search-entry] [协议与凭据][search-api] [配置][search-utils] |
| `pi-clarify@1.0.1` | `/clarify` 将零散请求改为清楚的待发送草稿，同语言、保留原意；用户可再编辑。 | `input` 事件、模型查询/凭据、编辑框读写；固定模型配置用同步 `fs` 写入。已有非 TUI 路径，但现宿主 `hasUI=false` 时只通知结果，不等于已接回编辑框。 | **优先的小功能**。无普通运行依赖，npm 解包约 16 KB；这是发布物大小，不是新增 bundle 大小。仍需取消、换聊天和卸载后的迟到结果保护。[原码][clarify-source] |
| `pi-context@2.2.0` | 会话检查点、结构时间线、带交接摘要的新分支；适合长期整理资料时保持任务状态。 | `getTree/getChildren/getBranch/getLeafId`、`branchWithSummary/branch/navigateTree`、`getContextUsage`、`abort/waitForIdle`、`sendUserMessage` 及回合/关闭事件；另一个 `/context` 入口带 TUI。 | **后续阶段**。新增收益是代理主动操作历史结构，不能只说“压缩”，Piem 已有压缩能力。分支与保存语义适配明显比前两项深。[主要入口][context-source] [界面入口][context-ui] |
| `@benvargas/pi-firecrawl@1.1.0` | `firecrawl_map` 发现站内网址，`scrape` 读取页面，`search` 搜索并可抓取结果。 | flags、独立服务密钥、直接 `fetch`、同步配置写入；输出截断时会把全文写到 `tmpdir()`，须换成受约束、可等待完成的 Vault 方案。 | **确有网页采集需求时再做**。该版本只注册这三个工具，不能凭包简介宣称已经有 crawl/extract。会增加 Firecrawl 服务配置和请求成本。[原码][firecrawl-source] |
| `pi-prompt-template-model@0.12.2` | 提示模板绑定模型、思考档位及后续多步骤流程；当前 Piem 模板仅展开文字。 | Node fs/crypto、模板扫描、多种事件/renderer、思考档位写入、分支/子代理流程；`deterministic-step.ts` 直接 `spawn` 子进程。 | **暂缓整包**。它已是流程引擎，不能当作轻量的“模板选模型”。依赖 `minimatch`，发布物解包约 1.58 MB，不代表 bundle 体积。[入口][template-source] [进程执行][template-process] |

以上评估将“功能值得做”和“上游整包可以直接复用”分开。若改写工厂、删掉上游功能再实现 Piem 版本，应如实称为适配实现，不能记作原版扩展已完整接入。

## 来源与许可核对

本次实时读取五包 npm `latest`，版本与上表一致。对前四包重新读取 npm tarball、核对 registry SHA-1，并逐字比对已有审计目录的文本文件：分别 7、5、13、4 个文件全匹配；没有解包执行或安装。模板模型只刷新包元数据并静态读取已有对应版本源码。

| 包 | npm 固定版本来源 | 发布声明与许可文件 |
| --- | --- | --- |
| pi-web-search | [1.5.0 元数据](https://registry.npmjs.org/pi-web-search/1.5.0) | 声明 MIT；该 tarball 及固定 gitHead 的递归文件树均未带 LICENSE/COPYING，发布接入前补齐许可全文与版权归属。 |
| pi-clarify | [1.0.1 元数据](https://registry.npmjs.org/pi-clarify/1.0.1) | MIT，包内 LICENSE：Copyright 2026 dodo-reach。 |
| pi-context | [2.2.0 元数据](https://registry.npmjs.org/pi-context/2.2.0) | 声明 MIT；该 tarball 及固定 gitHead 的递归文件树均未带 LICENSE/COPYING，发布接入前补齐。 |
| @benvargas/pi-firecrawl | [1.1.0 元数据](https://registry.npmjs.org/%40benvargas%2Fpi-firecrawl/1.1.0) | MIT，包内 LICENSE：Copyright 2026 Ben Vargas。 |
| pi-prompt-template-model | [0.12.2 元数据](https://registry.npmjs.org/pi-prompt-template-model/0.12.2) | 声明 MIT，现有版本审计中含 LICENSE；本次未重取 tarball。 |

许可文件缺失的证据为 [web-search 固定树](https://api.github.com/repos/ttttmr/pi-web-search/git/trees/d6eb1d76ad51797a15a483dea169f24b7b46d8ff?recursive=1) 与 [context 固定树](https://api.github.com/repos/ttttmr/pi-context/git/trees/0235d4e762bb253fb1c4f781def0bc9eecbc4c45?recursive=1)，不把 npm 的 MIT 字段等同于已取得完整版权文本。

[tools]: https://github.com/YoungSx/piem/blob/361b89e60cb860a7e41db859685aa27c873a2d09/docs/tools.zh-CN.md
[host]: https://github.com/YoungSx/piem/blob/361b89e60cb860a7e41db859685aa27c873a2d09/src/extensions/extensionHost.ts
[bridge]: https://github.com/YoungSx/piem/blob/361b89e60cb860a7e41db859685aa27c873a2d09/docs/pi-extension-bridge.zh-CN.md
[search-entry]: https://github.com/ttttmr/pi-web-search/blob/d6eb1d76ad51797a15a483dea169f24b7b46d8ff/src/index.ts
[search-api]: https://github.com/ttttmr/pi-web-search/blob/d6eb1d76ad51797a15a483dea169f24b7b46d8ff/src/api.ts
[search-utils]: https://github.com/ttttmr/pi-web-search/blob/d6eb1d76ad51797a15a483dea169f24b7b46d8ff/src/utils.ts
[clarify-source]: https://github.com/dodo-reach/pi-clarify/blob/aa2a7a1fa3446cd2700fcd68e10158b2809b10ac/extensions/clarify.ts
[context-source]: https://github.com/ttttmr/pi-context/blob/0235d4e762bb253fb1c4f781def0bc9eecbc4c45/src/index.ts
[context-ui]: https://github.com/ttttmr/pi-context/blob/0235d4e762bb253fb1c4f781def0bc9eecbc4c45/src/context.ts
[firecrawl-source]: https://github.com/ben-vargas/pi-packages/blob/fc0a6ac2bfb712f8e4d0fbf72857fff629837619/packages/pi-firecrawl/extensions/index.ts
[template-source]: https://github.com/nicobailon/pi-prompt-template-model/blob/accfa7817f78942d918e436405cb4f1a90afa23a/index.ts
[template-process]: https://github.com/nicobailon/pi-prompt-template-model/blob/accfa7817f78942d918e436405cb4f1a90afa23a/deterministic-step.ts
