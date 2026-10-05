# Durable 原生对齐：阶段 1 宿主适配

基线为阶段 0 的 `0497598`。本阶段交付模型、工具和原生数据适配，并在真实 Runtime 中验证。生产聊天仍使用原执行链；原生会话的 UI 路由和完整切换属于阶段 2。

## 适配与删除重复实现的边界

- `withNativeModelLookup` 将稳定配置行 ID 解析成真正的 API Model。两个配置行可共享 API 模型名而拥有不同能力；恢复和每次查找读取当前配置。chat 的 typed lookup 使用同一规则，目录/可用性查询仍暴露底层 API catalog，不建立第二套目录。
- `delegateModels` 保留官方类方法及 `this`。同时修复 `withRequestDefaults` 展开类实例导致公开方法消失的问题，所有请求入口注入已有的凭据、Vault transport、缓存及重试默认值。未添加新的重试循环。
- `nativeTool` 只桥接 Obsidian 专属工具。原版 read/write/edit 应直接通过 Harness 的 `env` 使用现有 VaultExecutionEnv；smoke 中的原版 write 没有先转成 AgentTool 再转回去。
- 工具更新是整份快照，通过 `piemProgress` details 封套替换；一笔在途写入加一个最新替换快照，避免无界队列。发出时复制内容，保存失败立即取消旧工具 signal，排空并优先上报存储错误。原生 UI 后续需识别此封套。
- 默认 `unsafe`；只有工具显式 `replay: safe` 才传递 safe。保留参数修复、执行顺序、内容、details、isError 和 usage。
- 不伪装非等价契约：outputSchema 注册时拒绝；返回 structuredContent 或 terminate=true 时明确报告“已经执行，勿重试”的兼容错误，不把“全 batch 才结束”错误映射成“任意工具结束”。这些工具尚不能切换生产，须在阶段 3 完成相应契约。

## 原生文件与恢复

- 原生格式 v7 与旧 v3/v4/v5/v6 分开。旧仓库列表不承认它，打开、快照、替换及 PiemSession 入口拒绝接管；未知格式也不得降级覆盖。
- `readNativeHistory` 保留官方 kind/model/data/entryId，生成稳定的会话内标识；严格识别到旧 Piem 元数据时保留旧 UUID。无复制写入、无伪 seq、parentId 或时间戳；重开和 fork cutoff 保持身份。
- `recoverNativeSessionCopy` 只挽救撕裂的最后一帧；通过 `Vault.create` 创建唯一副本并校验，完整重放原始提交。不经过旧的单运行快照，也不重建或重映射任务树。任何失败均保留原件和候选文件，不删除同步端可能已经改写的内容。
- 仅任务状态的远端取消也会使旧实例写入失败，保留文件内的终态/取消凭证。不提供任意分歧任务树自动合并；生产冲突分叉和用户界面属于后续接入门槛。

## 验证与子代理审查

- `npm run verify`：4485 tests、构建、lint、全部静态门禁通过。后续只增加 smoke 的积压场景与文档，再通过 TypeScript、脚本语法、copy/version 检查及定向测试。
- 修改的测试文件逐个独立运行；五项定向测试文件合计 44 tests / 184 断言通过。
- 现有 `DurableVaultStorage.test.ts` 调用官方 `createStorageConformance`，本轮独立运行 32 tests / 193 断言通过。
- 子代理分别实现后交叉进行 Standards/Spec 审查；主代理独立审查工具桥。发现并闭合：未知格式覆盖、恢复失败误删同步数据、Models 原型方法丢失及 typed lookup 不一致、进度快照引用污染、保存失败未取消工具、smoke 清理链中断。

## 最终真实 Obsidian smoke

入口：`scripts/smoke-native-adapters-obsidian.mjs`，先跑未改动执行流程的成品 durable smoke，再构建 `native-adapters-fixture.ts` 为独立测试插件，通过官方插件加载器运行。源码适配与测试插件产物分开记录；没有在成品 main.js 中加入测试导出或替换上游运行代码。

| 模式 | 成品旧执行链 | 原生适配测试插件 |
| --- | --- | --- |
| 桌面 1024×800 | 19 项通过 | 20 项通过 |
| 手机受限 390×844 | 24 项通过 | 22 项通过 |

原生检查包括：官方 write 真实 Vault 写入、结果前中断、原件保留与副本恢复、unsafe 不重复执行、成品 Obsidian 元数据工具转换、提交去重、历史/分支身份、持久化 partial 和事件积压恢复。两端各写入一次。

手机插件看到移动端平台标志；官方加载器拒绝 fs、node:fs、node:fs/promises、child_process、node:module、electron 六项负对照，实际插件加载只取得 obsidian。测试 bundle 与生产一样保留 pi-ai 的 Bun-only node:fs 环境回退引用，但 Chromium 未执行该分支；没有伪造 Node shim 来通过检查。

手机本轮观测：

- 短流式回答：4 个不同的已提交 partial；9 次追加、3474 bytes，约 734 ms。
- 故意暂缓事件消费：111 次提交，恢复后收到 11 批事件，其中 1 次完整快照，111 条记录全部恢复。
- 全场景 143 次追加、35762 bytes，最大并发追加数 1。
- 整个 renderer 的采样峰值 JS heap 为 161913689 bytes；它包含 Obsidian 和两个插件，不是本插件增量内存，也不等于精确峰值或手机真机预算。

这些是小型固定场景观测，不能替代长会话性能回归、生产 UI 积压测量或 iOS/Android 真机。

- 成品 main.js SHA-256：`0e6eb578352a53b0d635cfc30ac40858834c6962d3f6a8f649e7fd68d2336785`。
- 原生测试插件 SHA-256：`108267dbb19ede918f61e25f7dc8d766ba8a538fdb11363e17e9a2e32bceb1cc`。
- 桌面/手机分别使用相同的上述产物，报告及截图在 `/home/ubuntu/piem-native-stage1-final-20261005/`。
- 截图已目视核查，负对照通知已正常关闭；CDP 9357 与虚拟桌面进程均清理。

## 下一阶段

将一类新会话完整接入原生 submit → GenerationTask → ToolTask，并消费原生历史和进度封套。旧格式继续走旧路径；同一会话不得同时拥有两个执行引擎。主聊天扩展的 finishTurn、立即 steer、无用户消息继续，以及尚未支持的工具输出契约，仍须完成后才能全面切换。
