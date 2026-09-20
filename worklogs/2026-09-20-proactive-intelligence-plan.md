# 增强 Piem 主动上下文感知与时序智能开发计划与实时进度

> **日期**: 2026-09-20  
> **分支**: `feat/proactive-intelligence`  
> **目标**: 基于第三方审计结论与移动端（Obsidian Mobile）核心硬约束，以“本地零成本感知、环境式无侵入呈现、遵循 Obsidian & Pi 原生标准”为原则，全面增强 Piem 主动上下文感知与时序交互能力。

---

## 一、 核心设计原则与硬约束

1. **绝对兼顾移动端（Obsidian Mobile First）**：
   - 严禁在 CodeMirror 6 中注入会破坏中文/日文 IME 输入法组合态（Composition Events）的行内幽灵文字（Ghost Text）。
   - 严禁依赖不存在 `:hover` 的触控断裂交互（如 Gutter 悬停、波浪线悬停）。
   - 严禁在后台启动长耗电、会被移动操作系统（iOS/Android Doze）冻结的无休止定时器或盲目网络预取（Silent Scout）。
   - 状态栏（Status Bar）在移动端默认隐藏，交互阵地收敛于 **Chat 面板输入框上方（QuickActions 芯片区）** 与 **空白首屏（EmptyState）**。
2. **本地零成本感知（Zero Token, <5ms Overhead）**：
   - 充分利用 Obsidian 内存缓存（`app.metadataCache.getFileCache`、`listItems`、`sections`、`unresolvedLinks`、`frontmatter`）与时钟节律。
   - 不发起额外 LLM 调用，不阻塞 Obsidian UI 主线程，不消耗移动端网络流量与电量。
3. **原生标准与单一来源（SSOT）**：
   - 深度复用与扩展 `NoteFacts`、`probeNoteFacts`、`renderNoteFactLines`、`emptyScreenQuickActions`。
   - 双语严密同步（`src/i18n/en.ts` 与 `src/i18n/zhCN.ts`）。
   - 在 Xvfb + 真实 Obsidian 1.13.7 arm64 runtime 下执行桌面与 390px 移动端视觉 Smoke 测试。

---

## 二、 阶段开发计划

### Phase 1: 本地零成本时序与特征感知（Local Cadence & Structural Proactivity）
- [x] **A. 时序节律感知 (Temporal & Cadence Proactivity)**
  - 感知当前本地时序：晨间 (`morning`, 05:00-12:00)、午间/下午 (`afternoon`, 12:00-18:00)、晚间 (`evening`, 18:00-05:00)。
  - 感知日记属性：是否为“今日日记”（`isToday`），结合晨间/晚间时段提供差异化的专注与复盘建议。
- [x] **B. 深度笔记结构探测 (Enriched noteFacts)**
  - 待办探测（`todoCount`, `doneTodoCount`）：利用 `cache.listItems` 瞬时探测 `- [ ]` 未闭环任务。
  - 代码特征探测（`hasCode`）：利用 `cache.sections` 探测代码块。
  - 标签与技能特征嗅探（`dominantTopic`, `suggestedSkill`）：嗅探读书笔记、学术文献或代码开发等特征。
- [x] **C. 确定性快速建议矩阵升级 (`emptyScreenQuickActions`)**
  - 优先级与场景编排：根据时序、待办、代码、孤岛、空白等特征动态推荐最贴合的 3 个一键 Prompt 芯片。
  - 完善英文与中文 i18n 文案。
- [x] **D. 模型侧提示工程增强 (`quickActionSuggestionRequest`)**
  - 扩展 `renderNoteFactLines` 与 `noteFactsKeyPart`，使有网络时的模型生成建议同样具备时序与任务感知能力，同时缓存 Key 具备状态敏感性。

### Phase 2: 会话跨期连接与轻量唤醒（Long-Horizon Recall）
- [x] **A. 笔记-会话轻量映射索引 (`noteSessionIndex`)**
  - 在 `ObsidianAgentService` 中维护常驻内存的 `notePath -> { sessionPath, sessionTitle, updatedAt }` 映射。
  - 在用户发送消息、切换笔记或加载会话时静默更新索引（O(1) 开销，零磁盘遍历）。
- [x] **B. 跨期会话唤醒建议 (`recallSession`)**
  - 当用户在空白聊天中打开曾探讨过的笔记时，优先浮现“回顾上次探讨 / 继续讨论”芯片。

### Phase 3: 严格验证与视觉 Smoke（Verification & Visual Smoke）
- [x] **A. 单元测试全绿**
  - `bun test src/agent/noteFacts.test.ts` (13 pass / 0 fail)
  - `bun test src/ui/quickActionSuggestions.test.ts` (19 pass / 0 fail)
  - `bun test src/agent/noteSessionIndex.test.ts` (3 pass / 0 fail)
  - 全局门禁与测试：`npm run build && npm run lint && bun test` (4,008 pass / 0 fail / 271 files)
- [x] **B. 真实 Obsidian Runtime 视觉 Smoke 验证**
  - Xvfb + Obsidian 1.13.7 (arm64) 独立虚拟环境验证。
  - Desktop 模式 (1024x800) 与 Mobile 模式 (390x844 官方手机模拟) 双通过。
  - 任务笔记（`Tasks/Project-Roadmap.md` -> “整理未完待办”）、代码笔记（`Code/Algorithm.md` -> “审查代码质量”、“解析代码逻辑”）、今日日记（`Daily/2026-09-20.md` -> “晨间专注规划”）、历史会话（`Research/PriorDiscussion.md` -> “继续上次探讨”）全场景覆盖并完成点击交付测试。
  - 确认 390px 移动端无横向滚动溢出、无未经授权的 Node/Electron API 调用。
  - 产出物：
    - `worklogs/2026-09-20-proactive-smoke-desktop.json`
    - `worklogs/2026-09-20-proactive-smoke-mobile.json`
    - `worklogs/2026-09-20-proactive-desktop-tasks.png`
    - `worklogs/2026-09-20-proactive-desktop-final.png`
- [x] **C. 准备与提交 PR**
  - 编写详细交接与变更说明，保证全量测试和静态门禁 100% 绿灯。

---

## 三、 实时进度看板

| 时间 | 状态 | 当前事项 | 结果 / 产物 |
| :--- | :---: | :--- | :--- |
| 2026-09-20 17:35 | ✅ 已完成 | 拉取最新 master，创建 `feat/proactive-intelligence` 分支 | 代码基线已同步 |
| 2026-09-20 17:38 | ✅ 已完成 | 梳理开发计划，初始化交接记录文档 | `worklogs/2026-09-20-proactive-intelligence-plan.md` |
| 2026-09-20 17:45 | ✅ 已完成 | 实施 Phase 1: 扩展 `noteFacts.ts` 与 `quickActionSuggestions.ts` | 待办/代码/时序特征探测与芯片升级 |
| 2026-09-20 18:05 | ✅ 已完成 | 实施 Phase 2: 实现 `NoteSessionIndex` 及跨期会话唤醒 | 轻量 O(1) 跨会话索引与建议矩阵 |
| 2026-09-20 18:25 | ✅ 已完成 | 单元测试与双语检查 | 4,008 个测试用例全部通过，双语完全对齐 |
| 2026-09-20 18:40 | ✅ 已完成 | Phase 3: 真实 Obsidian 1.13.7 runtime 视觉 Smoke 测试 | 桌面与 390px 移动端 100% 通过，产出视觉与数据证据 |

