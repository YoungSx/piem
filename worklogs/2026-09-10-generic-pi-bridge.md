# 通用 Pi Bridge 兼容能力

日期：2026-09-10。基线：`f6a696f3d4b318286f5edf594285e1ea905cf404`。

用户最终范围是只交付通用 Bridge，不接入 `pi-suggest`。本次没有新增社区扩展、
工厂或能力开关。现有 Quick actions 生成和点击直接发送行为保持原样。

## 实现

- 已审核社区源码的两个 Pi 命名空间在构建时解析到同一组兼容导出；沿用原版
  loader、Runner 与会话，不复制或改写社区扩展函数。未知导出继续构建失败。
- 导入的 `complete` 与 `getApiKey` / `getApiKeyAndHeaders` 兼容。返回的是绑定
  聊天、模型和回调的不透明凭据，真实密钥仍由 Piem 网络通道读取；沿用原有
  两请求并发上限、60 秒超时、用量归属与物理网络完成前占位。
- 标准 `Container`、`Text`、`SelectList`、`DynamicBorder`、`BorderedLoader`
  映射为 Obsidian 原生控件。私有弱引用保留 render 行数组的结构，包装器原样
  转交仍可用；任意文本不解析成 HTML 或猜测按钮。主题格式函数保留文字，
  原生界面沿用 Obsidian 主题。
- `setWidget(factory)` 支持替换和重新挂载；`custom(factory)` 使用原生弹窗。
  `done` 同步撤销旧控件，异步工厂迟到返回会清理，刷新请求合并且不能自激，
  一个清理失败不妨碍其他资源退出。
- 快捷操作提供输入框内按键及可触摸的折叠菜单。输入法、导航、发送与标准
  编辑按键保留；旧挂载的操作不会因相同 adapter 再使用而复活。

取消覆盖宿主可管理的调用。扩展自建后台任务仍须通过组件 `dispose` 和自己的
取消信号结束；Pi 的 void 回调返回 Promise 时会观察错误，但不会假称浏览器能
拦住任意异步闭包。两种语言的手册均写明此边界。

## 验证证据

- 最终生产构建、bundle/skills/copy/CSS/version 门禁通过；全量 **3442 tests /
  0 fail / 11441 assertions**。`npm run verify` 的外层超时在最后 lint 阶段结束
  进程，随后单独 `npm run lint` 完成并返回 0，不把超时记录称作整条命令成功。
  原始记录为 `/tmp/piem-generic-verify.log`、`/tmp/piem-generic-lint-final.log`。
- 生产 `main.js` 为 **1,879,729 字节**，SHA-256
  `db5c01a3cfc73be2dcfa6cef20583dbddd5b1333ad1f8087e4740ec197d9b4fc`。
  bundle 门限按既有规则调到 1.80 MiB；非零模块无新社区扩展、终端运行时或
  本地契约工厂。未提交构建产物。
- `scripts/native-extension-fixture.test.ts` 使用本地测试工厂的公开 Pi 包导入，
  在无 Node、无 provider SDK、无终端运行时的 VM 中验证组件、快捷操作、模型
  请求、凭据保密、重挂及清理；这不是社区包集成测试。
- 新增/改动的 11 个测试文件分别独立通过；记录为
  `/tmp/piem-generic-independent-tests.json`。宿主回归包括替换失败、工厂重入、
  自绘交互拒绝、同步 done、刷新自激、清理报错和异步拒绝观察。
- 手动 CSS 检测器结果为 `[]`，保存在 `/tmp/piem-generic-design-detect.json`。
  键盘焦点回归验证程序修改选中项时，列表内焦点跟随；列表外焦点不会被抢走。
  触控门禁读取所有 `any-pointer: coarse` 块，仍检查已有按钮的实际尺寸约束。
- 由未实现 UI 的代理独立查看五张有效实机应用截图并审查原生组件、快捷键及
  生命周期代码，裁定 `ship`，未留实质 P1/P2；未对真机或所有主题作此承诺。
  原计划新建审查线程达到线程上限，改由既有模型模块代理执行独立 UI 审查。

真实 Obsidian 使用独立临时 Vault
`/tmp/piem-generic-bridge-smoke-3sqztbo_/vault` 和本地确定性模型。测试构建包含
与生产同源的模块图及本地契约工厂；发布构建不含该工厂，bundle gate 明确禁止
`scripts/fixtures/`。两种成品的摘要分别记录，不把测试成品称作发布产物。

| 环境 | 结果 | 模型通道 |
| --- | --- | --- |
| Obsidian 桌面，1120 × 900 | 29 项通过，5 个本地请求，0 个界面错误 | `fetch` + CORS |
| 官方手机模拟，390 × 844 | 28 项通过，5 个本地请求，0 个界面错误 | `fetch` + CORS |

两组均使用测试构建 SHA-256
`ca03a480019a3876ffb24964f4e764c9654f5d29fb07abed96600288a38fe43a`，
1,883,640 字节。报告和有效截图是临时目录下
`generic-bridge-{desktop,mobile}.json` 及对应 `picker.png`、`loader.png`；
桌面 `panel.png` 也已查看。手机 `panel.png` 捕获了侧栏入场动画，明确不作为
稳定布局证据。没有修改产品宣传截图，因为当前内置扩展不使用这些新增界面。

### 环境限制

本轮的 `requestUrl` 请求在真实 Obsidian 中停在 IPC。独立 GET、直接模型完成
和导入完成请求均复现；`request-url` 已发送而没有回复，服务器未收到请求，
普通 `fetch` 能到达同一端点。换无代理参数不改变结果。环境诊断保存在
`request-url-environment-diagnostic.json`，未为此修改产品网络逻辑；不能据本次
真实验收宣称 `requestUrl` 通道已验证。既有网络与资源占位的自动化测试仍保留。

未做 iOS/Android 真机、后台恢复、真实服务商建议质量或完整主题组合测试。
真实截图和 API 调用不等于读屏软件实测。

## 清理

每次临时 Obsidian 和 Xvfb 均由专用父进程管理并退出；最终 `cleanup.json`
记录 `allExited: true`。烟测关闭 CDP WebSocket、本地 HTTP server 和计时器。
无 watch 构建、开发服务器或安装进用户笔记库的测试扩展。
