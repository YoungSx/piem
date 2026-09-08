# 内置技能迁移为标准文件：开发方案

> 2026-09-08 · 方案，尚未实现。基于 `ba21b37` 的源码和当日官方文档核对。
> 本 PR 交付迁移设计；下文的模块、命令和验收项均是后续开发要求，不代表已经存在或通过。

建议把内置技能变成仓库中完整的 `skills/<name>/SKILL.md`，随插件版本发布为独立数据资源，再通过 Obsidian 的 Vault API 安装到可见目录。运行时只从真实文件加载，沿用 Pi 的技能解析、命令展开和层级合并。

这个方案有一项产品代价：全新安装需要联网取得一次技能资源。已有本地文件可以离线读取，技能下载失败也不能阻止聊天。如果要求“正文完全移出 `main.js`”同时“普通社区插件安装首次离线也有全部技能”，现有安装机制无法同时满足。

## 1. 已核实的现状

| 位置 | 当前行为 | 迁移要改变什么 |
|---|---|---|
| `src/agent/skills/*/SKILL.md` | 已有 7 个文件，但没有标准的 `name`、`description` frontmatter；正文合计 22,369 字节 | 补全标准格式，迁到根目录 `skills/`，保持原有技能名 |
| `src/agent/builtinSkills.ts` | 手工 import 7 个正文，从 i18n 取描述，直接构造 `Skill` | 删除手工登记和虚拟技能构造 |
| `esbuild.config.mjs` | `.md` 的 text loader 把正文内联进 `main.js` | 构建输出独立资源，运行时模块只带摘要、大小、技能名等轻量资源描述 |
| `src/agent/ObsidianAgentService.ts` | `reloadSkills()` 合并内置、用户目录、Vault；异常兜底再次构造内置技能 | 正常加载和异常处理都改为真实文件，不留下内存内置兜底 |
| `src/agent/skillLoader.ts` | 已调用 Pi 的 `loadSkills`；每轮刷新技能 | 复用同一解析逻辑，保留下一条消息看到编辑的行为 |
| `src/tools/skillTools.ts` | `read_skill` 读取已加载快照 | 保留稳定工具名和一致快照；更新“内置没有文件”的说明 |
| `src/skills/skillImport.ts` | 已有来源记录、SHA-256 和更新计划 | 复用经验证的纯逻辑，不直接用网络导入器承担内置分发 |
| `.github/workflows/release.yml` | 只打包并发布 `main.js`、`manifest.json`、`styles.css` | 增加独立技能资源的构建、校验、证明和发布 |

有三处容易误判：

- 把现有 `.md` 换个目录再 import，正文仍在 `main.js`，不算完成这次迁移。
- Obsidian 官方安装器只下载上述三个文件；上传一个 `skills.zip` 不会让安装器自动解压它。
- 当前 Pi `loadSkills` 会读取完整正文。系统提示词只列元信息、按需向模型提供正文，是已有行为；“正文按需读盘”是另一项优化，不能冒称本次自动实现。

## 2. 文件格式与目录

仓库中的唯一内容来源：

```text
skills/
  summarize/
    SKILL.md
  link-graph/
    SKILL.md
  tag-organize/
    SKILL.md
  find-skills/
    SKILL.md
  efficient-web-research/
    SKILL.md
  vault-memory/
    SKILL.md
  distill-skill/
    SKILL.md
```

每个文件都是能单独交给标准加载器的完整技能：

```markdown
---
name: summarize
description: Summarize the active Obsidian note or selection without changing it. Use when the user asks for a summary of their current note.
compatibility: Requires Piem's Obsidian vault tools.
---

Summarize the active Markdown note.

1. Call get_active_note with includeContent and includeSelection enabled.
```

落实规则：

- `name` 必填，与目录名一致，1–64 个字符，只用小写英文字母、数字和单连字符，不以连字符开头或结尾。
- `description` 必填，1–1024 个字符，写明用途和触发条件。
- 保留已有正文、外部来源署名与许可；本次不顺带重写技能行为。
- 需要时可加 `references/*.md`、`assets/*.md`。相对引用保留目录结构，能用 Vault 工具打开。
- 本轮发布 Markdown 资源；不下载、执行脚本，不因格式允许 `scripts/` 就新增执行能力。
- `name` 和模型读到的 `description` 只来自文件。移除加载层的 `Translator` 依赖；界面按钮、来源、状态仍走双语 i18n。技能描述按文件显示，与用户技能一致。这会使当前内置技能的描述不再随界面语言切换，需要在变更说明里写明。
- 新增一个合法技能目录就能参加构建；不能再要求往 TypeScript 数组登记一次。

Vault 中采用两个可见的同级目录：

```text
Piem/
  builtin-skills/                 # 插件发布的技能，普通 Markdown，可打开和同步
    summarize/SKILL.md
    ...
  skills/                        # 用户自己写的、导入的、定制的技能
    summarize/SKILL.md            # 同名时覆盖官方版本
```

本提案按“用户能在 Obsidian 中查看技能”设计。官方文件采用独立的 `Piem/builtin-skills/`，避免直接塞进 `Piem/skills/` 后，把原先最低优先级的默认技能突然变成最高优先级的 Vault 技能。两处均不使用点目录，也不需要 Node 文件系统。

来源与存储位置要分开：官方文件仍是 `source: builtin`，但已经有可打开的 Vault 路径。设置页不能继续用 `source === vault` 判断一个技能是否可打开。

## 3. 分发方式：版本绑定的独立数据包

由一次构建产出 `dist/builtin-skills.json`，内容是有格式版本的 UTF-8 数据包，含插件版本、相对路径和原始 Markdown。JSON 只负责运输；落盘后仍是标准目录与文件，不是运行时数据库。当前体积很小，无需引入 ZIP 解压库。

构建步骤：

1. 枚举 `skills/`，拒绝符号链接、越界路径、重复名字和不允许的资源类型。
2. 用已有 `yaml` 严格验证必填 frontmatter，再用 Pi 原生加载器交叉验证全部技能。不能只检查 Pi 的 diagnostics：缺 `name` 时它可能采用目录名，仍不满足我们的发布要求。
3. 保持源文件正文不变，稳定排序，生成数据包和整体 SHA-256。
4. esbuild 通过构建期虚拟模块取得摘要、字节数和技能名清单，**不得引入任何正文**。技能名只用来解释尚未准备好的命令，不生成不存在的 `Skill`。产物不提交 Git。
5. 开发 watch 同样跟踪源目录的新增、删除和修改，更新数据包与摘要，避免必须重启开发命令才发现新技能。

发布资源下载地址固定为：

```text
https://github.com/YoungSx/piem/releases/download/<this.manifest.version>/builtin-skills.json
```

- 插件版本仍来自 `manifest.json`，运行时从 `this.manifest.version` 传入。不得使用 `latest` 或可变分支 `master`。
- 校验本次构建内嵌的包摘要，再校验 schema、版本、路径、文件数量和体积，全部通过后才写文件。摘要随已安装插件交付，不能只信下载包里自报的摘要。
- 建议首版限制为总包 1 MiB、单文件 256 KiB、最多 64 个文件；超限明确失败，不能截断后当成功安装。
- 通过现有、与用户网络设置绑定的 transport 发出 GET，不携带模型密钥或 Vault 内容。在中英文安全文档和设置说明中披露 GitHub 请求。
- 开发与测试注入本次构建的数据包，无需先发布不存在的 tag；正式代码不能为开发方便回退到 `master`。
- Release 工作流校验、证明并上传该资源；构建已创建 `dist/` 后，现有打包步骤也要改为幂等建目录，并把新增产物加入忽略规则。新增包属于插件正常版本发布的一部分，不建立独立自动更新渠道。

选择比较：

| 选择 | 真正移出 JS 正文 | 普通安装首次离线有技能 | 结论 |
|---|---|---|---|
| 标准 MD 编写，仍内联进 `main.js` | 否 | 是 | 只满足源码整理 |
| 内联种子，首次启动写出 MD | 否 | 是 | 能获得真实文件，但仍占 JS 体积 |
| 独立资源包，按当前插件版本下载落盘 | 是 | 否 | 本方案推荐，明确首次联网代价 |
| 仅上传额外目录或 ZIP | 是 | 否 | 官方安装器不负责安装这些文件，单独做不成立 |

## 4. 运行时职责

只增加一个负责准备官方文件的模块，技能内容解析仍归 Pi。

| 模块 | Interface 与职责 |
|---|---|
| 构建模块 | 从 `skills/` 生成经过验证的资源和摘要，供 esbuild 与发布流程使用 |
| `BuiltinSkillInstaller`（新） | `prepare()` 返回安装报告；`dispose()` 结束生命周期。内部处理下载、校验、所有权、更新与并发；不构造 `Skill` |
| `skillLoader.ts`（已有） | 分别对官方目录和用户 Vault 目录调用 `loadSkills`，与用户级技能按原顺序合并 |
| `ObsidianAgentService`（已有） | 采用一次加载得到的目录、正文与诊断快照，提供给主代理、子代理、命令和设置页 |

`BuiltinSkillInstaller` 接收 Vault、transport、目标资源描述和状态持久化依赖；不要自己创建新的文件系统或网络客户端。更新决策可以放在一个内部纯函数中，避免变成“大而全”的 SkillProvider 框架。

时序约定：

1. 插件只在工作区准备好之后发起一次准备任务，记录并处理它的 Promise；`onload` 不等待网络。
2. 同一插件实例里，并发调用共用一次准备任务。目标摘要与已完成记录相同，且目标文件仍在时，直接复用本地文件；下次启动也不重新下载。自动失败后本次加载周期不循环重试，设置页的显式重试可以再尝试。
3. 有本地文件时先加载它们。升级下载失败仍用原有文件，并报告更新失败，不把“旧版可用”显示为“当前版本已完成”。
4. 全新安装尚在准备时，只列出真实可用技能。用户调用尚未就绪的技能时，提示准备状态和恢复入口，不能伪装成成功或只报拼写错误。普通聊天仍能运行。
5. 准备成功后通过现有刷新路径重载；不要在正在展开的命令中途换正文。至少保证下一次发送时采用新快照。
6. 每轮刷新只读本地，不下载、不修复、不重建文件；继续让用户编辑在下一条消息生效。
7. 准备尝试有总等待期限，例如 15 秒；卸载后取消等待、清理定时器和监听器，迟到结果不得继续写盘。

传输的真实限制：当前 `requestUrl` 适配器的取消只能停止等待，无法物理中止 Obsidian 发出的底层请求，也会先缓存完整响应。方案不能宣称拥有流式内存上限或底层硬取消。采用一次请求、不自动连环重试、迟到响应不写盘；后续若需要更强保证，应单独验证可取消的传输实现。

## 5. 所有权与升级

保留现有顺序：**Vault 自写技能 > 用户目录技能 > 官方技能**。现有 `disabledSkills` 继续按技能名在合并后过滤；安装不能重新启用用户已关闭的技能。

定制的正常路径是把技能复制到 `Piem/skills/<name>/SKILL.md`。官方文件被直接编辑时也必须保护，不能因为目录叫 builtin 就无条件覆盖。

状态通过插件现有 `loadData` / `saveData` 保存，独立于技能正文，记录格式版本、目标发布版本及摘要、每个已确认安装文件的基线摘要、被用户移除的技能和安装问题。设置归一化与持久化需保留该内部记录，不把它变成用户开关。不要给标准 frontmatter 塞安装状态，也不要给每篇技能单独编造发布版本。

| 观察到的状态 | 处理 |
|---|---|
| 首次安装，目标路径不存在 | 创建父目录和文件，验证成功后记录所有权 |
| 目标已有文件，但没有可靠所有权记录 | 视作用户文件；保留。内容与目标完全一致时可安全确认已安装 |
| 本地与记录的基线相同，上游已改变 | 条件更新到新版本 |
| 本地已改变，上游未改变 | 保留修改，标为已定制，不下载或重写 |
| 本地已改变，上游也改变 | 保留本地，报告冲突，不自动三方合并 |
| 曾经安装过的技能入口被删掉 | 记录移除意图，不在每次启动时长回来；由显式恢复操作重新安装 |
| 上游不再提供某个技能 | 不自动删 Vault 内容；报告已退役，留给用户清理 |
| 包下载、校验或写入失败 | 保留已有文件和逐项真实状态，不把整个版本标成已安装 |
| 状态损坏或丢失 | 不凭目录名取得现存文件的所有权；保留文件并报告无法确认 |
| 较旧设备或插件遇到较新记录 | 不自动回滚官方文件，不抢回用户技能的优先级 |

写入安全不能停留在“先算哈希再覆盖”：

- 新文件用 `Vault.create`，目标被别人抢先创建时不转为覆盖。
- 已有文件先拿到预期原文，再用 Obsidian `Vault.process` 在同步回调里比较原文、决定是否替换。比较失败即冲突，不能靠 `read` 之后直接 `modify`。
- 逐个检查写入返回结果；某文件失败不能记成成功。写成功但状态还没保存就崩溃时，下次通过与目标内容比较恢复；状态持久化串行，不能用旧设置快照覆盖同时保存的其他配置。
- 同一个技能带引用文件时，把 `SKILL.md` 作为激活入口最后写；任一资源更新失败，报告该技能未完整完成。首版内置仍是单文件技能，不宣称多文件或跨设备原子事务。
- 同步可以把文件和状态分开送达。证据不一致时保留文件、报冲突；`Vault.process` 的原子性只覆盖本实例的单个文件，不等于跨设备锁。

现有导入器只可选择性复用。源码里 `installSkill()` 没检查 `env.writeFile()` 的 `Result`，`planUpdate()` 会把本地缺失项判为新增；直接调用会分别造成假成功和恢复用户删除。这两条都不符合上表。抽取复用前先修正所依赖的契约并加回归测试，不把现有行为当成已经可靠的安装层。

## 6. 加载、命令与故障边界

- 两个 Vault 目录共用 Pi `loadSkills`，不要另写 Markdown 解析器。用户级目录继续走现有桌面能力桥，手机继续跳过该来源。
- 文件路径登记为 `/Piem/builtin-skills/<name>/SKILL.md`，删除 `/__piem_builtin_skills__`。相对资源位置由真实路径推导。
- 保留 `/name`、`/skill:name`、`read_skill`，保留同名 prompt template 的既有优先级。
- `read_skill` 继续读取本轮加载快照；不能另行读到另一版本正文，造成提示词目录、slash 展开和子代理各说各话。
- `SkillLoadReport` 增加官方来源的安装状态和加载诊断。设置页展示同一次实际加载的报告，给真实文件提供打开入口。
- 官方源、用户源、Vault 源独立收集成功与失败。一层失败不抹掉另外两层，也不再从 TypeScript 恢复出“文件不存在但能用”的内置技能。
- 同一来源整次读取失败可保留最后一次有效快照并明确标旧；确定某文件已删除或失效则按加载结果移除，不能永久用旧快照抵消用户删除。
- 不扩大普通 `read` 工具到宿主文件系统。它仍受 Vault 约束，用户级技能仍通过 `read_skill` 访问。

## 7. 实施顺序与删改清单

建议同一功能 PR 内分三组提交，全部验收后再合并，避免发布一个移除了默认技能却还不会安装的中间版本。

1. **标准源文件与构建资源**：迁移 7 个文件并补 frontmatter；资源生成、严格校验、摘要注入、开发 watch、发布上传及证明一起完成。
2. **安装与加载**：实现安装状态及条件写入；接入生命周期与独立来源加载；完整保留覆盖顺序、禁用项、命令与子代理快照。
3. **界面、文档和删除旧路径**：真实文件打开、准备/失败/冲突/恢复状态；中英文 `docs/extending`、`docs/security` 和相关设置说明同步更新；删除旧内置构造、手工 import、正文内联和过期测试。

需要检查的旧支撑：`src/markdownModule.d.ts`、`scripts/bun-md-text.ts`、`bunfig.toml` 的 Markdown preload 和 esbuild `.md` text loader。在确认没有其他 Markdown import 后删除，不能只停用一半。`scripts/check-bundle.mjs` 增加“资源正文未混回 JS”的验证，预算按真实构建结果调整，不先许诺启动提速数字。

不顺带重构整个 agent service、用户目录桥或远程技能商店。设置页若改变现有截图表达的行为，按 `assets/screenshots/README.md` 重拍真实 Vault 截图。

## 8. 验收

| 验收面 | 必须可复核的结果 |
|---|---|
| 标准格式 | 7 个目录直接交给 Pi 加载成功；缺必填字段、坏名字、重复名、坏相对引用导致发布构建失败 |
| 发布产物 | 包与源文件一致，摘要与 `main.js` 的描述一致；往 `skills/` 加合法目录能自动加入包；JS 中没有技能正文或虚拟内置根路径 |
| 首次安装 | 从只有标准三个插件文件开始，经模拟固定版本端点安装成功；不是依赖开发机器预存技能的测试 |
| 离线与失败 | 首次离线、404、超时、摘要不符、只读 Vault 都不阻止普通聊天；已有文件仍可读取，设置页准确报告失败 |
| 更新保护 | 未修改文件能升级；用户修改、未知文件、删除、禁用和版本倒退均受到上表约束 |
| 竞态与恢复 | 并发准备只有一次下载；编辑与更新竞争不会覆盖编辑；写入失败和写后崩溃不记录假成功；卸载后无迟到写入或本模块残留定时器 |
| 真实路径 | 能在 Obsidian 打开官方技能；Vault `read` 读到对应文件；Markdown 引用文件可达 |
| 一致性 | `read_skill`、`/name`、模板冲突、主代理与子代理、设置目录采用同一有效技能集合；同名覆盖顺序与现状一致 |
| 动态编辑 | 保存本地文件后下一条消息看到新内容；读取过程不触发网络或补写 |
| 平台 | 桌面和无 Node 环境均可加载官方 Vault 文件；iOS/Android 真机安装、升级、同步另行烟测并报告实际边界 |

使用 `bun:test`，关键文件必须可独立运行；DOM 以外测试需要 `window` 时用现有轻量 stub。验证不执行远程技能，不启动常驻开发服务器。完整门禁串行运行，避免叠加构建和测试负载：

```bash
npm run build
npm run check:bundle
npm run check:copy
npm run check:css
npm run check:version
bun test
npm run lint
```

另外独立跑受改动的安装、更新、loader、service 和技能工具测试文件。交付前基于实时默认分支 rebase，确认 PR 无冲突，并核验当前提交的全部 CI；不能把资源发布/真机烟测尚未做过说成完成。

## 9. 核对来源

- [Agent Skills 格式规范](https://agentskills.io/specification)：必填 frontmatter、目录结构、可选资源、渐进加载。
- [Obsidian 发布与安装说明](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)：安装时从匹配 tag 下载三个标准插件文件；另核对了其 [官方原文](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submit%20your%20plugin.md)。
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)：文件访问方式；原子修改同时核对当前安装的 `obsidian.d.ts` 中 `Vault.process` 的同步回调契约。
- 当前依赖 `@earendil-works/pi-agent-core` 的 `dist/harness/skills.js`：`loadSkills`、frontmatter 处理、相对路径展开的实际实现。运行时开发应使用公开导出，不导入这个内部文件。
