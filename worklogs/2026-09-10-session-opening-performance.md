# 历史会话冷开与笔记切换性能审查

2026-09-10，审查发布版 `1.0.70`（`f6a696f3d4b318286f5edf594285e1ea905cf404`），并在独立 Xvfb 桌面运行实际 Obsidian。用户补充的症状是：同一会话首次打开慢，热切换正常，重新启动应用后又慢。

## 已证实的原因与修复

1. **已知路径的冷开先读取全部历史文件。** `loadSession → findMetadata → repo.list` 枚举所有 cwd 子目录；Obsidian 的 DataAdapter 没有部分读取接口，Pi 所需的一行 header 实际会读取整份日志。34 份会话的样例库中，打开一份会话发生 35 次日志读取，含 33 次无关读取；再次打开命中 `hydrated` 后为 0。重建 manager 会重复这些读取。正常样例日志没有发生写回，其 SHA-256 不变，不能将这种现象归因于迁移未持久化。
2. **读取期间没有状态通知。** 原 `openSession` 直到读取、准备 agent 都完成才通知面板，忙碌标记为 false，也没有加载动画。现在冷选择同步发布 opening 状态，旧标题、正文与草稿保持一致，准备成功后一次提交焦点；失败、取消、快速连选和卸载均有回归。热选择保留摘要刷新而不先绘制旧会话的 loading 帧。
3. **切笔记重新遍历完整历史并构建消息子树。** Markdown 本身已有 sourcePath ref，不会因切笔记重跑，但折叠计划、消息行、图标和动作仍重建。历史子树现使用 React memo；40 条消息的仅笔记变化回归由 161 次正文访问降为 0。流式更新绕过 memo，消息条数单独捕获，覆盖 Pi 原地追加且快到没有中间 streaming 帧的回复。

已知路径现在只读取目标 header 和目标日志，两次读取均为目标文件。使用依赖本身的 `parseHeader` / `metadataFromHeader`，保留原来的一层 cwd 目录边界、旧 cwd 名、文件重命名与损坏日志拒绝。仅加载期间的 Promise 合并并发请求，不新增持久化缓存。`prepareSession` 与同步 `focusSession` 分离，使准备未完成时原会话仍是唯一焦点。

正常日志的打开保持零写入；Pi 既有的断尾及缺尾换行修复行为没有改变，因此这不是对所有损坏文件的零写保证。

## 实际运行验证

宿主为 Linux ARM64 的 Obsidian 1.13.7、Electron 43.3.0、Chromium 150.0.7871.212，独立配置与样例 Vault。没有真实 provider key，也没有请求模型。

可提交的复现入口：

```bash
node scripts/smoke-session-obsidian.mjs <CDP-port> <output-dir>
```

脚本要求当前 Vault 精确等于 `<output-dir>/vault`。它使用已安装 bundle 的原生 manager 生成 160 条消息与 6 份无关历史，验证真实 service、ChatApp 与 Vault API，并输出 `session-performance.json`、`session-loading.png` 和 `session-opened.png`。

最终 bundle：1,857,788 字节，SHA-256 `18d6c605ad15422d432fb57be54e24c0059859f77fb77c8d9581ed43eb622681`。安装副本与本地构建一致。相对发布基线增加 4,265 字节，无新依赖；按既有规则将 bundle 上限从 1.77 MiB 提至 1.78 MiB，其余依赖组成检查保持通过。

最终脚本 **32 项检查通过**：

| 场景 | 结果 |
| --- | --- |
| 冷打开 | 2 次目标日志读取，0 次无关读取，160 条消息完整恢复 |
| 热打开 | 0 次日志读取 |
| 新 manager / service 再打开 | 仍为 2 次目标读取，0 次无关读取 |
| 会话保存 | 目标 SHA-256 不变，正常打开 0 写入 |
| 人为按住目标读取 | 旧正文保留，`aria-busy=true`，显示“正在打开对话…”，发送禁用 |
| 动画 | `pi-spin` 的 `currentTime` 实际推进；不是只检查 CSS 声明 |
| 笔记切换 | 真实 leaf 获得焦点，active-note context 更新，原消息数组复用，0 次日志读取 |
| 清理 | 0 个 renderer 异常；所有临时 service dispose 后 runtime 总数为 0 |

最终小样本 service 冷开记录为 10.0 ms，重建后 8.9 ms，热开为 1.4–1.6 ms。这些不含挂载整篇聊天的排版，不能作为用户实际开窗耗时。人为延迟仅用于观察 loading UI，不计入性能结果。

另用 34 份会话、单份 400 条消息（目标 362,226 字节，总样例历史约 11.4 MiB）复现原问题。修复后冷选择记录到 2 次读取、0 次无关读取。也实际停止并重新启动 Obsidian 进程，再次打开仍为 2 次读取且源文件未变。真实文件树点击会更新笔记与聊天上下文：最终两次长会话笔记切换记录约 93–147 ms 至观察窗口结束，没有 50 ms 以上 long task；原版对应记录约 313–373 ms。测量包含两帧与读空闲等待，部分基线开了 CPU profiler，机器还有其他任务，**这些是诊断记录，不是受控速度比**。

## 未解决的边界

- **长历史首次 Markdown 排版仍有停顿。** 所有 400 条消息完整挂载，原生 Markdown / Prism 高亮和布局仍会占用主线程；最终观测约 0.8–1 秒，真实进程重启的一次观测约 2.7 秒，期间包含长任务。此次没有引入虚拟滚动、截断历史或延迟 Markdown，也不能承诺这段停顿里的动画保持流畅。
- **会话列表与内容搜索仍会扫描历史。** 优化的是已知路径的单份打开；打开面板填充历史列表、无有效“上次打开”记录的回退路径，仍可能支付全库读取成本。
- 样本为当前 Pi 原生 JSONL 历史，没有用户实际慢文件。确认的是本次可重复的读取放大和界面更新问题，并未验证任意旧格式迁移。
- 只验证桌面 Electron。未验证移动真机或 WebKit；已有 reduced-motion CSS 没有改动，本次真实动画检查使用正常动效模式。

本地 `npm run verify` 全部通过：构建、bundle/skills/copy/css/version 门禁、**3,414 项测试（218 个文件）**、lint。新增 sessionOpen、sessionOpening、transcriptUpdates 文件也分别独立运行通过；流式、后台会话、草稿、失败恢复、存储并发均有回归。

本机证据在 `/home/ubuntu/piem-session-smoke-20260910/`，包括最终 JSON、截图、进程重启记录、CPU profiles 与 `verify.log`。本次 Xvfb 的前两轮宿主出现 `GPU process isn't usable` 退出，后续实例完成了最终烟测；未将功能通过当作图形驱动问题已解决。最终主动卸载插件、确认 runtime 为 0，停止并 wait 回收所属 Obsidian / Xvfb 及其 Electron 子进程，CDP 端口关闭。没有操作其他任务的桌面实例。
