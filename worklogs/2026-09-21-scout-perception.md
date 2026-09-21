# Silent Scout 模型驱动感知（Model-Driven Perception）

> **日期**: 2026-09-21
> **分支**: `feat/scout-perception`
> **目标**: 把 scout 的"通用建议"升级为"模型已经看过的具体发现"，并保证手机上跑得动。

---

## 一、需求与结论

需求原案是"暂存已完成的结果（Staged Diff）+ 一键 Accept"。审计后按用户决定收敛为：
**不做 diff、不做 Accept，只做模型驱动的感知**——后台把笔记看一遍，把发现变成具体的芯片文案。

用户拍板的两道门（唯一的两道）：

1. **内容 hash 没变不跑**
2. **距上次同笔记感知不到 X 分钟不跑**（X = 10 分钟，不对外开放设置）

---

## 二、机制

| 环节 | 落地 |
| :--- | :--- |
| 触发 | 切笔记（`active-leaf-change` / `file-open`）+ **同笔记存盘**（`vault.on("modify")`） |
| 本地取证 | `vaultGardener` 同步算：未闭环承诺、断链修复、MOC；`noteFacts` 算 tags / frontmatter |
| 模型判断 | 一次非流式请求，`toolChoice: "none"`，走"建议模型"，`maxTokens: 400` |
| 结构化输入 | frontmatter 块 + 标题大纲 + 开头 + 结尾（各段独立预算） |
| 结构化输出 | 最多 3 条 finding，按严重度排序；首条成为芯片 |
| 呈现 | `[已就绪] {label}`，点击发出的是一句普通提示词，不写盘 |

**「本地取证，模型判断」** 是这次的核心取舍：模型不负责检索（那是免费的本地活），只负责判断。
所以它不需要工具、不需要多轮、不需要子代理栈——手机上才跑得动。

---

## 三、两道门的语义

- **门 1（hash）** 在**派发时**比对"上次成功感知看过的文本"。失败（`null`）不钉 hash，
  所以掉线的请求会在冷却期后重试，而不是让这篇笔记整个会话都感知不到。
- **门 2（冷却）** 同样在派发时读，不在排程时读：防抖被快速切换重置时不该消耗冷却。
- 顺带修掉旧逻辑的坑：`setActiveNotePath` 原本是"有 insight 就不再 scout"，
  等于一篇笔记一个会话最多感知一次，正文改到面目全非也不重算。

---

## 四、手机（Obsidian Mobile）约束

1. **只在前台事件触发**。iOS/Android 一挂起 JS 就冻结，请求会断在半路；挂起≠被杀，
   内存里的暂存仍在，回前台继续。所以"离开 app 期间跑完"从不被承诺。
2. **成本被两道门按住**。切笔记是最频繁的事件（面板自己的 leaf 也会触发），
   没有门的话每次切笔记都是一次计费调用。
3. **无新 UI 层级**：芯片复用现有 QuickActions 触控行（该行本来就是为手机设计的）。
4. **不写盘**：感知只是建议，点击是普通回合，因此没有 diff 陈旧基线的数据损坏风险。

---

## 五、改动清单

| 文件 | 改动 |
| :--- | :--- |
| `src/agent/scoutPerception.ts` | 新增：采样器、prompt 组装、宽松解析、端到端请求 |
| `src/agent/silentScout.ts` | 两道门、`observe()` 单一入口、`hashContent()`、findings |
| `src/agent/ObsidianAgentService.ts` | prefetch runner 改走 `requestScoutFindings`（内联 prompt 删除） |
| `src/agent/noteFacts.ts` | `stagedScoutAction` → `scoutFinding`（findings[0]） |
| `src/ui/quickActionSuggestions.ts` | 芯片文案走 `quickActions.empty.scoutFinding.label` |
| `src/ui/activeNoteWatch.ts` | 新增 `vault.on("modify")`：工作笔记被写入时重新发布 |
| `src/i18n/{en,zhCN}.ts` | `[Ready] {finding}` / `[已就绪] {finding}` |
| `scripts/check-bundle.mjs` | 门史 #24（2,390,550 B，仍落在 2.28 MiB 刻度内） |
| `scripts/{run-smoke-proactive.py,smoke-proactive-obsidian.mjs}` | 台子修复 + 感知场景 |

---

## 六、验证

### 单元 / 门禁

- `bun test`：**4,043 pass / 0 fail**（274 文件）
- `npm run verify`（build + 5 道静态门 + 测试 + lint）：全绿
- `check:bundle`：2.28 MiB of 2.28 MiB，清洁

### 真实 Obsidian runtime smoke

Xvfb + Obsidian 1.13.7 (arm64)，独立 disposable vault，本地确定性 mock 端点。

| Pass | 结果 | 关键断言 |
| :--- | :---: | :--- |
| 桌面 (1024 视口) | **13/13 ✅** | 感知芯片 `[已就绪] 2 处矛盾`、端点恰好收到 1 次、门 1/门 2 各自成立 |
| 移动 (390×844 官方手机模拟) | **17/17 ✅** | 同上 + Node 访问审计全过、无意外 console 错误、无溢出 |

产物：`worklogs/2026-09-21-scout-smoke-{desktop,mobile}.json`、
`worklogs/2026-09-21-proactive-{desktop,mobile}-scout.png`（感知场景截图）。

**真机验证到的关键事实**（mock 端点的到达日志直接确认）：
- 感知 prompt 的形状正确：`<subject>` 包裹、本地事实在前（Tags / Frontmatter: absent /
  未闭环承诺 / 断链）、结构化采样（Frontmatter 块 + Outline + Opening + Closing）在后。
- 门 1：切走再切回同一篇 → 端点收到数保持 1。
- 门 2：改了正文 → 冷却期内端点收到数仍是 1。
- 旧的静态场景（任务/代码/日记/回忆）全部不受感知影响。

---

## 七、台子上踩到的坑（都是台子的，不是产品的）

1. **主进程 `requestUrl` 在本环境整个是死的**：连死端口都挂 12 秒不报错，渲染进程
   `fetch` 完全正常。smoke 改用 `fetch` 传输（同一套模型/prompt/解析）。2026-09-20
   团队台子上 requestUrl 是好的——环境差异，与 #296 之前的传输两分法结论无冲突。
2. **新 profile 没有 `obsidian.json`** → Obsidian 停在 first-run starter，那页的
   `window.app` 是另一个空壳。launcher 现在预置 obsidian.json 指向 disposable vault。
3. **社区插件总开关**：`community-plugins.json` 列了插件但 master switch 没开时，
   插件静默不实例化。rescue 表达式还要包 async IIFE（裸 await 会被
   `Runtime.evaluate` 拒掉）。
4. **无头窗口的计时器节流**：Xvfb 窗口在 Chromium 眼里从未获得焦点，SSE 落定被拖到
   几十秒。launcher 现在开 `Emulation.setFocusEmulationEnabled(true)`。
5. **starter 复用后的僵尸 target**：从 starter 打开库会留下死 target 排在前面，
   CDP 选错就连消息都不回。target 选择先认 `index.html`。
6. **fixture 权威性**：复用 vault 里旧 fixture 会替脚本做主。ensure 循环现在按内容
   不一致就覆盖。

---

## 八、已知取舍

- **32 位 hash**：碰撞只是跳过一次感知，感知永远只是建议、从不写盘，最坏是芯片陈旧。
- **10 分钟冷却硬编码**：真嫌不对再抬成设置项。
- **failed 不钉 hash**：靠冷却限流，不做指数退避（按项目既有结论，工具失败不加熔断）。