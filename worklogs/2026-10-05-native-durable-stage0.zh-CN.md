# Durable 原生对齐：阶段 0 实施记录

基线：`9a3211f`。本阶段完成依赖升级、兼容契约和原生存储预备验证；生产仍使用现有 Agent 循环，不宣称阶段 1–5 已完成。

## 变更

- Pi 六个直接依赖与相关 overrides 统一固定为 1.0.2，锁文件没有升级无关依赖。
- npm 原版 pi-coding-agent 1.0.1 与安装的 1.0.2：28 个受审文件逐字节一致。仅更新扩展审计版本和对应版本断言，哈希、导入限制及宿主权限不变。
- 新增原生 Harness 契约测试：provider session 身份跨重试和重开稳定，fork/子会话隔离，旧会话补身份。
- 新增原生 Vault 存储预备测试：generation/tool 所有权重开、unsafe 写入结果缺失后的恢复、requestId 去重、Stop 排空前取消标记保存。使用 MemoryAdapter，不冒充真实 Obsidian 测试。
- 全量测试暴露旧 rename 弹窗测试竞态：轮询可能错过 30–60ms 的消失窗口。仅将该测试改为显式时钟和轮询步骤，保留 answered/零 Escape 断言；生产代码未改。

## 验证

- `npm run verify`：构建、静态门禁、4456 项测试、lint。
- 独立测试：nativeProviderIdentity 3 项/25 断言；nativeVaultExecution 2 项/21 断言；pi-extensions 11 项/59 断言；linkUpdateConfirm 8 项/12 断言。
- 真实 Obsidian 1.13.7 虚拟桌面，运行 `scripts/obsidian-rig.py` 和 `scripts/smoke-durable-obsidian.mjs`：桌面 1024×800，19 项；官方手机模拟 390×844，24 项。两端均只写入一次。
- 手机插件平台标志为 isMobileApp=true、isDesktopApp=false；官方加载器拒绝 fs、node:fs、node:fs/promises、child_process、node:module、electron 六项负对照。
- smoke 与最终构建产物 SHA-256：`13d1e58eeae8b2341013fe03b1a8c12e399cd5f1b04153447b222d3c96fb077a`。
- 本机证据：`/home/ubuntu/piem-native-stage0-20261005/` 下的 durable-desktop/mobile.json、同名 PNG 与 summary.json。截图已目视核查；CDP 9356 关闭，无残留台子进程。
- 手机受限模拟不等于 iOS/Android 真机；smoke 验证升级后的生产旧执行链，新原生链目前仅由契约实验验证。

## 子代理审查

- Standards：独立核对依赖、28 个审计哈希、测试独立性和资源释放，无阻断发现。
- Spec：独立核对计划和行为契约，无阻断发现；明确未把实验说成生产迁移。
- 追加复核：版本断言更新、rename 确定性测试修复、原生 Vault 测试均由非作者复核。两项强化建议已落实：去重核对消息/调用数量；Stop 快照直接核对 running+abortRequested。

## 下一阶段的明确门槛

1. Models.getModel 尚不能解析自定义端点的配置模型；需要沿用已有转换和 provider 注册，并处理配置热更新及相同 API ID 的不同配置行。
2. Piem 的历史投影与 UUID 索引仍假定 Piem 写入元数据；不能直接把原生条目送入旧读路径。
3. 原始 Vault 日志已证实能保留完整任务树，但两份分歧任务树没有现成的官方合并/重映射接口；必须保留执行证据和取消凭证，不能继续套用单运行快照。
4. finishTurn 的可写边界、无用户消息继续、立即 steer 与原生 hooks/inbox 的语义差异保持为未解决门槛，见同行契约文档。

每个后续阶段仍需独立审查、问题修复、真实 Runtime smoke 和该提交的 CI 验收。
