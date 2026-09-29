# 社区 cron 扩展收口：触发链源码钉死与「原版导入」终审

日期：2026-09-29。基线：`655777a`（research/community-cron-pi-extensions，与 origin/master 零差距）。前置：[[piem-cron-extension-survey]]（本轮把其中两处「未复核/待验证」全部钉死，无新增侦察）。

## 结论先行

1. **社区 cron 扩展「原版不改」零解，定论不变。** 最优候选 `@vincentff/pi-scheduler@1.0.3`（MIT，零依赖，单文件）源码级复核通过触发契约，但存档路径是三层嵌套，照原样进不了 piem 的命名空间 KV——要补路径翻译才能活。
2. **决定性缺口钉在后台定时器不投递**：`extensionResources.ts` 的 `schedule()`（:61-79）fire 时只跑 `timer.callback(...)`，不接 `afterTimer` → 消息进 `pending` 后永远没人调 `deliver()` → 闹钟响了悄无声息。前台 scoped 路径（`extensionPlatform.ts:280-298`）有完整 `before→callback→after` 包裹但 `requireScope()` 挡死 idle 挂载。两处合起来 = 一处 ~20 行的桥修可解，不碰 ObsidianAgentService。
3. **最懒且对的出路仍是自写 ~40-60 行原生扩展**（用户需求：手机可跑＋相对计时＋启动即跑＋开关）。修好投递缺口后，自写扩展直接受益；社区原版还要多付路径翻译＋审计门＋bundle 压力，换来的 cron 六字段/weekly/at 用户没要。

## 本轮钉死的事实（全部源码级，npm pack 固定产物）

### 1. vincentff@1.0.3 触发契约天生合规

- fire：`pi.sendUserMessage(rt.prompt, { deliverAs: "followUp" })`（`extensions/index.ts:354`）——正好命中 `communityHost.ts:176` 的口令，无需改一行。
- arm：`session_start`（:382）即注册计时器，启动自动跑。
- 定时器是**裸 `setTimeout`**（:345 `rt.timer = setTimeout(...)`）——esbuild 注入的 scoped globals（`scripts/pi-scoped-globals.mjs`）把裸 `setTimeout` 别名到 platform 能力；后台挂载时即 `resources.setTimeout`。

### 2. Bug A 钉死：后台 timer fire 后无人调 deliver()

- `extensionResources.ts` `schedule()` fire 只 `timer.callback(...args)`，**不碰 afterTimer/deliver**（:74-77）。
- `forBackgroundExtension` 挂载时 `setTimeout: resources.setTimeout` 直通（`extensionPlatform.ts:343`），没把 `beforeTimer/afterTimer` 线进去；而前台 `platform.setTimeout`（extensionPlatform.ts:280-298）有完整包裹，但其 `requireScope()`（:281）在无 operation 时抛——idle 也能挂 timer 的只有后台这条路。
- 后果：fire → callback 里 `sendUserMessage(..., {deliverAs:"followUp"})` → 进 `communityHost.pending` → **没人送**。对照 `afterTimer`（communityHost.ts:104 `flushWrites()+deliver()`）前台会送、后台不会。
- **最小修**：`createExtensionResources` 加可选 `afterTimer?: () => Promise<void>`，`schedule()` 的 task 链在 callback 后补 `await options.afterTimer?.()`（成功失败都要走，`finally` 语义）；`forBackgroundExtension` 构造处（`extensionPlatform.ts:315`）传 `() => owner.flushWrites().then(() => owner.deliver())`。`afterTimer`（communityHost.ts:104）本身不 `requireScope`，idle 安全。零回归依据：`deliver()` 空 pending no-op（:509）。
- 前台路径不受影响：`platform.setTimeout` 的包裹在 extensionPlatform.ts:280-298 原样保留。

### 3. vincentff 的存档路径确认要桥

- 路径（:293-294）：`path.join(process.env.HOME || "~", ".pi", "agent", "scheduler-tasks.json")` 与 `path.join(cwd, ".pi", "scheduler-tasks.json")`。**不走 `getAgentDir()`**——scopedProcess 只设 `PI_AGENT_HOME`，`process.env.HOME` 读未知键返 undefined（不抛），落到 `"~"` 兜底。
- 产物是三层嵌套路径（`~/.pi/agent/…` / `<cwd>/.pi/…`），而 `configFile`（extensionPlatform.ts:179-190）只认 `/extensions/config/**` 和 `/vault/.config/**`（后者限一层嵌套）两个根，`.pi/` 开头直接 `unavailable` → `readFileSync`/`writeFileSync` 都撞墙。**上一轮「可能不用补路径桥」的悬念作废：需要**。最小翻译：在 `configFile` 的根判定加 `.pi/` 一档（照 `/vault/.config` 现成译法，允许 1 层嵌套吸收 `agent/`），~10 行。

### 4. scoped 挂载的死法（为何必须 forBackgroundExtension）

scoped `platform.setTimeout` 挂载时即 `requireScope()`（成功，因为 session_start 是在 operation 内），但 fire 时 `assertScope(scope)` 会因会话 operation 已结束而抛 "already finished" → 长延时任务 fire 必炸。只有后台挂载的 resources timer 能活过 operation 边界。

## 出路定稿

| 方案 | 成本 | 结论 |
| --- | --- | --- |
| A：引 @vincentff 原版 + 两个桥修 | Bug A 桥 ~20 行 + 路径翻译 ~10 行 + 审计门 + bundle +8-12KB | 可行但为 6 段 cron/weekly/at 付出全套代价——用户只点名相对计时 |
| B：自写 ~40-60 行原生扩展 | 依赖 Bug A 桥修（A 路也要修，是公共底座）；正文零依赖 | **首选**。`getAgentDir()/scheduler.json` 直接进 KV；`sendUserMessage(text,{deliverAs:"followUp"})` 合约已验；注册即 arm；`disabledExtensionIds` 白送开关 |

无论 A/B，先落**投递桥修**（独立 PR）：修的是宿主，7 个定时包 + 未来所有定时扩展受益。真机 smoke 验三点：重启存档在、fire 真叫醒一轮 follow-up、后台 idle 时 activeRuntime 在场（唯一纸面未钉死的悬念，见 survey）。

## 本轮没做

- 未动源码、未开 PR（用户尚未拍板 A/B）。
- bundle 门未实测：vincentff 全文 ~19KB TS 源，编译后增量对 1.89 MiB 门（余量 ~1KB）几乎必超；B 方案的定时器+解析估算 <2KB，同样要过门实测。
- `ctx.hasUI` 的 `/schedule list` UI 分支未验（foreground command 场景，非 make-or-break）。
