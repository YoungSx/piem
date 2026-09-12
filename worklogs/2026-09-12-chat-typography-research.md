# 聊天正文排版：官方依据与最小接入方案

研究日期：2026-09-12。范围限于正文行高、段落和列表节奏、行内代码混排；不扩大到过程状态、正文宽度或字重设计。本文来自实际读取的官方文档、Web 标准和本机 Obsidian 发布包，**没有执行宿主、浏览器或测试**，实现观察与运行验证分开记录。

## 结论

优先接回 Obsidian 的原生阅读样式：Markdown 正文容器使用 `markdown-rendered`，正文单独使用 `line-height: var(--line-height-normal)`，撤去统一的 `0.4em` 段落/列表间距覆盖。由宿主提供段距、列表项距和行内代码字体、字号、底色。保留插件现有的局部溢出处理，不新增字体资产或一套重复的代码样式。

这是一项设计判断，依据如下；添加类名会同时启用链接、列表、引用、代码块等规则，必须实际检查连带效果。

## 1. MarkdownRenderer 不替调用者提供阅读容器

[官方 API 文档][render] 对 `render()` 的承诺是 “Renders Markdown string to an HTML element.”，`el` 参数是 “The element to append to”。[官方类型声明][api] 同样没有自动添加 CSS 类的承诺。因此，仅看 React JSX 缺少类名，不足以断言运行时缺类。

本次进一步静态读取本机 **Obsidian 1.13.7 官方发布包**：

- 路径：`/tmp/piem-node-bridge-smoke-20260911/runtime/obsidian-1.13.7-arm64/resources/obsidian.asar`；包内 `package.json` 声明版本 `1.13.7`。
- 包 SHA256：`a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`。
- `app.js` SHA256：`8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898`。
- `app.css` SHA256：`f612f1e8f36486fa57f3b8bd45f0c848409d5b168002e757a13c6d286a7b4c41`。
- 已查询[官方发布 API][release-api]，确认[发布页][release]和[增量包资产][release-asar]的 URL；复用本地包，没有重新下载资产来比对压缩包摘要。读取时核对了包内文件 SHA256 与 ASAR 内置完整性字段。

**实现观察：** `app.js` 将公开的 `MarkdownRenderer` 导出为内部 `YW`；`YW.render` 方法位于字符串偏移 `2001656`，完成解析、净化、`n.appendChild(u)`、后处理和嵌入加载，方法本身不添加 `markdown-rendered`。检查该字符串的全部 14 处出现，类名添加位于阅读视图、嵌入、其他调用者等位置。官方自身渲染社区插件 README 时，也是调用者创建 `community-modal-readme markdown-rendered` 容器。

这是指定版本实现的证据，不是 API 的跨版本保证；后处理器或其他插件仍可能改变 DOM，真实宿主需要读取渲染完成后的 `classList`。

## 2. 原生变量和规则分别负责什么

下表中的行号均指上述 SHA256 的官方 `app.css`；默认值来自这份发布物，不能替代用户当前主题的计算值。

| 用途 | 官方依据与原生实现 | 对本次修改的含义 |
| --- | --- | --- |
| 正文行高 | [Typography][type]：`--line-height-normal` 默认 `1.5`；`--line-height-tight` 默认 `1.3`，用于搜索结果、树项、提示等紧凑区域。`body` 在第 3204 行使用 tight，`.markdown-preview-view` 在第 4467 行才使用 normal。 | `markdown-rendered` 本身不设行高；正文需要单独接上 normal。 |
| 段落间距 | [Typography][type]：`--p-spacing` 是 “Spacing between paragraphs”。发布物默认 `1rem`（2577）；`.markdown-rendered p` 的上下间距均使用它（14167–14170）。 | 移除插件 `0.4em` 覆盖，恢复主题对段距的控制；不硬编码截图中的像素值。 |
| 列表节奏 | [List][list]：`--list-spacing` 是 “Vertical spacing between list items”。发布物默认 `0.075em`（2444）；原生 `li` 使用上下 padding（13187–13191）。外层 `ul/ol` 使用 `--p-spacing`，嵌套列表不重复加段距，列表内首尾段落清除边缘间距（13165–13198）。 | 不能只给每个 `li` 加同样的段落 margin；原生规则已经区分列表层级。 |
| 行内代码 | [Code][code] 列出 `--code-size`、`--code-normal`、`--code-background`；[Typography][type] 将等宽字体用于代码块和行内代码。原生 `.markdown-rendered code` 使用 `--font-monospace`、`--code-size`、原生底色与边框（11394–11403）。默认 `--code-size` 是 `--font-smaller`，即 `0.875em`。 | 复用原生类即可；官方文档没有这里所需的 `--code-font` 变量，不创造不存在的契约。 |
| 代码块 | `.markdown-rendered pre` 提供背景、padding、局部水平滚动，`pre code` 撤掉行内代码的 padding 和底色（11452–11466）。 | 插件原有 `white-space: pre` 和横向滚动规则继续承担长代码的可达性，不能为了正文换行而覆盖它。 |
| 标题 | 全局 `h1` 与 `.markdown-rendered h1` 共用原生字号、字体、字重等规则，其他级别同理（12762 起）。 | 不能把“缺少容器类”扩大成“标题原生样式全部失效”；本轮不改标题尺度。 |

[官方样式指南][styling] 明确建议插件使用内置 CSS 变量，以获得原生观感并兼容社区主题。保留现有 `--font-ui-medium` 正文尺度，处理当前已确认的三项；改用另一套字体或强制 16px 没有本次需求依据。

## 3. 行高、中文断行和缩放

- [MDN line-height][line-height]：无单位数值乘以元素自己的字号，“the preferred way to set line-height and avoid unexpected results due to inheritance”；正文建议至少 `1.5`，缩放时行高随文字同比例变化。采用宿主的无单位 normal 变量符合此方向，主题实际值需实测。
- [MDN word-break][word-break]：`keep-all` 不在 CJK 文字间断行；`break-all` 会在非 CJK 单词内部任意拆开。**设计判断：** 中英混排保留自然断行，不为解决长标识符给全文设置这两者。
- [MDN overflow-wrap][overflow-wrap]：“will only create a break if an entire word cannot be placed on its own line without overflowing”。现有 `overflow-wrap: break-word` 可继续兜底长 URL 和标识符；它与让代码块局部滚动是不同职责。
- [CSS Text 3][css-text] 的 `line-break` 处理标点等断行严格度；`auto` 允许浏览器按行宽调整并遵循语言习惯。没有证据要求此次加入 `strict` 或为混排正文强行插空格。
- [WCAG 1.4.12][text-spacing] 明确说 “Content is not required to use these text spacing values.”。其 1.5 倍行距、2 倍段后距等是用户覆盖样式后仍不丢失内容的要求，**不是默认段距必须设成 2em**。[WCAG 1.4.4][resize-text] 要求文字放大至 200% 后不丢失内容或功能。

## 4. 接入边界与实际验证

实现时只使用 `markdown-rendered`，不要顺手加 `markdown-preview-view`；后者还带入 `height: 100%`、文件 padding、自有垂直滚动等视图布局（官方 CSS 4464–4474），会改变聊天列。

正文行高应限定在用户/助手的正文块及其流式纯文本形态。当前 `prose` 角色也用于思考与摘要，`message-content` 还包含过程行；对它们的共同祖先统一设行高，可能改变本轮明确忽略的过程区域。

加类名有一项已定位的连带影响：原生未解析链接规则会使用 `opacity: var(--link-unresolved-opacity)`（13407–13412，默认值为 `0.7`）。现有聊天链接样式只声明虚线和偏移；应保留其清晰的未解析状态，避免重新变淡，并更新旧注释中“原生选择器不会命中”的过时依据。由实现选择最窄的覆盖范围。

以下仍需真实 Obsidian smoke，不能由静态扫描或 happy-dom 声称通过：

1. 读取渲染后的类名、正文与行内代码的 computed style，确认 normal 行高、等宽字体、相对字号和原生代码底色实际生效；同时看流式转完整 Markdown 是否突变。
2. 用中文混排、长行内标识符、紧凑/宽松/嵌套列表、任务列表、引用、代码块和表格检查 300/390/560px；正文不横滚，宽代码和表格仍能在自己的区域滚动。
3. 检查明暗主题、主题变量覆盖、200% 放大和用户增加文本间距，确认没有裁切或控制项遮挡；模拟移动尺寸不等于 iOS/Android 真机验证。
4. 比对过程状态和展开思考、未解析链接及 hover，确认接入阅读类没有把原有状态或操作改坏。

[render]: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/TypeScript%20API/MarkdownRenderer/render.md
[api]: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts
[release]: https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.7
[release-api]: https://api.github.com/repos/obsidianmd/obsidian-releases/releases/tags/v1.13.7
[release-asar]: https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7/obsidian-1.13.7.asar.gz
[type]: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Typography.md
[code]: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Editor/Code.md
[list]: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Editor/List.md
[styling]: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/About%20styling.md
[line-height]: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/line-height
[word-break]: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/word-break
[overflow-wrap]: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-wrap
[css-text]: https://www.w3.org/TR/css-text-3/#line-break-property
[text-spacing]: https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
[resize-text]: https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html
