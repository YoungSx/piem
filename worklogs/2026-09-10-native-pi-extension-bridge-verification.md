# Pi 原生界面桥接与验收

日期：2026-09-10。实现基线：`63cc317d2f585499978f71b7b66ff391c546cca9`。

用户要求优先评估 `pi-suggest`，同时独立补齐可复用桥接，并明确 Piem 使用
Obsidian 原生界面。此次没有安装该候选，也没有替换现有 quick actions。
[候选评估及纯逻辑复现](2026-09-10-quick-actions-community-alternatives.md)独立记录。

## 交付行为

- 沿用 Pi 原版 loader、Runner、工具包装器；新增生命周期、真实会话分支读视图、
  模型目录和 `complete`。不创建第二套会话引擎，不把未持久化消息伪造为日志条目。
- 原生 Modal 承接选择、确认、输入和多行编辑；当前会话草稿支持读取、替换、
  按选区粘贴；文本组件和状态显示在输入框上下方。扩展补全使用原生列表，
  空框可选择 **显示建议**，触控可用，保留斜杠菜单和 Tab 焦点导航。
- 有面板时准确报告 `rpc` / `hasUI:true`，无面板时为 `print` / false。
  终端组件工厂和终端渲染没有引入；不支持的接口明确失败。
- 按实际处理器管理取消归属：先完成的启动回调不被后一个取消的处理器误杀；
  未完成调用、旧会话和释放后的接口不能晚写新草稿。重开面板恢复文本和有效
  补全，不重复发送 `session_start`。关闭清理最多等待一秒。
- 模型请求只选择已配置的 provider/id，经 Piem 鉴权与网络通道；不把 key 或
  认证头交给扩展。参数白名单、防验证后修改，每会话最多两个请求、60 秒超时；
  `requestUrl` 停止后的真实网络请求结束前仍占位，不将结束等待说成物理取消。
- `before_agent_start` 的系统提示仅作用于当前轮，自定义消息照常落盘；失败不
  留未关闭运行记录。观察事件报错会显示错误，但不跳过回复保存和运行收尾。
- 草稿读写补齐必要竞态：迟到磁盘读取不能覆盖新输入，切换期间的旧 setter
  只写原会话，外部预填始终绑定当前会话。没有新增能力开关。

## 验证

`npm run verify` 全部通过：TypeScript、生产 bundle、skills/copy/CSS/version 门禁、
**3377 tests / 0 fail / 11053 assertions**，以及全仓 ESLint。

新增或修改的 **13 个测试文件逐个独立通过**；另单独运行代理服务既有 196 项
回归。独立文件记录：`/tmp/piem-native-independent-tests.json`。完整门禁原始记录：
`/tmp/piem-native-verify.log`。测试中的 DOM 和协议替身没有冒充真实设备。

真实 Obsidian 1.13.7 在临时 Vault `/tmp/piem-native-bridge-smoke-KhoUCT/vault` 中运行，
模型端点只监听本机，凭据为测试字符串，所有请求使用真实 HTTP/SSE 协议适配。

| 脚本 | 环境 | 结果 |
| --- | --- | --- |
| `smoke-community-obsidian.mjs` | 桌面 | 39 项通过，8 次主模型请求 |
| `smoke-extension-ui-obsidian.mjs` | 桌面 | 18 项通过，5 次请求（含建议及独立完成请求） |
| `smoke-community-obsidian.mjs --expect-mobile` | 官方手机模拟 | 44 项通过，8 次主模型请求 |
| `smoke-extension-ui-obsidian.mjs --expect-mobile` | 官方手机模拟 | 19 项通过，5 次请求 |

手机使用 `app.emulateMobile(true)` 和 390 × 844 视口，验证 `app.isMobile`、
`is-phone`、`emulate-mobile`。社区脚本在真实插件加载处验证 Node 负对照，
正常插件全程只请求 `obsidian`。原生界面脚本使用本地静态测试工厂和成品中同一
Service 的依赖注入接口，验证弹窗返回值、草稿输入、补全、事件顺序、分支读取、
独立模型请求、用量、停止和 A/B 隔离；这不是 `pi-suggest` 原包集成验收。

四份结果使用同一份产物：

- `main.js`：**1,853,523 字节**。
- SHA-256：`6236f7ecc842167507fe5ad4b92de0a772a07f1a815491592068b53168e1f7f0`。
- 与基线记录的 1,822,186 字节相比增加 31,337 字节；bundle 门限按现有规则移至
  1.77 MiB。metafile 无 Pi TUI、动态安装器或新增 provider catalog。

排查中修复的真实问题和测试问题分别处理：生命周期报错跳过保存、前置失败漏
关闭运行记录、启动处理器共享取消归属、草稿异步串写均有回归；手机脚本则改为
按标题选择新弹窗，并等待宿主已有初始化/同步完成，避免操作正在关闭的旧弹窗
或把服务忙碌拒绝误判为 UI 故障。没有通过重试用户命令来掩盖产品失败。

原始结果：临时目录中的 `community-desktop.json`、`native-extension-desktop.json`、
`community-mobile.json`、`native-extension-mobile.json`；运行日志
`/tmp/piem-native-real-smoke-final.log`。临时材料可能被系统清理。

## 清理与边界

Obsidian 和 Xvfb 由低优先级、有限超时的父进程管理；每个脚本在 finally 关闭
HTTP server、CDP WebSocket、计时器和观察器。`cleanup.json` 确认本次拥有的进程
全部退出。没有安装用户 Vault，没有后台开发服务器或监听构建残留。

尚未做 iOS/Android 硬件、实际 WebView 的后台恢复，以及真实模型建议质量评测。
现有宣传截图的界面未变；只有扩展注册相应能力后才显示新增原生控件。
