# 手机 Pi 兼容桥选型

调查日期：2026-09-10。星数来自当日 GitHub REST API 的 `stargazers_count`，只是
关注度快照，不代表适用性或维护质量。选型依据为仓库源码与官方文档。

| 方案 | 星数 | 核实的能力与限制 | 结论 |
| --- | ---: | --- | --- |
| [unenv](https://github.com/unjs/unenv) | 768 | MIT，Nuxt/Nitro 等采用；提供 alias/inject/preset。`fs.readFileSync`、写入等仍为 `notImplemented`，README 的覆盖勾选不代表真实文件系统 | 借鉴按环境替换模块；整套替换不能解决 Vault 与 Pi 会话 |
| [BrowserFS](https://github.com/jvilk/BrowserFS) | 3165 | README 从 2024-03-22 起明确 DEPRECATED，推荐 ZenFS；模拟 Node fs，异步后端同步化要镜像 | 不引入已弃用依赖 |
| [ZenFS](https://github.com/zen-fs/core) | 422 | Node fs、多后端与同步操作；仓库声明 LGPL-3.0，后端需单独实现/配置 | 将来确需通用虚拟文件系统时重新评估；当前没有 Vault 后端可直接套用 |
| [memfs](https://github.com/streamich/memfs) | 2093 | Apache-2.0，内存 Node fs 与浏览器 FSA 适配 | 可用于虚拟卷，但不是 Obsidian Vault；目前只读包元数据无需引入完整卷和镜像 |
| [node-libs-browser](https://github.com/webpack/node-libs-browser) | 449 | GitHub 已归档；README deprecated；fs、child_process 等没有浏览器实现 | 不采用 |
| [WebContainer Core](https://github.com/stackblitz/webcontainer-core) | 4635 | 该仓库 README 明示是问题追踪入口，仓库 MIT 不能解释为运行内核开源许可；官方文档要求 SharedArrayBuffer 与跨源隔离 | 不能直接嵌进 Obsidian 手机 WebView；体量、部署和会话模型均不匹配 |

一手证据：

- [unenv 使用方式](https://github.com/unjs/unenv/blob/f89b7ccb5c05da70b946319783acf1fa1f113e22/README.md)、
  [fs 未实现操作](https://github.com/unjs/unenv/blob/f89b7ccb5c05da70b946319783acf1fa1f113e22/src/runtime/node/internal/fs/fs.ts)。
- [BrowserFS 弃用声明与 AsyncMirror](https://github.com/jvilk/BrowserFS/blob/master/README.md)。
- [ZenFS 后端与默认内存卷](https://github.com/zen-fs/core/blob/1047a5de15543fa89d561382339f4f55289f86f3/README.md)。
- [memfs 文件系统与适配范围](https://github.com/streamich/memfs/blob/a6eec7a016b5aa3ce26f0a79de3673a82bab4092/README.md)。
- [node-libs-browser 弃用及未实现模块](https://github.com/webpack/node-libs-browser/blob/master/README.md)。
- [WebContainer 仓库用途](https://github.com/stackblitz/webcontainer-core/blob/539de1335e893ebe8eaf2df69cd5f056babf1091/README.md)、
  [平台要求](https://webcontainers.io/guides/browser-support)。这份官方浏览器支持页面
  自报最后更新为 2023 年，因此不把其 Safari beta 描述当作当前全部平台的兼容结论。
  没有查到 Obsidian iOS/Android WebView 的支持承诺。

## 决策

没有发现能直接满足“Obsidian Vault + Pi 原版扩展 + 受限手机 + 无运行时代码下载”
的整套成熟桥。采用小型宿主：复用 Pi 原版 loader/runner/event bus/tool wrapper；
继续使用成熟的 [pathe](https://github.com/unjs/pathe)（589 星）及
[events](https://github.com/Gozala/events)（1408 星），不自行实现路径或事件算法。

构建清单统一登记固定版本、虚拟路径和源码 SHA-256。平台层只读取随包内置的
资源，操作系统、进程执行、动态加载明确拒绝；Pi 宿主单独实现当前会话、上下文
过滤、工具与命令适配。同步 Node fs 不冒充异步 Vault，避免引入双份笔记和迟到写入。

首批优先级沿用[社区调研](2026-09-09-mobile-pi-community-extensions-research.md)：
模型交接标注、切换模型、无提示继续；书签迁移到同一个宿主实现。原版扩展代码
保持不变，宿主接线在产品内完成。适配不是任意 npm 包的沙箱，也不是通用 Node
运行时；新扩展必须先审查其实际能力并通过构建与运行验收。
