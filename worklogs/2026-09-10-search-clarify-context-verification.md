# 搜索、草稿改写与会话接续扩展验收

日期：2026-09-10（2026-09-11 复验更新）。主分支基线：`539c48c0faace983ab5f0c59d2e5da63506243d7`。

验收期间主分支合入了通用 Pi 兼容层（`539c48c`：generic component factories 与
公共 completion 兼容）。本分支已 rebase 到该基线并整合：保留 compat 层的
`assertCanComplete` 门与 `snapshotModel`/`revokeAuth` 拆分，叠加本分支的
`getAuth` 桥与 `onRequest` 请求占位追踪；两套机制并存（compat 层服务静态社区
扩展，scoped factory 服务三个研究扩展的每宿主闭包绑定）。bundle 门限按合并后
实测 1,961,730 B（1.87 MiB）抬到 1.88 MiB。
用户要求接入 `pi-web-search`、`pi-clarify`、`pi-context`，完成包括手机受限环境的 smoke。

## 交付行为

- 固定三个 npm 包版本及实际编译文件的 SHA-256；保留上游工厂和 marker 解析。
  构建时把平台依赖封装到每段聊天的宿主，运行时不下载、求值扩展代码，也不替换
  全局网络或定时器。编译器只在开发工具中运行，不进入插件包。
- `web_search` 复用当前模型凭据，通过 Obsidian 网络出口处理 Responses 与
  Anthropic 原生搜索，保留来源；不支持的接口明确失败，不静默换服务商。
- `/clarify`、命令面板和 `-clarify` 通过上游改写流程返回原生输入框，用户再决定
  发送。支持原版大小写与标点规则；模型固定选择用插件设置保存。迟到改写不能
  覆盖新输入、另一个聊天或关闭后的草稿。
- 检查点标签保存后报告成功。摘要先写入单个复用暂存通道，再发布选中分支并继续
  请求；旧历史保留。保存失败不宣称成功，停止后不续跑。已开始的 Vault 写入
  可能落盘，运行状态采用真实保存结果，不由失效宿主发起回滚。
- 与本轮期间合入的原生 UI/生命周期桥整合：保留弹窗、补全、启动/结束事件、
  模型目录与完成请求限额。`/context` 使用 Piem 现有用量面板；上游终端界面没有
  被冒称为原生界面。Gemini 独有 `url_context` 在当前配置协议下不可用。
- 超时或停止及时返回；底层 `requestUrl` 未结束时仍保留占位，防止连续取消堆积
  后台请求。原生扩展 Stop 不重跑启动；流式事件不逐 token 读取历史。

## 本地门禁

- `npm run build`、bundle/skills/copy/CSS/version 门禁通过。
- rebase 后全量 `bun test`：**3518 pass / 0 fail / 11851 assertions / 228 files**。
- 真实 Obsidian smoke（rebase 后产物，SHA-256 `5dd016803f6c…`）：桌面 105 项、
  官方手机模拟（390×844）110 项、社区扩展 39/44 项、原生 UI 18/19 项、
  书签回归 41 项，全部通过；Obsidian、Xvfb 与 CDP 端点均确认关闭。
- `npm run lint`：通过。全量门禁曾发现两处 lint，修正后已独立重跑为零错误；
  最终产物重新构建并通过下述全部运行验收。
- **220 个测试文件逐个独立运行全部通过**，总耗时 79.72 秒，含最终产物加载。
- Standards 与 Spec 两份独立只读复审及修复复核均通过。发现的请求占位、超时、
  marker 分流、搜索错误状态、流式读取和停止后启动回调问题均有回归覆盖。

原始本地日志：`/tmp/piem-three-release-verify.log`（全量测试）、
`/tmp/piem-three-delivery-lint.log`、`/tmp/piem-three-final-build.log`、
`/tmp/piem-three-independent-tests.json`。临时文件可能被系统清理；
[提交的结果摘要](2026-09-10-search-clarify-context-smoke.json)保留检查名称、计数、
设备模式、产物摘要及清理证据，不包含请求正文或真实凭据。

## 真实 Obsidian smoke

真实 Obsidian 1.13.7，独立笔记库 `/tmp/piem-research-smoke-orcrn_95/vault`。
测试服务仅监听本机，使用构造数据与测试字符串密钥，完整经过插件、Pi 与
真实 HTTP/SSE 协议。没有调用付费模型来代替可重复验收。

| 脚本 | 环境 | 结果 |
| --- | --- | --- |
| `smoke-research-extensions-obsidian.mjs` | 桌面 | **105 项通过**，60 次请求，5 次重载 |
| 同上，`--expect-mobile` | 官方手机模拟 | **110 项通过**，60 次请求，5 次重载 |
| `smoke-community-obsidian.mjs` | 桌面 / 手机 | **39 / 44 项通过** |
| `smoke-extension-ui-obsidian.mjs` | 桌面 / 手机 | **18 / 19 项通过** |
| `smoke-bookmark-obsidian.mjs --expect-mobile` | 手机 | **41 项通过** |

搜索验收覆盖两种协议、真实引用链接、401 原生错误状态、无伪造来源、不支持协议
不跳服务商及停止后的迟到响应。草稿覆盖命令、编辑框来源、marker、手动发送、
认证失败、取消后占位、换聊天、卸载、固定模型重载。会话覆盖检查点、重名保护、
时间线、摘要分支父节点、旧历史保留、继续请求真正包含摘要、隐藏消息以及重载。
Vault 写入失败、停止与写入交错、60 秒超时等细粒度场景由真实服务及存储回归覆盖。

手机不是缩窄桌面截图：使用 `app.emulateMobile(true)` 和 **390 × 844** 视口，
断言 `app.isMobile`、`is-phone`、`emulate-mobile`。在 Obsidian 实际插件加载器
中探测 `fs`、`node:fs`、`node:fs/promises`、`child_process`、`node:module`、
`electron` 六种负对照，全部不可用；插件五次重载全程只取得 `obsidian`。
另有整个异步生命周期始终无 Node 全局的 VM 产物回归，拒绝动态导入。

所有运行结果对应同一最终 `main.js`：

- 大小：**1,936,212 字节**。
- SHA-256：`e5215b928eec35d7e29d05901bc51fd4507daa0805fdec1c4566afc0e0132817`。
- 三个上游工厂图分别占 31,307 / 6,262 / 11,403 字节。没有终端运行时、完整文件
  系统映像或构建编译器混入。体积门禁按原有规则调整到 1.85 MiB。

截图为该独立笔记库的真实桌面与手机渲染，保存在同一临时目录；已查看，消息列
不横向溢出。已有 README 宣传截图的基础界面没有改变，不用构造数据替换真实截图。
启动监督脚本 `run-smoke.py` 位于临时目录，串行运行上述七组，最后回收所有子进程。

## 清理与验证边界

HTTP 测试服务、CDP 连接、观察器和定时器均在 finally 清理。最终 `cleanup.json`
确认本轮 Obsidian 与 Xvfb 进程已经退出；没有留下 watch 构建或开发服务器。
没有改动其他工作区的运行进程。

尚未做 iOS/Android 真机 WebView、系统后台恢复，以及真实服务商搜索可用性或
模型改写质量评估。本轮手机结论限于官方手机模拟、Node 受限加载器和隔离 VM。
