# 原版 Pi 书签桥：实现与验收

## 交付范围

初始基线 `ff8bf0a98535b05d9c15b958508d09551eb66142`；手机 Node 补验时同步到
`a6d1d8669b347a160ffb92b4f2b01a647f1f9463`，沿用已合入的手机技能探测修复。

直接导入 `@earendil-works/pi-coding-agent` 0.84.3 的原版 loader、Runner、event bus
和 `examples/extensions/bookmark.ts`；没有复制这些实现。有限 Node 桥只服务这条
静态依赖图，现有桌面用户技能继续使用原生 NodeExecutionEnv。

- 打包时检查版本与关键源码 SHA-256；各模块的 `import.meta.url` 对应自己的
  虚拟路径。仅提供只读包元数据、路径、URL、环境与浏览器 EventEmitter。
- jiti、CLI 根入口、TUI、语法高亮与 cross-spawn 的未使用边被摇掉；如果重新
  可达，构建失败。模块组成门禁要求原版文件存在，禁止这些大依赖回归。
- Runner 构造器的具体 CLI 类类型缺口用单一 `Reflect.construct` 边界隔离，
  检查结果确为官方 Runner；没有把宿主强转成完整 SessionManager/ModelRegistry。
  未接入接口明确拒绝。它只支持所选 bookmark，并非通用 ExtensionAPI 宿主。
- 每段现有会话惰性建立一个宿主，命令串行执行，读取完整日志快照，等待原版
  handler 和真实标签写入完成后再通知成功。焦点切换不会改变 owner。
- 原生 Obsidian 命令提供添加、移除、搜索及读取书签；标签限制为 160 字符，
  长回复摘要为 4000 字符。中英文文案及文档同步更新。
- 修复标签同步的必要边界：无新增本地消息时保留磁盘分支与操作记录，只补缺失
  facts；序列化读取保留真实 lane 头。同步移走书签目标时明确拒绝写入，不误报成功。
- Pi、pathe、events 的许可文本随生成的 `main.js` 一起分发。

## 本地自动检查

环境：Linux arm64，Bun 1.4.2，Node 24.14.1，esbuild 0.25.5。

最终同步主分支后，`npm run verify` 全部通过：build、bundle、skills、copy、CSS、
version、3285 项测试和 lint。205 个测试文件逐个独立运行也全部通过。

产物 `main.js`：

- SHA-256：`92b633578df7277399abefaa9d98c8b9569a1f6d8b7d143c958fb582dd7305ee`
- 1,790,598 字节。相同依赖环境下重建当前基线 `a6d1d86` 为 1,727,624 字节，
  增加 62,974 字节。
- 体积门限按已有 0.01 MiB 递进规则设为 1.71 MiB；不含动态加载器/TUI/高亮。
- 原有 1 处容忍的 opaque dynamic import 未增加。初次测试中的用户技能 Node
  探测已由主分支修复；下面的最终官方模拟审计要求插件全程只请求 `obsidian`。

主要回归覆盖：原版加载与移除、A/B 隔离、串行保存、失败重试、只同步标签、
分叉、回退后的全日志选择、保存中删除、过期宿主、IME Enter、卸载监听清理、
短操作的引用计数及清理保护、只读资源与相对虚拟路径。

## 真实 Obsidian smoke

隔离 vault/profile；没有用户笔记，没有模型密钥，没有调用模型。

- Obsidian 1.13.7，Electron 43.3.0，Node 24.18.1，Chrome 150.0.7871.212。
- 独立 Xvfb :97，CDP 仅监听 127.0.0.1:9338。禁 GPU，低优先级，进程有外层超时。
- 最终产物经过 36 项桌面流程断言：设备模式、实际命令注册与原生弹窗焦点、保存前切换聊天、
  搜索与回复显示、注入磁盘失败后保留输入并重试、分叉保留书签、外部标签同步、
  移除、连续三次卸载重载、保存中删除且文件不复活。
- 三轮重载事件注册数均为 21；新增子进程 0，新增 ChildProcess/FSWatcher/FSEvent
  句柄 0，浏览器 fetch 调用 0，流程中的 renderer errors/unhandled rejections 0。
- 另验证 5 个边界：5000 字回复截为 4000 字、忙碌会话拒绝、回退到空 lane 后
  lane 仍为空、只追加标签、仍由原版逻辑选择全部日志中的最后回复。
- 1120px / 390px 的深浅主题四张真实窗口截图与布局测量均无书签弹窗横向溢出。
  390px 是缩窄的桌面窗口，不能当作 iOS/Android 真机验证。

可重跑脚本：

```bash
node scripts/smoke-bookmark-obsidian.mjs 9338 /path/to/isolated-smoke
```

先将真实产物安装到 `/path/to/isolated-smoke/vault/.obsidian/plugins/piem/`，用独立
profile 启动 Obsidian，启用插件并开放上述本地 CDP 端口。脚本会确认 vault 路径，
创建测试对话并将结果写入该目录的 `results.json`；不会读取其他 vault。
准备当前版本的内置 Markdown 技能及安装记录可避免首装 GitHub 下载干扰观察。

### 官方手机模拟补验

此前的 390px 检查只是桌面窄屏，没有启用官方手机模拟。用户指出后，按
[Obsidian 官方移动开发文档](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
执行 `app.emulateMobile(true)`；应用会自动重载。再通过 DevTools/CDP 设置
390 × 844 视口，确认 `app.isMobile === true`，页面同时带有 `emulate-mobile`、
`is-mobile`、`is-phone`。

```bash
node scripts/smoke-bookmark-obsidian.mjs 9338 /path/to/isolated-smoke --expect-mobile
```

补验的重点是插件是否还能访问 Node。读取真实 Obsidian `loadPlugin` 实现后确认：
`emulate-mobile` 模式下，插件自己的 `require` 只提供 Obsidian 白名单模块；
Node/Electron 请求会触发 Notice、`console.error` 并返回 `null`。DevTools 控制台的
全局 `require` 仍可用，不能拿控制台的结果当作插件的结果。

`obsidian-plugin-node-audit.mjs` 在四次真实插件加载时观察官方传给 Piem 的
`require`，不改写 `main.js`，也不把自制模块拒绝器冒充官方行为：

- 使用同一个插件 `require` 故意请求 `fs`、`node:fs`、`node:fs/promises`、
  `child_process`、`node:module` 和 `electron`，六项均拿不到模块。
- Piem 本身在加载、保存/读取/移除、失败重试、A/B 切换、同步、分叉、三次重载
  及保存中删除全流程只请求 `obsidian`；Node/Electron 请求为 0。
- 41 项检查通过。除上述六次验证拦截用的预期错误外，控制台错误、未处理异常、
  新增子进程和 watcher 均为 0。结果单独保存为 `results-mobile.json`。

首次观测还发现旧用户技能探测反复请求 Node，产生提示；书签本身不依赖这些
模块。该修复在验证期间由主分支的 `a6d1d86` 合入，当前分支已同步使用，
没有保留另一套相同修复。

初次补验失败的是脚本的桌面假设：原生 Modal 仅在有物理键盘时自动聚焦。
脚本现按设备模式检查焦点，并等待手机弹窗关闭动画完成。
另用真实 CDP 触控输入验证深浅主题：点输入框能聚焦、输入标签后点按钮能保存；
输入框与按钮均为 44px 高，弹窗宽 366px，没有横向溢出。

新增原始证据：`mobile-state.json`、`results-mobile.json`、
`mobile-touch-results.json`、`official-phone-light.png`、`official-phone-dark.png`、
`cleanup-mobile.json`，均位于同一隔离 smoke 目录。

官方模拟能检查插件的 Node 模块依赖，但没有删除 renderer 的全部 Node 全局。
因此另将真实成品放入独立 VM：`process`、`Buffer`、全局 `require`、`Bun`
在初始化及异步调用期间始终缺席。该环境仍完成初始化、书签保存、重开读回、
移除及写入失败重试；Node/Electron 和动态 import 的负对照测试确保门禁会拒绝
错误依赖。使用的 Obsidian API 与 Vault 在 VM 中是测试实现，官方模拟使用的
则是真实 API/Vault；两项证据分别验证环境缺失与实际宿主行为。

模拟不验证手机软键盘、系统 WebView、文件权限或真机性能。
退出使用 `app.emulateMobile(false)`。

初始基线与首版产物在同一 Electron renderer 中重复六轮函数编译采样：
基线中位 56.2 ms，首版 58.4 ms；
三轮本版插件加载为 178.9 / 187.0 / 223.9 ms。只是同机温态观察，不是手机启动
基准，也不证明差异具有统计显著性。

本机原始证据保存在 `/tmp/piem-bookmark-smoke-vh9zbv0z/`：`results.json`、
`limits-results.json`、`visual-results.json`、`performance.json`、四张 PNG 和
`cleanup.json`。最终自动检查日志为 `/tmp/piem-mobile-node-rebased-verify.log` 与
`/tmp/piem-mobile-node-rebased-isolated.log`。原始产物和临时文件不提交。

## 验证边界

iOS/Android 真机未验收；不把官方桌面手机模拟、VM 或缩窄桌面窗口称为真机通过。
本次只内置原版 bookmark。系统命令、动态扩展安装、TTY、其他扩展事件/工具适配
和 Pi core 升级不在此实现中。#391 / #393 的真机要求及更通用能力、#392 的官方
公开类型修复仍需后续处理，因此本 PR 不自动关闭这些 issue。
