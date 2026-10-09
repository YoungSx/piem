# Provider OAuth 接入方案：复用 Pi，兼顾 Obsidian 手机端

2026-10-09；代码基线 `da676c6`。调研与设计，未修改产品实现。

## 结论

保留 Pi 的 `OAuthAuth`、`ProviderAuthInteraction`、`CredentialStore` 和 `Models.getAuth()`。Piem 负责 Obsidian 的网络、登录交互和本机存储适配；不要另写 token 刷新管理器，也不要让手机运行 CLI、Node HTTP 回调服务器或读取 CLI 的 `auth.json`。

先修复已有登录入口，完善 xAI/Kimi 的设备码和 OpenRouter 的无回调 PKCE。随后按需求接 Copilot 的完整 provider 行为。OpenAI 新 ChatGPT 登录与旧 Codex 登录必须分开评估：当前上游已将 Codex 标为 legacy，新的官方直连方式仍要求 loopback 回调，不能当作现成的手机登录方案。Claude 订阅登录有明确的官方第三方接入限制，不应因为 Pi 中存在实现就将它承诺为可发布能力。

## 当前仓库实际已有的能力

- [oauthFlows.ts](../src/auth/oauthFlows.ts)：xAI、Kimi 设备码；Anthropic、OpenRouter 手工粘贴 PKCE。
- [signInSession.ts](../src/auth/signInSession.ts)：应用拥有登录/退出编排，调用 flow 后通过 `CredentialStore.modify` 保存。
- [credentialStore.ts](../src/auth/credentialStore.ts)：实现 Pi 的存储接口；同一 provider 的读写串行，支持刷新互斥和退出清理。
- [main.ts](../src/main.ts)：全插件共享凭据存储，设置页和 agent 使用同一实例。
- [streamFn.ts](../src/net/streamFn.ts)：为 provider 注册 OAuth；token 请求固定走 `createObsidianRequestUrlFetch()`，模型请求另选传输方式。
- [connectionTest.ts](../src/connectionTest.ts)：已区分 key 与 OAuth，并通过 Pi 解析/刷新用于探测的认证信息。
- [SignInModal.ts](../src/ui/settings/SignInModal.ts)：设备码、授权链接、粘贴输入和取消；目前只支持 `manual_code` prompt。

因此这里是修复并扩展已有接入，不是重建认证架构。

## 必须先处理的实际缺口

1. **新建订阅预设没有写入认证类型。** [ProviderModal.ts](../src/ui/settings/ProviderModal.ts) 的 `choosePreset()` 调用 `applyProviderPreset()` 后只回写 name/baseUrl/protocol，遗漏 `oauthFlow`。新行初始为空，因此选择订阅预设仍保存成 API-key 行。`applyProviderPreset()` 自身有写入字段，但不意味着 UI 调用链正确。
2. **订阅预设仍无条件呈现 API-key 字段。** 同一弹窗总是调用 `addSecretKeyField()`，与订阅登录路径不一致。需要让用户选择 provider 后能直接看到登录动作和状态，完成后再测试实际模型请求。
3. **手动授权流程会覆盖登录链接。** `auth_url` 事件显示 URL；紧接着 `prompt(manual_code)` 调用 `showManualCode()`，该方法 `body.empty()`，导致链接被输入框替换。应同时保留“打开登录页”和“粘贴授权码”，不能只覆盖成当前一步的文本。
4. **宿主存储依赖未公开方法。** [obsidianKeychain.ts](../src/obsidianKeychain.ts) 读取依赖 `peekSecret`，写入可用性依赖 `deleteSecret`。当前官方类型只公开 `getSecret`、`setSecret`、`listSecrets`。建议公开读取 API 作为基本契约，`peekSecret` 仅在实际收益成立时作可选优化；删除能力继续封装并检测，不能在没有证据时把写空串等同于删除。[Obsidian 存储文档][obsidian-secrets] [官方类型][obsidian-types]
5. **新 provider 的行为不能只靠一个 token。** [modelConfig.ts](../src/modelConfig.ts) 将持久化行 ID 放入 `model.provider`，通常是 UUID；Pi 的 OpenAI ChatGPT 参数过滤却检查字面量 `model.provider === "openai"`，Copilot 的协议实现也有身份判断。只加一行 OAuth 配置会漏掉 provider 专属行为。扩展时保持持久化行 ID 稳定，在 provider 构造/请求适配处集中补齐协议行为，不能把所有 UUID 全局重命名。

这些是代码检查发现；尚未运行真实 Obsidian UI 重现。

## Pi 的契约与复用范围

核对的是 lockfile 指定的 `@earendil-works/pi-ai@1.1.0`。工作树未安装 node_modules，读取了本机 Bun 缓存中的同版本发布包，并确认上游 `v1.1.0` tag 源文件可访问。[Pi README][pi-readme] [认证类型][pi-auth-types]

- `OAuthAuth.login(interaction, options?)` 返回凭据；交互由 `prompt` / `notify` / signal 表达。`LoginOptions` 已含安装 ID 的 `getDeviceId` 和应用名 `agentName`。
- `refresh(credential, signal)` 产生新凭据，`toAuth(credential)` 无副作用地返回 `apiKey`、`headers`、`baseUrl`。需要完整保留 provider 扩展字段，例如 clientId、accountId、scopes、enterpriseDomain。
- `CredentialStore.modify` 是唯一写入口。Pi 在其中重新检查过期时间并刷新；当前实现默认提前五分钟刷新，并对已开始的 refresh 使用独立超时，避免调用者取消后丢掉服务端刚轮换的新 token。[认证解析实现][pi-auth-resolve]
- `Models.getAuth()` 是请求所用凭据的入口。`CredentialStore.read()` 适合展示“已保存凭据”，不能等价为“当前账号能调用模型”。
- 内置 OAuth 流程是 provider 的私有实现；`pi-ai/oauth` 不是供应用枚举全部登录器的运行时 registry。不要照搬旧 `@mariozechner/pi-ai` 的接入示例。
- 上游 flow 直接调用全局 `fetch`，当前接口没有 OAuth 传输注入；部分文件静态导入 `node:http` / `node:crypto`，Copilot 还带模型目录。现阶段继续实现小型宿主适配，复用 Pi 的认证契约与刷新编排。长期可向上游提出传输和回调能力注入，但不能把全局替换 fetch 或模拟 Node 作为手机方案。

## Provider 选择

| Provider | 上游与官方事实 | 适合 Piem 的选择 |
| --- | --- | --- |
| xAI / Kimi | 锁定版本有设备码实现；本仓库已有 HTTP 适配 | 首批完善，复用当前轮询和刷新；需要实际账号验证 |
| OpenRouter | 官方现支持省略 `callback_url`：浏览器显示一次性授权码，使用 S256 PKCE 兑换用户 API key；不是订阅 access/refresh token 对 | 首批采用无回调模式，删除“浏览器撞到 localhost 后复制地址”的常规路径；不必部署中转 |
| GitHub Copilot | Pi 使用 GitHub device flow，再换短期 Copilot token；refresh 字段保存长效 GitHub token；`toAuth` 派生账号专属 baseUrl，还有模型策略与专属请求头 | 下一批独立适配；完整接登录、换票、模型目录和请求行为，不塞成通用设备码表的一行 |
| OpenAI / ChatGPT 新方式 | Pi 的 `openai` 已承载新的 Sign in with ChatGPT；官方允许用户 token 调用公共 Responses API，但当前注册要求 `http://127.0.0.1:<port>/auth/callback` listener | 长期优先此正式路线；手机授权回调尚需可行性验证，当前没有依据承诺 `obsidian://` 或 HTTPS 中转回调可替代 |
| OpenAI Codex legacy | 锁定版有设备码登录，但使用独立 `openai-codex-responses` 和 ChatGPT backend endpoint | 如果手机 ChatGPT 是首要需求，可单独做兼容性试验；需要补专用协议，不能把该 token 当新 OpenAI 直连 token，也不把 CLI 的设备授权支持外推成第三方接入承诺 |
| Claude Pro / Max | Pi 和本仓库仍有 flow，但官方明确不允许第三方应用提供 Claude.ai 订阅登录并代用户路由请求 | 不作为本次可发布登录方式；保留 Claude API-key 路径。移除入口时需保留已有凭据的退出/清除通道 |
| Gemini / Antigravity | 此发布包未找到 Google Gemini CLI 或 Antigravity OAuth 实现；Google API key/Vertex ADC 是其他路径 | 不承诺“Pi 原生直接支持”；先保留现有 Gemini API-key 路径 |

来源：[xAI][pi-xai]、[Kimi][pi-kimi]、[OpenRouter 官方 PKCE][openrouter-oauth]、[Copilot 上游][pi-copilot]、[OpenAI 上游][pi-openai]、[Codex 上游][pi-codex]、[Claude 官方限制][claude-auth]。

## OpenAI 需要额外注意的变化

新的官方直连路线已不是“订阅 token 永远不能调用 api.openai.com”。但登录和请求均有明确约束，不能把旧 Codex token 与新注册混用。[注册登录][openai-signin] [模型与推理][openai-inference]

- 初次动态注册使用 `dynamic_agent_client`，返回 issued client ID；后续登录应复用该 ID。安装 host ID 必须在本机稳定，不能从同步的 vault 设置复制给另一台设备；应用名称使用 Piem。
- 官方要求校验 state，并验证 ID token 的签名、issuer、audience、expiry、nonce，保留验证后的账号身份。Pi 锁定版发送 nonce，但本次检查的 `openai-chatgpt` 实现没有完成这些 ID-token 验证，也每次重新动态注册。移植时要按现行官方契约补齐，不能认为复用上游就自动满足。
- 模型目录按账号获取，官方返回 `models` 数组中的 `slug` / `display_name` / `visibility`；不能默认复用普通 API-key `/models` 响应解析。
- 推理使用公共 `/v1/responses`，要求 `store:false`、`stream:true`，且有禁止参数/工具清单。应以现行官方限制验证 Pi 的请求体，覆盖 agent、子代理、摘要等全部路径。缓冲传输仍须消费完整 SSE 终止事件，不能把 HTTP 200 当作推理成功。[预览限制][openai-limits]
- 官方 Codex CLI 的 device auth 需要个人设置或 workspace 允许；这是 CLI 的现行能力，不是新 direct-token 流程的通用 mobile grant。[Codex 认证][codex-auth]

## 手机端应有的行为

1. **系统浏览器完成登录。** 优先 device code，其次 provider 正式提供的无回调 PKCE。不要嵌入 provider 密码页，也不要假设注册一个 Obsidian URI handler 就能改变 provider 的 redirect allowlist。
2. **切后台不等于退出。** 用户去 Safari/Chrome 登录时宿主可能暂停 JS。轮询依据绝对 deadline 和 provider interval；回前台后检查到期并继续，不能靠后台 interval 持续运行。
3. **登录尝试归会话模块管理。** `signInSession` 保留当前 attempt，UI 展示状态；显式取消、删除 provider、卸载要终止。后台回来可以继续；若系统杀进程，清楚地重新发起登录，首版不必持久化全部未完成授权状态。不得把 verifier 或 pending code 写进同步的 data.json。
4. **凭据各设备分别保存。** provider 配置可同步，refresh token/设备 ID 使用宿主本地存储；每台设备独立登录。不能把同一轮换 refresh token 通过 vault 同步到多设备并发使用。
5. **运行时检测存储能力。** 公开 API 存在不代表当前手机一定有可写后端。验证写入拒绝、读回、删除及重启后读取；`setSecret():void` 的同进程成功不能证明已持久化。没有可用存储时明确说明能力边界，不能静默降级到 data.json 保存 OAuth token。
6. **所有 token 请求走现有 requestUrl 适配。** CORS、网络返回与逻辑取消保持集中；requestUrl 无法物理取消已经发出的原生请求，应忽略迟到结果，并保证取消/退出后不会被旧登录结果重新写回凭据。已开始的 token rotation 则遵循 Pi 的提交语义，不能在保存前丢弃新 refresh token。

Obsidian 官方说明密钥存于按 vault 区分的本地存储；平台加密细节与本机持久化仍须实测。[存储文档][obsidian-secrets] 当前官方类型有 `registerObsidianProtocolHandler`，但该能力并不授予外部 provider 对自定义 redirect URI 的支持。[官方类型][obsidian-types]

## 实施顺序与验收

**第一步：闭环已有能力。** 修正预设字段、登录链接与输入共存、OAuth/API key 的 UI 区分；OpenRouter 改为官方无回调 PKCE；复核宿主存储公共契约及 token 发往的合法 endpoint。OAuth 行切换 provider/endpoint 时清理或重新认证，不能把已存订阅 token 发给任意自定义 URL。

**第二步：完善手机生命周期。** 以当前 signInSession 为基础承载 attempt，不新建另一套 AuthManager；补取消/迟到结果保护、绝对到期时间、回前台恢复。所有登录/刷新继续使用共享 CredentialStore。

**第三步：按首要 provider 扩展。** Copilot 做完整适配；OpenAI 先做正式直连的回调可行性验证，如果产品要求手机端首发 ChatGPT，则另行验证 legacy device flow 和专用请求协议再决定，不能藏进同一个普通 OpenAI 预设里。

**测试应验证行为而非表字段。** 从选择预设到保存/登录按钮出现；打开外部页后返回；拒绝、超时、取消；并发请求只刷新一次；刷新期间取消不丢新 token；退出后旧登录不能复活；存储失败不显示成功；实际模型目录、回复、工具调用、摘要和子代理使用同一认证路径。手机至少覆盖 iOS、Android 各一次重启持久化与前后台切换。

实现时再同步更新 `docs/settings.md` / `docs/settings.zh-CN.md`、`docs/security.md` / `docs/security.zh-CN.md` 及中英文文案；必要的真实截图随 UI 改动更新。完整构建、lint、bun test、bundle gate 随实现执行，本次不将设计调研描述为发布验收。

## 本次验证边界

- 已单独运行 `bun test src/auth/deviceCode.test.ts`：27 pass。
- 已单独运行 `bun test src/auth/pkce.test.ts`：31 pass。
- 已单独运行 `bun test src/auth/credentialStore.test.ts`：23 pass。
- 总计 81 pass，均为当前实现的脚本化单元测试；未证明真实 provider 登录、真实存储重启或 UI 路径可用。
- 未做真实账号授权，未运行全量 build/lint/test。工作树没有安装 node_modules，源契约通过本机缓存和上游原文核对。
- T3 `device_list` 返回无设备：iOS 需要 macOS/Xcode；Android SDK 未安装。因此未做手机验证。

[pi-readme]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/README.md#oauth-providers
[pi-auth-types]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/types.ts
[pi-auth-resolve]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/resolve.ts
[pi-xai]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/xai.ts
[pi-kimi]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/kimi-coding.ts
[pi-copilot]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/github-copilot.ts
[pi-openai]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-chatgpt.ts
[pi-codex]: https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-codex.ts
[openrouter-oauth]: https://openrouter.ai/docs/guides/overview/auth/oauth#headless-apps-ssh-servers-containers
[openai-signin]: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
[openai-inference]: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
[openai-limits]: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
[codex-auth]: https://learn.chatgpt.com/docs/auth#login-on-headless-devices
[claude-auth]: https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
[obsidian-secrets]: https://docs.obsidian.md/plugins/guides/secret-storage
[obsidian-types]: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
