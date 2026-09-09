# 原版 Pi 书签桥：实现与验收

## 交付范围

基线 `ff8bf0a98535b05d9c15b958508d09551eb66142`。

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

`npm run verify` 全部通过：build、bundle、skills、copy、CSS、version、3252 项测试、
lint。202 个测试文件逐个独立运行也全部通过。最后一次接口拒绝收紧后，重跑完整
verify 及 19 项 bridge/真实产物专项测试。

产物 `main.js`：

- SHA-256：`d4a55aa76bd5fec88bd650fd3f32452ea302d28a99b9da571b6126f9dc331bcc`
- 1,783,412 字节。相同依赖环境下重建基线为 1,720,434 字节，增加 62,978 字节。
- 体积门限按已有 0.01 MiB 递进规则设为 1.71 MiB；不含动态加载器/TUI/高亮。
- 原有 1 处容忍的 opaque dynamic import 未增加；手机模拟中，现有技能模块仍
  会捕获一次 Node 能力探测失败，书签执行期间没有新增 require 或动态 import。

主要回归覆盖：原版加载与移除、A/B 隔离、串行保存、失败重试、只同步标签、
分叉、回退后的全日志选择、保存中删除、过期宿主、IME Enter、卸载监听清理、
短操作的引用计数及清理保护、只读资源与相对虚拟路径。

## 真实 Obsidian smoke

隔离 vault/profile；没有用户笔记，没有模型密钥，没有调用模型。

- Obsidian 1.13.7，Electron 43.3.0，Node 24.18.1，Chrome 150.0.7871.212。
- 独立 Xvfb :97，CDP 仅监听 127.0.0.1:9338。禁 GPU，低优先级，进程有外层超时。
- 最终产物经过 35 项流程断言：实际命令注册与原生弹窗焦点、保存前切换聊天、
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

同一 Electron renderer 中重复六轮函数编译采样：基线中位 56.2 ms，本版 58.4 ms；
三轮本版插件加载为 178.9 / 187.0 / 223.9 ms。只是同机温态观察，不是手机启动
基准，也不证明差异具有统计显著性。

本机原始证据保存在 `/tmp/piem-bookmark-smoke-vh9zbv0z/`：`results.json`、
`limits-results.json`、`visual-results.json`、`performance.json`、四张 PNG 和
`cleanup.json`。自动检查日志为 `/tmp/piem-extension-verify-final.log` 与
`/tmp/piem-bookmark-isolated-results.log`。原始产物和临时文件不提交。

## 验证边界

iOS/Android 真机未验收；不把 VM 或缩窄桌面窗口称为手机真机通过。
本次只内置原版 bookmark。系统命令、动态扩展安装、TTY、其他扩展事件/工具适配
和 Pi core 升级不在此实现中。#391 / #393 的真机要求及更通用能力、#392 的官方
公开类型修复仍需后续处理，因此本 PR 不自动关闭这些 issue。
