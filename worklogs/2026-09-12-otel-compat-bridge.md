# OTel 依赖图的兼容桥修复

基线：`645917e6ad7e285e244da7bf03c3816060f5762a`。范围是此前定位的三个宿主侧接入阻塞，不改 b1tank 原厂业务行为，不在生产中登记或启用遥测扩展。

## 实现与依据

1. 新增显式 `audit.browser` 包内文件映射。只允许确切的 `./source.js` → `./browser/source.js`；目标必须列入 files 并通过哈希、版本、realpath 检查。入口、已登记 package subpath 和相对导入均适用；不从可变化的 package.json 自动接纳新的源码。
2. 相对源码解析支持 `./lodash.merge` → `lodash.merge.js`。隐式代码后缀、TypeScript 替代和文件/目录优先级与项目所用 esbuild 做对照测试。
3. 后台工厂的 globalThis/window/self/global 使用每实例私有视图；合法 alias 与计算属性可用，SDK Symbol 注册不写入宿主。fetch/timers/process 仍沿原有归属能力，运行时 import/require 和未审核 Node 模块继续拒绝。视图不是任意 JavaScript 安全沙箱。
4. 官方浏览器 SDK 的 document visibilitychange/pagehide 经有限视图转发，事件不携带真实 DOM 引用；开始 shutdown、工厂失败、资源撤销时移除监听。新 helper 仅在相应编译图使用时进入产物。

依据：[esbuild onResolve](https://esbuild.github.io/plugins/#resolve) 完全接管解析、[resolveExtensions](https://esbuild.github.io/api/#resolve-extensions)、[browser 平台](https://esbuild.github.io/api/#platform)、[inject 的词法绑定](https://esbuild.github.io/api/#inject)。保持现有审核边界，不以放开 ambient globals 换取 SDK 编译成功。

## 自动验证

- `npm run verify` 全通过：build、bundle/skills/copy/CSS/version、**3763 个测试 / 254 文件 / 13022 断言**、lint。日志 `/tmp/piem-otel-bridge-verify.log`。
- 8 个直接涉及的测试文件逐个独立运行通过，日志 `/tmp/piem-otel-bridge-independent.json`。新增跨层 contract 覆盖 browser+带点路径、四种 global 入口、跨模块 Symbol、两个会话、隐藏页 flush、失败工厂立即清理、shutdown 超时清理。
- 首次完整 typecheck 暴露新测试 onResolve 的隐式无返回，已修；还修正测试 Event/EventTarget 跨 DOM realm 的顺序依赖。未把定向测试成功代替完整门禁。
- 初次 bundle gate 超限：原 2,002,780 B → 2,003,146 B（+366 B），新增 bytes 是资源 shutdown signal。metafile 确认 extensionGlobals 和全部 OTel SDK 均未进入生产包；门限调整为 2,004,000 B，而非为外部 SDK 预留大额空间。

## 原厂图和真实宿主

固定 [b1tank/pi-otel `337d139`](https://github.com/b1tank/pi-otel/tree/337d1390571dacc4b07e6500ecbadabf585c19d9)，OTel 按上游锁文件使用 API 1.9.1、SDK 2.10.0、exporters/log SDK 0.221.0。原厂源码未改，通过当前生产 `buildScopedFactory` 编译；第二层浏览器 bundle **176,840 B、0 外部 import**。这是独立临时 fixture，不是成品插件增量。

临时诊断 audit 的全部登记源码均校验；逐个核对真实 package browser 映射，仅记录实际目标存在的映射。sdk-trace-base 的 metadata 含未使用且目标不存在的旧 platform 映射，未将它加入诊断清单；实际代码从 sdk-trace 取得 browser processor。诊断清单不是生产扩展审计声明。

真实 `CommunityHost` + 无 Node VM + 内存传输：两会话三种信号 JSON 导出，页面隐藏触发发送，A 关闭不影响 B，监听 8 → 4 → 0；ambient OTel 注册标记保留，正常内容 sentinel 不出站。证据 `/tmp/piem-otel-bridge-verification-20260912-8m6k8oil/{compile-result,host-result}.json`，运行脚本及 audit 同目录。

真实 Obsidian 1.13.7 arm64，临时 Vault/Profile/Xvfb；生产包副本后附加上面编译的原厂工厂，测试后恢复原包：

- 桌面：原厂 OTel 14 项，现有社区扩展 39 项，研究扩展 105 项。
- 官方手机模拟（390 × 844）：原厂 OTel 14 项，现有社区扩展 44 项，研究扩展 110 项。
- OTel 使用真实 requestUrl 向回环测试端点发送 /v1/traces、/v1/metrics、/v1/logs，服务器检查 JSON content-type、三次模型调用的 span 和两个会话身份、卸载后请求不增长。回环端点仅校验接收到的协议结构，不冒充完整 OTel Collector。
- 原厂工厂会给恢复中的旧会话也建实例，首次脚本错误地假定恰有两实例；已按初始化恢复数校正并重新通过，没有改产品逻辑迎合测试。
- 测试 Obsidian 由 600 秒上限的父进程管理；首轮到期退出时，随后一次 CDP 回归收到 ECONNRESET。已确认该实例与 crash handlers 退出后重新启动。恢复时手机模式仍在，但视口回到平板宽度，补回 390 × 844 后手机回归重新通过；这些初次失败不计为产品验证成功。
- 桌面/模拟结果都对应生产 SHA256 `db83d30ab00b0f5c79dc59cf112613c878e078c2db35de8f173d444300246213`；文件在 `/tmp/piem-otel-bridge-smoke-20260912/`，`otel-smoke.mjs` 为原厂测试脚本。

## 验证边界

只完成这三个兼容桥阻塞及必要生命周期保障。没有部署 Collector、连接外部遥测后端或改上游模型耗时/隐私语义；没有 iOS/Android 真机、系统冻结恢复和真实弱网结果。原厂 OTel 仅用于临时验收，生产包不包含它。测试服务、CDP、Obsidian/Xvfb 和 detached crash handlers 在本轮收尾时按归属清理。
