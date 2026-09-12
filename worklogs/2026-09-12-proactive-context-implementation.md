# 主动上下文菜单实现与验证

2026-09-12。承接 [API 调研](2026-09-11-obsidian-proactive-context-audit.md)，实现文件夹、多选、外链右键，以及无选区时询问整篇笔记。

## 最终行为

- 四种菜单使用 Obsidian 原生 Menu，事件通过 `registerEvent` 统一清理；只在用户点击后准备上下文。
- 文件加入当前对话的固定引用，最多 8 个；其余文件及文件夹路径追加到已有草稿，并报告加入、重复、追加及不可用数量。URL 仅接受 HTTP/HTTPS，明确标为外部网页。
- 共享交付路径等待真实会话就绪；批量固定一次通知。草稿按所属会话等待加载，不在切换期间串到另一个对话；加载时输入框只读，超出草稿存储预算不静默截断，关闭面板未交付也有说明。
- 手机输入框折叠时，加入引用后展开、聚焦并滚动到草稿末尾。
- 活动正文和 `get_active_note` 读取按路径匹配的实时编辑器文本，包括未保存修改；没有编辑器才回退 Vault 内容。路径被冻结后，用户切换笔记不会读成新笔记。
- 文本拖入保留浏览器原生行为；图片仍走原有附件处理，其他文件拖入给出使用上下文菜单的说明。
- 中英文说明同步到 `docs/settings`。没有新增依赖，没有为了上下文入口新增能力开关。

## 本地验证

CI 固定 Bun 1.4.0。原环境缺少 Bun，本次从 npm 官方发行包按 SHA-512 完整性校验后解到 `/tmp/piem-context-runtime-20260912/`，没有修改全局运行时。

- 首次文件引用、草稿尚未加载、实时编辑器正文三条回归均先确认失败，再用实际服务/界面链路修复。
- Standards 审查未发现阻塞；Spec 审查提出慢草稿手动输入、单项关闭反馈、手机折叠三条问题，已修复并逐条复核。
- `npm run verify`：**3,780 pass / 0 fail，252 个测试文件**，构建、bundle/skills/copy/css/version 检查及 lint 全部通过。
- 最后新增的输入框滚动修正再次运行 build、lint、bundle/copy/version 检查及相关 UI 测试：**118 pass / 0 fail**。
- 修改过的测试文件均单独运行通过，包含 `ObsidianAgentService.test.ts`、菜单、ChatApp、ChatComposer、noteEditor。
- 同一锁文件、同一依赖下独立构建默认分支：2,002,780 B；最终实现 2,009,903 B，增加 **7,123 B**。新增打包模块仅 `contextRequest`、`noteEditor`；门槛按现有规则从 1.91 移至 1.92 MiB。

## 真实 Obsidian

隔离 Vault：`/tmp/piem-context-smoke-20260912/vault`，独立 profile、Xvfb、Obsidian 1.13.7 arm64。没有操作用户 Vault。请求验证使用本地确定性 HTTP 服务，没有调用外部模型。

- 文件夹真实右键菜单出现，冷服务首次打开后目录进入草稿；目录不伪装固定笔记。
- CDP 原生鼠标输入在 Explorer 选中 20 个文件，真实多选右键提供入口；全部目标可在固定引用和草稿的并集中找到，数量提示准确。DOM 合成 click 无法可靠模拟 Explorer 选择，不作为这项证据。
- 实际编辑器无选区/有选区菜单和阅读视图外链菜单均验证；先前草稿保留。
- 最终大部分逻辑构建的本地 HTTP 请求包含全部 20 个文件、目录和 URL。故意让 `cachedRead` 返回旧文本时，请求仍包含真实编辑器的新文本。该测试只证明传输内容，不证明真实模型的理解质量或任意网页抓取成功。
- 官方移动端模拟分别检查 1024px 和 **390px phone**；最终构建确认引用能展开输入框、聚焦且滚动到新增引用。没有实际 iOS/Android 软键盘或长按手势测试。
- 最终成品 SHA-256：`a0d5cd190afc3f3e5cc1cd22a31ea7a46fef0c3f40f71e2b8b70de732c20c5e8`。最后两行 `scrollTop` 修正单独重验手机；此前桌面/HTTP 验证的成品 SHA 为 `04c47750ef485697975f4d47dc98b818332b8a31b71a9225183f0b3f3159d084`，不混称同一成品。

证据目录包含 `final-desktop.json`、`real-multiselect.json`、`model-request.json`、`final-phone.json/png`、`final-bundle.json`、`final-unload.json`、`cleanup.json`、`verification-summary.json`。截图已查看。临时文件可能被清理；源码回归测试保留在仓库。

宿主按本次父进程时限重启过；日志中有 `GPU process isn't usable`，不能把功能验证说成宿主图形稳定性保证。每轮关闭都回收所属子进程；最终卸载后 runtime 为 0，Obsidian/Xvfb 和收养的 Electron 子进程均已退出，CDP 端口关闭。用于体积对照的临时 worktree 已删除。

当前菜单交付使用固定引用和草稿。Pi 原生 `CustomMessage`/文件标签及结构化卡片可行性的补查，见调研报告最后一节。
