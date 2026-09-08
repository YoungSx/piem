# NodeExecutionEnv 迁移方案调研

> 2026-09-08。范围：用 Pi 的文件系统实现替换 `NodeHomeEnv`；保留现有用户技能功能、移动端降级与 shell 禁用。交付是迁移方案和可复跑的打包实验，运行时代码尚未迁移。

## 推荐路线

**使用当前 Pi 0.84.3 的公共 `@earendil-works/pi-agent-core/node`，删除手写文件系统实现，只保留宿主探测、懒加载和三个禁用方法。** 包体门槛允许按实测提高；约 35 KiB 的增量不值得换来私有路径或一轮全仓 API 迁移。

- 文件系统交给 Pi：路径解析、读文件、目录枚举、错误映射都不再自行维护。
- Obsidian 适配留在本地：手机安静跳过；用户目录只供技能加载；vault 工具继续走 `VaultExecutionEnv`。
- 实施时同步更新包体预算。完整插件原型从 1,692,913 B 增至 1,728,614 B，约 +2.1%；可先按 **1.70 MiB** 规划，最终数值跟随正式实现的测量。
- 0.85.1 单独规划。试升级有 213 条编译诊断，涉及 26 个文件，并触及会话存储与同步；它不是获得 NodeExecutionEnv 的前提。

本次是研究 PR：源码对照、实验方法、待改文件和验收标准已落地；正式替换、调整运行时门槛及设备验收属于实施 PR。

## 先纠正迁移前提

**当前安装的 Pi 0.84.3 已公开提供 `NodeExecutionEnv`，迁移不要求先升级 0.85。** 0.84.3 的 `package.json` 已导出 `./node`，该入口明确导出这个类；并非 0.85 新增。[0.84.3 包配置][pkg843]、[入口源码][entry843]

这次同时下载两版 npm 官方发布包，按 Registry 的 SHA-512 `integrity` 核验压缩包，再比对 `dist/harness/env/nodejs.js`：本地 0.84.3 和前次解压的 0.85.1 均与各自官方产物逐字一致。引用固定提交而非会移动的 `main`：

| npm 版本 | Registry `gitHead` | 官方发布产物 |
| --- | --- | --- |
| 0.84.3 | `bfb004d4418ff05c6f909eaaab856cbe75c1fde0` | [元数据][npm843]、[tarball][tar843] |
| 0.85.1 | `d981de1229ef899957bbe968bc8dcda02a21f477` | [元数据][npm851]、[tarball][tar851] |

因此，本次推荐不改 `package.json` / `bun.lock` 的 Pi 版本。若后续另行决定全面升级，也能沿用下面的宿主边界和验收用例。

## 上游边界与依赖

| 项目 | 0.84.3 | 0.85.1 |
| --- | --- | --- |
| 可用公共入口 | `@earendil-works/pi-agent-core/node` | 同左；另增 `@earendil-works/pi-agent-core/harness/env/nodejs` |
| 构造参数 | `{ cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }` | 相同 |
| Node `engines` | `>=22.19.0` | 相同，不能把它误算成此次升级新增限制 |
| 配套 Pi 包 | `pi-ai: ^0.84.3`、`pi-telemetry: ^0.84.3` | 两者都为 `^0.85.1` |
| chord | 无 | `@earendil-works/chord: ^0.85.1`；该包还依赖 `esbuild: 0.28.1` |

来源：[0.84.3 配置][pkg843]、[0.85.1 配置][pkg851]、[0.84.3 构造器][node843-constructor]、[chord 官方元数据][npm-chord851]。chord 的 `unpackedSize` 是 917,443 字节；这是 npm 解包体积，**不是插件 bundle 增量**。0.85.1 的 `pi-ai` 还把 Anthropic SDK 从当前 0.84.3 配套的 `0.91.1` 提升到 `0.123.0`，完整升级应另审提供商变化。[pi-ai 0.84.3][npm-ai843]、[pi-ai 0.85.1][npm-ai851]

`./node` 的第二行是 `export * from "./index.ts"`。实测确认它会增加懒初始化包装的体积；以下方案接受公共入口的成本，不把私有 `dist/...` 深路径当成稳定公共 API。[入口源码][entry843]

## 完整打包与宿主实验

工具：Node 24.14.1、Bun 1.4.2、仓库 esbuild 0.25.5；源码基线 `99c1567`，默认分支推进到 `a1c4d13` 后复跑，三个体积相同。Pi 由现有 lockfile 固定为 0.84.3。通过 esbuild `onLoad` 临时覆盖 userSkills 的接线，不修改运行时代码或依赖。

可复跑脚本：[scripts/research-node-execution-env.mjs](../scripts/research-node-execution-env.mjs)。它串行构建三种完整插件、只在内存中保留产物，并在 finally 停止 esbuild；只打印测量结果，不扫描真实 home 技能。

```sh
npm run build
node scripts/research-node-execution-env.mjs
```

| 接法 | 完整 main.js | 对基线增量 | 结论 |
| --- | ---: | ---: | --- |
| 原版 NodeHomeEnv | 1,692,913 B | — | 与真正 production build 字节数一致 |
| 懒加载本地 bridge，再具名导入公共 `/node`，覆盖 shell/temp 三方法 | 1,728,614 B | 35,701 B，34.9 KiB | 推荐；正常维护公共 API |
| 直接 `await import("@earendil-works/pi-agent-core/node")` | 1,755,085 B | 62,172 B，60.7 KiB | 保留了更多入口内容；此行仅作打包对照，没有接 shell/temp 拒绝，不作为可交付实现 |

这些是研究原型测量，不是最终迁移产物。原型的类型、异常报告和宿主探测还需要按下面的实施清单落地；新包体预算按最终产物校准。现有上限是 1,698,693 B（1.62 MiB），推荐接法高出 29,921 B。按本次允许增加体积的约束，提高门槛即可，不需要深导入、复制上游源码或另装一份不同版本的 Pi。

打包的必要调整与大小无关：当前 `external: [...builtinModules]` 没有覆盖 `node:` 前缀；导入官方 env 会报 8 个 `Could not resolve "node:..."`。增加 `"node:*"`，保持宿主内建模块为 require；**Pi 本身仍打进 main.js**，不可 external 掉 Pi 或依赖运行时加载额外文件。

公共 bridge 另触发了现有 providers 目录禁入检查。metafile 显示唯一命中是 `providers/faux.js` 的 **17 B 空初始化包装**；保留变量名再次构建，产物为 `init_faux=__esm({".../providers/faux.js"(){}})`，没有 faux 实现或模型数据。原型 `check:bundle` 的两个失败项就是体积与这一项，未增加动态 import 等加载错误。实施时应只对这个空包装建立精确证据检查，例如把该文件单列为受限的字节预算并约束公开导出实现仍被摇掉；其他 providers、模型目录和 SDK 禁入检查继续有效。不可删掉整个依赖门来放行。

曾用私有 nodejs 路径并切断 bridge 的根包依赖作定位实验：增量约 6.6 KiB。这只用于说明入口成本，不是推荐方案，不进入运行时代码。

已做的宿主验证：

- 用 Node VM 加载桥接原型，覆盖无 require、require 抛错、返回 undefined、模块不完整四种形状；模块顶层均没有请求 Node 内建模块，工厂均跳过。桌面替身能从临时目录读取技能，shell 返回 shell_unavailable；计时器与 spawn 计数均为零。
- 完整原型 bundle 经现有 Obsidian loader 测试辅助加载，在拒绝 Node 模块、返回 undefined 和不完整桌面三种宿主形状下，onload 均完成，设置页与视图均注册，随后调用 onunload。此启动路径未请求 Node 内建模块。
- 这些是模拟宿主验证；独立工厂的读取验证和完整插件 onload 验证是两件事，不能据此声称完整插件在桌面已完成技能扫描，也不能声称手机实机通过。

补充发现：[src/testUtils/pluginLoader.ts](../src/testUtils/pluginLoader.ts) 默认仍会把任何 `node:*` 请求交给真实 Node；仅设置 `exposeGlobalRequire: false` 不足以证明手机兼容。实施测试要明确覆盖/拒绝 Node 模块，并触发技能加载本身，不能只测导出类或启动。

## 文件系统行为：哪些能直接沿用

| 行为 | 当前 `NodeHomeEnv` | 上游 `NodeExecutionEnv`（两版相同处） | 迁移处置 |
| --- | --- | --- | --- |
| `cwd` | 默认 home，可注入假 home；只读属性 | 必须传入，仅原样存储，可写属性 | 工厂传真实 home；不要使用 Obsidian 进程工作目录 |
| 绝对路径、相对路径 | 使用宿主 `path.resolve` | 使用宿主 `isAbsolute` / `resolve`；相对路径相对于 `cwd` | 采用上游规则，保留 Windows 实机验证 |
| `~` | 展开成 `this.cwd`；因此测试假 home 生效 | 展开成 `os.homedir()`，**不取 `cwd`** | 测试使用绝对临时路径或隔离的宿主替身；不能只传 `cwd: tempHome` 后访问 `~` |
| `~\\` | 两个平台都识别前缀 | 仅 `process.platform === "win32"` 时识别；`~/` 两平台都识别 | 跟随真实宿主规则，Windows 回归要覆盖 |
| `file://` | 无 URL 解码分支 | 合法 URL 经 `fileURLToPath`；无效 URL 留作普通路径 | 不是本次产品能力扩张；配置路径校验仍由现有入口负责 |
| `joinPath` | 拼接后解析成绝对路径，展开 `~` | 只 `path.join(...parts)`；可返回相对路径，保留 `~` | 不可声称语义等价。Pi loader 从 `fileInfo.path` 获取绝对目录，再调用 join，正常加载不依赖旧的额外解析 |
| `writeFile`、`appendFile` | 自动建父目录 | 也自动递归建父目录 | 文件写入语义可复用，但只暴露产品需要的方法 |
| `renameFile` | 自动建目标父目录 | **不建目标父目录**，直接 `fs.rename` | 技能只读加载不需要它；若以后接入写入流程，显式处理父目录 |
| `createDir`、`remove` | mkdir 默认 recursive=true；remove 默认 recursive=false、force=false | 相同 | 无需自行重写 |
| `fileInfo` / `listDir` | lstat，不跟随链接；其他特殊文件误归 symlink | 同样 lstat；特殊文件 `fileInfo` 返回 invalid，列表跳过不支持的文件类型 | 接受上游更精确的对象类型 |
| `listDir` 遇到子项 lstat 失败 | 并行读取，失败子项填 size=0、mtimeMs=0 后继续 | 顺序读取；失败返回整个目录的错误 | 接受有诊断的失败；补“不可读/消失文件不会假报空目录”回归 |
| symlink | 读文件跟随；canonicalPath 解链 | 相同；悬空链接 `exists` 仍为 true，因为检查的是链接本身 | 覆盖链接到文件和目录、悬空链接 |
| `readTextLines` | 全量读后 split；CRLF 留 `\r`，结尾换行留下空项 | readline 流式读取，达到 maxLines 停止；finally 关闭 reader 和 stream | 跟随上游流式语义；技能 loader 使用 readTextFile，不受此差异影响 |
| `exec` | 返回 shell_unavailable | 会真实寻找 shell、spawn；默认继承进程环境且无超时 | 必须在宿主适配边界继续拒绝，不能把类直接当作 agent 的执行环境 |
| 临时目录 / 文件 | 返回 not_supported | 真正在 `os.tmpdir()` 创建 | 保留不支持；本次无使用场景 |
| `cleanup` | 无资源需清理 | 仅终止 activeChildPids 并清空集合，**不会删除创建的临时文件/目录** | 上游对象由工厂/调用者管理；不能依赖 cleanup 清理 temp |

本地对照：[nodeHomeEnv.ts](../src/skills/nodeHomeEnv.ts)。上游证据：[路径及类型][node843-path]、[join 和构造器][node843-constructor]、[文本流][node843-read]、[写入及 rename][node843-write]、[元数据和列表][node843-stat]、[目录及 cleanup][node843-temp]、[shell 配置][node843-shell]与[执行实现][node843-exec]。两版 `resolvePath` 函数逐字相同；0.85.1 的 [文件系统实现][node851-fs] 确认上述共同行为未变。

两版都没有名叫 `ls`、`glob`、`stat`、`fileExists`、`tempDir` 的 env 方法：准确名称是 `listDir`、`fileInfo`、`exists`、`createTempDir`；**没有 glob API**。目录递归是 Pi 的技能 loader 在 `listDir` 之上实现，不是 NodeExecutionEnv 的功能。[接口][types843]、[递归加载][skills843-recursion]

`fileInfo` 不跟随 symlink，并不意味着 loader 不跟随：loader 会调用 `canonicalPath` 后重新检查目标类型，再递归访问目录。此次迁移必须保留这一行为；文件系统类也不是把访问限制在 cwd 的沙箱。[loader 链接解析][skills843-symlink]、[路径解析][node843-path]

## 已做的小实验

环境：Linux，Bun 1.4.2；直接使用当前官方 0.84.3 模块与本项目 `NodeHomeEnv`。操作限定在新建临时目录；读取 `os.homedir()` 只用于路径解析比较，没有扫描真实 home 技能。所有实验目录最终由脚本显式删除，没有调用 shell。

| 实验 | 实际结果 |
| --- | --- |
| `joinPath(["x", "a.md"])` | 旧版得到临时目录下的绝对路径；上游得到 `x/a.md` |
| 注入 `cwd: tempHome` 后 `absolutePath("~")` | 旧版得到 tempHome；上游得到真实 home |
| `readTextLines` 读取 `first\r\nsecond\r\n` | 旧版 `['first\r', 'second\r', '']`；上游 `['first', 'second']` |
| `writeFile` / `appendFile` 写入未建父目录 | 上游两种写入均成功 |
| rename 到未建父目录 | 上游返回 not_found；旧版成功 |
| `file://` 读取临时文件 | 上游成功；旧版 not_found |
| 链接 stat / read / canonical；悬空链接 exists | 分别得到 symlink / 正文 / 目标绝对路径 / true |
| 已取消 AbortSignal 的 readTextFile | 上游返回 aborted |
| createTempDir 后 cleanup | 目录仍存在；脚本另行删除 |
| 真实 loader 加载相对根目录，包含嵌套技能、目录链接、悬空链接和 .gitignore | 两个 env 得到相同两项技能、相同路径和顺序、diagnostics=[] |

Windows、macOS、Obsidian 桌面宿主、手机实际启动均尚未实测。Windows 路径判断目前是固定版本源码证据，不能用 Linux 上的 `path.win32` 模拟冒充设备验证。

## 加载与生命周期方案

建议保留一个很小的“用户技能宿主”模块，只负责设备能力探测、懒加载、生命周期和禁止 shell；读文件、错误转换、目录枚举与路径规则全部交给 Pi。`NodeExecutionEnv` 不替换 `VaultExecutionEnv`，也不注册成模型可调用的工具。

源码确认：NodeExecutionEnv 的静态依赖包括 `node:child_process`、`node:crypto`、`node:fs`、`node:fs/promises`、`node:os`、`node:path`、`node:readline`、`node:url`；构造器只保存参数并创建一个 Set。它本身没有在模块顶层或构造时扫描目录、启动 timer、创建临时目录或 spawn；这些行为只在对应方法里执行。`./node` 还会 re-export 根入口，所以完整入口的副作用和摇树效果仍以实际 bundle 为准。[imports][node843-path]、[构造器][node843-constructor]

落实时应验证：

1. 同步能力探测继续区分“没有 require”“require 抛错”“shim 返回 undefined”。设置面板的 `userSkillsSupported()` 与加载函数共用判定，保留手机上的安静跳过与 `found: undefined`。
2. 在探测成功后，异步导入本地桥接模块；桥接模块再静态具名导入公共 `@earendil-works/pi-agent-core/node`。完整打包已验证这条路径；用短小的子类覆盖 exec/createTempDir/createTempFile 即可，不再转发十几种文件操作。
3. 构造后的对象只在技能加载模块内部使用，不交给模型工具或会话存储。执行命令与临时文件操作继续返回原来的明确错误。上游没有“禁用 shell”的构造选项，`shellPath: ""` 会走自动查找分支，不能拿它充当封口；继承上游类也不会让 shell 方法被 tree-shaking 自动删除。[shell 配置][node843-shell]
4. 只为本次工厂自己创建的对象调用 cleanup；注入测试 env 或共享对象的所有权不应被悄悄改变。由于 shell/temp 路径始终封口，此对象正常加载技能不持有长期资源。
5. 重新组织测试接缝：假 home 与假 require 是现有测试功能，不是上游构造器支持项。避免为了继续沿用测试形状复制上游文件系统逻辑。
6. 无 Node 能力时安静返回 unsupportedLoad；有能力但加载桥接模块或创建 env 失败时，转换成用户技能诊断与 unknown 搜索状态，不让它把已加载的 vault 技能一起清空，也不要把失败误报为“目录不存在”。设置页继续呈现诊断，聊天不新增每次发送都弹出的错误。

## 实施改动清单

主调用链保持为 `ObsidianAgentService.reloadSkills → loadUserSkills → loadSourcedSkills`。只替换 loadUserSkills 创建 env 的部分：

```text
loadUserSkills
  ├─ 注入了 env → 使用注入对象，清理权留给调用方
  └─ 探测 Node 能力
       ├─ 不可用 → 原有手机跳过结果
       └─ 可用 → import 本地 bridge → NodeExecutionEnv({ cwd: home })
                  → Pi loadSourcedSkills + 现有去重/溯源/目录报告
                  → finally cleanup
```

| 文件 | 具体工作 |
| --- | --- |
| [nodeHomeEnv.ts](../src/skills/nodeHomeEnv.ts) | 移除 399 行通用文件系统实现；新的宿主模块仅负责能力探测/异步构造，bridge 用公共类和三个拒绝方法 |
| [userSkills.ts](../src/skills/userSkills.ts) | 去掉默认参数 `new NodeHomeEnv()` 和 instanceof 分支；异步创建、按所有权清理、保留注入 seam 与 unsupportedLoad、目录优先级/去重/诊断 |
| [userSkillsDir.ts](../src/skills/userSkillsDir.ts) | 将 HostRequire 类型引用迁到宿主探测模块；保留平台路径校验，更新旧类的注释链接 |
| [settings.ts](../src/settings.ts) | 保持同步 userSkillsSupported；与 loader 共享探测逻辑；不为可用能力新增开关 |
| [ObsidianAgentService.ts](../src/agent/ObsidianAgentService.ts)、[skillLoader.ts](../src/agent/skillLoader.ts) | 正常调用签名不需要变；更新 NodeHomeEnv 相关契约说明，核验用户技能失败仍保留 vault/builtin 技能 |
| [esbuild.config.mjs](../esbuild.config.mjs) | external 增加 node:*，保留单个 CJS 产物、SDK aliases 与懒初始化 |
| [check-bundle.mjs](../scripts/check-bundle.mjs) | 按最终实测提高大小上限；给 faux 空包装精确预算/回归断言，保留真实 provider/SDK 和动态 import 检查 |
| [eslint.config.mts](../eslint.config.mts) | 将旧 nodeHomeEnv 的局部 Node 规则说明/范围移到实际宿主文件，不全局放开 |
| skills 与 bundle 测试 | 用行为回归替代旧类内部细节断言，增强真正拒绝 Node 的宿主模拟；独立文件执行也必须通过 |

现有语义保留：用户指定目录优先于 `~/.pi/agent/skills`，再优先于 `~/.agents/skills`；应用合并仍为 vault 覆盖 user、user 覆盖 builtin。read_skill 读取已经载入的正文，不把本机文件系统变成模型可访问的新地址空间。技能导入、编辑、删除继续用 vault env。

边界仍是一份模块实现，不新增文件系统兼容库、长驻 watcher、后台扫描循环或技能内容缓存。每次扫描创建短生命周期对象，沿用现有刷新时机；模块的懒初始化由 bundle 自己管理。

## 实施验收与回退

1. 用真实临时目录对照相同 skill 集合、正文、filePath、disableModelInvocation、sourceDir、diagnostics；覆盖根 md、嵌套 SKILL.md、ignore、同名覆盖、缺失/权限错误、symlink。返回列表失败时必须有诊断，不能假报成功空列表。
2. 宿主模拟覆盖无 require、抛错、undefined、部分模块、正常桌面；必须触发技能扫描，断言手机没有加载 Node bridge、无聊天噪声，found 为 unknown；env 注入方保有 cleanup 所有权，工厂自建 env 在成功和失败后都 cleanup。
3. 调用 shell/temp 三个方法，断言拒绝并且真实 spawn/mkdtemp/writeFile 没被触达。重复加载/卸载不留下 timer、监听器、子进程。NodeExecutionEnv.cleanup 不负责清理临时文件，不能把未测的清理能力写进承诺。
4. Windows（盘符、UNC、~/ 与 ~\\）、macOS、Linux 桌面技能读取；iOS/Android 插件启动与 vault 技能仍正常。上游声明要求 Node >=22.19.0，实际 Obsidian Electron 的 Node 版本和八个 builtin 能力要验；仅当前机器 Node 24.14.1 通过不等于所有支持宿主通过。
5. `npm run build`、全部 bundle/copy/css/version 门、`bun test`、`npm run lint`；分别执行修改过的测试文件。PR 必须无冲突、当前提交 CI 全绿后交付。设备没有覆盖的项目列明，不能用 happy-dom 代替真实设备结果。

实施可在一个 PR 内完成上述当前版替换；保留旧实现提交作为 Git 回退点即可。当前版方案不修改 skill 文件、配置格式和会话日志，撤回实现提交即可恢复旧 loader；不需要同时维护两套 env 或新增切换开关。

本研究 PR 的本地核验：`npm run verify` 通过（production build、bundle/copy/css/version 门、3208 个测试、lint）；研究脚本重跑得到上表字节数，文档本地链接与引用均已检查。测试通过的是未迁移的当前产品和研究脚本；没有用它替正式实现背书。

## 0.85.1 是另一个独立决策

即使选择 0.85，也**不要求把产品迁入 AgentHarness 或启用 telemetry 收集**。NodeExecutionEnv 是独立类；0.85 的 Context 可以使用 Pi 公共上下文模块提供的 `BACKGROUND_CONTEXT`，需要取消时用 `withAbortSignal`。不存在 telemetry 父上下文时，Pi 明确回落到 `NOOP_TELEMETRY_CONTEXT`。[Context 源码][context851]

新公共窄入口 `/harness/env/nodejs` 的运行时闭包只有本包五个文件（nodejs/types/output-capture/adaptive-publisher/truncate）和八个 node builtin。Context 类型引用被擦除；显式导入 `/harness/context` 也只经过 `chord/context` 和无外部依赖的 telemetry 小模块，**不会因此打入 esbuild**。新增 output-capture 顶层创建 TextEncoder/TextDecoder，计时器由真正的 exec 输出路径触发。以上是发布源码闭包核验，不是整仓 0.85 bundle 测量。[窄 env 源码][node851-imports]、[chord context][chord851-context]

### 已运行的试升级

在专用临时 worktree `99c1567` 上，将 pi-agent-core/pi-ai **同时**换成 0.85.1，使用 `bun add --ignore-scripts` 安装依赖；主工作树和 lockfile 没有改动。未执行发布或用户数据迁移。

- `tsc -noEmit -skipLibCheck`：**213 条诊断 / 26 个文件**，其中生产文件 105 条 / 15 个。诊断数包含同一个接口变化引出的连锁报错，不代表 213 个独立修复任务。
- 主要集中在 `ObsidianSessionManager.ts`（55 条）、`ObsidianAgentService.ts`（13 条）、技能加载/导入、VaultExecutionEnv 和 session JSONL/搜索；测试也需要新的上下文和会话构造。
- 单独调用 esbuild 仍失败：`parseMutation`、`parseHeader`、`buildContextEntries`、`buildSessionContext`、`sessionEntryToContextMessages`、`createScanningSessionSearch` 六个运行时导入不再匹配。不是传入 Context 就能收尾。
- 旧 Session 值构造、view/moveLane/getLog/findOpenOperations/findRecords 等接口消失或改形；JSONL mutation codec 和搜索命中类型也变化。全面升级必须先确认现有会话数据的读写/同步兼容、准备旧格式 fixture 和回退设计，再迁移提供商/工具适配。
- 临时 worktree 已移除；此实验没有跑新版完整测试，也没有生成可发布 bundle。因此不能报告 0.85 已兼容，也不能给出其整包大小。

这使 0.85 成为独立的会话与 SDK 升级工程。包体门槛放宽后，没有必要只为一个 env 把这项工程捆进来。

但“只是给方法多传一个参数”也不准确。下面完整列出 FileSystem / Shell 公共接口差异；统一返回 `Promise<Result<返回值, FileError>>`，exec 使用 ExecutionError，cleanup 返回 `Promise<void>`。`S?` 表示可选 `AbortSignal`，`C` 表示必填 `Context`。源码：[0.84.3][types843]、[0.85.1][types851]。

| 成员（返回值） | 0.84.3 参数 | 0.85.1 参数 |
| --- | --- | --- |
| `cwd` | `string` 属性 | `string` 属性 |
| `absolutePath`（string） | `path: string, S?` | `path: string, C` |
| `joinPath`（string） | `parts: string[], S?` | `parts: string[], C` |
| `readTextFile`（string） | `path: string, S?` | `path: string, C` |
| `readTextLines`（string[]） | `path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }` | `path: string, options: { maxLines?: number } \| undefined, C` |
| `readBinaryFile`（Uint8Array） | `path: string, S?` | `path: string, C` |
| `writeFile`（void） | `path: string, content: string \| Uint8Array, S?` | `path: string, content: string \| Uint8Array, C` |
| `appendFile`（void） | 同 writeFile | 同 writeFile |
| `renameFile`（void） | `sourcePath: string, destinationPath: string, S?` | `sourcePath: string, destinationPath: string, C` |
| `fileInfo`（FileInfo） | `path: string, S?` | `path: string, C` |
| `listDir`（FileInfo[]） | `path: string, S?` | `path: string, C` |
| `canonicalPath`（string） | `path: string, S?` | `path: string, C` |
| `exists`（boolean） | `path: string, S?` | `path: string, C` |
| `createDir`（void） | `path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }` | `path: string, options: { recursive?: boolean } \| undefined, C` |
| `remove`（void） | `path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }` | `path: string, options: { recursive?: boolean; force?: boolean } \| undefined, C` |
| `createTempDir`（string） | `prefix?: string, S?` | `prefix: string \| undefined, C` |
| `createTempFile`（string） | `options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }` | `options: { prefix?: string; suffix?: string } \| undefined, C` |
| `cleanup`（void） | 无参数 | `C` |
| `exec` | `command: string, options?: ShellExecOptions`；返回 `{ stdout, stderr, exitCode }` | `command: string, options: ShellExecOptions \| undefined, C`；返回 `ShellExecResult` |

接口与具体实现还要区分：0.84.3 `NodeExecutionEnv` 对 absolutePath/joinPath、appendFile、fileInfo、canonicalPath、exists、createDir/remove、临时文件的方法实际上没有接收或检查接口允许的取消参数；readTextFile/readBinaryFile/writeFile/renameFile/listDir/exec 等才明确处理。0.85.1 增加大量 `context.abortSignal` 预检查，但 absolutePath/joinPath/cleanup 的参数仍命名 `_context`，没有取消行为。[0.84.3 类声明产物][node843-dts]、[0.85.1 路径方法][node851-path-methods]与[文件系统实现][node851-fs]

0.85.1 另外两处影响调用者：

- `ShellExecOptions` 去掉 `abortSignal`、`onStdout`、`onStderr`，增加有界输出 `capture` 与 `onUpdate(update, context)`；结果不再返回完整 stdout/stderr。未提供 capture/onUpdate 时输出被丢弃。[输出接口][shell851]
- `loadSkills(env, dirs, context)` 多必填 Context；`loadSourcedSkills(env, inputs, mapSkill, context)` 的 mapSkill 位置不可省略，只能传 undefined，回调还收到第三个 Context 参数。[loader 0.85.1][skills851]

因此，当前版迁移可以独立实施；未来 0.85 升级应另列会话持久化/同步兼容、工具签名、取消传播、输出处理、提供商 shim、测试替身和依赖打包的完整核验清单。

[pkg843]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/package.json#L8-L61
[pkg851]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/package.json#L8-L82
[entry843]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/node.ts#L1-L2
[npm843]: https://registry.npmjs.org/@earendil-works/pi-agent-core/0.84.3
[npm851]: https://registry.npmjs.org/@earendil-works/pi-agent-core/0.85.1
[tar843]: https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.3.tgz
[tar851]: https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.1.tgz
[npm-chord851]: https://registry.npmjs.org/@earendil-works/chord/0.85.1
[npm-ai843]: https://registry.npmjs.org/@earendil-works/pi-ai/0.84.3
[npm-ai851]: https://registry.npmjs.org/@earendil-works/pi-ai/0.85.1
[node843-path]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L1-L124
[node843-constructor]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L347-L365
[node843-shell]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L171-L275
[node843-exec]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L367-L500
[node843-read]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L502-L542
[node843-write]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L555-L600
[node843-stat]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L602-L649
[node843-temp]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/env/nodejs.ts#L651-L694
[node843-dts]: https://unpkg.com/@earendil-works/pi-agent-core@0.84.3/dist/harness/env/nodejs.d.ts
[node851-path-methods]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L395
[node851-fs]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L619-L850
[node851-imports]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L1-L35
[chord851-context]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/context/index.ts#L1-L120
[types843]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/types.ts#L231-L315
[types851]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/types.ts#L261-L391
[skills843-recursion]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/skills.ts#L50-L175
[skills843-symlink]: https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/skills.ts#L339-L369
[context851]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/context.ts#L1-L36
[shell851]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/types.ts#L318-L387
[skills851]: https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/skills.ts#L51-L108
