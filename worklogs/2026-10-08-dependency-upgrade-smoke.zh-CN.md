# 依赖升级后的真实 Obsidian smoke（2026-10-08）

功能验证取得 **17 组、34 次通过结果，共 1132 个检查点**，包含 15 组正式产物验证与 2 组测试专用桥接契约。首次记录时 **自动组合冷启动不能报全绿**：`obsidian-rig.py --smoke smoke-codemode-obsidian.mjs` 多次在 MCP 握手处超时；按 rig 已支持的分离启动方式，在独立虚拟桌面里执行同一脚本，桌面 34 项、手机模式 39 项通过。**该启动差异的根因此后已确认并修复**，仍然没有用盲目重试或扩大超时掩盖它：浏览器进程启动后约 25 秒才读完持久化 cookie 存储，在此之前 `URLRequestHttpJob::Start` 把每个带 cookie 的请求挂在该加载之后——Obsidian `requestUrl`（MCP 挂载走的通道）正在其中，15 秒的握手预算必然用尽。rig 现在在交接前等一次带 cookie 的 `requestUrl` 探针落地，组合冷启动桌面与手机模式均通过；摘掉该门禁的对照立刻复现原始超时。根因证据与复现方法见[真机 smoke 台](../docs/obsidian-smoke-rig.zh-CN.md)第 12 条。

## 环境与产物

- 真实 Obsidian 1.13.7，Electron 43.3.0 / Chromium 150，Linux aarch64，Xvfb 独立虚拟桌面和临时笔记库。
- 手机使用 Obsidian 官方 `app.emulateMobile(true)` 与 390×844 视口；主要功能同时验证插件加载器的 Node 拒绝负对照。
- iOS 原生模拟器不可用（宿主不是 macOS/Xcode）；Android SDK/模拟器未安装。**以上不是 iOS/Android 真机或原生模拟器结果。**
- 模型和 MCP 请求使用本地确定性 HTTP 服务；没有使用用户凭据。没有验证真实商业模型、OAuth 登录或运营商网络。
- 正式 `main.js`：3,659,180 字节，SHA-256 `d2eca99077227baf6bef7321096fb705a25159d96ac6711b47b3a88164495829`。所有正式产物用例笔记库中的文件已与该构建逐一比对。
- 新版内置技能由构建的 `dist/builtin-skills.json` 安装到临时笔记库，保留真实文件摘要与安装状态；没有拿已发布旧版本的资源冒充本次依赖升级后的资源。

## 覆盖与结果

下表只列最终功能验证；早期失败记录保留在证据目录，MCP 自动冷启动当时的限制与此后的根因修复见首段。两个契约用例的测试专用构建不计为正式发布产物验证。

| 功能 | 桌面 | 官方手机模式 |
| --- | --- | --- |
| 持久化、中断恢复与防重复写入 | [19 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/durable/durable-desktop.json) | [24 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/durable/durable-mobile.json) |
| 模型切换、继续任务、重载 | [40 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/community/community-desktop.json) | [45 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/community/community-mobile.json) |
| 搜索、改写、检查点与上下文压缩 | [105 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/research-extensions/research-extensions-desktop.json) | [110 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/research-extensions/research-extensions-mobile.json) |
| 书签、写入失败、删除与同步 | [36 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/bookmark/results.json) | [41 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/bookmark/results-mobile.json) |
| 工作流 Worker、并行与恢复 | [12 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/workflow/cleanup.json) | [13 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/workflow/cleanup.json) |
| 待办组件与状态恢复 | [16 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/rpiv-todo/rpiv-todo-desktop.json) | [20 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/rpiv-todo/rpiv-todo-mobile.json) |
| 主动上下文与后台工作 | [13 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/proactive/proactive-desktop.json) | [17 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/proactive/proactive-mobile.json) |
| 原生扩展输入、对话框与生命周期 | [18 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/extension-ui/native-extension-desktop.json) | [19 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/extension-ui/native-extension-mobile.json) |
| 会话存储、加载与历史 | [38 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/session/session-performance.json) | [38 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/session/session-performance.json) |
| 定时触发与重载后恢复 | [11 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/scheduler/scheduler-desktop.json) | [11 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/scheduler/scheduler-desktop.json) |
| 回复后的两阶段建议 | [4 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/reply-suggestions/reply-suggestions.json) | [4 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/reply-suggestions/reply-suggestions.json) |
| 模型标识与切换 | [11 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/model-icon/model-icon.json) | [11 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/model-icon/model-icon.json) |
| Obsidian 设置读写 | [14 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/settings-api/settings-api.json) | [14 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/settings-api/settings-api.json) |
| 排版、主题、宽内容与文字缩放 | [128 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/typography/typography.json) | [128 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-mobile-extra/typography/typography.json) |
| MCP、QuickJS、图片、取消及资源回收 | [34 项通过](/home/ubuntu/piem-dependency-smoke-20261008/mcp-manual-cold/desktop.json) | [39 项通过](/home/ubuntu/piem-dependency-smoke-20261008/mcp-manual-cold/mobile.json) |
| 通用扩展契约（测试专用构建） | [30 项通过](/home/ubuntu/piem-dependency-smoke-20261008/generic-ui-final/generic-bridge-desktop.json) | [29 项通过](/home/ubuntu/piem-dependency-smoke-20261008/generic-ui-final/generic-bridge-mobile.json) |
| 后台扩展契约（附加测试模块） | [20 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/background-bridge/background-bridge-desktop.json) | [20 项通过](/home/ubuntu/piem-dependency-smoke-20261008/final-production/background-bridge/background-bridge-mobile.json) |

## 本轮修正

1. 新版 Anthropic API 导入环境变量元数据时连带加载了 Pi 的 Node 环境探测模块。在真实 Electron 中产生未处理的 `node:fs`、`node:os`、`node:path` 动态导入错误。`pi-extensions.mjs` 现在为两处 provider 环境模块绑定现有的私有浏览器进程视图；原版常量、显式环境覆盖及 provider 实现保留。新增回归检查确认不读取宿主 PATH，也不发起 Node 动态导入。
2. 更新 smoke 数据与定位：书签故障注入跟随当前持久化写入；待办定位当前专用卡片；排版场景显式展开 trace 来测独立条目边界；弹出菜单等待正确处理尚未挂载的按钮；图片测试改用有效 PNG。
3. 通用契约构建补齐真实 Codemode/WASM 资源；rig 安装匹配本次构建的技能，并支持没有专用移动参数的脚本通过 `--mobile-only` 验证手机模式。

## 验证与证据

- 修正后 `npm run verify` 通过：构建、bundle/skill/copy/CSS/version 门禁、4,463 项测试、lint。
- 新增 Anthropic 环境回归先失败后通过；`scripts/pi-extensions.test.ts` 单独运行通过。
- [汇总 JSON](/home/ubuntu/piem-dependency-smoke-20261008/summary-final.json) 包含所有报告路径、计数和未闭环项。
- [桌面恢复截图](/home/ubuntu/piem-dependency-smoke-20261008/final-production/durable/durable-desktop.png)、[手机恢复截图](/home/ubuntu/piem-dependency-smoke-20261008/final-production/durable/durable-mobile.png)。
- [桌面 Codemode 报告](/home/ubuntu/piem-dependency-smoke-20261008/mcp-manual-cold/desktop.json)、[手机 Codemode 报告](/home/ubuntu/piem-dependency-smoke-20261008/mcp-manual-cold/mobile.json)。
- 自动冷启动失败证据保留于 `/home/ubuntu/piem-dependency-smoke-20261008/final-codemode-desktop/codemode`。这一限制不是被后续独立运行的通过结果覆盖的，而是由根因确认后的 rig 门禁解除：带门禁的组合冷启动桌面与手机模式均通过，只摘掉两处门禁调用的对照仍复现 `Connecting to "smoke" timed out after 15s` 与 `Timed out: MCP handshake and mount`。

复现普通用例：先 `npm run build`，再执行 `python3 scripts/obsidian-rig.py "$PWD" <新的临时目录> <空闲CDP端口> --skip-build --smoke scripts/smoke-durable-obsidian.mjs`；可用 `--mobile-only` 单独跑官方手机模式。独立运行用例时省略 `--smoke`，等 rig 提示就绪，再在另一个终端运行相应 `node scripts/smoke-…-obsidian.mjs <端口> <同一临时目录>`。
