import type { DeepPartial, EnCopy } from "./en";

/**
 * Simplified Chinese copy.
 *
 * Typed as `DeepPartial<EnCopy>` so a missing key compiles fine (and falls back
 * to English at runtime) while an unknown key is a compile error. Keep this file
 * in the same shape as `en.ts`; only translate the leaves.
 */

export const zhCN: DeepPartial<EnCopy> = {
	view: {
		tabTitle: "Piem 对话",
		panelCrashed: "对话面板遇到了意外错误。",
		panelCrashedRetry: "重试",
	},

	commands: {
		openChat: "打开对话",
		newChat: "新建对话",
		stopResponse: "停止回复",
		tidyUp: "整理较早思维",
		focusInput: "聚焦对话输入框",
		askAboutSelection: "询问所选内容",
		askAboutNote: "询问此笔记",
		ribbonOpenChat: "打开 Piem 助手",
		menuAskAboutSelection: "询问所选内容",
		menuAskAboutFile: "询问此文件",
		noActiveNote: "没有可询问的当前笔记。",
		couldNotOpenChat: "无法打开对话视图。",
		openLogs: "打开日志视图",
		couldNotOpenLogs: "无法打开日志视图。",
		searchChats: "搜索对话",
		openSubagents: "打开子代理面板",
		couldNotOpenSubagents: "无法打开子代理面板。",
	},

	chat: {
		placeholder: "询问 Piem，或输入 / 使用命令…",
		composerAria: "给 Piem 发消息",
		/** 整理占住回合时的停止档位文案。上一版「停止整理」在按钮里塞了两个名词，机制说明交给正上方的状态栏，按钮只说它做什么。 */
		stop: "停止",
		stopResponse: "停止回复",
		sendMessage: "发送消息",
		sendNeedsKey: "填写 API 密钥后才能发送",
		renameChat: "重命名对话",
		deleteChat: "删除对话",
		openChatHistory: "查看历史对话",
		newChat: "新建对话",
		moreActions: "更多对话操作",
		openSettings: "打开设置",
		dismissMessage: "关闭消息",
		/**
		 * 上下文越过自动压缩阈值的横幅提示及其按钮文案（阈值与圆环着色同源）。
		 * 走 polite 通道播报并附带整理按钮：颜色变化是屏幕阅读器收不到的信号。
		 */
		contextWall: "上下文快满了。整理较早思维可以继续聊更久。",
		contextWallAction: "整理",
		/**
		 * 崩溃恢复横幅及其按钮：上一次会话有没跑完的运行、用户的话还留在
		 * 记录末尾，点一下就能让模型接着回答。和上下文横幅一样是常驻提议，
		 * 走 polite 通道播报——是面板自己的接续，不是要读者立刻处理的故障。
		 */
		recoveryOffer: "上一次回复没写完就断了。从断掉的地方继续吗？",
		recoveryResume: "继续",
		conversationAria: "对话",
		skipToComposer: "跳到输入框",
		skipToTranscript: "回到对话",
		working: "正在处理：{tools}",
		/**
		 * 输入指示器，在发送到首个 token 之间显示在助手在消息流中的位置。
		 * 仅用于屏幕阅读器；视觉上是三点跳动，不显示这句文字。
		 */
		replying: "Piem 正在回复…",
		replyingAria: "Piem 正在回复",
		latest: "最新",
		latestQuestion: "有个问题等你",
		openingChatAria: "正在打开对话",
		connectModel: "连接一个模型以开始",
		needsApiKey: "Piem 需要 API 密钥才能回答。",
		addApiKey: "添加 API 密钥",
		addApiKeyHintBefore: "在 ",
		addApiKeyHintPath: "设置 → Piem",
		addApiKeyHintAfter: " 中添加 API 密钥。",
		askAboutVault: "询问你的笔记库",
		askAboutVaultHintBefore: "Piem 可以在这里读取、搜索和编辑笔记。试试“总结我打开的笔记”，或选中文本后运行 ",
		askAboutVaultHintCommand: "询问所选内容",
		askAboutVaultHintAfter: "。",
		youStopped: "你已停止这条回复。",
		youStoppedSpoken: "你已停止这条回复。",
		editMessage: "编辑并重发",
		editingNotice: "正在编辑上一条提问——发送后将替换这条回复。",
		/**
		 * 从一条回复分叉：复制出一个新对话，原对话原封不动。用「分叉」不用「分支」，
		 * 因为没有树要回来爬——新对话就在历史列表里，跟别的对话一样。
		 *
		 * 叫「对话」不叫「会话」：面板里每一处都这么叫（新建对话、删除对话、查看历史
		 * 对话、保留的对话数），两个词指同一样东西时，读者会以为是两样东西。
		 */
		forkFromHere: "从此处分叉新对话",
		forkConfirmTitle: "从此处分叉新的对话？",
		forkConfirmBody: "新对话会带上到这里为止的全部内容。当前对话原封不动，两个对话随时可以在「历史对话」里切换。",
		forkConfirmAction: "分叉",
		editingCancel: "取消编辑",
		replyTruncated: "这条回复达到模型的长度上限，提前结束了。",
		replyTruncatedSpoken: "这条回复达到模型的长度上限，提前结束了。",
		providerFailure: {
			auth: "供应商拒绝了这个密钥。到设置里核对一下再问。",
			authSpoken: "供应商拒绝了这个密钥。到设置里核对一下再问。",
			quota: "这个账号在供应商那边额度用完了。充值后再问。",
			quotaSpoken: "这个账号在供应商那边额度用完了。充值后再问。",
			contextLength: "这段对话超出了模型能装下的长度。整理较早思维后再问。",
			contextLengthSpoken: "这段对话超出了模型能装下的长度。整理较早思维后再问。",
			refused: "供应商拒绝回答这一条。换个说法通常就好了。",
			refusedSpoken: "供应商拒绝回答这一条。换个说法通常就好了。",
			rateLimit: "供应商现在太忙了。等一下再试。",
			rateLimitSpoken: "供应商现在太忙了。等一下再试。",
			/* 不用「规定时间」：那是合约口吻，而且这个插件根本没设超时，没有谁规定过时间。 */
			timeout: "供应商迟迟没有回话。",
			timeoutSpoken: "供应商迟迟没有回话。",
			offline: "连不上供应商。检查一下网络再试。",
			offlineSpoken: "连不上供应商。检查一下网络再试。",
			serverError: "供应商自己出错了。再试一次通常就好。",
			serverErrorSpoken: "供应商自己出错了。再试一次通常就好。",
			unknown: "供应商没有回话，也没说为什么。",
			unknownSpoken: "供应商没有回话，也没说为什么。",
		},
		branchSummaryFailed: "重试已经发出去了，只是没能为被替换掉的分支生成摘要：{error}",
		busyTidying: "Piem 正在整理思维。过一会儿再发这条。",
		busyResending: "Piem 正在重发你的消息。过一会儿再发这条。",
		forkFailed: "没能从那条回复分叉新对话：{error}",
		sessionOpenFailed: "没能打开那个对话：{error}",
		sessionDeleteFailed: "没能删除那个对话：{error}",
		you: "你",
		agent: "Piem",
		thoughtItThrough: "思考了一下",
		/** 思考行仍在流式生成时；落定后读「思考了一下」。 */
		thinkingNow: "正在思考…",
		/**
		 * 整理行的三种状态文案。
		 *
		 * 说「思维」不说「消息」：被整理掉的是智能体自己更早的思考，读者不必
		 * 先知道「上下文窗口装的是一串消息」才能看懂对话里发生了什么。落定后
		 * 的文案报的是一次事件、不是一个位置——正因如此，一行才能承载整段
		 * 过程：它画在整理发生的那个时刻，而不是残存记录的开头。
		 */
		tidyRunning: "整理思维中…",
		tidyDone: "思维已整理",
		tidyFailed: "思维整理失败",
		imagePlaceholder: "[图片：{mimeType}]",
		imagesNotSupported: "{model} 不支持图片。请更换模型或移除图片。",
		/** 压缩或重写正占用回合时又收到一次发送；编辑器的控件让这只会是罕见的竞态。 */
		/** 排队区标题（aria）。回复进行中发出的消息先在这里等待。 */
		queueLabel: "等待插话",
		/** 排队 chip 上的图片数量后缀。 */
		queueImages: "{count} 张图",
		/** 排队 chip 的撤回按钮。 */
		queueCancel: "撤回",
		/** 回复流式输出期间，回合槽位已是停止档位，这个安静的文字按钮为鼠标用户保留草稿的排队入口；只在有草稿时出现，键盘快捷键不受影响。 */
		queueDraft: "排队发送",
		/** 回复已生成但没能写进 vault。读者反正已看到正文，所以这是通知而不是警报。 */
		persistFailed: "没能存进笔记库——重新载入后这条回复就没了。",
		persistFailedCopy: "先复制出来",
		/** 溢出菜单项：把对话记录写成 vault 里的 Markdown 笔记。 */
		exportNote: "存为笔记",
		/** 导出笔记里的角色标题。 */
		exportUser: "我",
		/** 导出笔记里的角色标题。 */
		exportAssistant: "助手",
		/** 导出笔记里一行工具调用的署名。 */
		exportTool: "工具",
		/** 对话既无名字也无首条消息时的笔记标题兜底。 */
		exportUntitled: "对话",
		/** 导出笔记写入失败时的通知。 */
		exportFailed: "没能把对话存为笔记：{error}",
		imageThumbAlt: "已附图片：{mimeType}",
		imageAlt: "图片：{mimeType}",
		removeImage: "移除图片 {index}",
		imageNotFound: "在 vault 中找不到 {path}，未发送。",
		rowLabelSystem: "系统",
		rowLabelCommand: "命令",
		rowLabelSummary: "总结",
		headerAria: "当前对话",
		actionsAria: "对话操作",
		tokensSuffix: "token",
		contextAria: "上下文窗口占用",
		// 回答进行中改动的控件（issue #252），提示要等这条回复落地才生效。
		appliesAfterReply: "本条回复结束后生效",
		contextValueText: "已使用 {estimated}{tokens} / {window} {unit}，{percent}%，{state}",
		contextEstimatedPrefix: "约 ",
		/** Popover line for prompt-cache use: the hit rate plus the cached volume. */
		cacheLine: "缓存 {percent}% · {tokens} {unit}",
		/** Popover footnote for thinking models: reasoning tokens already inside the reply count. */
		reasoningNote: "含推理 {tokens}",
		commandMenuAria: "提示命令和技能",
		commandKindTemplate: "提示",
		commandKindSkill: "技能",
		unknownCommand: "未知命令：/{name}",
		unknownCommandSkillProblems: "有技能没能读取成功。请查看「设置 \u2192 扩展能力」。",
		commandConflict: "提示和技能都使用 /{name}。本次已使用提示；如需技能，请输入 /skill:{name}。",
		nothingToCompact: "暂时没有可整理的内容。",
	},

	builtinSkills: {
		summarize: {
			description: "总结当前笔记或所选内容，不修改原文。",
			content: `总结当前 Markdown 笔记。

1. 调用 get_active_note，并启用 includeContent 和 includeSelection。如果存在所选内容，默认总结所选内容；只有附加说明明确要求时才总结整篇笔记。
2. 如果返回内容被截断，先用 read 分段读完相关部分，再下结论。
3. 保留事实、术语和有意义的链接，不补写原文没有的信息。
4. 先给简短摘要，再列关键点；只有原文确实包含任务时才列行动项。
5. 除非用户明确要求，否则不要编辑笔记。遵循此技能块之后附加的说明。`,
		},
		linkGraph: {
			description: "分析当前笔记的出链、反向链接和缺失连接。",
			content: `分析当前 Markdown 笔记周围的链接图谱。

1. 优先使用上下文中的当前笔记路径。如果没有路径，调用 get_active_note；若未打开 Markdown 笔记，清楚地请用户先打开一篇。
2. 调用 get_note_links，并把 direction 设为 both。若工具提示索引尚未就绪，应说明数据不可用，不要断言笔记没有链接。
3. 调用 get_note_metadata，借助标题和标签判断笔记作用。只有确实需要内容时，才读取最相关的邻接笔记。
4. 分别报告出链、反向链接、未解析链接、主题簇、桥接笔记和可能缺失的连接；把事实与建议分开。
5. 除非用户明确要求，否则不要创建或修改链接。遵循此技能块之后附加的说明。`,
		},
		tagOrganize: {
			description: "审计标签并提出一致、低噪声的标签结构。",
			content: `整理用户的 Obsidian 标签体系，但不要突然修改文件。

1. 从附加说明确定范围；默认只分析当前笔记。单篇笔记使用 get_note_metadata 获取标签。
2. 如需全库审计，用 grep 分批查找 frontmatter 标签和正文 hashtag，再用 get_note_metadata 抽查代表性笔记。结果被截断时必须说明。
3. 比较前先规范化标签：开头的 #、大小写、单复数和嵌套路径可能表示同一概念。
4. 找出重复或近似标签、孤立标签、过宽标签和不一致的层级。给出精简的标准标签体系及旧标签到新标签的映射。
5. 修改前先展示方案。只有得到明确同意后才编辑；保持 frontmatter 格式，并列出每篇被改动的笔记。`,
		},
		findSkills: {
			description: "查找可信的 agent skill，并说明如何加入 Piem。",
			content: `帮助用户从开放的 agent-skills 生态中查找技能。本流程基于 Vercel 的 MIT 许可 find-skills 技能，并按 Piem 只能操作 vault 的边界做了调整。

1. 先弄清领域和具体任务。只有常见且专业的重复任务才优先寻找可复用技能。
2. 如果有 web_fetch，检查 skills.sh 和源码仓库；如果没有，明确说明无法实时核验，只给出 skills.sh 地址，不编造结果。
3. 核验安装量、仓库所有者、GitHub 信誉、许可证、近期维护情况、完整 SKILL.md 和公开安全审计。不要只看搜索标题就推荐。
4. 给出简短候选列表，包含技能名、用途、来源、证据、链接和兼容限制。Piem 不能运行 npx，也不能安装到 vault 之外。
5. 只有用户明确要求安装时，才获取并审查完整 SKILL.md，然后写入 Piem/skills/<name>/SKILL.md。不要执行远程代码，不要复制隐藏脚本，覆盖已有 vault skill 前必须确认。`,
		},
	},

	chatStatus: {
		opening: "正在打开对话…",
		// 重发窗口：先为被舍弃的分支写摘要，再发新问题，消息流全程不报。
		resending: "正在重发您的消息…",
		// 序数而非总数：轮次还在飞，总数尚不存在。
		turnSteps: "第 {count} 步",
	},

	// 快捷键字形是键帽而非词语，各语言一律保持原样。
	modelSwitcher: {
		switchModel: "切换模型",
		buttonTitle: "{action} · {model}",
		modelWithProvider: "{model} · {provider}",
		noModels: "还没有配置模型",
		manageModels: "管理模型…",
	},

	thinkingLevel: {
		switchThinking: "调整思考力度",
		// The level interpolates verbatim: a wire keyword, never translated.
		buttonTitle: "{action} · {level}",
	},

	sendShortcut: {
		enter: "↵",
		modMac: "⌘↵",
		modOther: "Ctrl+↵",
		buttonTitle: "{action} · {chord}",
	},

	context: {
		nearlyFull: "上下文即将占满",
		filling: "正在填充",
		ok: "正常",
		meterHeuristic: "按消息大小估算，首次回复后更新。",
		meterMeasured: "接近 {percent}% 时自动整理思维。",
		tidyWhileCompacting: "整理思维中…",
		tidyWhileStreaming: "回复结束后可整理较早思维",
	},

	contextRow: {
		rowAria: "共享给 Piem 的笔记",
		followActive: "跟随当前笔记",
		openFollowed: "打开 {path}，自动跟随中",
		openPinned: "打开 {path}，已固定",
		pinToChat: "把 {name} 固定到此对话",
		stopFollowing: "停止跟随当前笔记",
		removeFromContext: "从上下文中移除 {name}",
	},

	replyActions: {
		label: "回复操作",
		copy: "复制回复",
		insert: "在光标处插入",
		append: "追加到笔记",
		regenerate: "重新回答",
		couldNotCopy: "无法复制到剪贴板。",
		needOpenNoteToInsert: "打开一个笔记以插入此回复。",
		needOpenNoteToAppend: "打开一个笔记以追加此回复。",
		durationTooltip: "开始 {start} · 结束 {end}",
	},

	quickActions: {
		label: "试试这样问",
		empty: {
			summarizeNote: {
				label: "总结这篇笔记",
				prompt: "总结当前笔记的要点。",
			},
			improveNote: {
				label: "改进这篇笔记",
				prompt: "审阅当前笔记，给出具体的改进建议。",
			},
			brainstorm: {
				label: "头脑风暴",
				prompt: "基于当前笔记，给我五个可以延伸的方向。",
			},
			draftNote: {
				label: "起草新笔记",
				prompt: "帮我起草一篇新笔记：先问我主题，然后先列提纲再动笔。",
			},
			mapVault: {
				label: "摸底我的库",
				prompt: "列出我笔记库里的文件夹，说说它是怎么组织的。",
			},
			capabilities: {
				label: "你能做什么？",
				prompt: "在我的笔记库里你能帮我做什么？举三个具体的例子。",
			},
		},
		suggest: {
			instruction:
				"你正在为一位聊天助手生成一键追问按钮。只回复一个 JSON 数组，最多 3 个对象，每个形如 {\"label\": string, \"prompt\": string}。label 是显示在按钮上的 2-4 个词；prompt 是按下按钮后发送的完整消息。不要使用 markdown、代码围栏或数组以外的任何文字。用{language}书写。",
			emptyWithNote:
				"对话还是空的，用户正打开着笔记「{path}」作为上下文。",
			emptyNoNote:
				"对话还是空的，也没有打开任何笔记；建议应该围绕用户的笔记库整体。",
			reply:
				"请基于下面这段助手的回答来给建议：\n\n{reply}",
		},
	},

	noteReference: {
		truncated: "所选文本较长，仅引用了其开头部分。",
	},

	askUser: {
		title: "Piem：那我问你, look in my eyes!",
		cardLabel: "Piem 的提问",
		waiting: "那我问你",
		waitingMany: "那我问你 {count} 件事",
		queued: "后面还排着 {count} 个",
		answered: "记下了",
		dismissed: "你让 Piem 自己定",
		delegate: "让 Piem 自己定",
		confirm: "确认",
		other: "自己写一个…",
		otherLabel: "自己写答案：{header}",
		multiHint: "符合的都可以选。",
		remaining: "还有 {count} 题没答",
	},

	session: {
		newChat: "新建对话",
		untitled: "未命名对话",
		searchPlaceholder: "搜索对话",
		searchContentPlaceholder: "按标题或聊过的内容搜索对话",
		searchInstructions: "输入以筛选对话列表。",
		searchNoResults: "还没有匹配的对话。",
		searchMatchCount: "{count} 条匹配消息",
		runStateRunning: "运行中",
		runStateWaitingInput: "等待输入",
		runStateError: "出错",
		renameChat: "重命名对话",
		deleteChat: "删除对话",
		cancel: "取消",
		save: "保存",
		delete: "删除",
		nameLabel: "名称",
		nameDesc: "留空则回退到开场消息。",
		pickerOpenHint: "打开对话",
		pickerDeleteHint: "删除对话",
		deleteRestorable: "对话记录会移入回收站，之后仍可从那里恢复。",
	},

	traceTool: {
		read: "读取了一条笔记",
		getActiveNote: "查看了当前笔记",
		noteLinks: "跟随了链接",
		noteMetadata: "读取了笔记属性",
		ls: "列出了一个文件夹",
		find: "查找了笔记",
		grep: "搜索了笔记库",
		write: "写入了一条笔记",
		edit: "编辑了一条笔记",
		updateFrontmatter: "改动了笔记属性",
		insertAtCursor: "在光标处插入了文字",
		moveNote: "重命名或移动了一条笔记",
		trashNote: "把一条笔记移到了回收站",
		openNote: "打开了一条笔记",
		openSidePanel: "打开了一个侧边栏面板",
		gotoLocation: "跳到了笔记中的某处",
		notify: "发出了一条提示",
		askUser: "向你提了一个问题",
		readSkill: "读取了一份技能",
		listTasks: "列出了任务",
		summarizeTasks: "总结了任务",
		webFetch: "抓取了一个网页",
		spawnSubagent: "派出了一个子代理",
		listSubagents: "列出了子代理",
		killSubagent: "停掉了一个子代理",
		followUpSubagent: "又给子代理下了一条指令",
		waitSubagent: "等待了一个子代理",
		failed: "失败",
		detailPair: "{counts} · {argument}",
	},

	traceFold: {
		writeOne: "改动了 1 条笔记",
		writeMany: "改动了 {count} 条笔记",
		webOne: "抓取了 1 个网页",
		webMany: "抓取了 {count} 个网页",
		subagentOne: "调度了 1 个子代理",
		subagentMany: "调度了 {count} 个子代理",
		readOne: "读取了 1 条笔记",
		readMany: "读取了 {count} 条笔记",
		searchOne: "搜索了 1 次",
		searchMany: "搜索了 {count} 次",
		otherOne: "使用了 1 个工具",
		otherMany: "使用了 {count} 个工具",
		otherAlsoOne: "使用了 1 个其他工具",
		otherAlsoMany: "使用了 {count} 个其他工具",
		also: "{first}并{second}",
		list: "{first}，{rest}",
	},

	settings: {
		// 四个页签。原来的「历史」「日志」各只有两三行，撑不起一个页签，
		// 于是并进回答同一问题的那一页：聊天存储属于它存的对话，
		// 日志级别则和语言一样，属于「调教插件」这件事。
		tabModels: "模型",
		tabChat: "对话",
		tabExtensions: "扩展能力",
		tabGeneral: "通用",

		logLevelHeading: "日志级别",
		logLevelDesc:
			"插件往日志里写多少内容。日常使用“警告”就够；排查问题时调成“调试”，看完再调回去。",
		logsHeading: "日志",
		// 这一行得有名字：光秃秃一个按钮像个走丢的控件，屏幕阅读器
		// 单独念它时也得知道它打开的是什么。
		logViewerName: "日志查看器",
		logViewerDesc: "插件写下的全部日志，可搜索、可按级别过滤。",

		languageHeading: "语言",
		languageDesc: "界面使用的语言。“自动”会跟随笔记库的语言。",

		shortcutsHeading: "快捷键",
		// 挂在通用页的「快捷键」小节下。全插件只有这一个键盘设置，
		// 撑不起独立一节；但有了节名，读者按「快捷键」这个词找就能找到，
		// 不用记住它在哪个页签。
		sendShortcut: "发送消息用",

		statusActiveModel: "默认模型",
		providersHeading: "提供方",
		providersDesc: "请求可以发送到的端点。一个提供方包含基础 URL、请求协议和一把密钥。",
		addProvider: "添加提供方",
		noProviders: "还没有提供方。添加一个，即可将请求发送到你自己的端点或网关。",
		editProvider: "编辑提供方",
		deleteProvider: "删除提供方",
		modelsHeading: "模型",
		modelsDescWithProviders: "你可以选择的模型。每个模型指定一个提供方以及该提供方期望的模型 ID。",
		modelsDescNoProviders: "请先添加提供方——模型需要一个端点来提供服务。",
		addModel: "添加模型",
		noModels: "还没有模型。",
		activeModelHeading: "默认模型",
		activeModelDesc: "所有请求都会从这个模型发出。",
		missingBuiltinModel:
			"此版本不再内置 {provider}/{modelId}，请求将改为发往 {replacement}。若要继续使用，请在下方将其添加为提供方和模型。",
		editModel: "编辑模型",
		deleteModel: "删除模型",
		keySet: "已设置密钥",
		keyBound: "密钥在 Obsidian 钥匙串中",
		keyMissing: "钥匙串条目已缺失",
		noKey: "无密钥",
		modelCount: "{count} 个模型",
		modelsCount: "{count} 个模型",
		// 模型列表上方的筛选行。超过一屏行数才出现——扫几行比打字快，
		// 控件得先挣到自己的位置。
		modelsFilterPlaceholder: "输入名称、ID 或提供方以筛选…",
		providerMissing: "提供方缺失",
		activeSuffix: " · 当前",
		showAgentDetails: "显示代理详情",
		showAgentDetailsDesc: "在对话面板中显示 token 数、花费和原始工具参数。",
		// 选项按「读者看到的对话」措辞，不按机器行为：例外项由打开的 diff 行自己解释。
		traceExpand: "工具动态展开方式",
		traceExpandDesc:
			"对话流中思考、工具调用与结果默认展开多少。任何一行之后仍可手动开合。选「全部折叠」时，连续的工具调用还会再收成一行，并写明这一串做了什么。",
		traceExpandCollapsed: "全部折叠",
		traceExpandHighValue: "高价值行展开",
		traceExpandExpanded: "全部展开",
		sendShortcutDesc: "用哪个键发送消息。无论选哪项，Ctrl+回车 和 ⌘+回车 都能发送。",
		sendShortcutEnter: "回车（Shift+回车 换行）",
		sendShortcutModEnter: "Ctrl+回车 或 ⌘+回车（回车用于换行）",
		sendShortcutMobileNote: "在手机上回车一律换行——软键盘没有 Shift+回车——请用发送按钮。",
		// 对话页的小节标题，把「行为」和「存放」隔开。用标题而不用折叠：
		// 存储不是高级配置，长期用户迟早要找，不该点开才看得见。
		chatHistoryHeading: "聊天记录",
		chatHistoryDesc: "聊天记录存放的位置，以及旧的保留多少条。",
		networkHeading: "网络",
		networkHeadingDesc: "请求如何离开笔记库。",
		networkTransport: "网络传输",
		networkTransportDesc:
			"requestUrl 可在各处绕过浏览器限制，但会缓冲响应——token 会一次性出现。fetch 会增量流式返回，但可能被拦截。",
		// 这两项是配置里的字面值（"requestUrl" | "fetch"），保持原样以便和配置、日志对上。
		transportRequestUrl: "requestUrl（缓冲，各处可用）",
		transportFetch: "fetch（流式，可能被拦截）",
		webFetchName: "获取网页",
		webFetchDesc:
			"任务需要网页时，代理可以请求外部 URL。这些请求及其中的数据会离开笔记库和 Obsidian；上方的传输方式决定它们如何发出。",
		whatLeavesVault: "什么会离开笔记库",
		whatLeavesVaultDesc:
			"提示词、工具读取的笔记库内容以及工具结果，会发送给服务于默认模型的提供方。不会发送到任何其他地方。",
		chatLogsInVault:
			"聊天记录是笔记库里的文件，会随你的笔记一起同步和备份。它们包含对话内容，以及回答过程中读取的笔记原文。",
		apiKeysHeading: "API 密钥",
		restrictedKeyHint: "请使用受限、低限额的密钥：笔记库是一个普通文件夹，里面的密钥会随着该文件夹的每次备份和同步一起传播。",
	},

	skills: {
		heading: "技能",
		desc: "代理可以按需加载的指令。它们是笔记库里的文件——像普通笔记一样编辑，下一条消息就会生效。",
		import: "从 URL 导入",
		empty: "还没有技能。从 URL 导入一个，或在 Piem/skills 里建一个包含 SKILL.md 的文件夹。",
		importedFrom: "导入自 {url}",
		handAuthored: "在笔记库中手写。更新请直接修改文件。",
		rootFile: "单篇笔记充当的技能。像普通笔记一样编辑；无法从这里更新或删除。",
		open: "打开",
		update: "检查更新",
		delete: "删除",
		upToDate: "{name} 已经是最新版本。",
		updatedOne: "{name} 已更新：更改了 1 个文件。",
		updatedMany: "{name} 已更新：更改了 {count} 个文件。",
		conflict: "{name} 有本地修改，未覆盖任何内容。冲突的文件：{files}。",
		couldNotUpdate: "无法更新 {name}：{message}",
		couldNotDelete: "无法删除 {name}：{message}",
		reload: "重新加载",
		// 「就是」而不是「是」：这句承诺的是「完全一致」，不只是「有关系」。
		reloadClean: "已重新读取技能，没有发现问题。代理现在用的就是磁盘上的内容。",
		reloadProblems: "已重新读取技能。返回的问题列在各自的分区下方。",
		couldNotReload: "无法重新读取技能：{message}",
		problemsHeading: "读取技能文件时的问题",
		problemsDesc: "这些文件找到了，但无法作为技能读取，所以上面的列表里没有它们。其余技能都正常加载了。",
		userHeading: "用户级技能",
		userDesc: "自动从这台电脑上、笔记库之外的文件夹加载。下面列出了实际读取的文件夹。",
		userEmpty: "这台电脑上没有用户级技能。",
		userDirName: "额外的技能文件夹",
		userDirDesc:
			"除内置文件夹之外，再从这台电脑上的一个文件夹加载技能。请填写完整路径，或以 ~ 开头表示你的主目录。留空则只读取内置文件夹。",
		userDirProblemRelative:
			"请填写完整路径——以 / 或盘符开头，或用 ~ 表示你的主目录。像 'skills' 这样的普通名称不会被读取，因此不会加载任何额外文件夹。",
		userSearchedHeading: "已搜索的文件夹",
		userSearchedDesc:
			"上次加载技能时查找过的位置。你没有创建过的文件夹本来就不存在，这不是故障。你确实创建过的文件夹应当显示它包含多少个技能——如果没有，说明实际读取的路径不是你想要的那个。",
		userSearchedMissing: "此路径上没有文件夹。",
		userSearchedEmpty: "已读取，其中没有技能。",
		userSearchedFound: "已读取，加载了 {skills}。",
		// 检查本身失败了——文件夹既没有确认存在，也没有确认不存在。不并入「没有
		// 文件夹」：权限问题挡住了我们的读取时，说「这里没有文件夹」会把人引去
		// 完全错误的方向。
		userSearchedUnknown: "无法检查该文件夹。",
		userProblemsHeading: "读取本机文件夹时的问题",
		// 「原样返回」是这句话的关键：它告诉读者下面那段英文是操作系统吐出来的，
		// 不是插件自己坏了——否则一行 EACCES 看起来就像崩溃日志。后两句分别交代
		// 后果，以及「其他文件夹不受影响」，免得一个读不了的文件夹显得整段都不可信。
		userProblemsDesc: "以下是这台电脑的文件系统原样返回的内容。这些路径上的技能没有加载。能正常读取的文件夹不受影响。",
		userSkillOne: "1 个技能",
		userSkillMany: "{count} 个技能",
	},

	skillImport: {
		title: "导入技能",
		urlName: "技能 URL",
		urlDesc: "GitHub 的文件夹或文件，或任何公开的 .md 页面。",
		urlPlaceholder: "https://github.com/owner/repo/tree/main/skills",
		preview: "预览",
		fetching: "正在获取…",
		importOne: "导入 1 个技能",
		importMany: "导入 {count} 个技能",
		invalidUrl: "这看起来不像技能 URL。请使用 GitHub 文件夹、GitHub 文件或公开的 .md 链接。",
		fetchFailed: "获取失败：{message}",
		installFailed: "导入失败：{message}",
		noneFound: "那里没有找到技能。技能是一个包含 SKILL.md 的文件夹，或一篇带名称和描述的 .md 文件。",
		installed: "已导入 {count} 个。",
		cancel: "取消",
	},

	/**
	 * 「扩展能力」页的 MCP 服务器区块。
	 *
	 * 描述先把出境说清：配置一个服务器，就意味着请求会离开笔记库、发往该
	 * URL。状态行一律写成完整的句子，不写光秃秃的「错误」——报错原文就在
	 * 本行里，不该让读者再去别处找。
	 */
	mcp: {
		heading: "MCP 服务器",
		desc: "接入远程 MCP（Model Context Protocol）服务器提供的工具。这些工具会以 mcp_ 前缀出现在对话中；请求会离开笔记库，发往你填写的地址。",
		// 无条件出现——挂载固定走缓冲传输，与读者选了什么无关。这条降级是真的，
		// 但此前只写在源码注释里，用户看不见的地方。这里不再指引读者去换 fetch：
		// 换了也救不回挂载的推送，只会改变工具调用的走法。
		bufferedNoPush:
			"MCP 挂载固定走缓冲传输，服务器无法主动推给你：工具列表只在你保存设置时刷新，服务器自己改了不算。",
		add: "添加服务器",
		edit: "编辑",
		delete: "删除",
		empty: "还没有配置 MCP 服务器。添加一个，即可让它的工具进入对话。",
		statusOk: "已连接；{tools} 个工具可用。",
		statusError: "上次连接失败：{error}",
		statusConnecting: "正在连接…",
		statusDisabled: "已停用。开启后才会连接。",
		disableConsequenceTools: "该服务器提供的工具会立即全部退出对话。",
		disableConsequenceToken: "连接令牌仍保留在配置里，重新开启即可恢复。",
		statusUntested: "尚未连接。保存设置或重新加载插件时会连接。",
		testTitle: "连接",
		testOk: "已连上服务器；{tools} 个工具可用。",
		name: "名称",
		namePlaceholder: "GitHub",
		nameRequired: "给服务器起个名字。",
		urlName: "地址",
		urlDesc: "服务器的 MCP 端点。请求会离开笔记库，发往这个地址。",
		urlPlaceholder: "https://example.com/mcp",
		urlRequired: "请填写 http(s) 地址。",
		tokenName: "Bearer 令牌",
		tokenDesc: "每次请求都会作为 Authorization 头发给这台服务器。公开服务器可留空。",
		tokenTarget: "这台服务器的 URL",
		addTitle: "添加 MCP 服务器",
		editTitle: "编辑 MCP 服务器",
		addButton: "添加",
		saveButton: "保存",
		cancelButton: "取消",
	},

	about: {
		version: "版本 {version}",
		sourceName: "源代码",
		sourceDesc: "本插件在 GitHub 上的仓库。",
		sourceLabel: "打开仓库",
		issuesName: "反馈问题",
		issuesDesc: "缺陷与功能建议请提交到问题追踪器。",
		issuesLabel: "打开问题列表",
		licenseName: "许可协议",
		licenseDesc: "本插件的分发条款。",
		licenseLabel: "阅读许可协议",
		sponsorName: "赞助我",
		sponsorDesc: "请我在 Ko-fi 上喝杯咖啡。",
		sponsorLabel: "疯狂星期四 V 我 50",
	},

	compaction: {
		groupLabel: "上下文整理",
		groupHint: "高级选项。在上下文占满之前，Piem 已经会自动整理较早思维。",
		reserveName: "整理前预留的余量",
		reserveDesc: "为撰写总结而预留的 token。调高会更早整理，调低则先用掉更多窗口。默认 {default}。",
		keepName: "保留的近期消息",
		keepDesc: "总结时原样保留的近期对话 token 数。调高可原文保留更多往来内容。默认 {default}。",
		tokenFloor: "低于 {min} token 的值会被提升到该下限。",
	},

	sessions: {
		retentionName: "保留的对话数",
		retentionDesc: "创建新对话时，较早的对话会移到回收站，之后仍可从那里恢复。设为 0 则保留全部对话。",
		retentionFloor: "低于 {min} 的值会被提升到该下限。",
		retentionUnlimited: "保留全部对话。{stored}",
		retentionWillTrash: "{stored} 下一次新建对话会把最早的 {chats}移到回收站。",
		retentionSafe: "{stored} 达到上限前不会移入回收站。",
		storedNone: "尚未存储任何对话。",
		storedOne: "已存储 1 个对话。",
		storedMany: "已存储 {count} 个对话。",
		chatOne: "1 个对话",
		chatMany: "{count} 个对话",
		dirName: "对话文件夹",
		dirDesc: "笔记库内用于写入聊天记录的文件夹。其中的记录会随你的笔记一起同步和备份，Piem 自己的搜索工具也能读到它们。",
		dirRestartHint: "将在你下次新建对话时生效。",
		dirUnchanged: "新对话将写入 {dir}。",
		dirChanged: "新对话将写入 {next}。不会搬动任何文件：{current} 中的对话仍在磁盘上，但会从对话列表中消失，直到你把文件移过去。",
		dirProblemEmpty: "请填写笔记库内的一个文件夹。",
		dirProblemAbsolute: "请使用笔记库内的文件夹，而不是电脑上的路径。",
		dirProblemEscape: "文件夹不能用 '..' 跳出笔记库。",
		dirProblemUnusable: "这不是笔记库能容纳的文件夹。",
		legacyOne: "有 1 个来自旧版本的对话仍在 {dir}。把其中的 .jsonl 文件移到上面的文件夹，即可让它重新出现在对话列表中。",
		legacyMany: "有 {count} 个来自旧版本的对话仍在 {dir}。把其中的 .jsonl 文件移到上面的文件夹，即可让它们重新出现在对话列表中。",
	},

	connectionTest: {
		noKey: "此提供方还没有 API 密钥。",
		noModelId: "此模型还没有模型 ID。",
		requestFailed: "请求失败。",
		requestAborted: "请求已中止。",
		reached: "已连通 {target}{served}。",
		servedSuffix: " — 实际服务模型 {model}",
		unknownError: "未知错误",
		probedWith: "（探测所用模型：{model}）",
		listingNoModels: "已连通 {target}，但它未列出任何模型。",
		listingOneModel: "已连通 {target} — 它列出 1 个模型。",
		listingModels: "已连通 {target} — 它列出 {count} 个模型。",
		listingNeedsKey: "{target} 需要 API 密钥（{status}）。{relayed}",
		listingRejectedKey: "{target} 拒绝了该 API 密钥（{status}）。{relayed}",
		listingUnsupported: "已连通 {target}，但它不提供模型列表，因此无法验证密钥。请在此提供方下添加一个模型以测试真实请求。",
		listingStatus: "{target} 返回 {status}。{relayed}",
	},

	target: {
		customEndpoint: "自定义端点（{modelId}）",
		needsKeyToSend: "{target} 需要先在插件设置中填写 API 密钥，才能发送提示词。",
		needsKeyToCompact: "{target} 需要先在插件设置中填写 API 密钥，才能整理较早思维。",
	},

	confirmDelete: {
		title: "删除{subject}？",
		cancel: "取消",
		delete: "删除",
		disableTitle: "停用{subject}？",
		disable: "停用",
		providerSubject: "提供方“{name}”",
		modelSubject: "模型“{name}”",
		skillSubject: "技能“{name}”",
		mcpServerSubject: "MCP 服务器“{name}”",
		copyKey: "复制 API 密钥",
		copied: "已复制到剪贴板。",
	},

	deletion: {
		providerKeyRemoved: "基础 URL 和 API 密钥会从此笔记库的配置中移除。",
		providerOneModel: "由它提供服务的模型也会被移除：{names}。",
		providerManyModels: "由它提供服务的 {count} 个模型也会被移除：{names}。",
		modelProviderStays: "提供方及其密钥会保留，其他模型仍可正常使用。",
		modelWasActive: "它是默认模型，移除后由 {model} 接替。",
		modelWasLast: "它是唯一的模型，移除后没有继任——请先添加另一个再发消息。",
		skillFiles: "技能的文件会移入回收站，并不再对代理可用。",
		mcpServer: "它的工具不再提供给代理。其令牌绑定的钥匙串条目会保留不动。",
	},

	// 第一下 Esc 落在带着未保存修改的配置弹窗上时，就地显示的这句话。
	// 三个表单共用一句：机制完全相同，只是字段不同，学一次规则到处通用。
	discard: {
		warning: "这个表单有未保存的修改——再按一次 Esc 就会丢弃。",
	},

	// 过长行描述的展开/收起按钮。
	descFold: {
		more: "展开",
		less: "收起",
	},

	test: {
		button: "测试",
		running: "测试中…",
		pending: "正在发送测试请求…",
	},

	secretStorage: {
		delegated: "绑定的密钥保存在 Obsidian 的钥匙串里，不在此笔记库内。",
		delegatedUnencrypted: "绑定的密钥保存在 Obsidian 的钥匙串里，但此设备不加密存储。它们仍不在此笔记库内。",
		manual: "此设备不支持钥匙串，此处输入的密钥会以明文形式存储在此笔记库的插件配置中。",
		manualKeyField: "仅发送给 {target}。{storage} 请使用受限、低限额的密钥。",
		/** 委托层级下折叠的手填字段：分组提示已说明存到哪里。 */
		manualKeyFieldPlain: "仅发送给 {target}。请使用受限、低限额的密钥。",
		noSync: "钥匙串不会同步，因此每台设备都要各自选取一次。在另一台设备上重新选取是正常的。",
		providerTarget: "此提供方的基础 URL",
		boundTo: "已绑定钥匙串条目「{name}」。",
		danglingRef: "此提供方绑定的钥匙串条目已被删除。请重新选取。",
		openKeychain: "打开钥匙串",
		openKeychainDesc: "在 Obsidian 的设置里创建或选取钥匙串条目。",
		manualGroup: "手动填写密钥",
		manualGroupHint: "密钥无法放进钥匙串时使用。会存储在此笔记库的配置中。",
	},

	providerModal: {
		addTitle: "添加提供方",
		editTitle: "编辑提供方",
		// 表单第一行，也是决定表单形状的那一行：预设拥有名称、基础 URL 和协议，选中预设时
		// 这三行就隐藏，只剩密钥要填。「自定义」排在最前，因为那本就是表单打开时的状态——
		// 要接网关的人不该先划过十六个用不上的厂商，才回到原地。
		preset: "预设",
		presetDesc: "选一个已知提供方，剩下只需填它的 API 密钥。想自己设名称、基础 URL 和协议就选「自定义」——网关、代理，或自托管服务。",
		presetCustom: "自定义",
		name: "名称",
		nameDesc: "在列出该提供方的地方显示。可选——留空时使用基础 URL。",
		namePlaceholder: "我的网关",
		baseUrl: "基础 URL",
		baseUrlDesc: "API 的根地址，例如 https://api.example.com/v1",
		baseUrlPlaceholder: "https://api.example.com/v1",
		protocol: "协议",
		protocolDesc: "该端点使用的请求格式。第一个选项是网关和自托管服务器实现最广泛的一种。",
		apiKey: "API 密钥",
		apiKeyPlaceholder: "输入 API 密钥",
		connection: "连接",
		connectionDesc: "检查 URL、协议和密钥。该提供方下已有模型时用其中一个测试，否则询问端点它提供哪些模型。",
		cancel: "取消",
		add: "添加",
		save: "保存",
		baseUrlRequired: "基础 URL 是必填项。",
		baseUrlInvalid: "该基础 URL 不是有效的 URL。请包含协议，例如 https://api.example.com/v1",
		baseUrlScheme: "基础 URL 必须使用 http 或 https。",
		couldNotSave: "无法保存提供方：{message}",
	},

	modelModal: {
		addTitle: "添加模型",
		editTitle: "编辑模型",
		// 四个能力字段的折叠组。身份三件套（提供方、ID、显示名称）保持平铺：
		// 新模型不填它们存不了，把必填项藏起来只是把一屏滚动换成一次点击加一场寻找。
		capabilityGroup: "能力与限制",
		capabilityGroupHint: "上下文窗口、输出上限，以及模型接受什么。",
		provider: "提供方",
		providerDesc: "哪个已配置的端点为此模型提供服务。",
		modelId: "模型 ID",
		modelIdDesc: "原样发送到服务器。开始输入可搜索已知模型 ID，或输入你自己的。",
		modelIdPlaceholder: "gpt-4o-mini",
		displayName: "显示名称",
		displayNameDesc: "在模型选择器中显示。留空则使用模型 ID。",
		displayNamePlaceholder: "我的模型",
		contextWindow: "上下文窗口",
		contextWindowDesc: "该模型接受的 token 数。整理会据此规划；留空则使用默认值。",
		positiveNumberHint: "需要正整数——留空表示使用默认。",
		contextWindowPlaceholder: "128000",
		maxTokens: "最大输出 token 数",
		maxTokensDesc: "单次回复的上限。留空则使用默认值（8192）。",
		maxTokensPlaceholder: "8192",
		supportsThinking: "支持思考",
		supportsThinkingDesc: "仅当该模型接受推理参数时启用。严格的服务器会直接拒绝它们。",
		thinkingHintSupported: "该模型支持思考，建议开启。",
		thinkingHintUnsupported: "该模型不支持思考，建议关闭。",
		thinkingUnbacked: "模型目录没有收录这个 ID，思考开关没有出处可依。仅在确定服务器接受时保持开启。",
		supportsImages: "接受图片",
		supportsImagesDesc: "开启后允许随文本一起向该模型发送附件图片。",
		imagesHintSupported: "该模型接受图片，建议开启。",
		imagesHintUnsupported: "该模型不接受图片，建议关闭。",
		imagesUnbacked: "模型目录没有收录这个 ID，图片开关没有出处可依。仅在确定服务器接受图片时保持开启。",
		// Issue #160：数字字段过去只填一次便永久沉默，上一个模型的数值会
		// 无声地留在新 ID 下面。下面几行是这次失败的替代品：目录只建议，
		// 数值永远是用户的，无出处的数值要明说而不是略过。
		contextWindowAdvice: "目录建议此模型使用 {value}。",
		contextWindowAdviceMatches: "与目录中此模型的数值一致。",
		contextWindowUnbacked: "模型目录没有收录这个 ID，这个数字没有出处可依。请对照提供方文档核实。",
		maxTokensAdvice: "目录建议此模型使用 {value}。",
		maxTokensAdviceMatches: "与目录中此模型的数值一致。",
		maxTokensUnbacked: "模型目录没有收录这个 ID，这个数字没有出处可依。请对照提供方文档核实。",
		adoptNumber: "采纳建议值",
		adoptToggleOn: "开启",
		adoptToggleOff: "关闭",
		connection: "连接",
		connectionDesc: "发送一个最小请求，以确认提供方、密钥和模型 ID 能协同工作。",
		cancel: "取消",
		add: "添加",
		save: "保存",
		chooseProvider: "请选择一个提供方。",
		providerMissing: "该提供方已不存在。",
		modelIdRequired: "模型 ID 是必填项。",
		added: "模型已添加。",
		saved: "模型已保存。",
		couldNotSave: "无法保存模型：{message}",
	},

	language: {
		auto: "自动",
		// Autonyms are shown from each language's own table and must not be
		// translated — the picker reads `language.en` from this table.
		en: "English",
		"zh-cn": "简体中文",
	},

	// 这些是各家 API 的产品名，保持原文以便用户对照自己端点的文档。
	wireProtocol: {
		openaiChat: "OpenAI Chat Completions",
		openaiResponses: "OpenAI Responses",
		anthropicMessages: "Anthropic Messages",
	},

	subagents: {
		tabTitle: "Piem 子代理",
		panelAria: "此对话的子代理",
		entryRunning: "{count} 个子代理正在干活。打开子代理面板。",
		entrySettled: "此对话共 {count} 个子代理。打开子代理面板。",
		popoverAria: "此对话的子代理",
		openDetail: "{task}——查看运行",
		listAria: "子代理，最早的在前",
		empty: "还没有子代理。",
		emptyHint: "当 Piem 把一件事交给子代理去做，这里会出现那次运行：它接到什么、报回什么，以及中间的每一步。",
		emptyDetail: "选一次运行，看它接到什么、写回什么。",
		back: "返回列表",
		panelNotice: "在这里可以停掉某个 run，但无法和它对话——要改方向，在聊天里告诉 Piem。",
		stopOne: "停止此 run",
		stopAll: "全部停止",
		stopAllAria: "停止所有正在运行的子代理",
		archiveFinished: "归档已结束的",
		archiveFinishedAria: "归档所有已结束的运行",
		sectionArchived: "已归档",
		archivedCount: "{count} 次运行",
		archivedListAria: "已归档的子代理，最早的在前",
		allArchived: "所有运行都已归档。展开下面的「已归档」可以查看。",
		status: {
			running: "进行中",
			done: "已完成",
			incomplete: "被中断",
			failed: "失败",
		},
		ranFor: "耗时 {duration}",
		startedAt: "{time} 开始",
		incompletePartial: "还没写完就被停掉，下面的报告是残稿。",
		killedByParent: "因为对话这一轮停了，它也停了。",
		killedByTeardown: "因为对话关掉了，它也停了。",
		killedByTool: "Piem 停掉了它：这个答案已经不需要了。",
		killedByUser: "你在面板里停掉了它。",
		sectionTask: "任务",
		followUpsLabel: "之后 Piem 又要求：",
		sectionInstructions: "长期约束",
		sectionConfig: "配置",
		sectionReport: "报告",
		sectionProcess: "过程记录",
		configRole: "角色",
		configModel: "模型",
		configThinking: "思考",
		configDepth: "层级",
		depthValue: "第 {depth} 层",
		usageTurns: "{count} 轮",
		usageTokens: "{tokens} tokens",
		usageCost: "{cost}",
		reportPending: "还在跑。跑完了报告会出现在这里。",
		reportNone: "它在写出报告之前就失败了。",
		failureLabel: "哪里出了问题",
		processCount: "{count} 步",
		processPending: "过程记录会在这次运行结束时留下。",
		processNone: "什么都没留下：这次运行还没动手就结束了。",
		line: {
			user: "指令",
			assistant: "回复",
			thinking: "思考",
			toolCall: "调用 {tool}",
			toolResult: "{tool} 返回",
			toolError: "{tool} 失败",
		},
		clipped: "……为显示已截断",
	},

	logView: {
		title: "Piem 日志",
		filter: {
			all: "全部级别",
			off: "关闭",
			debug: "调试",
			info: "信息",
			warn: "警告",
			error: "错误",
		},
		copy: "复制",
		clear: "清空",
		openFile: "打开日志文件",
		empty: "该级别下暂无日志。",
		dropped: "已有 {count} 条更早的记录被丢弃，以保证缓冲区不超限。",
		fileHint: "落盘日志：{path}",
	},
};
