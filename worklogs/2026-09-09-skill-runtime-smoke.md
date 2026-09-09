# Obsidian 技能运行时烟测与手机受限模拟

2026-09-09，在 PR #398 的实现上补充真实运行验收，并修复烟测发现的移动端 Node 探测提示。

## 运行环境与产物

- 实际宿主：Obsidian 1.13.7、Electron 43.3.0、Chromium 150.0.7871.212，Linux ARM64，独立 Xvfb 虚拟桌面。
- 独立样例笔记库和配置目录；没有修改日常笔记库或使用真实服务商密钥。
- 最终构建 `main.js`：1,727,624 字节，SHA-256 `0851a8b90615d77286a592622e817d6c694ae4c91e153adc7f9e31ecd683b692`。测试库副本与本地构建逐字节摘要相同。
- 正文、资源、写入与会话编码使用实际 Obsidian Vault 和已构建插件。聊天与摘要通过本机 HTTP 服务返回确定的 OpenAI 兼容响应；GitHub 导入使用固定响应夹具。它们验证工具调用链，不代表真实模型的技能选择质量。

## 结果

| 场景 | 已执行内容 | 结果 |
| --- | --- | --- |
| 桌面 | 内置/笔记库/用户目录发现；真实资源读取；越界符号链接拒绝；长中文和表情正文三页续读；实际聊天、压缩、落盘重开与下一次请求 | 17 项通过 |
| iOS 受限模拟 | Obsidian 手机界面，390×844；插件平台标记为 iOS；禁止 Node/Electron 模块；屏蔽 process、Buffer、global、electron、全局 require；不提供 secretStorage | 19 项通过 |
| Android 受限模拟 | 360×800；Android 平台标记；同样屏蔽宿主模块与全局；发出 CDP 4 倍 CPU 降速指令 | 19 项通过 |
| 权限恢复 | 真实 Vault 的资源读取返回权限错误，缓存正文仍可用；恢复后无需重载即可读取资源 | 3 项通过，含受限模式 |
| 安装 | 单个技能目录的 SKILL.md 与 Markdown 引用真正写入 Vault，刷新后可读；不请求脚本 | 通过，3 次夹具请求、0 次脚本请求 |
| 生命周期 | 连续卸载/重载 3 次，用户资源仍可用；卸载清空服务与会话 runtime | 9 项通过；0 次子进程创建，0 个新增跟踪句柄 |

受限模式全过程保留模块请求记录，修复后只请求 `obsidian`，Node/Electron 请求为 0，未捕获到未处理异常。手机页面与消息列的 `scrollWidth` 等于 `clientWidth`：390 像素页面 / 276 像素消息列，360 像素页面 / 308 像素消息列。已人工查看截图。

压缩验证检查实际下一次 provider 请求中仍有技能末尾与引用内容，同时系统提示只含技能目录。保留副本不在聊天界面重复展示。七个内置技能预置为与构建摘要一致的文件，离线可用；本次未验证首次联网下载内置资源。

## 烟测发现并修复的问题

Obsidian 原生 `app.emulateMobile(true)` 会在插件尝试加载 Node 包时显示 Notice，即使插件捕获了失败。旧 `nodeSkillsHome` 与目录校验会主动探测 `node:fs/promises`、`node:path`、`node:os`：一次加载/刷新记录到 16 条提示，技能列表虽然正确降级，却打扰用户。

现先用 Obsidian `Platform.isMobile` 跳过宿主模块探测；手机保留同步来的桌面目录配置，桌面仍按模块实际能力判断。回归同时覆盖源码和构建产物，要求手机加载与刷新过程中 **一次 Node 请求也没有**。真实模拟器重跑后 Node 请求、对应控制台错误均归零。

实现：[nodeSkillsHost.ts](../src/skills/nodeSkillsHost.ts)、[userSkillsDir.ts](../src/skills/userSkillsDir.ts)。回归：[bundleLoad.test.ts](../src/bundleLoad.test.ts)、[nodeSkillsHost.test.ts](../src/skills/nodeSkillsHost.test.ts)、[userSkillsDir.test.ts](../src/skills/userSkillsDir.test.ts)。新增 Obsidian 运行时依赖的测试文件先安装共享 stub，保证文件单独运行。

修复后 `npm run verify` 通过：构建、bundle/skills/copy/css/version 门禁、3,252 项测试（199 个文件）和 lint 全部通过。五个受影响的测试文件独立运行也通过；完整门禁构建与实际烟测产物的 SHA-256 相同。

## 可复核证据与边界

本机证据保存于 `/home/ubuntu/piem-skill-smoke-20260909/`：`summary.json`、各场景结果 JSON、CDP 场景脚本、测试服务脚本，以及 `desktop.webp`、`ios-restricted.webp`、`android-restricted.webp`。原始独立 Vault、配置与请求记录位于 `/tmp/piem-skill-runtime-63mo0edx/`。临时构建与截图不作为发布文件提交。

受限模式使用 Obsidian 原生手机模拟界面和真正的 Vault，再在插件加载包装中拒绝宿主模块、屏蔽 Node 全局并提供手机 Platform。它仍运行在 Chromium：**没有验证 iOS WebKit、Android WebView、Capacitor 文件桥、真机内存回收、软键盘或后台恢复**。CPU 降速是调试器模拟，不是手机性能基准。

首轮虚拟桌面在功能检查通过后出现 Electron `GPU process isn't usable`，实例退出；后续重启并完成桌面复测、两种手机模式及生命周期验证。该退出的根因没有进一步证明，不能凭功能断言排除图形运行风险。宿主日志还出现测试环境回收站不可用提示，未作为技能检查通过的依据。

结束时主动卸载插件，确认服务已清空、runtime 数为 0；停止并 wait 回收本任务的 Obsidian、Xvfb 与本机 HTTP 服务，检查进程及监听端口均已消失。其他任务的实例未被操作。
