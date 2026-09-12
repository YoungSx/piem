# 原厂 OTel 扩展标准接入

日期：2026-09-12。基于主分支 `516a036`；[机器可读验收摘要](2026-09-12-otel-extension-integration.json)。

## 接入方式

- Bun Git 依赖固定到 `b1tank/pi-otel#337d1390571dacc4b07e6500ecbadabf585c19d9`，不是 npm 的同名包。上游 `package.json` 与五份生产 TypeScript 源码逐字节匹配该提交，未移植、重写或补丁修改埋点代码。
- 原始 `src/index.ts` 通过 `pi-scoped-factory:pi-otel` 编译，在默认 `CommunityHost` 注册后台工厂；15 个包的 299 个唯一文件和 7 条浏览器映射经过固定版本、源码哈希审计。
- 三个稳定 SDK 包保持上游锁文件的 `2.10.0`，避免引入同一次解析中的另一组 SDK。其余依赖由 `bun.lock` 固定；保留 MIT、Apache-2.0 与派生代码许可。
- 原生设置新增 **OpenTelemetry 收集地址**，只接收 HTTP(S) 基地址。由宿主将地址、`service.name=piem`、manifest 版本和一分钟指标周期传给原厂环境变量；不读取电脑环境变量或模型密钥。地址留空时不发送，更改后重载插件生效。
- 必要宿主修正：Stop 后重建前清理旧后台工厂；浏览器 Buffer 使用明确文件路径，避免生产配置把 `buffer/index.js` 当外部 Node 模块。产物检查守住原厂工厂和 Buffer 的实际打包。

## 验证

- `npm run verify` 全部通过：build、bundle/skills/copy/css/version 门禁、**3781 tests / 256 files / 13174 assertions**、lint。
- 六个涉及改动的测试文件逐个独立运行通过，包括默认社区宿主、超时关闭、重建期间卸载、地址编码后重载及浏览器 Buffer。
- 最终生产 `main.js` 为 **2,204,000 字节**，SHA-256：`b337aaf935a3571716b7821f040bed162c6694a13be2a40371a17b5506b504b8`。遥测依赖闭包没有外部模块；源码与产物都没有临时 Collector 地址。
- 真实 Obsidian **1.13.7** 桌面 **42 项**、官方手机模拟（390px）**47 项**通过。使用该生产产物、默认宿主及原生设置保存/重载，没有向 `main.js` 注入工厂、替换服务或使用测试 `extensionFactories`。
- 手机模拟的三次实际加载只请求 `obsidian`；6 项 Node/Electron 否定对照全部拒绝。未宣称 iOS/Android 真机通过。
- 临时启动官方 **OpenTelemetry Collector core 0.160.0 ARM64**，仅监听回环地址。发布包校验和匹配官方摘要；其原生 OTLP 接收器解析 HTTP JSON，分别输出三信号。
- 每端两次会话得到 **14 spans、56 lifecycle logs、9 种指标**：包括模型请求、真实 `read` 工具、停止后重发、HTTP 错误、删除一个会话后另一个继续。验证 trace/span ID、父子关系、会话隔离、manifest 版本、token 用量与两个错误 spans。
- 合成 `PRIVATE_` 提示、笔记正文及测试密钥未出现在 Collector 输出中。清空地址重载及卸载后均无新增记录；计时器、页面监听最终归零。

## 验证边界与清理

- 保留上游语义：模型耗时包含工具执行时间，`telemetry.sdk.language` 为上游的 `nodejs` 标签；Stop 在当前宿主重建路径中结束为 `session_shutdown`，不宣称为独立取消状态。
- 正文开关保持上游默认关闭，但模型错误文字仍进入状态与异常事件。文档和设置已披露；不承诺错误文字绝不包含笔记内容。
- 未补完整子代理内部埋点，也不保证慢网下最后一批数据必达。三种信号的出口均按上游实现，不改为其他平台 SDK。
- Collector 进程、二进制、压缩包、配置与原始遥测文件已删除。临时 Obsidian、Xvfb、模型服务全部退出，临时 vault/profile 已删除，两个监听端口已关闭；没有修改用户自己的 vault 或 Collector。
