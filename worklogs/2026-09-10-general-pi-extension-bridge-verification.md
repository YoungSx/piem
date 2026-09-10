# 通用 Pi 扩展桥实现与验收

初始基线：`18510dc634987cb2ddb7cc5711507811c8c9eb9c`。最终同步基线：
`e222db16da7a06e54e2dea3ab776308f40cf66f0`。日期：2026-09-10。

## 范围与选型

[市场调研](2026-09-10-node-compat-bridge-landscape.md)核对 6 种方案，没有能直接
提供手机 Obsidian/Vault/Pi 语义的现成整套桥。继续复用 Pi 官方实现及 pathe/events。

- `createExtensionHost` 统一运行原版 loader、runner、event bus、tool wrapper。
  书签及社区扩展是两个真实适配，使用不同读视图，不建立影子 CLI 会话。
- 构建清单登记 4 个固定版本包、虚拟根目录及所有编译源码摘要；包中未审核源码、
  未批准依赖和未实现 Node builtin 会失败，动态加载及 TUI 仍被产物门禁禁止。
- 按优先级接入原版 `pi-assistant-provenance` 0.1.0、`pi-model-switch` 0.2.0、
  `pi-invisible-continue` 0.3.11。它们默认启用，随插件发布，不下载执行外部代码。
- 模型目录只返回配置了密钥且无歧义的模型；切换在当前调用者会话中保存并通过
  `prepareNextTurn` 应用。源码及元数据不包含密钥。上游零价格在工具及文档中解释
  为未知。设置保存失败不能报告成功。
- `/continue` 与 Obsidian 的 **继续当前任务** 命令使用相同上游 handler，走原有
  消息队列、run ledger 和持久化。隐藏标记不进入正常模型请求或可见消息。
  同名模板/技能保留短名，扩展可通过 `/extension:continue` 及斜杠菜单调用。
- 上下文错误不静默跳过；卸载令已捕获命令/API 失效，并清理订阅。无新增 watcher、
  定时轮询、进程或后台安装器。
- 英中手册、设置披露、第三方许可均随改动更新。现有宣传截图没有被这些新增
  命令和设置文字改变；运行验收新增截图单独记录，不冒充用户真机截图。

## 本地门禁

- `npm run verify`：构建、bundle/skills/copy/CSS/version 检查、**3305 tests**、lint 全过。
- **207 个测试文件逐个单独运行全过**；记录 `/tmp/piem-general-bridge-independent.json`，
  修复后重跑总耗时 59.86 秒。构建先于 bundle-load 测试。
- 无 Node 的 VM 中加载真实 `main.js`，真实 ObsidianAgentService + HTTP 协议适配
  验证 9 条社区流程：次轮模型切换、来源标注、无提示继续及重载、焦点隔离、
  模型日志写入失败、缺少密钥，以及停止时移除排队继续。
- 原版宿主和构建定向测试另覆盖不支持注册、重名、上下文失败、释放后接口、
  事件订阅、静态资源和未审核源码。
- 首轮全量发现产物门禁测试的模拟清单缺少新扩展，修正夹具后重跑全绿。
- 最终同步后的手机 smoke 揭示脚本只等停止流式输出、未等存储收尾；将单次等待
  改为检查会话准备和同步均空闲，没有增加重试命令。

## 真实 Obsidian runtime smoke

隔离目录 `/tmp/piem-community-smoke-beqoeqe0`，只含测试笔记、测试会话和本机假密钥。
Obsidian 1.13.7，虚拟显示 `:96`，调试端口 `127.0.0.1:9341`。进程低优先级、禁 GPU，
由带硬超时的父进程管理；每次测试的 HTTP server 和 WebSocket 都在 finally 关闭。

`node scripts/smoke-community-obsidian.mjs 9341 <directory>`：

- **39 项桌面断言通过**，8 次真实 OpenAI-compatible HTTP/SSE 测试请求。
- 第一轮 Alpha 调用原版 `switch_model`，下一请求实际为 Beta；会话日志和默认选择
  一致。随后手动切回 Alpha，在后续请求看到 Beta 来源标注。
- 原生命令、斜杠继续、隐藏标记持久化与过滤、空会话拒绝、书签仍可用。
- 连续 3 次卸载/重载，旧宿主不能继续工作，书签和继续均恢复，监听注册稳定 22。

官方 `app.emulateMobile(true)` 后设置 390 × 844，再加 `--expect-mobile`：

- **44 项手机模拟断言通过**，8 次真实 HTTP/SSE 测试请求。
- `app.isMobile`、`is-phone`、`emulate-mobile` 均真实成立。
- 在 Obsidian 注入给插件的同一个 require 中做六项负对照：fs、node:fs、
  node:fs/promises、child_process、node:module、electron 均拿不到模块。
- 实际插件在 4 次加载和全流程只请求 `obsidian`，没有 Node/Electron 请求。
- 无非对照 console error、renderer error 或 unhandled rejection。
- 手机斜杠菜单真实渲染 `/continue 继续当前任务 扩展`，277.6px 宽，没有横向越界。

原有 `scripts/smoke-bookmark-obsidian.mjs --expect-mobile` **41 项再次通过**：
标签保存/移除、失盘重试、会话隔离、同步、分叉、3 次重载、保存中删除不复活；
进程创建 0，新增 ChildProcess/FSWatcher/FSEvent 句柄 0。

最终测试产物：

- `main.js`：1,822,186 字节。
- SHA-256：`7ad617f5d26297f867a0a27d38a1d86dae12e2dea1759486165189e190a5c6f9`。
- 桌面/手机/书签三份结果的 SHA 相同。bundle 门限 1.74 MiB；既有 1 处容忍的
  opaque dynamic import 未增加，手机全流程未触发它。
- 本次启动的 Obsidian 和 Xvfb 已退出；调试端口已关闭，见 `cleanup.json`。

原始结果和截图（临时目录可能由系统清理）：

- `/tmp/piem-community-smoke-beqoeqe0/community-desktop.json`
- `/tmp/piem-community-smoke-beqoeqe0/community-mobile.json`
- `/tmp/piem-community-smoke-beqoeqe0/results-mobile.json`
- `/tmp/piem-community-smoke-beqoeqe0/community-mobile-menu.png`
- `/tmp/piem-community-smoke-beqoeqe0/cleanup.json`

## 独立 review

两个 Paseo 只读子代理分别审查规范、需求，均使用固定基线
`18510dc634987cb2ddb7cc5711507811c8c9eb9c` 及用户任务描述，没有修改代码或运行测试。

- **规范轴**：P1 卸载后旧宿主回滚设置；P2 停止与异步运行登记竞争。
  通过所有权检查禁止失效宿主再次写入；运行登记使用独立短期占用，取消后
  只结清局部 runId。复审确认两项解决、无新实质缺口。
- **需求轴**：P2 跨聊天继续时日志用了全局默认而非真正的会话模型；P2 同一个
  运行登记竞争。日志改取 `agent.state.model`，全部四个运行入口检查取消结果。
  复审确认两项可关闭、无残留问题。
- 三项去重后的发现均先在真实 bundle + 无 Node VM 测试中复现红灯，再修复到绿灯。
  取消后复查无未关闭 operation，且下一次继续成功；卸载回滚从两次旧设置写变为
  一次已开始的写；模型记录在请求期间与完成后均匹配实际请求。
- 修复后的 205 项定向回归、同步主分支后的 3305 项全量，以及桌面 39 / 手机 44 / 旧书签手机 41
  均重跑通过。早期内置协作通道多次断流，最终独立 review 由 Paseo 通道完成。

## 验证边界

这是实际 Obsidian 的官方手机模拟，加上始终没有 Node globals 的 VM；没有连接
真实 iOS/Android 硬件。系统 WebView、软键盘、后台冻结/恢复仍需真机检验，不能
称为“手机真机完美运行”。本机确定性模型端点只检验协议及运行路径，不证明云端
模型会自主选择正确工具。上游 aliases/provenance 配置未挂载，完整 Node/终端和
任意动态 npm 扩展不在支持范围。单条已经开始的 Vault 写入不能物理取消。
