/**
 * English copy — the source of truth.
 *
 * Every string a human can see in the UI lives here, nested by screen. It is
 * declared `as const` so `zhCN.ts` can type-check against it with `DeepPartial`:
 * any key a translation forgets falls back to this table at runtime, and any
 * key a translation invents is a compile error.
 *
 * Keep the shape stable — flattening or renaming here ripples through every
 * language. Add a leaf for every new piece of copy; never inline English in a
 * component.
 */

export const en = {
	/** Chat panel tab title shown in the workspace tab strip. */
	view: {
		tabTitle: "Piem chat",
		panelCrashed: "The chat panel hit an unexpected error.",
		panelCrashedRetry: "Retry",
	},

	/** Commands, the ribbon icon, and the workspace menu. */
	commands: {
		openChat: "Open chat",
		newChat: "New chat",
		stopResponse: "Stop response",
		tidyUp: "Tidy earlier thoughts",
		focusInput: "Focus chat input",
		askAboutSelection: "Ask about selection",
		askAboutNote: "Ask about this note",
		ribbonOpenChat: "Open Piem assistant",
		menuAskAboutSelection: "Ask about selection",
		menuAskAboutFile: "Ask about this file",
		noActiveNote: "No active note to ask about.",
		couldNotOpenChat: "Could not open the chat view.",
		openLogs: "Open log view",
		couldNotOpenLogs: "Could not open the log view.",
		searchChats: "Search chats",
		openSubagents: "Open subagent panel",
		couldNotOpenSubagents: "Could not open the subagent panel.",
	},

	/** Chat panel — header, banner, composer, message list, and trace rows. */
	chat: {
		/**
		 * Doubles as the only advert for slash commands: the composer has no other
		 * affordance saying they exist, and a user who never types `/` never learns.
		 */
		placeholder: "Ask Piem, or / for commands…",
		composerAria: "Message Piem",
		/**
		 * The stop phase's label while the compactor holds the turn. "Stop compaction"
		 * named the mechanism and made the button carry two nouns; the transcript's
		 * own tidying row already narrates what is happening, so the button only says
		 * what it does.
		 */
		stop: "Stop",
		stopResponse: "Stop response",
		sendMessage: "Send message",
		/**
		 * Replaces the send label while no key is configured. States the reason
		 * rather than repeating "send": it is the only explanation a disabled
		 * button can offer, through both its tooltip and its accessible name.
		 */
		sendNeedsKey: "Add an API key to send",
		renameChat: "Rename chat",
		deleteChat: "Delete chat",
		openChatHistory: "View chat history",
		newChat: "New chat",
		moreActions: "More chat actions",
		openSettings: "Open settings",
		dismissMessage: "Dismiss message",
		/**
		 * The banner notice and its button when the context crosses into the band
		 * where automatic compaction will fire mid-conversation (the same threshold
		 * the gauge colours). Announced politely, with the tidy action beside it,
		 * because a screen reader has no way to notice a colour change.
		 */
		contextWall: "Context is almost full. Tidy earlier thoughts to keep going longer.",
		contextWallAction: "Tidy up",
		/**
		 * The crash-recovery banner and its button: a run the previous session
		 * never finished left the user's words as the transcript's tail, and
		 * one click lets the model answer them. A standing offer like the
		 * context wall, announced politely — the panel's own continuation, not
		 * a failure the reader must drop everything for.
		 */
		recoveryOffer: "The last reply was cut off before it finished. Continue from where it stopped?",
		recoveryResume: "Continue",
		conversationAria: "Conversation",
		/** Skip link above the transcript; see WCAG 2.4.1 (Bypass Blocks). */
		skipToComposer: "Skip to message box",
		/** Reverse skip link: from the composer back to the transcript, the same bypass read backwards. */
		skipToTranscript: "Back to conversation",
		/**
		 * Announcement for the running-tools row at the tail of the transcript.
		 *
		 * Screen-reader only: the row draws three dots, and the tools it names are
		 * already on the transcript rows above it, each carrying its own state. This
		 * line exists because those rows cannot announce themselves — `role="status"`
		 * reports the text inside the region, and this is that text.
		 */
		working: "Working: {tools}",
		/**
		 * The typing indicator shown between sending and the first token, in the
		 * assistant's own position in the transcript.
		 *
		 * Copy is not shown — three bouncing dots carry the meaning, the way a
		 * chat app signals "the other side is typing" without labelling the wait.
		 * This string exists only for screen readers, so a non-sighted reader
		 * gets the same heads-up a sighted one gets from the dots. It is named as
		 * a turn in progress ("Piem is replying") rather than a wait, because the
		 * reader wants to know the reply is coming, not that the panel is idle.
		 */
		replying: "Piem is replying…",
		replyingAria: "Piem is replying",
		latest: "Latest",
		/**
		 * The same jump button, when the conversation is blocked on a question that
		 * has been scrolled past. "Latest" would be true and useless: it does not
		 * say that something down there is waiting on the reader.
		 */
		latestQuestion: "A question is waiting",
		openingChatAria: "Opening chat",
		connectModel: "Connect a model to start",
		needsApiKey: "Piem needs an API key before it can answer.",
		addApiKey: "Add an API key",
		/**
		 * Split around the emphasized settings path so each language controls the
		 * word order on both sides of the bold run.
		 */
		addApiKeyHintBefore: "Add an API key in ",
		addApiKeyHintPath: "Settings → Piem",
		addApiKeyHintAfter: ".",
		askAboutVault: "Ask about your vault",
		/** Split around the emphasized command name, as above. */
		askAboutVaultHintBefore: "Piem can read, search, and edit notes here. Try “summarize my open note”, or select text and run ",
		askAboutVaultHintCommand: "Ask about selection",
		askAboutVaultHintAfter: ".",
		youStopped: "You stopped this reply.",
		/** Appended to spoken text, so it continues the sentence in lower case. */
		youStoppedSpoken: "you stopped this reply.",
		/**
		 * The edit-and-resend control on the last answered question. Names both
		 * halves of what it does — the composer opens with the words, and sending
		 * rewrites the conversation from that turn — because "edit" alone reads
		 * like a transcript annotation, and the destructive half is the one the
		 * reader has to expect before pressing Send.
		 */
		editMessage: "Edit and resend",
		/** The composer notice while an edit is armed; see {@link editMessage}. */
		editingNotice: "Editing your last question — sending replaces this reply.",
		/**
		 * Starts a fork from a reply: a new chat carrying everything up to and
		 * including that reply, while the conversation it grew from stays as it is.
		 *
		 * "Fork" rather than "branch": there is no branching tree to come back to —
		 * the new chat lives in the chat history like any other, and the old one is
		 * simply left alone.
		 */
		forkFromHere: "Fork a new chat from here",
		/** Title of the dialog confirming the fork. */
		forkConfirmTitle: "Fork a new chat from here?",
		/**
		 * States the whole outcome before it happens: what the new chat carries,
		 * that the current one is untouched, and that both stay reachable.
		 */
		forkConfirmBody: "The new chat carries the whole conversation up to this reply. This one stays as it is, and you can switch between them in your chat history.",
		/** The confirm button. */
		forkConfirmAction: "Fork",
		/** Cancels the armed edit and restores the draft it displaced. */
		editingCancel: "Cancel edit",
		/**
		 * Shown when the provider cut the reply at its output-token ceiling
		 * (`stopReason: "length"`).
		 *
		 * Names the limit rather than blaming the model: the sentence stops
		 * mid-thought through no decision of its own, and a reader who knows why can
		 * ask for a shorter answer or raise the limit. "Ask again" is the recovery,
		 * and the Retry action beside it is how.
		 */
		replyTruncated: "This reply hit the model's length limit and stopped early.",
		/** Appended to spoken text, so it continues the sentence in lower case. */
		replyTruncatedSpoken: "this reply hit the model's length limit and stopped early.",
		/**
		 * Why a turn ended in a provider failure, one family per sentence.
		 *
		 * Named by what the reader should do next rather than by protocol shape:
		 * `rateLimit` and `quota` are separate sentences because waiting fixes one
		 * and only paying fixes the other. `unknown` is the honest fallback, and it
		 * matters — the provider's own words sit under every one of these, so a
		 * misread family costs a vague headline, never a fact.
		 */
		/**
		 * Why a turn ended in a provider failure, one family per sentence.
		 *
		 * Named by what the reader should do next rather than by protocol shape:
		 * `rateLimit` and `quota` are separate sentences because waiting fixes one
		 * and only paying fixes the other. `unknown` is the honest fallback, and it
		 * matters — the provider's own words sit under every one of these, so a
		 * misread family costs a vague headline, never a fact.
		 *
		 * Each `*Spoken` is the *whole* sentence with a lower-case opening, matching
		 * `youStoppedSpoken` and `replyTruncatedSpoken` above. An earlier cut
		 * truncated them to the diagnosis and dropped the remedy, which meant the
		 * screen-reader user heard what went wrong and not what to do — the same
		 * eyes-not-ears split the old 9em banner cap was criticised for, inverted.
		 */
		providerFailure: {
			auth: "The provider rejected the key. Check it in settings, then ask again.",
			authSpoken: "the provider rejected the key. Check it in settings, then ask again.",
			quota: "This account is out of credit with the provider. Top it up, then ask again.",
			quotaSpoken: "this account is out of credit with the provider. Top it up, then ask again.",
			contextLength: "This conversation is too long for the model. Tidy earlier thoughts, then ask again.",
			contextLengthSpoken: "this conversation is too long for the model. Tidy earlier thoughts, then ask again.",
			refused: "The provider declined to answer this one. Rewording it usually helps.",
			refusedSpoken: "the provider declined to answer this one. Rewording it usually helps.",
			/** "Too busy", not "rate-limiting": the reader here does not read logs. */
			rateLimit: "The provider is too busy right now. Give it a moment, then try again.",
			rateLimitSpoken: "the provider is too busy right now. Give it a moment, then try again.",
			timeout: "The provider did not answer in time.",
			timeoutSpoken: "the provider did not answer in time.",
			offline: "Piem could not reach the provider. Check the connection, then try again.",
			offlineSpoken: "Piem could not reach the provider. Check the connection, then try again.",
			serverError: "The provider hit an error of its own. Trying again often works.",
			serverErrorSpoken: "the provider hit an error of its own. Trying again often works.",
			unknown: "The provider did not answer, and did not say why.",
			unknownSpoken: "the provider did not answer, and did not say why.",
		},
		/**
		 * A failed branch summary, reported outcome-first.
		 *
		 * The retry it belongs to has already gone out — `summarizeAbandonedBranch`
		 * rewinds unconditionally because the retry was the user's actual request —
		 * so the only loss is a note about the fork that was replaced. That is why
		 * this rides the quiet channel: an assertive alert over a bookkeeping
		 * summary was the loudest thing in the panel saying the least.
		 */
		branchSummaryFailed: "The retry went through, but Piem could not summarize the branch it replaced: {error}",
		/**
		 * The two states that hold the turn exclusively, named rather than
		 * paraphrased. Both reuse the words the panel is already showing for what is
		 * happening — the tidying row in the transcript, the status bar for a resend.
		 */
		busyTidying: "Piem is tidying earlier thoughts. Send this again in a moment.",
		busyResending: "Piem is resending your message. Send this again in a moment.",
		/**
		 * Outcomes of a control the reader just pressed, on Obsidian's own toast.
		 *
		 * These are command outcomes: nothing in the conversation changed, and the
		 * transcript on screen is still the one it was. A banner over a healthy
		 * conversation misattributes the damage; a toast appears beside the thing
		 * that was pressed and leaves. One shape for all of them — "Could not X" —
		 * so the channel reads as one channel.
		 */
		/** The fork toast's body; the message names what went wrong, this names what did not happen. */
		forkFailed: "Could not fork a new chat from that reply: {error}",
		sessionOpenFailed: "Could not open that chat: {error}",
		sessionDeleteFailed: "Could not delete that chat: {error}",
		you: "You",
		agent: "Piem",
		thoughtItThrough: "Thought it through",
		/** The thinking row while the model is still producing it; settled, it reads "Thought it through". */
		thinkingNow: "Thinking…",
		/**
		 * The tidying row, one label per state.
		 *
		 * "Thoughts" rather than "messages": what the tidy consumes is the agent's own
		 * earlier thinking, and a reader should not have to know that a context window
		 * is a list of messages to understand what just happened to their chat. The
		 * settled label reports an event rather than marking a position, which is what
		 * lets one row carry the whole attempt — it is drawn where the tidy happened,
		 * not at the head of what survived it.
		 */
		tidyRunning: "Tidying thoughts…",
		tidyDone: "Thoughts tidied",
		tidyFailed: "Could not tidy thoughts",
		imagePlaceholder: "[image: {mimeType}]",
		/** Shown as a banner when the active model lacks image capability. */
		imagesNotSupported: "{model} does not accept images. Switch models or remove the image.",
		/** Queue region label (aria). Messages sent mid-reply wait here. */
		queueLabel: "Waiting to be read",
		/** Image count suffix on a queued chip. */
		queueImages: "{count} images",
		/** Retract button on a queued chip. */
		queueCancel: "Take back",
		/**
		 * The mouse half of mid-run queueing: while a reply streams the single
		 * turn slot is Stop, so this quiet text button keeps the draft's queue
		 * path open for pointer users. Visible only while a draft exists — the
		 * chord keeps working regardless.
		 */
		queueDraft: "Queue draft",
		/**
		 * Rendered under the reply it names, and never dismissible.
		 *
		 * No `{error}` any more: this now sits beside the reply it is about, so
		 * "this reply" is unambiguous — and the adapter's own message was the one
		 * part of it the reader could do nothing with. That goes to the log. What
		 * they can do is take the words out, which the button beside this does.
		 */
		persistFailed: "Not saved to the vault — this reply will be gone after a reload.",
		persistFailedCopy: "Copy it out",
		/** Overflow-menu item that writes the transcript into the vault as a Markdown note. */
		exportNote: "Save as note",
		/** Role heading in an exported note. */
		exportUser: "You",
		/** Role heading in an exported note. */
		exportAssistant: "Assistant",
		/** One-line attribution for a tool call inside an exported note. */
		exportTool: "tool",
		/** Note title fallback when a chat has neither a name nor a first message. */
		exportUntitled: "Chat",
		/** Notice when writing the exported note failed. */
		exportFailed: "Could not save the chat as a note: {error}",
		/** alt text for a staged image thumbnail. */
		imageThumbAlt: "Image attached: {mimeType}",
		imageAlt: "Image: {mimeType}",
		/** aria-label for the button removing the Nth staged image (1-based). */
		removeImage: "Remove image {index}",
		/** Notice when a ![[...]] embed could not be read from the vault. */
		imageNotFound: "Could not find {path} in the vault; it was not sent.",
		rowLabelSystem: "System",
		rowLabelCommand: "Command",
		rowLabelSummary: "Summary",
		headerAria: "Current chat",
		actionsAria: "Chat actions",
		tokensSuffix: "tokens",
		contextAria: "Context window use",
		/**
		 * Tooltip suffix on a control whose mid-run choice is waiting for the run
		 * in flight to land (issue #252), e.g. "Switch model · Opus 5 · OpenRouter
		 * · Takes effect after this reply".
		 */
		appliesAfterReply: "Takes effect after this reply",
		contextValueText: "{estimated}{tokens} of {window} {unit} used, {percent} percent, {state}",
		contextEstimatedPrefix: "Estimated ",
		/** Popover line for prompt-cache use: the hit rate plus the cached volume. */
		cacheLine: "cache {percent}% · {tokens} {unit}",
		/** Popover footnote for thinking models: reasoning tokens already inside the reply count. */
		reasoningNote: "incl. {tokens} reasoning",
		/** Accessible name for the `/`-command autocomplete list. */
		commandMenuAria: "Prompt commands and skills",
		/** Source labels shown beside autocomplete entries. */
		commandKindTemplate: "Prompt",
		commandKindSkill: "Skill",
		/** Notice shown when a `/name` matches no loaded template or skill. */
		unknownCommand: "Unknown command: /{name}",
		/**
		 * Appended to the refusal above only when the last skill load had
		 * problems, and never otherwise — a plain typo gets a plain answer.
		 *
		 * It exists because the refusal can be wrong rather than merely
		 * unhelpful: a SKILL.md whose frontmatter name breaks pi's rules loads
		 * under its folder name instead, so the command the user read in their
		 * own file really is missing while the skill really is loaded. Names no
		 * path and quotes no error; the problems themselves are in the tab this
		 * points at.
		 */
		unknownCommandSkillProblems: "Some skills could not be read. See Settings \u2192 Extensions.",
		/** A template keeps the short name; the skill remains reachable explicitly. */
		commandConflict: "Both a prompt and skill use /{name}. Used the prompt; use /skill:{name} for the skill.",
		/** Notice summarizing non-fatal warnings from loading prompt templates. */
		/**
		 * Outcome of an on-demand tidy that found nothing worth summarizing.
		 *
		 * Not a failure — the chat is simply short enough that compaction would
		 * discard nothing. It is a notice rather than an error for that reason.
		 */
		nothingToCompact: "Nothing to tidy up yet.",
	},

	builtinSkills: {
		summarize: {
			description: "Summarize the active note or selection without changing it.",
			content: `Summarize the active Markdown note.

1. Call get_active_note with includeContent and includeSelection enabled. If a selection exists, summarize it unless the additional instruction explicitly asks for the whole note.
2. If the returned content is truncated, read the remaining note in bounded chunks before drawing conclusions.
3. Preserve facts, terminology, and meaningful links. Do not invent missing context.
4. Lead with a compact summary, then list key points and only the action items that actually appear in the note.
5. Do not edit the note unless the user explicitly asks you to. Honor any instruction appended after this skill block.`,
		},
		linkGraph: {
			description: "Analyze the active note's backlinks, outgoing links, and missing connections.",
			content: `Analyze the link graph around the active Markdown note.

1. Use the active note path from context. If none is available, call get_active_note and stop with a clear request when no Markdown note is open.
2. Call get_note_links with direction set to both. Treat an indexing warning as unavailable data, not as proof that the note has no links.
3. Call get_note_metadata for headings and tags that explain the note's role. Read only the most relevant neighboring notes when their content is needed.
4. Report outgoing links, backlinks, unresolved links, clusters, bridge notes, and useful missing connections. Separate observed links from suggestions.
5. Do not create or edit links unless the user explicitly asks you to. Honor any instruction appended after this skill block.`,
		},
		tagOrganize: {
			description: "Audit tags and propose a consistent, low-noise tag structure.",
			content: `Organize the user's Obsidian tag system without making surprise edits.

1. Determine the requested scope from the additional instruction; default to the active note. Use get_note_metadata for note-level tags.
2. For a broader audit, use grep in bounded passes to find frontmatter tags and inline hashtags, then inspect representative notes with get_note_metadata. State when results are truncated.
3. Normalize tags before comparing them: leading #, case variants, singular/plural variants, and nested tag paths can represent the same concept.
4. Identify duplicates, near-duplicates, orphan tags, overly broad tags, and inconsistent nesting. Propose a small canonical taxonomy with an old-to-new mapping.
5. Show the plan before changing files. Only edit tags after explicit approval, preserve frontmatter formatting, and report every changed note.`,
		},
		findSkills: {
			description: "Find reputable agent skills and explain how to add them to Piem.",
			content: `Help the user discover skills from the open agent-skills ecosystem. This workflow is adapted from Vercel's MIT-licensed find-skills skill for Piem's vault-only environment.

1. Clarify the domain and exact task. Prefer a reusable skill only when the request is common and specialized enough to benefit from one.
2. If web_fetch is available, inspect skills.sh and the source repository. If it is unavailable, say that live results cannot be verified and give the user the skills.sh URL instead of inventing results.
3. Verify install count, repository owner, GitHub reputation, license, recent maintenance, the complete SKILL.md, and any published security audit. Never recommend from a search title alone.
4. Present a short list with the skill name, purpose, source, evidence, URL, and any compatibility limits. Piem cannot run npx or install outside the vault.
5. Only when the user explicitly asks to install, fetch and inspect the full SKILL.md, then write it under Piem/skills/<name>/SKILL.md. Never execute remote code, never copy hidden scripts, and never overwrite an existing vault skill without confirmation.`,
		},
	},

	/**
	 * The chat status bar, between the transcript and the composer.
	 *
	 * One live surface for what the panel is doing. It used to be two — a status
	 * line inside the composer and a compacting badge in the header — which
	 * announced the same state twice to a screen reader and named it two ways.
	 *
	 * A reply in flight is not reported here: the transcript shows that as a
	 * typing indicator at the assistant's position, so naming it in the bar too
	 * would say one thing two ways.
	 */
	chatStatus: {
		opening: "Opening chat…",
		// The retry/edit window: a branch summary request runs before the
		// replacement send, and the transcript narrates none of it.
		resending: "Resending your message…",
		// Ordinal, not a total: the run is mid-flight, so no total exists to name.
		turnSteps: "step {count}",
	},

	/**
	 * The Send control.
	 *
	 * The chord lives on the button rather than in a status line beside it: the
	 * hint belongs to the control it describes, and a reader looking for how to
	 * send looks at Send. The glyphs are keycaps, not words, so translations keep
	 * them as they are.
	 */
	/**
	 * The model switcher at the left of the composer's send row.
	 *
	 * Replaces the model line the header used to print. That line could be read
	 * and not acted on; these strings name the same target on the control that
	 * changes it.
	 */
	modelSwitcher: {
		/** The verb, which leads the button's accessible name. */
		switchModel: "Switch model",
		/** Accessible name and tooltip, e.g. "Switch model · Opus 5 · OpenRouter". */
		buttonTitle: "{action} · {model}",
		/**
		 * A model and the endpoint serving it — the menu rows and the tooltip.
		 * Matches the Models tab's own row format, so a user meets one string
		 * where they configured the model and where they select it.
		 */
		modelWithProvider: "{model} · {provider}",
		/** Menu row shown when nothing is configured yet, above the settings door. */
		noModels: "No models configured",
		/** Menu row that opens the Models tab; the switcher's only escape hatch. */
		manageModels: "Manage models…",
	},

	/**
	 * The composer's thinking-level selector, which replaced the settings-centre
	 * dropdown: the level belongs to the conversation, and this is where it is
	 * both read and changed.
	 */
	thinkingLevel: {
		/** The verb, which leads the button's accessible name. */
		switchThinking: "Change thinking level",
		/**
		 * Accessible name and tooltip, e.g. "Change thinking level · high". The
		 * level interpolates verbatim and stays out of this table: it is a wire
		 * keyword the request sends, so no language translates it (issue #143).
		 */
		buttonTitle: "{action} · {level}",
	},

	sendShortcut: {
		enter: "↵",
		modMac: "⌘↵",
		modOther: "Ctrl+↵",
		/** Accessible name and tooltip, e.g. "Send message · Ctrl+↵". */
		buttonTitle: "{action} · {chord}",
	},

	/** Context meter in the chat header. */
	context: {
		nearlyFull: "context nearly full",
		filling: "filling",
		ok: "ok",
		meterHeuristic: "Estimated from message sizes; updates after the first reply.",
		/**
		 * The note under the figures when the provider reports usage.
		 *
		 * Distilled to the one fact the figures cannot carry: when compaction
		 * fires. "Reported by the provider" was cut — the figures already say it,
		 * by lacking the tilde the heuristic estimate carries, and the popover is
		 * an 11–16rem box where a preamble clause costs a wrapped line.
		 */
		meterMeasured: "Tidying starts near {percent}%.",
		/**
		 * Names for the tidy control while it cannot act.
		 *
		 * The button stays rendered in both states so it never moves, and a disabled
		 * control has no channel but its own name to say why it is inert. Both are
		 * accessible names, not sentences in the panel.
		 */
		tidyWhileCompacting: "Tidying thoughts…",
		tidyWhileStreaming: "Tidy earlier thoughts once the reply finishes",
	},

	/**
	 * The chip row above the composer, naming what the next turn will be told about.
	 *
	 * Every leaf here is an accessible name and nothing else. Visually a chip
	 * carries a file name plus a dashed-or-solid border; the rest of what it means
	 * — which of the two kinds it is, and what its controls will do — exists only
	 * in these strings, because the icons are `aria-hidden`. Leaving them in
	 * English did not degrade the row for a Chinese screen reader user, it removed
	 * the row's only information channel.
	 */
	contextRow: {
		rowAria: "Notes shared with Piem",
		followActive: "Follow the active note",
		/**
		 * Two leaves rather than one template with the kind substituted in. The
		 * kind word has to agree with the sentence around it, and a language that
		 * inflects could not fix that from a shared template.
		 */
		openFollowed: "Open {path}, followed automatically",
		openPinned: "Open {path}, pinned",
		pinToChat: "Pin {name} to this chat",
		/**
		 * Names the behaviour, not the note. Dismissing the followed chip turns
		 * following off; "remove this note" would promise something the control
		 * cannot deliver, since opening another file would bring it straight back.
		 */
		stopFollowing: "Stop following the active note",
		removeFromContext: "Remove {name} from context",
	},

	/** Reply action buttons and their failure notices. */
	replyActions: {
		label: "Reply actions",
		copy: "Copy reply",
		insert: "Insert at cursor",
		append: "Append to note",
		/**
		 * Names the outcome ("answer this again"), not a repeat of the question.
		 *
		 * It replaced "Ask again", which read as an addition next to the three
		 * additive actions beside it while the action actually replaces the reply.
		 */
		regenerate: "Regenerate reply",
		couldNotCopy: "Could not copy to the clipboard.",
		needOpenNoteToInsert: "Open a note to insert this reply.",
		needOpenNoteToAppend: "Open a note to append this reply.",
		/**
		 * The duration stamp's tooltip, not its visible text: on the transcript
		 * the stamp reads `8s` or `1:24`, which needs no translation, and the
		 * hover is where the reader asks for the actual instants.
		 */
		durationTooltip: "Started {start} · Ended {end}",
	},

	/**
	 * One-tap prompts. `empty` is the empty screen's deterministic first moves;
	 * `suggest` builds the model-generated request that replaces them and owns
	 * the post-reply row. `label` names the chip on screen; `prompt` is the
	 * full text a tap sends, written as a message to the model rather than a
	 * button title.
	 */
	quickActions: {
		label: "Suggested prompts",
		empty: {
			summarizeNote: {
				label: "Summarize this note",
				prompt: "Summarize the main points of the active note.",
			},
			improveNote: {
				label: "Improve this note",
				prompt: "Review the active note and suggest concrete improvements.",
			},
			brainstorm: {
				label: "Brainstorm next ideas",
				prompt: "Based on the active note, suggest five ideas to extend it.",
			},
			draftNote: {
				label: "Draft a new note",
				prompt: "Help me draft a new note: ask me for the topic, then outline it before writing.",
			},
			mapVault: {
				label: "Map my vault",
				prompt: "List the folders in my vault and describe how it is organized.",
			},
			capabilities: {
				label: "What can you do?",
				prompt: "What can you help me with in my vault? Give three concrete examples.",
			},
		},
		suggest: {
			instruction:
				"You are generating one-tap follow-up prompts for a chat assistant. Reply with ONLY a JSON array of at most 3 objects, each {\"label\": string, \"prompt\": string}. Each label is 2-4 words shown on a button; each prompt is the full message the button sends. Do not use markdown, code fences, or any text outside the array. Write in {language}.",
			emptyWithNote:
				"The conversation is empty and the user has the note \"{path}\" open as context.",
			emptyNoNote:
				"The conversation is empty and no note is open; the suggestions should be about the user's vault in general.",
			reply:
				"Base the suggestions on this assistant reply:\n\n{reply}",
		},
	},

	/** Note-reference command. */
	noteReference: {
		truncated: "The selected text was long; only its beginning was quoted.",
	},

	/** The agent's structured question, behind the ask_user tool. */
	askUser: {
		/**
		 * Title of the escalated dialog. Only the dialog has a title bar: in the
		 * transcript the card's state line does this job, and it says more.
		 */
		title: "Piem asks",
		/**
		 * Accessible name of the question card and of the record it leaves behind.
		 * Both are landmarks in the transcript — a region a screen reader can jump
		 * to — and a region without a name is one nobody can find.
		 */
		cardLabel: "Question from Piem",
		/** The card's state line while the conversation is blocked on one question. */
		waiting: "Piem needs your call",
		/** The same line for several questions, so the reader knows the size of the ask. */
		waitingMany: "Piem needs your call on {count} things",
		/**
		 * Another question is already queued behind this one — a subagent and its
		 * parent both asking. Said out loud, because a second card appearing from
		 * nowhere after the first is answered reads as a glitch.
		 */
		queued: "{count} more after this",
		/** The record's state line once the user has answered. */
		answered: "You answered",
		/** The record's state line once the user handed the decision back. */
		dismissed: "You left it to Piem",
		/**
		 * The way out, named for its consequence rather than its mechanism.
		 *
		 * The tool's result tells the model to "make the most reasonable choice
		 * yourself and say that you did", so that — not "Cancel", and not a close
		 * box — is what this button does. In the transcript it is also the *only*
		 * way out: a card in the stream has no Esc and no frame to close.
		 */
		delegate: "Let Piem decide",
		/** Confirms an answer once every question has one. */
		confirm: "Confirm",
		/** Placeholder of the free-text row at the end of the option list. */
		other: "Something else…",
		/**
		 * Accessible name of that row's input. The placeholder is the visible
		 * label, and a placeholder never reaches the accessibility tree — so the
		 * name says which question the field belongs to, which matters once a
		 * dialog carries four of them.
		 */
		otherLabel: "Your own answer for: {header}",
		/** Hint above a multi-select question's options. */
		multiHint: "Pick as many as apply.",
		/** Sits beside a disabled Confirm, naming what it is still waiting for. */
		remaining: "{count} still to answer",
	},

	/** Session dialogs: titles, search, and chat actions. */
	session: {
		newChat: "New chat",
		untitled: "Untitled chat",
		searchPlaceholder: "Search chats",
		/** Placeholder once the picker can also read what was said in each chat. */
		searchContentPlaceholder: "Search chats by title or what was said",
		searchInstructions: "Type to filter the list of chats.",
		searchNoResults: "No chat matches that yet.",
		/** Sits under a row whose match came from the transcript rather than the title. */
		searchMatchCount: "{count} matching messages",
		/** Status dot in the history picker: the session has a turn in flight (issue #235). */
		runStateRunning: "Running",
		/** Status dot: the session paused for an answer or a queued prompt. */
		runStateWaitingInput: "Waiting for input",
		/** Status dot: the session's last turn ended in an error. */
		runStateError: "Error",
		renameChat: "Rename chat",
		deleteChat: "Delete chat",
		cancel: "Cancel",
		save: "Save",
		delete: "Delete",
		nameLabel: "Name",
		nameDesc: "Leave empty to fall back to the opening message.",
		pickerOpenHint: "Open chat",
		pickerDeleteHint: "Delete chat",
		deleteRestorable: "The chat log moves to trash, so it can still be restored from there.",
	},

	/** Trace row tool names (reader-facing, not the model's ids). */
	traceTool: {
		// In `toolCatalog.ts` order, so a new tool has one obvious place to go in
		// each file rather than a name to hunt for in this one.
		read: "Read a note",
		getActiveNote: "Checked the open note",
		noteLinks: "Followed links",
		noteMetadata: "Read note properties",
		ls: "Listed a folder",
		find: "Looked for notes",
		grep: "Searched the vault",
		write: "Wrote a note",
		edit: "Edited a note",
		updateFrontmatter: "Changed note properties",
		insertAtCursor: "Inserted text at the cursor",
		moveNote: "Renamed or moved a note",
		trashNote: "Sent a note to trash",
		openNote: "Opened a note",
		openSidePanel: "Opened a side pane",
		gotoLocation: "Jumped to a spot in a note",
		notify: "Sent a notice",
		askUser: "Asked you a question",
		readSkill: "Read a skill",
		listTasks: "Listed tasks",
		summarizeTasks: "Summarized tasks",
		webFetch: "Fetched a web page",
		spawnSubagent: "Started a subagent",
		listSubagents: "Listed the subagents",
		killSubagent: "Stopped a subagent",
		followUpSubagent: "Sent a subagent another instruction",
		waitSubagent: "Waited for a subagent",
		failed: "failed",
		/**
		 * Both halves of a paired row's detail, when a write reports a diff.
		 *
		 * The counts lead because they are short and never truncate; the argument
		 * follows and gives up its tail to the panel's width, which is the right way
		 * round — "+8 -0" is worthless clipped, a path is still legible clipped.
		 * Copy rather than a literal so the separator is a translator's choice.
		 */
		detailPair: "{counts} · {argument}",
	},

	/**
	 * The one-line summary a folded run of tool calls draws.
	 *
	 * Authored mid-sentence and lower-case: `describeTraceFold` joins the phrases
	 * with the two joiners at the end of this block and puts the finished line in
	 * sentence case, so each phrase has to read the same first or third in a list.
	 * No plural rule exists in this layer, hence a pair of keys per category.
	 */
	traceFold: {
		writeOne: "changed a note",
		writeMany: "changed {count} notes",
		webOne: "fetched a page",
		webMany: "fetched {count} pages",
		subagentOne: "ran a subagent",
		subagentMany: "ran {count} subagents",
		readOne: "read a note",
		readMany: "read {count} notes",
		searchOne: "ran a search",
		searchMany: "ran {count} searches",
		otherOne: "used a tool",
		otherMany: "used {count} tools",
		/**
		 * The same bucket, worded for the company it keeps. Alongside a named
		 * category, "used 1 tool" invites the reader to wonder whether the notes
		 * named next to it were somehow not tools.
		 */
		otherAlsoOne: "used another tool",
		otherAlsoMany: "used {count} other tools",
		/** Joins the final pair; `list` joins every earlier one. */
		also: "{first} and {second}",
		list: "{first}, {rest}",
	},

	/** Settings page. */
	settings: {
		// Four tabs. The former History and Logs tabs each held two or three rows
		// — too little to navigate for — so their rows folded into the tab whose
		// question they answer: chat storage is part of the conversation it
		// stores, and the log level is plugin adjustment, like the language.
		tabModels: "Models",
		tabChat: "Chat",
		tabExtensions: "Extensions",
		tabGeneral: "General",

		logLevelHeading: "Log level",
		logLevelDesc:
			"How much the plugin writes to its log. \"Warnings\" is enough for everyday use; turn it down to \"Debug\" while troubleshooting, then back.",
		logsHeading: "Logs",
		/**
		 * Names the row that opens the viewer, because a bare button reads as a
		 * stray control and assistive technology announcing it out of context
		 * still needs to say what it opens.
		 */
		logViewerName: "Log viewer",
		logViewerDesc: "Everything the plugin has written, searchable and filterable by level.",

		languageHeading: "Language",
		languageDesc: "What language the interface speaks. “Auto” follows the vault’s language.",

		shortcutsHeading: "Shortcuts",
		/**
		 * Sits under the Shortcuts heading on the General tab. It is the only
		 * keyboard setting the plugin has, so it borrows a section instead of
		 * standing one up; the heading keeps it findable by the word a reader
		 * reaches for — "shortcut" — rather than by remembering which tab.
		 */
		sendShortcut: "Send message with",

		statusActiveModel: "Default model",
		providersHeading: "Providers",
		providersDesc: "Endpoints requests can go to. A provider holds a base URL, a wire protocol, and one key.",
		addProvider: "Add provider",
		noProviders: "No providers yet. Add one to send requests to your own endpoint or gateway.",
		editProvider: "Edit provider",
		deleteProvider: "Delete provider",
		modelsHeading: "Models",
		modelsDescWithProviders: "Models you can select. Each one names a provider and the model ID that provider expects.",
		modelsDescNoProviders: "Add a provider first — a model needs an endpoint to be served from.",
		addModel: "Add model",
		noModels: "No models yet.",
		activeModelHeading: "Default model",
		activeModelDesc: "Every request goes out on this one.",
		/**
		 * Shown when the vault names a builtin model this trimmed build dropped.
		 *
		 * Names the replacement as well as the loss: the next prompt is answered by
		 * something, and not saying what makes the change look like a malfunction.
		 */
		missingBuiltinModel:
			"This build no longer includes {provider}/{modelId}, so requests go to {replacement} instead. Add it as a provider and model below to keep using it.",
		editModel: "Edit model",
		deleteModel: "Delete model",
		keySet: "key set",
		keyBound: "key in Obsidian's keychain",
		keyMissing: "keychain entry missing",
		noKey: "no key",
		modelCount: "{count} model",
		modelsCount: "{count} models",
		/**
		 * Filter row over the model list. It appears only past a screenful of
		 * rows, because scanning a handful beats typing — the control has to earn
		 * its place before it appears.
		 */
		modelsFilterPlaceholder: "Type to filter by name, ID, or provider…",
		providerMissing: "provider missing",
		activeSuffix: " · active",
		showAgentDetails: "Show agent details",
		showAgentDetailsDesc: "Show token counts, spend, and raw tool arguments in the chat panel.",
		/**
		 * The modes are stated as what the reader *sees*, not what the machine
		 * does: "collapsed" names the transcript they get, and "high value" names
		 * the exception rather than enumerating it — the diff row explains itself
		 * when it opens.
		 */
		traceExpand: "Open tool activity",
		traceExpandDesc:
			"How much of the machine traffic — thinking, tool calls, results — starts open in the transcript. Any row can still be opened or closed by hand. With everything collapsed, a run of consecutive tool calls also folds into a single row naming what the run did.",
		traceExpandCollapsed: "Everything collapsed",
		traceExpandHighValue: "High-value rows open",
		traceExpandExpanded: "Everything open",
		/**
		 * Names what the other key does under each option, because that is the
		 * actual trade: whichever key does not send has to make a new line, and a
		 * reader picking between them is deciding which one they press more often.
		 */
		sendShortcutDesc: "Which key sends the message. Ctrl+Enter and ⌘+Enter always send, whichever option is chosen.",
		sendShortcutEnter: "Enter (Shift+Enter for a new line)",
		sendShortcutModEnter: "Ctrl+Enter or ⌘+Enter (Enter makes a new line)",
		/** Shown under the row on a phone, where a soft keyboard has no Shift+Enter. */
		sendShortcutMobileNote: "On a phone, Enter always makes a new line — a soft keyboard has no Shift+Enter — so use the Send button.",
		/**
		 * Section heading under the Chat tab for where chats are kept. Storage is
		 * separated from behaviour by a heading, not a collapsible: it is not
		 * advanced configuration, it is something every long-term user eventually
		 * needs and should not have to unfold to find.
		 */
		chatHistoryHeading: "Chat history",
		chatHistoryDesc: "Where chats are kept, and how many old ones stay.",
		/** Summary line of the network section folded under the Models tab. */
		networkHeading: "Network",
		networkHeadingDesc: "How requests leave the vault.",
		networkTransport: "Network transport",
		networkTransportDesc:
			"Request URL bypasses browser restrictions everywhere but buffers responses — tokens appear all at once. Fetch streams incrementally but may be blocked.",
		transportRequestUrl: "Request URL (buffered, works everywhere)",
		transportFetch: "Fetch (streams, may be blocked)",
		/**
		 * Disclosure for the agent's outbound HTTP tool, which is always available.
		 *
		 * Was a toggle until #52. Reworded from permission to plain statement: the
		 * reader is being told what the agent can do, not asked to allow it. Still
		 * named for the capability rather than `web_fetch`, because a reader has
		 * never seen the tool's internal name and should not have to.
		 */
		webFetchName: "Fetching web pages",
		webFetchDesc:
			"The agent can request external URLs when a task needs a page. Those requests, and any data in them, leave the vault and Obsidian; the transport above decides how they travel.",
		whatLeavesVault: "What leaves this vault",
		whatLeavesVaultDesc:
			"Prompts, vault content read by tools, and tool results are sent to the provider serving the default model. Nothing is sent anywhere else.",
		chatLogsInVault:
			"Chat logs are files in your vault, so they sync and back up with your notes. They hold the conversation and whatever note text was read while answering it.",
		apiKeysHeading: "API keys",
		restrictedKeyHint: "Use a restricted, low-limit key: a vault is a plain folder, and a key inside it travels with every backup and sync of that folder.",
	},

	/**
	 * The Skills tab.
	 *
	 * The copy keeps the two lists honest about ownership: vault skills are
	 * this plugin's files and can be managed here; user-level skills belong to
	 * the machine and are shown, not managed.
	 */
	skills: {
		heading: "Skills",
		desc: "Instructions the agent can load on request. They are files in your vault — edit them like any note, and the next message picks up the change.",
		import: "Import from URL",
		empty: "No skills yet. Import one from a URL, or create a folder in Piem/skills with a SKILL.md inside.",
		importedFrom: "Imported from {url}",
		handAuthored: "Written in this vault. Updates come from editing the files.",
		rootFile: "A single note acting as a skill. Edit it like any note; it cannot be updated or deleted from here.",
		open: "Open",
		update: "Check for updates",
		delete: "Delete",
		upToDate: "{name} is already up to date.",
		updatedOne: "{name} updated: 1 file changed.",
		updatedMany: "{name} updated: {count} files changed.",
		/** Names the files it refused to touch, so the refusal is actionable. */
		conflict: "{name} has local edits, so nothing was overwritten. Conflicting files: {files}.",
		couldNotUpdate: "Could not update {name}: {message}",
		couldNotDelete: "Could not delete {name}: {message}",
		/**
		 * Reads the files again. The recovery for everything the two problem
		 * lists below can report — fix the file, fix the folder's permissions,
		 * then press this — and the only way to make a load happen on demand,
		 * which is what lets a failure be caught with the log view open.
		 */
		reload: "Reload",
		/**
		 * The reload's own verdict, needed because a clean reload changes nothing
		 * on screen: the problem lists simply stay empty, and a button that
		 * appears to do nothing reads as broken.
		 */
		reloadClean: "Skills read again, and nothing was wrong. The agent is using what is on disk now.",
		/** Does not restate the problems: they are listed under the section each belongs to. */
		reloadProblems: "Skills read again. The problems that came back are listed with each section.",
		couldNotReload: "Could not read the skills again: {message}",
		problemsHeading: "Problems reading skill files",
		/**
		 * Carries the consequence, which is the half a parser message never
		 * states: a file listed here is missing from the list above, and nothing
		 * else was affected by it.
		 */
		problemsDesc:
			"These files were found but could not be read as skills, so they are missing from the list above. Every other skill loaded normally.",
		userHeading: "User-level skills",
		/**
		 * Deliberately no longer names the folders.
		 *
		 * It used to list the two pi reads, which was the complete story until a
		 * third became configurable — and an enumeration that can go stale is
		 * worse than none, because a reader who trusts it stops looking. The
		 * searched list below states the actual set, refreshed from what was
		 * really read, so this line only has to say the kind of place they are.
		 */
		userDesc: "Loaded automatically from folders on this computer, outside this vault. The list below shows which folders were read.",
		userEmpty: "No user-level skills found on this computer.",
		userDirName: "Extra skills folder",
		/**
		 * Names both accepted spellings, so they are not discovered from a
		 * rejection, and says what an empty field does — here that is a valid
		 * answer rather than an omission, since nothing falls back to a default.
		 */
		userDirDesc:
			"One more folder on this computer to load skills from, on top of the built-in ones. Enter a full path, or one starting with ~ for your home folder. Leave it empty and only the built-in folders are read.",
		/**
		 * The only rejection the rules produce. States the consequence rather
		 * than the rule alone: a reader who types 'skills' and is told a path
		 * must be absolute still does not know that nothing extra is now loaded.
		 */
		userDirProblemRelative:
			"Enter a full path — one starting with / or a drive letter, or with ~ for your home folder. A plain name like 'skills' is not read, so no extra folder is loaded.",
		userSearchedHeading: "Folders searched",
		/**
		 * Carries the whole framing for the list, so the per-folder lines below
		 * can stay factual. Both halves are needed: an absent folder is the
		 * ordinary state and must not read as breakage, and a folder the user
		 * did create going unread is the defect this section exists to surface.
		 */
		userSearchedDesc:
			"Where skills were looked for the last time they loaded. A folder you have not created is simply not there, and nothing is wrong. A folder you did create should say how many skills it holds — if it does not, the path being read is not the one you meant.",
		/** Per-folder outcomes. Each states only what was seen, with no verdict attached. */
		userSearchedMissing: "No folder at this path.",
		/** Its own case: reached, and empty. A user with no skills listed needs the difference. */
		userSearchedEmpty: "Read, and holds no skills.",
		userSearchedFound: "Read, {skills} loaded.",
		/**
		 * The check itself failed — the folder was neither confirmed nor denied.
		 * Its own line rather than folded into "no folder": telling a reader whose
		 * permissions hid their skills that the folder is not there sends them
		 * looking in the wrong place entirely.
		 */
		userSearchedUnknown: "Could not be checked.",
		userProblemsHeading: "Problems reading folders on this computer",
		/**
		 * "In its own words" is the load-bearing phrase: it tells the reader the
		 * text below is the filesystem's, not Piem's own broken output, which is
		 * what keeps a line like `EACCES: permission denied` from reading as a
		 * crash. The second sentence is the consequence, and the third keeps one
		 * unreadable folder from implying the rest of the section is untrustworthy.
		 */
		userProblemsDesc:
			"Reported by this computer's filesystem, in its own words. Skills at these paths are not loaded. Folders that read cleanly are unaffected.",
		userSkillOne: "1 skill",
		userSkillMany: "{count} skills",
	},

	/** The import-skills modal. */
	skillImport: {
		title: "Import skills",
		urlName: "Skill URL",
		urlDesc: "A GitHub folder or file, or any public .md page.",
		urlPlaceholder: "https://github.com/owner/repo/tree/main/skills",
		preview: "Preview",
		fetching: "Fetching…",
		importOne: "Import 1 skill",
		importMany: "Import {count} skills",
		invalidUrl: "That does not look like a skill URL. Use a GitHub folder, a GitHub file, or a public .md link.",
		fetchFailed: "Could not fetch: {message}",
		installFailed: "Could not import: {message}",
		noneFound: "No skills found there. A skill is a folder with a SKILL.md, or a .md file with a name and description.",
		installed: "Imported {count}.",
		cancel: "Cancel",
	},

	/**
	 * The MCP servers section of the Extensions tab.
	 *
	 * The description states the outbound truth up front: configuring a server
	 * means requests leave the vault to that URL, and its tools run in chat.
	 * Every status line is a sentence, not a bare word, because "error" alone
	 * sends a reader hunting for the message this row already holds.
	 */
	mcp: {
		heading: "MCP servers",
		desc: "Connect tools served by remote MCP (Model Context Protocol) servers. Their tools appear in chat with an mcp_ prefix; requests leave the vault to the URL you enter.",
		/**
		 * Shown unconditionally, because mounting is pinned to the buffered
		 * transport no matter what this reader selected.
		 *
		 * The degradation is real and was previously disclosed nowhere a user
		 * looks — only in a source comment. It no longer tells the reader to
		 * switch transports: switching changes how tool calls travel, but the
		 * mount — and with it the lack of push — stays pinned.
		 */
		bufferedNoPush:
			"MCP mounting always rides the buffered transport, so a server cannot push to you: its tool list refreshes when you save settings, not when the server changes it.",
		add: "Add server",
		edit: "Edit",
		delete: "Delete",
		empty: "No MCP servers configured yet. Add one to bring its tools into chat.",
		statusOk: "Connected; {tools} tools available.",
		statusError: "Last connection failed: {error}",
		// Shown on the row's verdict line for the seconds the toggle's save takes
		// to attempt a connection — the row promises a result, so it must not sit
		// on a stale verdict while the network round trip runs.
		statusConnecting: "Connecting…",
		statusDisabled: "Disabled. Turn it on to connect.",
		disableConsequenceTools: "This server's tools leave chat immediately.",
		disableConsequenceToken: "Its token stays in the config; turning it back on restores it.",
		statusUntested: "Not connected yet. Saving settings or reloading the plugin connects it.",
		testTitle: "Connection",
		testOk: "Reached the server; {tools} tools available.",
		name: "Name",
		namePlaceholder: "GitHub",
		nameRequired: "Give the server a name.",
		urlName: "URL",
		urlDesc: "The server's MCP endpoint. Requests leave the vault to this address.",
		urlPlaceholder: "https://example.com/mcp",
		urlRequired: "Enter an http(s) URL.",
		tokenName: "Bearer token",
		tokenDesc: "Sent as an Authorization header with every request to this server. Leave it empty for open servers.",
		tokenTarget: "this server's URL",
		addTitle: "Add MCP server",
		editTitle: "Edit MCP server",
		addButton: "Add",
		saveButton: "Save",
		cancelButton: "Cancel",
	},

	/**
	 * About tab rows. The hrefs live in `aboutCopy.ts` — only the wording is here.
	 *
	 * Each row's label has to read on its own, because assistive technology can
	 * list a page's links out of context: "Open repository" survives that, "here"
	 * does not. Translations must keep that property.
	 */
	about: {
		version: "Version {version}",
		sourceName: "Source code",
		sourceDesc: "The plugin's repository on GitHub.",
		sourceLabel: "Open repository",
		issuesName: "Report a problem",
		issuesDesc: "Bugs and feature requests go to the issue tracker.",
		issuesLabel: "Open issues",
		/**
		 * Points at the licence file rather than naming the licence, so the panel
		 * never has to be kept in sync with the terms it claims.
		 */
		licenseName: "License",
		licenseDesc: "The terms this plugin is distributed under.",
		licenseLabel: "Read the license",
		sponsorName: "Support the project",
		sponsorDesc: "Fuel the plugin's development on Ko-fi.",
		sponsorLabel: "Support on Ko-fi",
	},

	/**
	 * The compaction group on the Behavior tab.
	 *
	 * pi calls these reserve and retention tokens, but an Obsidian reader's
	 * vocabulary is notes and chats, not context windows. The copy leads with the
	 * consequence — what happens to their conversation — and mentions tokens only
	 * as the unit the field takes.
	 */
	compaction: {
		groupLabel: "Context tidying",
		/** Names the default behaviour, so a reader who never opens the group knows it is handled. */
		groupHint: "Advanced. Piem already tidies earlier thoughts away before the context fills.",
		reserveName: "Headroom before tidying",
		reserveDesc:
			"Tokens kept free for writing the summary. Raise it to tidy up earlier, lower it to use more of the window first. Default {default}.",
		keepName: "Recent messages to keep",
		keepDesc:
			"Tokens of recent conversation left untouched by a summary. Raise it to keep more of the exchange verbatim. Default {default}.",
		/**
		 * What a rejected entry says. A field that silently reverts is the failure
		 * mode worth avoiding: someone who types 200 and finds 16,384 back in the
		 * box cannot tell whether the plugin refused, corrected, or ignored them.
		 */
		tokenFloor: "Values below {min} tokens are raised to it.",
	},

	/**
	 * The History tab.
	 *
	 * These are the only settings in the plugin that decide the fate of the user's
	 * own writing, so the wording follows two rules: never describe a limit
	 * without saying what happens to what falls outside it, and always say trash,
	 * because "removed" and "recoverable from trash" are different promises.
	 */
	sessions: {
		retentionName: "Chats to keep",
		/** Says trash in the same words the delete confirmation uses, so one recognises the other. */
		retentionDesc:
			"Older chats move to trash when a new one is created, so they can still be restored from there. Set to 0 to keep every chat.",
		retentionFloor: "Values below {min} are raised to it.",
		retentionUnlimited: "Every chat is kept. {stored}",
		/** The warning that makes the number's effect visible before it acts. */
		retentionWillTrash: "{stored} The next new chat moves the oldest {chats} to trash.",
		retentionSafe: "{stored} Nothing is trashed until the limit is reached.",
		storedNone: "No chats stored yet.",
		storedOne: "1 chat stored.",
		storedMany: "{count} chats stored.",
		chatOne: "1 chat",
		chatMany: "{count} chats",
		dirName: "Chat folder",
		/** Discloses both surprises up front: the logs sync, and the agent can read them. */
		dirDesc:
			"Folder inside this vault where chat logs are written. Logs there sync and back up with your notes, and Piem's own search tools can read them.",
		dirRestartHint: "Takes effect for the next chat you create.",
		dirUnchanged: "New chats are written to {dir}.",
		/**
		 * Says both halves, because the consequence must never be left implicit:
		 * where new chats go, and that the old ones drop out of the list until
		 * moved. A user who expects the list to follow the setting and finds it
		 * short would read that as the plugin having lost their conversations.
		 */
		dirChanged:
			"New chats will be written to {next}. Nothing is moved: chats in {current} stay on disk but drop out of the chat list until you move the files across.",
		/** Field-level rejections. Each names the rule that was broken, not just that something is wrong. */
		dirProblemEmpty: "Enter a folder inside this vault.",
		dirProblemAbsolute: "Use a folder inside this vault, not a path on your computer.",
		dirProblemEscape: "Folders cannot step outside the vault with '..'.",
		dirProblemUnusable: "That is not a folder this vault can hold.",
		/**
		 * Chats left in the folder earlier releases used. Naming the path is the
		 * whole value: it sits inside the config directory, which the file explorer
		 * does not show, so a reader who does not know where to look cannot recover
		 * them.
		 */
		legacyOne:
			"1 chat from an earlier version is still in {dir}. Move the .jsonl files into the folder above to see them in the chat list again.",
		legacyMany:
			"{count} chats from an earlier version are still in {dir}. Move the .jsonl files into the folder above to see them in the chat list again.",
	},

	/** Connection-test verdicts, shown next to the Test button. */
	connectionTest: {
		noKey: "No API key for this provider yet.",
		noModelId: "This model has no model ID yet.",
		/**
		 * One sentence per stop reason rather than a `{reason}` template: the
		 * reason is the provider library's enum, so interpolating it would drop a
		 * raw English token into a translated sentence.
		 */
		requestFailed: "Request failed.",
		requestAborted: "Request aborted.",
		reached: "Reached {target}{served}.",
		servedSuffix: " — served {model}",
		unknownError: "Unknown error",
		/** Names the model a provider test borrowed, so a model-specific failure is attributable. */
		probedWith: " (probed with {model})",
		/** Listing-probe verdicts, used when no model is configured to borrow. */
		listingNoModels: "Reached {target}, but it lists no models.",
		listingOneModel: "Reached {target} — it lists 1 model.",
		listingModels: "Reached {target} — it lists {count} models.",
		listingNeedsKey: "{target} requires an API key ({status}).{relayed}",
		listingRejectedKey: "{target} rejected the API key ({status}).{relayed}",
		listingUnsupported:
			"Reached {target}, but it does not list models, so the key could not be checked. Add a model under this provider to test a real request.",
		listingStatus: "{target} answered {status}.{relayed}",
	},

	/** How the active target is named in status lines and errors. */
	target: {
		customEndpoint: "The custom endpoint ({modelId})",
		needsKeyToSend: "{target} needs an API key in plugin settings before sending a prompt.",
		/** "Tidying up" rather than "compacting": the panel's own word for this everywhere the reader can see it. */
		needsKeyToCompact: "{target} needs an API key in plugin settings before tidying earlier thoughts.",
	},

	/** Delete-confirmation dialog. */
	confirmDelete: {
		title: "Delete {subject}?",
		cancel: "Cancel",
		delete: "Delete",
		disableTitle: "Disable {subject}?",
		disable: "Disable",
		providerSubject: 'provider "{name}"',
		modelSubject: 'model "{name}"',
		skillSubject: 'skill "{name}"',
		mcpServerSubject: 'MCP server "{name}"',
		// Deleting a provider takes its API key with it, and the key may exist
		// nowhere else — so the confirmation offers an escape hatch before the
		// click lands, not an apology after it.
		copyKey: "Copy API key",
		copied: "Copied to the clipboard.",
	},

	/** Consequences stated before a delete is confirmed. */
	deletion: {
		providerKeyRemoved: "The base URL and API key are removed from this vault's config.",
		providerOneModel: "The model served by it is removed too: {names}.",
		providerManyModels: "The {count} models served by it are removed too: {names}.",
		modelProviderStays: "The provider and its key stay, so other models keep working.",
		modelWasActive: "It is the default model, so {model} takes over when it goes.",
		modelWasLast: "It is the only model, and nothing takes its place — add another before your next message.",
		skillFiles: "The skill's files move to the trash and stop being available to the agent.",
		mcpServer: "Its tools stop being offered to the agent. Any keychain entry its token was bound to is left in place.",
	},

	/**
	 * The first Esc on a config modal holding unsaved edits. One sentence shared
	 * by every form: the mechanics are identical, only the fields differ, and a
	 * reader who learns the rule once knows it everywhere.
	 */
	discard: {
		warning: "This form has unsaved changes — press Esc again to discard them.",
	},

	/** The expand/collapse toggle on an over-long row description. */
	descFold: {
		more: "Show more",
		less: "Show less",
	},

	/** Connection-test row. */
	test: {
		button: "Test",
		running: "Testing…",
		pending: "Sending a test request…",
	},

	/** Where API keys are stored on this device, one sentence per tier. */
	secretStorage: {
		/** `delegated`: the keychain reads and encrypts. */
		delegated: "Bound keys live in Obsidian's keychain — not in this vault.",
		/**
		 * `delegated-unencrypted`: the keychain reads but does not encrypt (Linux
		 * with no keyring service). Delegation still works; the panel must say so.
		 */
		delegatedUnencrypted:
			"Bound keys live in Obsidian's keychain, which stores them unencrypted on this device. They are still kept out of this vault.",
		/** `manual`: no usable keychain; plaintext in the vault config. */
		manual: "This device has no keychain support, so keys typed here are stored as plaintext in this vault's plugin config.",
		manualKeyField: "Sent only to {target}. {storage} Use a restricted, low-limit key.",
		/** The collapsed typed field under a delegated tier: the group hint already said where it lands. */
		manualKeyFieldPlain: "Sent only to {target}. Use a restricted, low-limit key.",
		noSync: "The keychain does not sync, so each device needs its own binding. Picking the entry again on another device is expected.",
		providerTarget: "this provider's base URL",
		/** Description under a keychain-bound key row: which entry it points at. */
		boundTo: "Bound to keychain entry “{name}”.",
		/** The bound entry is gone from the keychain; the binding dangles. */
		danglingRef: "The keychain entry this provider was bound to is gone. Pick an entry again.",
		/** Button that opens Obsidian's own keychain settings page. */
		openKeychain: "Open keychain",
		openKeychainDesc: "Create or pick a keychain entry in Obsidian's settings.",
		/** Collapsible manual-entry fallback, offered when the keychain is available. */
		manualGroup: "Type a key manually",
		manualGroupHint: "For when a key cannot live in the keychain. Stored in this vault's config.",
	},

	/** Provider modal. */
	providerModal: {
		addTitle: "Add provider",
		editTitle: "Edit provider",
		/**
		 * First row of the form, and the one that decides its shape: a preset owns
		 * the name, base URL and protocol, so those three rows are hidden while one
		 * is selected and only the key is left to fill. The custom option leads the
		 * list because it is the form's own default — someone pointing at a gateway
		 * should not scroll past sixteen vendors to reach the state it opened in.
		 */
		preset: "Preset",
		presetDesc: "Pick a known provider and only its API key is left to enter. Choose Custom to set the name, base URL and protocol yourself — a gateway, a proxy, or a self-hosted server.",
		presetCustom: "Custom",
		name: "Name",
		nameDesc: "Shown wherever this provider is listed. Optional — the base URL is used when blank.",
		namePlaceholder: "My gateway",
		baseUrl: "Base URL",
		baseUrlDesc: "Root of the API, e.g. https://api.example.com/v1",
		baseUrlPlaceholder: "https://api.example.com/v1",
		protocol: "Protocol",
		protocolDesc: "The wire format this endpoint speaks. The first option is the one gateways and self-hosted servers implement most widely.",
		apiKey: "API key",
		apiKeyPlaceholder: "Enter API key",
		connection: "Connection",
		connectionDesc:
			"Checks the URL, protocol, and key. Uses one of this provider's models when there is one, and otherwise asks the endpoint which models it serves.",
		cancel: "Cancel",
		add: "Add",
		save: "Save",
		baseUrlRequired: "A base URL is required.",
		baseUrlInvalid: "That base URL is not a valid URL. Include the scheme, e.g. https://api.example.com/v1",
		baseUrlScheme: "The base URL must use http or https.",
		couldNotSave: "Could not save the provider: {message}",
	},

	/** Model modal. */
	modelModal: {
		addTitle: "Add model",
		editTitle: "Edit model",
		/**
		 * Collapsible group for the four capability fields. The identity fields
		 * (provider, ID, display name) stay flat: a new model cannot be saved
		 * without them, so hiding anything required would trade one scroll for a
		 * click and a hunt.
		 */
		capabilityGroup: "Capabilities & limits",
		capabilityGroupHint: "Context window, output cap, and what the model accepts.",
		provider: "Provider",
		providerDesc: "Which configured endpoint serves this model.",
		modelId: "Model ID",
		modelIdDesc: "Sent to the server verbatim. Start typing to search known model ids, or enter your own.",
		modelIdPlaceholder: "gpt-4o-mini",
		displayName: "Display name",
		displayNameDesc: "Shown in the model picker. Leave blank to use the model ID.",
		displayNamePlaceholder: "My model",
		contextWindow: "Context window",
		contextWindowDesc: "Tokens this model accepts. Compaction plans against it; leave blank for the default.",
		// Shown under a numeric field holding a value it will drop: 0, negative,
		// or not a number. The field reverts silently otherwise, and a silently
		// ignored keystroke reads as a broken field.
		positiveNumberHint: "Needs a positive whole number — leave blank for the default.",
		contextWindowPlaceholder: "128000",
		maxTokens: "Max output tokens",
		maxTokensDesc: "Cap on a single reply. Leave blank for the default (8192).",
		maxTokensPlaceholder: "8192",
		supportsThinking: "Supports thinking",
		supportsThinkingDesc: "Enable only if this model accepts reasoning parameters. Strict servers reject them outright.",
		thinkingHintSupported: "This model supports thinking. Recommended on.",
		thinkingHintUnsupported: "This model does not support thinking. Recommended off.",
		thinkingUnbacked: "The model catalog does not list this ID, so the thinking switch has no source behind it. Keep it on only if you know the server accepts it.",
		supportsImages: "Accepts images",
		supportsImagesDesc: "Enable to let this model receive attached images alongside text.",
		imagesHintSupported: "This model accepts images. Recommended on.",
		imagesHintUnsupported: "This model does not accept images. Recommended off.",
		imagesUnbacked: "The model catalog does not list this ID, so the image switch has no source behind it. Keep it on only if you know the server accepts images.",
		// Issue #160: the numeric limits used to be filled once and then go silent,
		// so a value left over from the previous model id sat under the new one
		// unremarked. The four lines below are that failure's replacements: the
		// catalog advises, the user's value is the user's, and an unbacked value
		// is said out loud rather than passed over.
		contextWindowAdvice: "The catalog suggests {value} for this model.",
		contextWindowAdviceMatches: "Matches the catalog for this model.",
		contextWindowUnbacked: "The model catalog does not list this ID, so this number has no source behind it. Check it against the provider's docs.",
		maxTokensAdvice: "The catalog suggests {value} for this model.",
		maxTokensAdviceMatches: "Matches the catalog for this model.",
		maxTokensUnbacked: "The model catalog does not list this ID, so this number has no source behind it. Check it against the provider's docs.",
		adoptNumber: "Adopt the suggested value",
		adoptToggleOn: "Turn on",
		adoptToggleOff: "Turn off",
		connection: "Connection",
		connectionDesc: "Sends one minimal request to confirm the provider, key, and model ID work together.",
		cancel: "Cancel",
		add: "Add",
		save: "Save",
		chooseProvider: "Choose a provider.",
		providerMissing: "That provider no longer exists.",
		modelIdRequired: "A model ID is required.",
		added: "Model added.",
		saved: "Model saved.",
		couldNotSave: "Could not save the model: {message}",
	},

	/** Settings language options. */
	language: {
		auto: "Auto",
		en: "English",
		"zh-cn": "简体中文",
	},

	/** Wire protocol labels for the dropdowns. */
	wireProtocol: {
		openaiChat: "OpenAI Chat Completions",
		openaiResponses: "OpenAI Responses",
		anthropicMessages: "Anthropic Messages",
	},

	/**
	 * The subagent inspector: the side panel, its entry point above the composer,
	 * and the detail page.
	 *
	 * The panel's controls are exactly three, and the shape of that set is the
	 * design (issues #153, #233, #290): stop one run, stop all of them, put the
	 * finished ones away. Every other leaf here names or describes something. What
	 * is missing is missing on purpose — there is no reply field, because a
	 * subagent cannot see this conversation and a reply would have nowhere to land,
	 * and no delete, because archiving a run the parent has not collected yet must
	 * not be able to destroy its report.
	 */
	subagents: {
		tabTitle: "Piem subagents",
		panelAria: "Subagents in this chat",
		/**
		 * Two leaves, not one with the status substituted in: the running case
		 * names a count that is changing and the settled case names a count that
		 * is done, and a language that inflects could not carry both from one
		 * template.
		 */
		entryRunning: "{count} subagent(s) working. Open the subagent panel.",
		entrySettled: "{count} subagent(s) in this chat. Open the subagent panel.",
		popoverAria: "Subagents in this chat",
		/** One popover row: opens the panel already showing that run. Task first — a reader scanning rows remembers what they asked, and "scout" describes several of them. */
		openDetail: "{task} — open run",
		listAria: "Subagents, oldest first",
		empty: "No subagents yet.",
		emptyHint: "When Piem hands a task to a subagent, the run shows up here: what it was asked, what it reported, and every step in between.",
		emptyDetail: "Pick a run to see what it was asked and what it wrote.",
		back: "Back to the list",
		/**
		 * Draws the line the panel actually holds: stopping is here, talking is
		 * not. Saying both halves matters — "you can stop" invites the reader who
		 * wants a circuit breaker, and "but not talk" preempts the reader who
		 * would otherwise look for a reply box that rule 2 forbids.
		 */
		panelNotice: "You can stop a run from here, but not talk to it — to change its course, tell Piem in the chat.",
		stopOne: "Stop this run",
		stopAll: "Stop all",
		stopAllAria: "Stop every running subagent",
		/**
		 * "Finished", not "done": a run that failed or was cut short is finished
		 * too, and all three are what this puts away. The accessible name spells
		 * out the sweep, since the label alone does not say how many it takes.
		 */
		archiveFinished: "Archive finished",
		archiveFinishedAria: "Archive every run that has finished",
		sectionArchived: "Archived",
		archivedCount: "{count} run(s)",
		archivedListAria: "Archived subagents, oldest first",
		/** What is left when the reader has archived everything; the section below still holds them. */
		allArchived: "Every run is archived. Open Archived below to read one.",
		status: {
			running: "working",
			done: "done",
			incomplete: "cut short",
			failed: "failed",
		},
		ranFor: "ran for {duration}",
		startedAt: "started {time}",
		incompletePartial: "Stopped before it finished, so the report below is partial.",
		killedByParent: "It stopped because the chat turn stopped.",
		killedByTeardown: "It stopped because the chat closed.",
		killedByTool: "Piem stopped it: the answer was no longer needed.",
		killedByUser: "You stopped it from this panel.",
		sectionTask: "Task",
		/**
		 * Introduces the later errands, under the task the child was spawned on.
		 * Names Piem rather than saying "follow-ups" because who asked is the part a
		 * reader cannot infer: the panel forbids *them* talking to a child, so an
		 * extra instruction can only have come from the chat.
		 */
		followUpsLabel: "Then Piem asked for:",
		sectionInstructions: "Standing instructions",
		sectionConfig: "Setup",
		sectionReport: "Report",
		sectionProcess: "Process record",
		configRole: "Role",
		configModel: "Model",
		configThinking: "Thinking",
		configDepth: "Level",
		/** Level 1 is a direct child of this chat; 2 was spawned by another subagent. */
		depthValue: "{depth}",
		usageTurns: "{count} turn(s)",
		usageTokens: "{tokens} tokens",
		usageCost: "{cost}",
		reportPending: "Still working. Its report lands here when it finishes.",
		reportNone: "It failed before writing a report.",
		failureLabel: "What went wrong",
		processCount: "{count} step(s)",
		processPending: "The transcript is kept when the run ends.",
		processNone: "Nothing recorded: the run ended before it did anything.",
		/** What each transcript step was. */
		line: {
			user: "Brief",
			assistant: "Reply",
			thinking: "Thinking",
			toolCall: "Ran {tool}",
			toolResult: "{tool} returned",
			toolError: "{tool} failed",
		},
		/** Marks a step whose text was clipped for display. */
		clipped: "… clipped for display",
	},

	/** The log viewer panel. */
	logView: {
		title: "Piem logs",
		filter: {
			all: "All levels",
			off: "Off",
			debug: "Debug",
			info: "Info",
			warn: "Warnings",
			error: "Errors",
		},
		copy: "Copy",
		clear: "Clear",
		openFile: "Open log file",
		empty: "No log records at this level yet.",
		dropped: "{count} earlier record(s) were dropped to keep the buffer small.",
		fileHint: "Persisted log: {path}",
	},
} as const;

export type EnCopy = typeof en;

/**
 * A nested object where every leaf is optional, recursively, and every leaf
 * string is widened to `string`.
 *
 * Translation tables are typed as `DeepPartial<EnCopy>` so they may omit keys
 * (which fall back to English) but may not invent keys. Widening the leaves is
 * what lets a translation write Chinese where English wrote English: the
 * `as const` English table types its leaves as literals, which no other language
 * could satisfy. Record leaves are made fully optional rather than per-key
 * optional because translating one entry of a record never requires touching the
 * others.
 */
export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends Record<string, unknown>
		? DeepPartial<T[K]>
		: T[K] extends string
			? string
			: T[K];
};
