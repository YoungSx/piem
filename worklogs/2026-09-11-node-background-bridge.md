# 通用后台扩展兼容桥

日期：2026-09-11。初始基线 `1f359926653e08ac04ee398eaf161a3d38e43b5a`；提交前已 rebase 到 `2dfe8251bfad6647da0a5cd978f86d8536cc08c6`。本轮按用户要求先补通用桥，没有安装 OTel 扩展，没有配置远程遥测接收端。

## 实现

- Pi 原生 `before_provider_request` / `after_provider_response` 连接实际 Agent streamFn。每请求捕获取消信号，旧回调不能混入 Stop 后的新回合；只传请求体和响应 metadata，不传模型凭据。普通 Agent 请求覆盖，摘要及 modelRegistry.complete 等额外请求不冒充已覆盖。
- 成功整理保存后发 `session_compact`，条目通过 append 返回的真实 ID 读取。Piem retainedTail 与 CLI 游标模型不同，firstKeptEntryId 读取明确报 unsupported，不造 ID。观察者错误不回滚保存，整理占用先释放后通知，允许观察者重入。
- 构建清单显式声明 entry/version/files、递归 dependencies 和 exports 子路径。验证全部登记源码哈希、版本和真实文件边界；拒绝未声明边、动态加载。编译后将 fetch/process/timers/Buffer 等平台访问闭合到各工厂。平台内共享 Symbol 注册仍需具体 SDK 源码审计，不宣称任意 JS 沙箱。
- Buffer 复用 buffer，SHA-256 复用 Noble，随机数走 Web Crypto；没有把完整 Node 或密码算法自行实现。固定新增依赖与许可证，纯模块仅在用到时进入产物。
- 每后台工厂私有 environment/虚拟 PID，独立 timeout/interval/promisified delay，不占聊天 busy。最多 64 timer/callback 名额；每服务最多 4 个物理请求，15 秒调用者时限，原生 requestUrl 真正结束才释放名额。Stop 不结束会话后台任务，卸载先停 interval，最多一秒清理后撤销资源。
- shutdown 使用最后有效安全 metadata，避免 service 先关闭会话后扩展不能读取 ID 而漏发最后一次数据。凭据不缓存给扩展，旧上下文和写接口仍不可用。

## 审查中修复

1. 被拒绝工厂的 complete 不能借后续操作重新请求模型。
2. 工厂抛错或注册不合规立即执行 onLoadFailure 清理，不等其他异步工厂加载完。
3. 后台配置保存使用 settled 非消费式观察；即使无关前台操作随后被取消，失败仍报告，前台 flush 也保留失败。
4. 背景配置独立于前台取消信号；微任务队列中的 interval 在执行前再次核对自身名额，shutdown 不能让它迟到再启动。
5. 依赖必须能显式声明 npm 子路径，不能只支持根入口后在安装真实 SDK 时绕过审核。

## 本地验证

- 同步主分支后的 `npm run verify` 全通过：build、bundle/skills/copy/CSS/version、**3752 项测试**及 lint。记录 `/tmp/piem-bridge-verify-rebased.log`。
- rebase 前最终代码的 **251 个测试文件逐个单独运行全过**，134.93 秒，`/tmp/piem-bridge-independent.json`；rebase 后全量 suite 再跑通过。
- 编译原始两包测试工厂，在禁 require/process/Buffer/Bun、ambient fetch/timers 的 VM 中运行。再用真实 CommunityHost 验证两会话网络、配置、哈希、周期工作与关闭隔离。
- `git diff --check`、双语链接检查通过。未提交 main.js、node_modules 或临时运行产物。

## 实际 Obsidian

使用临时 Vault `/tmp/piem-node-bridge-smoke-20260911/vault`、独立 profile、Obsidian 1.13.7 arm64、Xvfb。低优先级父进程管理，600 秒硬上限，子进程及 detached crash handlers 一并 wait 回收。期间到时重启过测试实例，首次失败均保留在终端记录；最终结果以匹配成品哈希的成功记录为准。

生产包 **2,002,780 字节**，SHA-256 `afc20bd501f3a3295c4ca0f029f97466a2bab343397d7ae4f25f2b50f62e7667`，bundle门限1.91 MiB。后台测试在生产包副本后追加静态测试工厂，结束后恢复原包；这不是生产内置扩展。

- 桌面：后台桥 20 项、社区扩展 39 项、研究扩展 105 项。
- 官方手机模拟：后台桥 20 项、社区扩展 44 项、研究扩展 110 项。
- 后台桥验证真实 requestUrl、两会话周期请求、删除一会话不影响另一个、两次 shutdown flush、模型hook改写到实际body、结束后请求不再增长。
- 结果文件为同目录 `background-bridge-{desktop,mobile}.json`、`community-{desktop,mobile}.json`、`research-extensions-{desktop,mobile}.json`，均记录所测成品SHA。服务端和CDP连接在各脚本finally关闭。

## 边界

没有测试真实 OTel SDK 的完整审计依赖图、SDK全局注册、OTLP Collector导出；本轮只提供后续接入的通用基础。事件/平台均由可重复的本地契约验收，不能把工厂夹具当作真实扩展兼容证明。Node timers返回数字，不实现ref/unref等对象；HTTP只能请求http/https；任意文件系统、进程和运行时下载执行仍禁止。手机为Obsidian官方模拟，没有iOS/Android硬件、真实WebView冻结恢复验证。
