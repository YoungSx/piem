import React, { useEffect, useRef, useState } from "react";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PendingToolCall } from "../agent/ObsidianAgentService";
import type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { App, Component, IconName } from "obsidian";
import type { TextBlockKind } from "./markdownPolicy";
import { MarkdownText } from "./MarkdownText";
import { assistantText, copyToClipboard, notifyActionResult, userText } from "./messageActions";
import { QuickActions } from "./QuickActions";
import { ReplyActions } from "./ReplyActions";
import { emptyScreenQuickActions, type QuickAction } from "./quickActionSuggestions";
import { describeReplyCutoff, type ReplyCutoff } from "./replyCutoff";
import { durationBadgeVisible, isFinalReply, replyDurationMs } from "./replyDuration";
import { useT } from "./TranslatorContext";
import type { Translator } from "../i18n";
import { suppressOwnTooltip } from "./tooltipSuppression";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";
import { GENERIC_TOOL_ICON, toolIcon } from "./toolCatalog";
import { countDiffLines, describePendingTool, describeTool, isToolIdentifier, summarizeToolPayload, summarizeToolResult } from "./traceSummary";
import { DEFAULT_TRACE_EXPAND, traceOpensByDefault, type TraceExpandSetting } from "./traceExpand";
import { AskUserCard, AskUserReceipt } from "./AskUserCard";
import { ASK_USER_TOOL, askUserOutcome } from "./askUserRecord";
import {
	blockIsVisible,
	describeTraceFold,
	planTraceFolds,
	traceFoldSlot,
	type TraceFoldGroup,
	type TraceFoldPlan,
	type TraceRowRef,
} from "./traceFold";
import { planToolPairs, pairedResult, resultIsPaired, type ToolPairPlan } from "./toolPair";
import {
	compactionDrawsMessage,
	compactionRowClass,
	compactionRowIcon,
	compactionRowLabel,
	compactionRowsAt,
	planCompactionRows,
	type CompactionPlan,
	type CompactionRow,
} from "./compactionRow";
import type { CompactionEvent } from "../agent/compaction";
import type { AskUserAnswer } from "../tools/askUserQuestion";
import type { AskUserRequest } from "../tools/askUserBroker";

export interface MessageListProps {
	messages: AgentMessage[];
	/** True while the agent turn is in flight; the last message is the streaming one. */
	isStreaming: boolean;
	/**
	 * Tools running right now, worded like the collapsed trace rows so the live
	 * line and the finished rows do not name the same tool two ways.
	 *
	 * Each may carry a `progress` line the tool reported through pi's
	 * `tool_execution_update`. Absent for a tool that reports nothing, in which
	 * case the row shows the name alone exactly as it always has.
	 */
	pendingToolCalls: PendingToolCall[];
	/**
	 * Messages that are on screen and not on disk, by identity.
	 *
	 * Compared by identity against {@link messages}, which is the same array the
	 * service handed out. The warning has to sit under the reply it names: it is
	 * the only report in this panel about loss the reader cannot undo, and "this
	 * reply could not be saved" at the top of the panel left them to work out
	 * which reply that was.
	 */
	unpersistedMessages?: readonly object[];
	isInitializing?: boolean;
	isConfigured?: boolean;
	/**
	 * Whether the transcript may use agent-internal vocabulary: raw tool ids and
	 * the `JSON.stringify` payload behind each call.
	 */
	showAgentDetails?: boolean;
	/**
	 * How much machine traffic starts open. Rows stay openable by hand either
	 * way — this is the state the reader meets, not a permission.
	 */
	traceExpand?: TraceExpandSetting;
	/**
	 * Opens the plugin settings tab. Absent when the host cannot reach it, in
	 * which case the empty state names the path in prose instead.
	 */
	onOpenSettings?: () => void;
	/**
	 * Regenerates the reply at `index` by re-asking the question behind it.
	 *
	 * Only ever called with the newest reply's index — see
	 * {@link regenerableIndex}. Absent while a turn is in flight, which hides the
	 * action rather than letting it queue a second run.
	 */
	onRetry?: (index: number) => void;
	/**
	 * Opens the question behind the newest reply for editing in the composer.
	 *
	 * Only ever called with the last answered question's index — see
	 * {@link editableQuestionIndex}. Sending from the composer then replaces the
	 * conversation from that turn, so the same in-flight gate {@link onRetry}
	 * keeps applies here: absent while a turn is running, rather than queueing
	 * an edit behind it.
	 */
	onEditMessage?: (index: number) => void;
	/**
	 * Forks a new chat that carries everything up to the reply at `index`.
	 *
	 * Offered on the newest reply only, which is where {@link onRetry} sits: the
	 * fork shares that row rather than that constraint. Copying from an earlier
	 * reply would be sound — the source keeps every turn it had — so this bound
	 * is the scope the control was introduced at, not something the copy cannot
	 * do. Absent while anything is in flight, because the turn it would copy is
	 * still being written.
	 */
	onFork?: (index: number) => void;
	/** Render context for `MarkdownRenderer.render`; supplied by the view. */
	app: App;
	component: Component;
	/**
	 * Note path used to resolve `[[wikilinks]]` and relative image paths;
	 * empty when no note is active.
	 */
	sourcePath: string;
	/**
	 * Element id of the composer's textarea, for the skip link above the
	 * transcript. Absent until the composer has mounted and reported it, which is
	 * also why the link is not rendered before then — a `href="#"` with no target
	 * is a tab stop that goes nowhere.
	 */
	composerAnchorId?: string;
	/**
	 * Whether the user currently has a Markdown note open that the model is told
	 * about. Shapes the empty screen's suggested prompts: with a note, the
	 * suggestions are about that note; without one, they are about the vault.
	 */
	hasActiveNote?: boolean;
	/** Whether a compaction request is in flight — one more reason to hide the follow-ups. */
	isCompacting?: boolean;
	/**
	 * The tidying attempt the transcript draws, from working to settled or failed.
	 *
	 * Separate from {@link isCompacting}, which is only the busy flag other rows
	 * gate on: this is the row's own material, and it outlives the request on the
	 * failure path. A success carries no event — pi's summary message in
	 * {@link messages} is the record.
	 */
	compactionEvent?: CompactionEvent | null;
	/**
	 * Messages the last compaction kept, which is what places its row.
	 *
	 * pi files the summary at index 0 because that is what replaces the history in
	 * the *request*; the tidy itself ran after every turn it retained. See
	 * {@link planCompactionRows}.
	 */
	compactionRetained?: number;
	/**
	 * Sends a tapped quick-action prompt as the user's own message.
	 *
	 * Supplying it turns the suggestions on; omitting it renders no row, which
	 * is how tests mount the transcript without wiring a sender.
	 */
	onQuickAction?: (prompt: string) => void;
	/**
	 * Model-generated suggestions for whichever placement is live, resolved by
	 * `ChatApp` (empty screen while the transcript is empty, otherwise the
	 * settled reply) and empty when none apply — not yet arrived, failed, or
	 * superseded.
	 *
	 * The two placements read it differently. The empty screen treats it as a
	 * replacement for its built-in chips, which stay up until it arrives, so a
	 * failed request costs the reader nothing. The reply row treats it as the
	 * whole row: chips are a nicety there, and a request that failed or came
	 * back empty shows nothing rather than canned prompts pretending the model
	 * suggested them.
	 */
	suggestedActions?: QuickAction[];
	/**
	 * The question `ask_user` is waiting on, when the panel is the surface for it.
	 *
	 * It renders at the tail rather than in `messages` because it is not a
	 * transcript entry yet: nothing has been decided, and the record only exists
	 * once the tool returns. The broker escalates to a dialog instead when the
	 * panel is not on screen, in which case this stays absent.
	 */
	pendingQuestion?: AskUserRequest | null;
	/** Further questions behind {@link pendingQuestion}; the card names the count. */
	queuedQuestions?: number;
	onAnswerQuestion?: (id: string, answers: AskUserAnswer[]) => void;
	onDismissQuestion?: (id: string) => void;
}

/**
 * Index of the message still streaming in — the last entry, because
 * `ChatApp` appends the in-flight message after the settled transcript.
 * Its text stays plain until the turn settles; see `markdownPolicy.ts`.
 *
 * Only an assistant entry can be the streaming one. Before the first token
 * arrives `isStreaming` is already true while the transcript still ends on the
 * user's own prompt; treating that as in-flight marked the user's message
 * `aria-busy` and — the visible part — downgraded it to plain text, so it
 * re-rendered as Markdown (and reflowed) the moment the real answer showed up.
 * The typing indicator, not the user's words, is what fills that gap.
 */
function streamingIndex(isStreaming: boolean, messages: AgentMessage[]): number | null {
	if (!isStreaming || messages.length === 0) {
		return null;
	}
	if (messages[messages.length - 1]?.role !== "assistant") {
		return null;
	}
	return messages.length - 1;
}

/**
 * The one block the model is writing right now, as a row address.
 *
 * A streaming message can hold a finished thinking block and a text block
 * still growing behind it, so "the turn is streaming" alone marks too much:
 * the thinking row would spin for the whole reply. The provider appends blocks
 * in order, so exactly the last block can still be growing.
 *
 * Stated here as an address, not as a predicate, because two unrelated things
 * need the same answer — the caret and spinner on the row itself, and the fold
 * planner's refusal to swallow a call that is still running — and a rule
 * written twice is a rule that drifts. `null` on a settled transcript, where
 * no block is live no matter what.
 */
function liveRowRef(messages: AgentMessage[], activeIndex: number | null): TraceRowRef | null {
	const message = activeIndex === null ? undefined : messages[activeIndex];
	if (activeIndex === null || !message || message.role !== "assistant") {
		return null;
	}
	return { message: activeIndex, block: message.content.length - 1 };
}

/**
 * The one reply that may be regenerated — the newest assistant turn.
 *
 * Regenerating rewinds the conversation to the question behind the reply, so
 * offering it on an older reply discards every turn that followed. The control
 * read as "ask again" and behaved as "cut the conversation here", with no
 * confirmation and no way back, so it is confined to the turn where rewinding
 * costs exactly the reply the button sits on.
 *
 * Walks backwards rather than checking the last index, because tool results and
 * harness output can trail the reply — anchoring on the last entry would hide
 * the action on the very turn a failed tool call makes worth retrying.
 *
 * A user turn found first means the newest question has no answer yet: the
 * previous reply is no longer the tail, and rewinding to it would take that
 * unanswered question down with it.
 */
function regenerableIndex(messages: AgentMessage[]): number | null {
	for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
		const role = messages[cursor]?.role;
		if (role === "assistant") {
			return cursor;
		}
		if (role === "user") {
			return null;
		}
	}
	return null;
}

/**
 * Whether the reply at `index` is the last of its turn.
 *
 * A turn that calls tools leaves several assistant entries behind — one per
 * model call — and the actions row is a turn-level affordance: copy/insert
 * under a mid-turn "let me look" would offer half a process sentence. The walk
 * forward answers the question at the first entry that can: another reply means
 * this one is still mid-turn, a question means the turn has closed, and the
 * end of the transcript closes it too.
 */
function closesTurn(messages: AgentMessage[], index: number): boolean {
	for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
		const role = messages[cursor]?.role;
		if (role === "assistant") {
			return false;
		}
		if (role === "user") {
			return true;
		}
	}
	return true;
}

/**
 * The one question that may be edited and resent — the newest answered turn.
 *
 * Editing a question rewinds the conversation to just before it, so the same
 * constraint that keeps {@link regenerableIndex} to one reply keeps this to the
 * question directly behind it: an edit offered any earlier would discard every
 * turn between it and the tail. The walk back from the reply is what names the
 * turn — tool results and harness output can sit between a question and its
 * answer, and the question is whichever user turn that walk reaches first.
 *
 * No reply at the tail means the newest question is unanswered, and an edit
 * there would discard the question itself; `null` keeps the action hidden.
 */
function editableQuestionIndex(messages: AgentMessage[]): number | null {
	const replyIndex = regenerableIndex(messages);
	if (replyIndex === null) {
		return null;
	}
	for (let cursor = replyIndex - 1; cursor >= 0; cursor -= 1) {
		if (messages[cursor]?.role === "user") {
			return cursor;
		}
	}
	return null;
}

/**
 * The duration stamp a reply earns, when it earns one.
 *
 * Three gates in sequence. The reply must be a run's final word — an
 * intermediate call followed by a tool result is machine traffic the trace rows
 * already narrate ({@link isFinalReply}). It must carry a recorded duration at
 * all — sessions written before the stamp existed read back without one. And it
 * must have taken long enough to be worth saying — a reply that lands in under
 * the threshold answers before the reader has wondered anything.
 *
 * `null` for every reply that fails any gate; the row simply renders without a
 * stamp and nothing about the layout changes.
 */
function replyTimingFor(messages: AgentMessage[], index: number): { durationMs: number; startedAt: number } | null {
	const message = messages[index];
	if (!message || !isFinalReply(messages, index)) {
		return null;
	}
	const durationMs = replyDurationMs(message);
	if (durationMs === null || !durationBadgeVisible(durationMs)) {
		return null;
	}
	return { durationMs, startedAt: message.timestamp };
}

/**
 * Whether the turn has been accepted but produced nothing to look at yet.
 *
 * The gap this covers is the one a reader reports as "it ignored me": the prompt
 * lands, the transcript ends on their own message, and the only sign anything
 * happened is a control at the other end of the panel. The wait is a first-token
 * latency the plugin does not control, so it is filled rather than hidden.
 *
 * False as soon as *anything* is visible — a token, a thought, a tool row — so
 * the placeholder never sits under content that has already answered the same
 * question. `toolsRunning` is passed in for that reason: the running-tools line
 * directly above is already the progress report.
 */
function awaitsFirstToken(messages: AgentMessage[], isStreaming: boolean, toolsRunning: boolean): boolean {
	if (!isStreaming || toolsRunning) {
		return false;
	}
	const latest = messages[messages.length - 1];
	return !latest || latest.role !== "assistant" || !hasVisibleContent(latest);
}

/**
 * Whether an assistant turn has produced anything: prose, a thought, a call.
 *
 * Asks {@link blockIsVisible} with agent details forced on, because the
 * question here is whether the *turn* got going rather than whether this
 * transcript draws the block. A turn whose one call is `ask_user` has got going
 * — the question card is on screen — and the typing indicator would otherwise
 * sit underneath it claiming nothing had happened yet.
 */
function hasVisibleContent(message: AssistantMessage): boolean {
	return message.content.some((block) => blockIsVisible(block, true));
}

/**
 * The reply, before it has any words.
 *
 * A typing indicator in the assistant's own position rather than a line of
 * chrome somewhere else, because its job is to hold the place the answer will
 * appear in — the reader's eye is already there. It reads as "the other side is
 * typing", the way a chat app signals that without labelling the wait, so it
 * never says "Piem is replying" in the visible transcript. It is replaced by the
 * real turn on the first token, so it never stacks with content.
 *
 * Not a live region: the settled turn is announced once by {@link TurnAnnouncer},
 * and announcing the start as well would make a screen reader interrupt the user
 * to say that nothing had happened yet. `aria-label` covers it for anyone
 * navigating the transcript by hand, since the dots themselves are decorative.
 */
function PendingReply(): React.JSX.Element {
	const t = useT();
	return (
		<article
			className="piem-chat__message piem-chat__message--assistant piem-chat__message--pending"
			aria-label={t.t("chat.replyingAria")}
			aria-busy={true}
			onMouseOver={suppressOwnTooltip}
		>
			<TypingDots />
		</article>
	);
}

/**
 * Three dots that say "still going" without saying what.
 *
 * Shared by the pending reply and the running-tools row. They are one signal in
 * two seats — before the first token, and while a tool is out — and the panel
 * shows them in the same place, so drawing them from two copies of the markup was
 * an invitation to drift.
 *
 * Always `aria-hidden`: each caller carries its own words for a screen reader (a
 * label on the reply, a live line beside the tools), and three empty spans have
 * nothing of their own to announce.
 */
function TypingDots(): React.JSX.Element {
	return (
		<span className="piem-chat__typing" aria-hidden="true">
			<span className="piem-chat__typing-dot" />
			<span className="piem-chat__typing-dot" />
			<span className="piem-chat__typing-dot" />
		</span>
	);
}

export function MessageList({
	messages,
	isStreaming,
	pendingToolCalls,
	unpersistedMessages,
	isInitializing = false,
	isConfigured = true,
	showAgentDetails = false,
	traceExpand = DEFAULT_TRACE_EXPAND,
	onOpenSettings,
	onRetry,
	onEditMessage,
	onFork,
	app,
	component,
	sourcePath,
	composerAnchorId,
	hasActiveNote = false,
	isCompacting = false,
	compactionEvent = null,
	compactionRetained = 0,
	onQuickAction,
	suggestedActions = [],
	pendingQuestion = null,
	queuedQuestions = 0,
	onAnswerQuestion,
	onDismissQuestion,
}: MessageListProps): React.JSX.Element {
	const t = useT();
	const activeIndex = streamingIndex(isStreaming, messages);
	/*
	 * Both of these are derived once per render rather than memoized, matching
	 * the index walks above and below: the transcript array is a new identity on
	 * every streamed token, so a memo keyed on it would recompute anyway.
	 */
	const liveRow = liveRowRef(messages, activeIndex);
	/*
	 * The calls still out, as a set the rows can query. Derived here rather than
	 * per row so a transcript of two hundred rows does not scan the pending list
	 * two hundred times, and derived from ids rather than names because two
	 * concurrent `read` calls are two rows with one name between them.
	 */
	const runningToolCalls = new Set(pendingToolCalls.map((pending) => pending.id));
	// Pairs first: the fold planner reads them, because a call whose result failed
	// has to break a run the same way the failure itself always has.
	const pairPlan = planToolPairs(messages);
	const foldPlan = planTraceFolds(messages, { mode: traceExpand, showAgentDetails, pairs: pairPlan });
	const compactionPlan = planCompactionRows({ messages, event: compactionEvent, retained: compactionRetained });
	const context: MessageContext = { app, component, sourcePath, showAgentDetails, traceExpand, foldPlan, pairPlan, liveRow, runningToolCalls, t };
	const regenerateIndex = regenerableIndex(messages);
	const editIndex = editableQuestionIndex(messages);
	/*
	 * Empty-screen suggestions exist for the configured, ready state only — the
	 * connect-model branch has its one call to action, and the skeleton has
	 * nothing to suggest yet. The model's answer replaces the built-ins when it
	 * arrives; until then the built-ins are what the reader sees, which is what
	 * keeps a slow or failed suggestion request from costing the empty screen
	 * its call to action.
	 */
	const emptyActions =
		!onQuickAction || isInitializing || !isConfigured
			? []
			: suggestedActions.length > 0
				? suggestedActions
				: emptyScreenQuickActions(hasActiveNote, t);
	/*
	 * Follow-ups exist only for a settled conversation. While anything is in
	 * flight the newest entry is not an answer the reader can react to yet, and
	 * a row that flickers in and out around each turn reads as noise. They come
	 * from the model alone — no built-in stand-ins, because a suggestion after a
	 * reply is a nicety, and an empty row states that honestly.
	 */
	const settledIndex = !isStreaming && !isCompacting && pendingToolCalls.length === 0 ? regenerateIndex : null;
	const followUpActions = !onQuickAction || settledIndex === null ? [] : suggestedActions;
	const transcriptRef = useRef<HTMLElement | null>(null);
	const shouldFollowRef = useRef(true);
	const [isAtLatest, setIsAtLatest] = useState(true);

	useEffect(() => {
		const transcript = transcriptRef.current;
		if (!transcript || !shouldFollowRef.current) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			transcript.scrollTop = transcript.scrollHeight;
		});
		return () => window.cancelAnimationFrame(frame);
		// The pending question joins the dependency list for the same reason the
		// running tools do: it changes the transcript's height, and a question that
		// arrived below the fold is a question the reader never answers.
	}, [messages, pendingToolCalls, isStreaming, pendingQuestion]);

	const updateFollowState = (): void => {
		const transcript = transcriptRef.current;
		if (!transcript) {
			return;
		}
		const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
		const atLatest = distanceFromBottom < 72;
		shouldFollowRef.current = atLatest;
		setIsAtLatest(atLatest);
	};

	const scrollToLatest = (): void => {
		const transcript = transcriptRef.current;
		if (!transcript) {
			return;
		}
		shouldFollowRef.current = true;
		setIsAtLatest(true);
		transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
	};

	return (
		<div className="piem-chat__transcript">
			{/*
			 * Bypass Blocks (WCAG 2.4.1). Every reply contributes four action
			 * buttons and every tool call a focusable summary, so a twenty-turn
			 * conversation puts well over a hundred tab stops between the top of
			 * the panel and the composer, with no way around them. Hidden until
			 * focused, so it costs a keyboard user one Tab and everyone else
			 * nothing.
			 *
			 * Omitted while the transcript is empty: a link that skips nothing is
			 * just one more stop.
			 */}
			{composerAnchorId && messages.length > 0 ? (
				<a href={`#${composerAnchorId}`} className="piem-chat__skip-link" onClick={(event) => focusAnchor(event, composerAnchorId)}>
					{t.t("chat.skipToComposer")}
				</a>
			) : null}
			{/*
			 * Not a live region. It used to carry `aria-live="polite"` plus
			 * `aria-relevant="additions text"`, so the streaming message
			 * re-announced on every token — a screen reader read half-words in a
			 * loop. Settled turns are announced once through `TurnAnnouncer` below.
			 */}
			<main
				ref={transcriptRef}
				className="piem-chat__messages"
				role="log"
				aria-label={t.t("chat.conversationAria")}
				aria-busy={isStreaming || isInitializing}
				tabIndex={0}
				onScroll={updateFollowState}
				onMouseOver={suppressOwnTooltip}
			>
				{messages.length === 0 ? (
					<EmptyState
						isInitializing={isInitializing}
						isConfigured={isConfigured}
						onOpenSettings={onOpenSettings}
						quickActions={emptyActions}
						onQuickAction={onQuickAction}
					/>
				) : (
					messages.map((message, index) => (
						<React.Fragment key={index}>
							{/*
							 * The tidying row, drawn at the position the tidy happened rather
							 * than where pi files its summary. See `compactionRow.ts`; the
							 * message it was projected from draws nothing of its own.
							 */}
							{seamRows(compactionPlan, index, context)}
							{compactionDrawsMessage(compactionPlan, index) ? null : (
								<MessageRow
									index={index}
									message={message}
									isStreaming={index === activeIndex}
									renderContext={context}
									replyTiming={replyTimingFor(messages, index) ?? undefined}
									onRetry={onRetry && index === regenerateIndex ? () => onRetry(index) : undefined}
									turnCloses={message.role === "assistant" ? closesTurn(messages, index) : undefined}
									/*
									 * The edit hides itself on an unsettled turn too — the resend
									 * truncates the transcript, and a turn still streaming (or
									 * being compacted) is not a tail worth standing on. `onRetry`
									 * leans on its caller for this; the edit owns it, because the
									 * control sits on an *earlier* message than the streaming one
									 * and would otherwise stay live through it.
									 */
									onEdit={
										onEditMessage && index === editIndex && !isStreaming && !isCompacting
											? () => onEditMessage(index)
											: undefined
									}
									onFork={
										onFork && index === regenerateIndex && !isStreaming && !isCompacting ? () => onFork(index) : undefined
									}
									notPersisted={unpersistedMessages?.includes(message)}
								/>
							)}
						</React.Fragment>
					))
				)}
				{/*
				 * A tidy in flight draws at the tail, because that is where "now" is —
				 * and, once it lands, where its own summary row will be. The reader
				 * watching the panel work sees one row change state in place.
				 */}
				{seamRows(compactionPlan, messages.length, context)}
				{/*
				 * The question sits at the tail, below the last thing said and above the
				 * running-tools line — which is where the turn actually is: the tool that
				 * asked is one of the calls that line is reporting, and it is blocked on
				 * this. Inside the scroller rather than docked over the composer, because
				 * "in the stream" is the whole point: it scrolls with the conversation and
				 * the record that replaces it lands in the same place.
				 */}
				{pendingQuestion && onAnswerQuestion && onDismissQuestion ? (
					<AskUserCard
						key={pendingQuestion.id}
						questions={pendingQuestion.questions}
						queued={queuedQuestions}
						onAnswer={(answers) => onAnswerQuestion(pendingQuestion.id, answers)}
						onDismiss={() => onDismissQuestion(pendingQuestion.id)}
					/>
				) : null}
				{pendingToolCalls.length > 0 ? (
					/*
					 * Something is still out — and visibly, that is all this says now.
					 *
					 * It used to name the running tools, from the same table and through
					 * the same function the rows above it use, under a spinner turning at
					 * the same rate as theirs. Two rows, one fact, and the tail was the
					 * copy: the transcript read back to itself. The rows own "which tool,
					 * and is it back" because they are where the tool is; what only a
					 * fixed seat at the bottom can say is that the turn has not finished
					 * even when the row that is working has scrolled out of sight.
					 *
					 * The names stay for the announcement. `role="status"` reports the
					 * text inside the region, so the visually-hidden line is what a
					 * screen reader hears and what changes as tools come and go — the
					 * dots cannot carry that, which is why they are marked decorative
					 * instead of being handed an `aria-label` that would have replaced
					 * the names with a summary.
					 */
					<div className="piem-chat__tool-status" role="status">
						<TypingDots />
						<span className="piem-chat__visually-hidden">
							{t.t("chat.working", {
								tools: pendingToolCalls.map((pending) => describePendingTool(pending, showAgentDetails, t)).join(", "),
							})}
						</span>
					</div>
				) : null}
				{awaitsFirstToken(messages, isStreaming, pendingToolCalls.length > 0) ? <PendingReply /> : null}
				{followUpActions.length > 0 && onQuickAction ? (
					<QuickActions actions={followUpActions} onSelect={onQuickAction} />
				) : null}
			</main>
			{!isAtLatest ? (
				/*
				 * Names the question when one is waiting.
				 *
				 * The card can be scrolled away from — that is the cost of putting it in
				 * the stream instead of pinning it over the composer — and "Latest" does
				 * not tell the reader that the conversation is blocked on something down
				 * there. Same button, same gesture, one accurate label.
				 */
				<button
					type="button"
					className={`piem-chat__latest${pendingQuestion ? " piem-chat__latest--asking" : ""}`}
					onClick={scrollToLatest}
				>
					<ObsidianIcon name={pendingQuestion ? "circle-help" : "arrow-down"} />
					{t.t(pendingQuestion ? "chat.latestQuestion" : "chat.latest")}
				</button>
			) : null}
			{/*
			 * The bypass read backwards. The forward link above fixes the trip
			 * *down*; this one fixes the trip back up, which is the trip a keyboard
			 * user takes more often — nothing sits between the composer and here
			 * that takes focus, so one Shift+Tab lands on it. Same conditions and
			 * same treatment as the forward link: nothing to skip to, nothing to
			 * render, and hidden until focused. The transcript has no id to point
			 * the `href` at (only the composer's is worth threading through state),
			 * so the link focuses it directly — the element is already
			 * `tabIndex={0}`, and the default action is prevented for the same
			 * reason the forward link does not rely on fragment navigation.
			 */}
			{composerAnchorId && messages.length > 0 ? (
				<a
					href="#"
					className="piem-chat__skip-link"
					onClick={(event) => {
						event.preventDefault();
						transcriptRef.current?.focus();
					}}
				>
					{t.t("chat.skipToTranscript")}
				</a>
			) : null}
			<TurnAnnouncer messages={messages} isStreaming={isStreaming} />
		</div>
	);
}

/**
 * Moves focus to the composer, instead of letting the fragment do it.
 *
 * The `href` stays — it is what makes this a link to assistive tech, and what
 * makes Enter activate it — but the default action is not relied on. Obsidian
 * runs in an Electron webview whose document URL it owns, so appending a hash
 * to it is the host's business, not the panel's; and a fragment navigation
 * scrolls to the target without reliably focusing it. Focusing by id is
 * deterministic in both respects.
 */
function focusAnchor(event: React.MouseEvent<HTMLAnchorElement>, anchorId: string): void {
	const target = event.currentTarget.ownerDocument.getElementById(anchorId);
	if (!target) {
		return;
	}
	event.preventDefault();
	target.focus();
}

/**
 * Announces a settled assistant turn once.
 *
 * The transcript itself cannot be the live region: the in-flight message
 * mutates on every token, and `aria-live` on its container makes a screen
 * reader read the partial text again with each delta. This waits for the turn
 * to settle, then publishes the finished text into a dedicated region.
 */
function TurnAnnouncer({ messages, isStreaming }: { messages: AgentMessage[]; isStreaming: boolean }): React.JSX.Element {
	const t = useT();
	const [announcement, setAnnouncement] = useState("");

	useEffect(() => {
		if (isStreaming) {
			return;
		}
		const latest = messages[messages.length - 1];
		if (!latest || latest.role !== "assistant") {
			return;
		}
		setAnnouncement(assistantSpeech(latest, t));
	}, [messages, isStreaming, t]);

	return (
		<p className="piem-chat__visually-hidden" role="status" aria-live="polite" aria-atomic="true">
			{announcement}
		</p>
	);
}

/**
 * What a settled assistant turn is announced as.
 *
 * Thinking and tool calls are excluded by {@link assistantText}: they are
 * mechanical traffic the transcript already collapses, and reading them aloud
 * would bury the answer.
 */
function assistantSpeech(message: AssistantMessage, t: Translator): string {
	const spoken = assistantText(message);
	const cutoff = describeReplyCutoff(message, t);
	if (!cutoff) {
		return spoken;
	}
	// Continues the sentence when there are words to continue, and stands alone
	// when the reply was cut before producing any — the case a reader most needs
	// told, since an otherwise-empty turn announces nothing at all.
	return spoken ? `${spoken} — ${cutoff.spoken}` : cutoff.notice;
}

interface EmptyStateProps {
	isInitializing: boolean;
	isConfigured: boolean;
	onOpenSettings?: () => void;
	/** Suggested first prompts; rendered in the ready branch only. */
	quickActions: QuickAction[];
	onQuickAction?: (prompt: string) => void;
}

/**
 * What the transcript shows before there is a transcript.
 *
 * The unconfigured branch offers a button rather than printing a settings path,
 * and the ready branch names what the agent can actually do — "Start a
 * conversation" alone left the reader to guess that this thing reads and writes
 * notes, and that a selection can be sent from the editor. The suggested
 * prompts below that turn the description into something a tap can start.
 */
function EmptyState({ isInitializing, isConfigured, onOpenSettings, quickActions, onQuickAction }: EmptyStateProps): React.JSX.Element {
	const t = useT();
	if (isInitializing) {
		return (
			<div className="piem-chat__skeleton" role="status" aria-label={t.t("chat.openingChatAria")}>
				{/* Skeleton rather than a spinner in the middle of the content area:
				    the panel loads into a task, so it shows the shape it is about to
				    fill. Announced once via the label; the bars are decorative. */}
				<span className="piem-chat__skeleton-line piem-chat__skeleton-line--short" aria-hidden="true" />
				<span className="piem-chat__skeleton-line" aria-hidden="true" />
				<span className="piem-chat__skeleton-line piem-chat__skeleton-line--medium" aria-hidden="true" />
			</div>
		);
	}
	if (!isConfigured) {
		return (
			<div className="piem-chat__empty">
				<ObsidianIcon name="key-round" className="piem-chat__empty-icon" />
				<p className="piem-chat__empty-title">{t.t("chat.connectModel")}</p>
				{onOpenSettings ? (
					<>
						<p>{t.t("chat.needsApiKey")}</p>
						<button type="button" className="mod-cta piem-chat__empty-action" onClick={onOpenSettings}>
							{t.t("chat.addApiKey")}
						</button>
					</>
				) : (
					<p>
						{t.t("chat.addApiKeyHintBefore")}
						<strong>{t.t("chat.addApiKeyHintPath")}</strong>
						{t.t("chat.addApiKeyHintAfter")}
					</p>
				)}
			</div>
		);
	}
	return (
		<div className="piem-chat__empty">
			<ObsidianIcon name="message-circle" className="piem-chat__empty-icon" />
			<p className="piem-chat__empty-title">{t.t("chat.askAboutVault")}</p>
			<p>
				{t.t("chat.askAboutVaultHintBefore")}
				<strong>{t.t("chat.askAboutVaultHintCommand")}</strong>
				{t.t("chat.askAboutVaultHintAfter")}
			</p>
			{onQuickAction ? <QuickActions actions={quickActions} onSelect={onQuickAction} /> : null}
		</div>
	);
}

interface MessageRowProps {
	/** The message's own position in the transcript; the fold plan is keyed on it. */
	index: number;
	message: AgentMessage;
	isStreaming: boolean;
	renderContext: MessageContext;
	/** Regenerates this reply; supplied only for the newest one. */
	onRetry?: () => void;
	/**
	 * Whether the copy/insert/append row belongs on this reply. A turn with tool
	 * calls leaves several reply entries; only the last of a turn speaks for it,
	 * and a mid-turn "let me look" has no prose worth a note action. Absent on a
	 * streaming row too — that gate lives beside the render.
	 */
	turnCloses?: boolean;
	/** Opens this question in the composer; supplied only for the newest answered one. */
	onEdit?: () => void;
	/**
	 * Forks a new chat that carries everything up to this reply; supplied only
	 * for the newest one, and it travels with the reply's own actions row so the
	 * two turn-level controls sit together.
	 */
	onFork?: () => void;
	/**
	 * The reply's recorded generation duration and stream start, when the
	 * transcript should spend a stamp on it. Resolved upstream — only the final
	 * reply of a run, only past the visibility gate — so this row renders
	 * without re-deriving the transcript's shape.
	 */
	replyTiming?: { durationMs: number; startedAt: number };
	/** Whether this message failed to reach the session log. */
	notPersisted?: boolean;
}

/**
 * One transcript entry.
 *
 * Only the two conversational roles get card chrome. Everything else — tool
 * calls, tool results, harness output, compaction summaries — renders flat, so
 * a card never contains another bordered box.
 */
function MessageRow({
	index,
	message,
	isStreaming,
	renderContext,
	onRetry,
	turnCloses,
	onEdit,
	onFork,
	replyTiming,
	notPersisted,
}: MessageRowProps): React.JSX.Element | null {
	if (message.role === "toolResult") {
		/*
		 * Drawn already, by the call row it answered — see `toolPair.ts`. Checked
		 * before the fold plan because a paired result is not a row at all: leaving
		 * it to the plan would let a fold count it and, when it happens to be a run's
		 * first row, draw the fold's summary at a position nothing occupies.
		 *
		 * `ask_user` never pairs, so its receipt below is unaffected.
		 */
		if (resultIsPaired(renderContext.pairPlan, index)) {
			return null;
		}
		const slot = traceFoldSlot(renderContext.foldPlan, index, null);
		if (slot) {
			// The run's first row draws the summary where it stood; every later
			// member draws nothing, because that summary already speaks for it.
			return slot.head ? <FoldedTrace group={slot.group} context={renderContext} /> : null;
		}
		return <ToolResultTrace message={message} context={renderContext} />;
	}
	if (message.role !== "user" && message.role !== "assistant") {
		return <HarnessTrace message={message} context={renderContext} />;
	}
	const cutoff = replyCutoff(message, renderContext.t);
	/*
	 * An assistant turn with nothing left to draw draws nothing at all. Rendering
	 * it anyway left an empty bubble — above the question card, when the turn was
	 * nothing but the suppressed `ask_user` call, and mid-run once every call the
	 * turn made went into a fold anchored further up. Worse, in the first case it
	 * came with a copy/insert actions row offering to copy no text at all. A stop
	 * notice still earns the row, because that is content of its own.
	 */
	if (message.role === "assistant" && !cutoff && hasNothingToDraw(message, index, renderContext)) {
		return null;
	}
	return (
		/*
		 * No role banner. A two-party conversation in a 300px sidebar identifies its
		 * speakers by side and fill already, and an avatar glyph plus the word "You"
		 * spent a whole line per turn restating what the layout had said — on a
		 * phone that is a visible fraction of the transcript. The accessible name
		 * carries the role instead, so nothing is lost to a screen reader.
		 */
			/*
			 * The bubble is an inner wrapper, not the article itself. The article is
			 * the transcript row — bubble plus the actions row beneath it — so a
			 * role's controls can sit *under* its card instead of inside it, the way
			 * the reply's copy/insert row does. For the assistant the wrapper paints
			 * nothing (see the stylesheet); only the user's turn fills it.
			 */
			<article
				className={`piem-chat__message piem-chat__message--${message.role}`}
				aria-busy={isStreaming}
				aria-label={renderContext.t.t(message.role === "user" ? "chat.you" : "chat.agent")}
				/*
				 * The label is for the screen reader's turn map, not the pointer: the
				 * role is already the first thing the bubble shows, so Obsidian's
				 * native tooltip would restate the visible text on every message,
				 * every turn. Message actions below keep their own tooltips.
				 */
				onMouseOver={suppressOwnTooltip}
			>
				<div className="piem-chat__bubble">
					<div className="piem-chat__message-content">{renderMessageContent(message, { index, isStreaming, renderContext })}</div>
					{cutoff ? (
						cutoff.raw !== undefined ? (
							/*
							 * The failure pill — the classified sentence IS the summary, and
							 * the provider's untouched words are what opens. The raw text used
							 * to sit in a second, unstyled disclosure below the notice; it was
							 * a sibling rather than a child only because `<details>` is not
							 * phrasing content and could not live inside the notice's `<p>`,
							 * and the stray row read as a repeat of the report above it. The
							 * transcript now reports a failed turn the same way it reports a
							 * failed tool call: one row, opened on demand.
							 *
							 * Closed by default and uncapped when open — the height cap the
							 * banner needed was a consequence of sitting *above* the
							 * transcript, and a reader who opened it asked for all of it.
							 *
							 * An empty `raw` renders flat rather than as an empty disclosure:
							 * a pill that opens onto nothing is the one dishonesty this row
							 * must not commit, and the `unknown` sentence ("did not say why")
							 * already carries that news itself.
							 */
							<Trace
								icon={cutoff.icon}
								name={cutoff.notice}
								className="piem-chat__trace--failed"
								body={cutoff.raw ? <p className="piem-chat__cutoff-raw">{cutoff.raw}</p> : null}
							/>
						) : (
							/*
							 * A stopped or truncated reply has nothing behind its line, so it
							 * stays the flat paragraph it always was — no disclosure affordance
							 * pointing at nothing.
							 */
							<p className={`piem-chat__interrupted piem-chat__interrupted--${cutoff.kind}`}>
								<ObsidianIcon name={cutoff.icon} className="piem-chat__interrupted-icon" />
								{cutoff.notice}
							</p>
						)
					) : null}
					{/*
					 * The only report in this panel about loss the reader cannot undo, so
					 * the only one with no dismiss control: the reply is on screen and not
					 * on disk, and it will be absent after a reload with no gap where it
					 * was. It used to be a dismissible grey line at the top of the panel,
					 * ranked below "Nothing to tidy up yet." and cleared by the next send —
					 * so the warning about the reply about to be lost was destroyed by the
					 * act of continuing the conversation.
					 *
					 * Muted, not red. Position and permanence carry the weight here; the
					 * red glyph is spent on the failure that has a retry.
					 *
					 * It carries its own copy button rather than leaning on the reply
					 * actions below, which are hover-revealed on desktop: a reader told
					 * their words are unsaved should not have to discover the control that
					 * rescues them. The adapter's own error text is not here — it goes to
					 * the log, and there is nothing in it the reader can act on. What they
					 * can act on is this button.
					 */}
					{notPersisted ? (
						<UnsavedWarning text={message.role === "assistant" ? assistantText(message) : userText(message)} />
					) : null}
				</div>
				{message.role === "assistant" && !isStreaming && turnCloses !== false ? (
					<ReplyActions
						app={renderContext.app}
						text={assistantText(message)}
						durationMs={replyTiming?.durationMs}
						startedAt={replyTiming?.startedAt}
						onRetry={onRetry}
						/*
						 * The fork action lives here, not under the user's question
						 * (issue #273): it answers "I want to carry this exchange
						 * elsewhere", the same urge the regenerate button next to it
						 * answers. The map already pinned the reply's index into this
						 * callback; the service copies the conversation up to it.
						 */
						onFork={onFork}
						failed={cutoff?.kind === "failed"}
					/>
				) : null}
				{message.role === "user" && onEdit ? (
					/*
					 * Rendered controls, mirroring the reply's actions row; the
					 * stylesheet reveals them on hover where hover exists and keeps
					 * them visible on touch. They sit under the bubble — outside the
					 * card, in the row the article owns — so the two roles read the
					 * same way. The fork action does not ride this row anymore
					 * (issue #273): it belongs to the reply it grows from.
					 */
					<div className="piem-chat__message-actions">
						<IconButton icon="pen-line" label={renderContext.t.t("chat.editMessage")} onClick={onEdit} />
					</div>
				) : null}
			</article>
	);
}

/**
 * Whether every block in this turn renders nothing.
 *
 * Two ways a block disappears. It is the `ask_user` call the transcript draws
 * as a question card instead, which {@link blockIsVisible} answers; or it was
 * swallowed by a fold whose summary stands somewhere above. A turn made
 * entirely of either is an empty card, and an empty card is a gap in the
 * transcript the reader cannot account for.
 *
 * Non-empty check first: a message with no content at all is not "nothing left
 * to draw", and `every` on an empty array would call it that.
 */
function hasNothingToDraw(message: AssistantMessage, index: number, context: MessageContext): boolean {
	if (message.content.length === 0) {
		return false;
	}
	return message.content.every((block, blockIndex) => {
		if (!blockIsVisible(block, context.showAgentDetails)) {
			return true;
		}
		const slot = traceFoldSlot(context.foldPlan, index, blockIndex);
		return slot !== null && !slot.head;
	});
}

/**
 * The marker on a message the session log did not take.
 *
 * Either role can carry it. A reply that never reached disk is the obvious case,
 * but a *question* that did not is worse — the transcript will reload missing the
 * words the reader typed, and nothing else in the panel would ever mention it.
 *
 * Its own component because it owns an action, and because the copy path wants
 * the same `notifyActionResult` reporting every other copy control in the panel
 * uses — one place where "copied" and "could not copy" are worded.
 */
function UnsavedWarning({ text }: { text: string }): React.JSX.Element {
	const t = useT();
	return (
		<p className="piem-chat__interrupted piem-chat__interrupted--unsaved">
			<ObsidianIcon name="file-x" className="piem-chat__interrupted-icon" />
			{t.t("chat.persistFailed")}
			{text ? (
				<button
					type="button"
					className="piem-chat__interrupted-action"
					onClick={() => {
						void copyToClipboard(text).then((copied) => notifyActionResult(copied, t.t("replyActions.couldNotCopy")));
					}}
				>
					{t.t("chat.persistFailedCopy")}
				</button>
			) : null}
		</p>
	);}

/**
 * Why an assistant turn stopped early, or `null` when it finished normally.
 *
 * Narrows to the assistant role here so the render site can stay a single
 * expression; a user message never carries a stop reason.
 */
function replyCutoff(message: UserMessage | AssistantMessage, t: Translator): ReplyCutoff | null {
	return message.role === "assistant" ? describeReplyCutoff(message, t) : null;
}

/**
 * The tidying rows planned for one transcript position, usually none.
 *
 * A function rather than inline markup because two call sites need it — every
 * message position, and the tail — and the tail is the one that matters: a tidy in
 * flight has no message to hang on, so without a row after the last message the
 * reader would sit through the wait with nothing on screen saying why.
 */
function seamRows(plan: CompactionPlan, at: number, context: MessageContext): React.JSX.Element[] {
	return compactionRowsAt(plan, at).map((row, order) => (
		<CompactionSeam key={`tidy-${at}-${order}`} row={row} context={context} />
	));
}

/**
 * One tidying attempt, as one row.
 *
 * The transcript's own trace vocabulary — a collapsed row that opens onto what it
 * is about — set across the column as a seam rather than aligned left with the
 * tool rows, because this is the one row that is not something the model did on
 * the reader's behalf: it is the conversation itself being cut. The state changes
 * in place, working to settled, the way a tool call becomes its result.
 *
 * The failure reveals the provider's untouched words in the same treatment the
 * failed-reply pill uses, and a settled summary reveals prose set in the interface
 * font: it is writing about the conversation, not machine output.
 */
function CompactionSeam({ row, context }: { row: CompactionRow; context: MessageContext }): React.JSX.Element {
	return (
		<Trace
			icon={compactionRowIcon(row.state)}
			name={compactionRowLabel(row.state, context.t)}
			className={compactionRowClass(row.state)}
			// Running has nothing behind it yet, so it renders flat — a disclosure
			// that opens onto nothing is the one dishonesty a trace row must not commit.
			body={
				row.body === undefined ? null : row.state === "failed" ? (
					<p className="piem-chat__cutoff-raw">{row.body}</p>
				) : (
					<Block text={row.body} kind="summary" isStreaming={false} context={context} />
				)
			}
			open={traceOpensByDefault(context.traceExpand, "harness", false)}
		/>
	);
}

/**
 * What the render helpers need besides the message itself.
 *
 * `index` is the message's position in the transcript. A content block's fold
 * address is that index paired with its own, and a block cannot name the
 * message it came from, so the pair has to be threaded down to the row.
 */
type RenderArgs = { index: number; isStreaming: boolean; renderContext: MessageContext };

interface MessageContext {
	app: App;
	component: Component;
	sourcePath: string;
	/** Mirrors the user setting; decides tool naming and payload visibility. */
	showAgentDetails: boolean;
	/** Mirrors the user setting; the default open state of every trace row. */
	traceExpand: TraceExpandSetting;
	/**
	 * Which runs of tool traffic are folded, and where each fold draws.
	 *
	 * Resolved once for the whole transcript rather than per row, because a run
	 * crosses message boundaries — a call and its result are never in the same
	 * message — so no single row can work out its own place in one.
	 */
	foldPlan: TraceFoldPlan;
	/**
	 * Which result answered which call, so one invocation draws one row.
	 *
	 * Resolved for the whole transcript for the same reason `foldPlan` is: a call
	 * and its result are never in the same message, so neither row can find the
	 * other on its own.
	 */
	pairPlan: ToolPairPlan;
	/** The block the model is writing right now; see {@link liveRowRef}. */
	liveRow: TraceRowRef | null;
	/**
	 * The call ids pi still has out, straight from `agent.state.pendingToolCalls`.
	 *
	 * A tool row asks this instead of {@link liveRow}, and the difference is not a
	 * refinement — it is a different question. `liveRow` answers "which block is
	 * the model writing", which a turn issuing one call happens to answer
	 * correctly and a turn issuing eight cannot: only the last block matches, so
	 * the other seven read as finished while they are still out. Blocks that have
	 * no id keep `liveRow` — a thought is not a call, and "the last block is still
	 * growing" is exactly right for it.
	 */
	runningToolCalls: ReadonlySet<string>;
	/**
	 * Copy for the render helpers.
	 *
	 * Carried on the context rather than read through {@link useT}: these are
	 * plain functions called during render, not components, so they cannot hold a
	 * hook of their own.
	 */
	t: Translator;
}

function renderMessageContent(message: UserMessage | AssistantMessage, args: RenderArgs): React.ReactNode {
	if (message.role === "user") {
		return renderUserMessage(message, args);
	}
	return renderAssistantMessage(message, args);
}

/**
 * Draws an image content block as the picture it is.
 *
 * The live agent state keeps the bytes the sender handed over — only the
 * persisted log swaps them for placeholder text (`sanitizeMessageForLog`),
 * so a reloaded session has no image block to draw and falls back to that
 * text line with nothing extra here. The data URI is the same shape the
 * composer's staged thumbnails use; one renderer serves every role that can
 * carry image blocks, so a tool returning a screenshot reads the same way a
 * user-pasted one does.
 */
function ImageBlock({ content, t }: { content: ImageContent; t: Translator }): React.JSX.Element {
	if (!content.data) {
		return <div>{t.t("chat.imagePlaceholder", { mimeType: content.mimeType })}</div>;
	}
	return <img alt={t.t("chat.imageAlt", { mimeType: content.mimeType })} className="piem-chat__image" src={`data:${content.mimeType};base64,${content.data}`} />;
}

interface TextBlockProps {
	text: string;
	kind: TextBlockKind;
	isStreaming: boolean;
	context: MessageContext;
	/** Forwarded to the block's outer element; see `MarkdownTextProps.className`. */
	className?: string;
}

/**
 * Shared text-block entry point. Every branch funnels through here so the
 * Markdown-vs-plain decision lives in exactly one place (`markdownPolicy.ts`).
 */
function Block({ text, kind, isStreaming, context, className }: TextBlockProps): React.JSX.Element {
	return <MarkdownText text={text} kind={kind} isStreaming={isStreaming} app={context.app} component={context.component} sourcePath={context.sourcePath} className={className} />;
}

function renderUserMessage(message: UserMessage, args: RenderArgs): React.ReactNode {
	if (typeof message.content === "string") {
		return <Block text={message.content} kind="user" isStreaming={args.isStreaming} context={args.renderContext} />;
	}
	return message.content.map((content, index) => {
		if (content.type === "text") {
			return <Block key={index} text={content.text} kind="user" isStreaming={args.isStreaming} context={args.renderContext} />;
		}
		return <ImageBlock key={index} content={content} t={args.renderContext.t} />;
	});
}

/**
 * Whether the block at `blockIndex` of message `index` is the one the model is
 * writing right now.
 *
 * A comparison against {@link liveRowRef}'s address rather than a rule of its
 * own: the fold planner is handed the same address to keep a running call out
 * of a fold, and the row and the planner disagreeing about which block is live
 * would show a settled count over a call still in flight.
 */
function isLiveBlock(context: MessageContext, index: number, blockIndex: number): boolean {
	return context.liveRow?.message === index && context.liveRow.block === blockIndex;
}

function renderAssistantMessage(message: AssistantMessage, args: RenderArgs): React.ReactNode {
	const context = args.renderContext;
	return message.content.map((content, blockIndex) => {
		const live = isLiveBlock(context, args.index, blockIndex);
		if (content.type === "text") {
			// The block the model is still writing carries a caret: with no marker,
			// a streaming reply and a finished one differed only by the actions row
			// appearing underneath after the fact.
			return <Block key={blockIndex} text={content.text} kind="assistant" isStreaming={args.isStreaming} context={context} className={live ? "piem-chat__block--live" : undefined} />;
		}
		if (content.type === "thinking") {
			return (
				<Trace
					key={blockIndex}
					icon={live ? "loader-circle" : "brain"}
					name={context.t.t(live ? "chat.thinkingNow" : "chat.thoughtItThrough")}
					className={live ? "piem-chat__trace--thinking piem-chat__trace--live" : "piem-chat__trace--thinking"}
					open={traceOpensByDefault(context.traceExpand, "thinking", false)}
				>
					<Block text={content.thinking} kind="thinking" isStreaming={args.isStreaming} context={context} />
				</Trace>
			);
		}
		/*
		 * `ask_user` draws no call row.
		 *
		 * The question is rendered in full at the tail while it is open, and as a
		 * receipt once it is answered, so a trace row naming the same call would put
		 * one question in the transcript twice — the second time as machine traffic,
		 * which is the vocabulary this whole change moves it out of. Under
		 * `showAgentDetails` the row comes back, because that mode exists to show the
		 * raw payload behind every call and this one has arguments worth reading.
		 *
		 * The rule lives in `traceFold.ts` because the fold planner needs the same
		 * answer: a call that draws nothing must not interrupt a run either, or a
		 * suppressed question would split one fold into two.
		 */
		if (!blockIsVisible(content, context.showAgentDetails)) {
			return null;
		}
		const slot = traceFoldSlot(context.foldPlan, args.index, blockIndex);
		if (slot) {
			return slot.head ? <FoldedTrace key={blockIndex} group={slot.group} context={context} /> : null;
		}
		return <ToolCallTrace key={blockIndex} call={content} result={pairedResult(context.pairPlan, args.index, blockIndex)} context={context} />;
	});
}


interface TraceProps {
	icon: IconName;
	name: string;
	detail?: string;
	className?: string;
	/**
	 * True when `name` is a raw tool id (`get_active_note`) rather than a written
	 * label ("Read a note"). Only an id is set in monospace; the rows whose names
	 * are sentences — thinking, harness output, and every translated tool name —
	 * are set in the interface font.
	 */
	nameIsIdentifier?: boolean;
	/** Revealed content; `null` renders a plain row with no disclosure affordance. */
	body?: React.ReactNode;
	/**
	 * Whether the row is still resolving, for assistive tech.
	 *
	 * The breath is the visual half of this and reaches nobody who cannot see it.
	 * It is `aria-busy` rather than a live region on purpose: dozens of rows can be
	 * out at once, and a region per row would announce a queue nobody asked to
	 * hear. The tail placeholder is the announcement; this is what a reader
	 * arriving at the row itself is told.
	 */
	busy?: boolean;
	/**
	 * The row's initial open state, from the expand mode the reader chose. An
	 * `open` attribute on a `<details>` sets the default, not a lock — the reader
	 * can still close the row by hand, which is why this is passed at render
	 * rather than managed as state: a re-render from a settings change restates
	 * the preference without fighting the reader's clicks.
	 */
	open?: boolean;
	children?: React.ReactNode;
}

/**
 * Class for a trace row's name.
 *
 * Shared by {@link Trace} and {@link ToolResultTrace}, which draw the same row
 * from different data and would otherwise each decide the typeface for
 * themselves.
 */
function traceNameClass(isIdentifier: boolean): string {
	return `piem-chat__trace-name piem-chat__trace-name--${isIdentifier ? "identifier" : "label"}`;
}

/**
 * Collapsed one-line disclosure for machine traffic (tool calls, tool results,
 * thinking, harness output).
 *
 * One vocabulary for all of it: the transcript used to expand raw JSON and full
 * tool output inline while hiding thinking and diffs behind `<details>`, so a
 * single `grep` could bury the model's actual prose. Everything mechanical now
 * collapses to a 1-line row the reader opens on demand.
 */
function Trace({ icon, name, detail, className, nameIsIdentifier = false, body, busy = false, open = false, children }: TraceProps): React.JSX.Element {
	const revealed = body === undefined ? children : body;
	const classes = ["piem-chat__trace", className].filter(Boolean).join(" ");
	const row = (
		<>
			<ObsidianIcon name={icon} className="piem-chat__trace-icon" />
			<span className={traceNameClass(nameIsIdentifier)}>{name}</span>
			{detail ? <span className="piem-chat__trace-detail">{detail}</span> : null}
		</>
	);

	// `undefined` rather than `false` for a settled row: `aria-busy="false"` on
	// every trace in a long transcript is markup that says nothing.
	const ariaBusy = busy ? true : undefined;
	if (!revealed) {
		return (
			<div className={`${classes} piem-chat__trace--flat`} aria-busy={ariaBusy}>
				{row}
			</div>
		);
	}
	return (
		<details className={classes} open={open} aria-busy={ariaBusy}>
			<summary className="piem-chat__trace-summary">{row}</summary>
			<div className="piem-chat__trace-body">{revealed}</div>
		</details>
	);
}

/**
 * One tool invocation, as one row.
 *
 * A component rather than inline markup because a folded run draws the same rows
 * inside its body, from calls belonging to messages other than the one being
 * rendered — so the row cannot be a closure over the turn it came from. It reads
 * its own running state off the context for the same reason: a fold used to hand
 * every row it drew `live={false}`, which was true only while a running call
 * could not be folded.
 *
 * The call and the result used to be a row each, drawing the same name from the
 * same table — so the transcript said "Wrote a note" under a wrench that reports
 * no status, then "Wrote a note" again under a tick that does. Two rows to say
 * one thing, and the two halves the reader wanted (which note, and did it work)
 * split across them with a truncation each.
 *
 * `result` is the message that answered this call, or `null` — and the two ways a
 * row gets there are now told apart. A call pi still has out is running; a call
 * with no result and nothing running behind it is a turn interrupted before the
 * answer arrived, and `circle-slash` is left to mean exactly that. Both used to
 * be one state, so an interrupted call and seven concurrent ones drew the same
 * row.
 *
 * A row that has its result wears `--result` so it keeps the height bound on its
 * body: the call's own payload is a few lines of JSON, but a grep's output is not,
 * and the class that used to carry that bound went with the row this one absorbed.
 */
function ToolCallTrace({
	call,
	result,
	context,
}: {
	call: ToolCall;
	result: ToolResultMessage | null;
	context: MessageContext;
}): React.JSX.Element {
	const showDetails = context.showAgentDetails;
	const running = context.runningToolCalls.has(call.id);
	const diff = result ? extractDiff(result.details) : null;
	const payload = showDetails ? <pre className="piem-chat__text">{JSON.stringify(call.arguments, null, 2)}</pre> : null;
	/*
	 * The result's own body, under the call's payload when both are shown. Order
	 * matters and follows time: what was asked, then what came back.
	 */
	const answer = result ? (
		<>
			{result.content.map((content, index) =>
				content.type === "text" ? (
					<Block key={index} text={content.text} kind="toolResult" isStreaming={false} context={context} />
				) : (
					<ImageBlock key={index} content={content} t={context.t} />
				),
			)}
			{diff ? <Block text={`\`\`\`diff\n${diff}\n\`\`\``} kind="assistant" isStreaming={false} context={context} /> : null}
		</>
	) : null;
	return (
		<Trace
			icon={traceIcon(call.name, running, result)}
			name={describeTool(call.name, showDetails, context.t)}
			nameIsIdentifier={isToolIdentifier(call.name, showDetails)}
			detail={pairedDetail(call, result, diff, context.t)}
			className={traceClasses(running, result)}
			busy={running}
			// A diff-bearing row opens itself under `highValue`: the critique called
			// the undo story the panel's biggest gap, and what an edit changed is the
			// one thing a reader answers by reading rather than by deciding to read.
			// Only a row that has its result can be that row, so a call still out asks
			// the question the call row always asked.
			open={result ? traceOpensByDefault(context.traceExpand, "toolResult", diff !== null) : traceOpensByDefault(context.traceExpand, "toolCall", false)}
			// Without the payload or a result there is nothing behind the row to open,
			// so it renders as a plain line rather than an empty disclosure.
			body={payload || answer ? <>{payload}{answer}</> : null}
		/>
	);
}

/**
 * The one glyph a tool row gets, and the tool keeps it in three of four states.
 *
 * Two states outrank the tool's identity, because each is something the reader
 * has to act on and neither has anything to do with which tool it was: it never
 * came back, or it broke. "It worked" is not one of them — a tick spent the slot
 * restating what the sentence beside it already said — and neither, now, is "it
 * is still going".
 *
 * That last one is the change. A spinner in this slot answered "is it working?",
 * a question the row could answer without the glyph: something is moving. What
 * it could not answer without the glyph is *what the wait is for* — and the wait
 * is the moment that question matters most, because a search and a subagent are
 * seconds and minutes apart. So a running row keeps the tool's own picture and
 * lets the motion carry the state; the hourglass a `wait_subagent` row now shows
 * is the honest picture of the wait, where the spinner was a picture of nothing.
 */
function traceIcon(name: string, running: boolean, result: ToolResultMessage | null): IconName {
	if (result) {
		return result.isError ? "alert-triangle" : toolIcon(name);
	}
	// No result, for one of two reasons the row must not blur: pi still has the
	// call out, or the turn ended without ever answering it.
	return running ? toolIcon(name) : "circle-slash";
}

/** Modifier classes for a paired row: the body bound, the failure tint, the breath. */
function traceClasses(running: boolean, result: ToolResultMessage | null): string | undefined {
	const classes = [
		result ? "piem-chat__trace--result" : null,
		result?.isError ? "piem-chat__trace--error" : null,
		running ? "piem-chat__trace--running" : null,
	].filter(Boolean);
	return classes.length > 0 ? classes.join(" ") : undefined;
}

/**
 * What a paired row shows without being opened.
 *
 * The argument, because "which note" is the question a collapsed tool row exists
 * to answer — and it is the call's half, which is why absorbing the result must
 * not cost it. A write's diff counts join it in front: they are the one thing the
 * result knew that the call could not, they are four characters, and they are
 * worthless clipped where a path is still legible clipped.
 *
 * A success's own summary sentence ("Successfully wrote 887 bytes to …") does not
 * appear. It restates the name, the argument and the tick — every part of it is
 * already on the row — and it was the reason the old result row truncated the one
 * thing it could have told the reader.
 *
 * A failure's does, and takes the whole line. "Why not" outranks "which note" the
 * moment there is a why-not: the glyph says something went wrong and the detail is
 * the only place the row can say what, whereas an argument the reader can no
 * longer act on is worth less than the sentence naming what to fix. The messages
 * these tools return name the path themselves when it is the path that was wrong.
 */
function pairedDetail(call: ToolCall, result: ToolResultMessage | null, diff: string | null, t: Translator): string {
	if (result?.isError) {
		return summarizeToolResult(result, t);
	}
	const argument = summarizeToolPayload(call.arguments);
	const counts = diff ? formatDiffCounts(diff) : "";
	if (counts && argument) {
		return t.t("traceTool.detailPair", { counts, argument });
	}
	return counts || argument;
}

/**
 * A tool result, collapsed.
 *
 * When the tool attached a diff, the summary carries the `+N -M` counts and the
 * body shows the diff itself — previously the diff sat in a second `<details>`
 * nested inside an always-expanded result block.
 */
function ToolResultTrace({ message, context }: { message: ToolResultMessage; context: MessageContext }): React.JSX.Element {
	/*
	 * The one tool result that is not machine traffic.
	 *
	 * Everything else in this row is something the agent did and the reader may
	 * want to audit; an `ask_user` result is something the *reader* decided, and
	 * folding a decision behind a disclosure summary buries the most human entry in
	 * the transcript. It renders open, as a record. An unreadable payload — an
	 * older session file, a hand edit — falls through to the ordinary row rather
	 * than to an empty one.
	 */
	if (message.toolName === ASK_USER_TOOL && !message.isError) {
		const outcome = askUserOutcome(message.details);
		if (outcome) {
			return <AskUserReceipt answers={outcome.answers} dismissed={outcome.dismissed} />;
		}
	}
	const diff = extractDiff(message.details);
	const classes = ["piem-chat__trace", "piem-chat__trace--result", message.isError ? "piem-chat__trace--error" : null].filter(Boolean).join(" ");
	const detail = diff ? formatDiffCounts(diff) : summarizeToolResult(message, context.t);
	return (
		// A diff-bearing result opens itself: the critique called the undo story
		// the panel's biggest gap, and this is the previewable half of the answer
		// (C option) — what the tool changed should be visible without a second
		// interaction, while the call row above it stays closed. The expand mode
		// sits on top of that: `highValue` keeps exactly this behaviour, and
		// `expanded` opens the rest of the traffic besides.
		<details
			className={classes}
			open={traceOpensByDefault(context.traceExpand, "toolResult", diff !== null)}
		>
			<summary className="piem-chat__trace-summary">
				<ObsidianIcon name={message.isError ? "alert-triangle" : toolIcon(message.toolName)} className="piem-chat__trace-icon" />
				<span className={traceNameClass(isToolIdentifier(message.toolName, context.showAgentDetails))}>
					{describeTool(message.toolName, context.showAgentDetails, context.t)}
				</span>
				{detail ? <span className="piem-chat__trace-detail">{detail}</span> : null}
			</summary>
			<div className="piem-chat__trace-body">
				{message.content.map((content, index) => {
					if (content.type === "text") {
						return <Block key={index} text={content.text} kind="toolResult" isStreaming={false} context={context} />;
					}
					return <ImageBlock key={index} content={content} t={context.t} />;
				})}
				{diff ? <Block text={`\`\`\`diff\n${diff}\n\`\`\``} kind="assistant" isStreaming={false} context={context} /> : null}
			</div>
		</details>
	);
}

/**
 * A run of consecutive tool traffic, drawn as one row.
 *
 * The summary says what the run did by category; the body holds the very rows
 * it replaced, so the fold costs a click rather than the detail. That is the
 * whole trade: a turn that read six notes wrote twelve rows of machine traffic
 * around one paragraph of prose, and none of those rows was individually the
 * problem.
 *
 * Keyed on each row's transcript address rather than the tool call id, which a
 * session file replayed from another build is not guaranteed to keep unique.
 */
function FoldedTrace({ group, context }: { group: TraceFoldGroup; context: MessageContext }): React.JSX.Element {
	/*
	 * Whether anything inside is still out. One bit, not a count: the summary
	 * beside it already says how many calls the fold swallowed, and "6 of 8 back"
	 * is a progress report a reader did not ask a folded row for. What they ask a
	 * folded row is whether this stretch of the turn is done, and the breath
	 * answers exactly that — one animation for however many calls are behind it,
	 * which is the whole reason the running calls are allowed to fold now.
	 */
	const running = group.rows.some((row) => row.kind === "call" && context.runningToolCalls.has(row.call.id));
	return (
		<Trace
			icon={GENERIC_TOOL_ICON}
			name={describeTraceFold(group.tallies, context.t)}
			className={running ? "piem-chat__trace--fold piem-chat__trace--running" : "piem-chat__trace--fold"}
			busy={running}
			/*
			 * The rows it swallowed, paired the same way the transcript pairs them —
			 * so opening a fold shows what the reader would have seen unfolded, and a
			 * run of three writes is three rows inside rather than six.
			 *
			 * A result whose call is paired is dropped rather than drawn: its call is
			 * in this body too (a run is consecutive tool traffic, and a call is what
			 * starts one), and it already carries the result. A result whose call is
			 * *not* paired stayed a row of its own upstream, so it stays one here.
			 */
			body={group.rows
				.filter((row) => row.kind === "call" || !resultIsPaired(context.pairPlan, row.ref.message))
				.map((row) =>
					row.kind === "call" ? (
						<ToolCallTrace
							key={`${row.ref.message}:${row.ref.block}`}
							call={row.call}
							result={pairedResult(context.pairPlan, row.ref.message, row.ref.block ?? -1)}
							context={context}
						/>
					) : (
						<ToolResultTrace key={`${row.ref.message}:result`} message={row.result} context={context} />
					),
				)}
		/>
	);
}

/** `+N -M` counts for a diff, matching what the collapsed summary used to show. */
function formatDiffCounts(diff: string): string {
	const { added, removed } = countDiffLines(diff);
	return `+${added} -${removed}`;
}

/**
 * Pulls the diff a write/edit tool attached to its result details.
 *
 * `details` is untyped on `ToolResultMessage`, and every other tool leaves it
 * without a diff field, so anything that is not a non-empty string is treated
 * as "no diff to show".
 */
function extractDiff(details: unknown): string | null {
	if (!details || typeof details !== "object") {
		return null;
	}
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" && diff.length > 0 ? diff : null;
}

/**
 * Harness message variants the chat panel does not model as conversation
 * (bashExecution, custom, branchSummary). These arrive via pi-agent-core's
 * `CustomAgentMessages` declaration merging.
 *
 * They render as traces, never as assistant messages: labelling harness output
 * "Piem" would attribute machine text to the model.
 */
function HarnessTrace({ message, context }: { message: AgentMessage; context: MessageContext }): React.JSX.Element | null {
	const rendered = renderHarnessBody(message, context);
	if (!rendered) {
		return null;
	}
	return (
		<Trace
			icon={harnessIcon(message.role)}
			name={harnessLabel(message.role, context.t)}
			className="piem-chat__trace--harness"
			open={traceOpensByDefault(context.traceExpand, "harness", false)}
		>
			{rendered}
		</Trace>
	);
}

function renderHarnessBody(message: AgentMessage, context: MessageContext): React.ReactNode {
	if (message.role === "bashExecution") {
		return <Block text={`$ ${message.command}\n${message.output}`} kind="harness" isStreaming={false} context={context} />;
	}
	// Prose the model wrote about the conversation, not a transcript: it is set in
	// the interface font like any other writing. `harness` below stays monospace
	// because bash output only lines up in a fixed pitch.
	if (message.role === "branchSummary") {
		return <Block text={message.summary} kind="summary" isStreaming={false} context={context} />;
	}
	if (message.role === "custom") {
		if (typeof message.content === "string") {
			return <Block text={message.content} kind="harness" isStreaming={false} context={context} />;
		}
		return message.content.map((content, index) => {
			if (content.type === "text") {
				return <Block key={index} text={content.text} kind="harness" isStreaming={false} context={context} />;
			}
			return <ImageBlock key={index} content={content} t={context.t} />;
		});
	}
	return null;
}

/**
 * Human-readable label for a non-conversational role.
 *
 * Unknown roles report as "System", never "Piem": the old default returned the
 * model's own name for anything unrecognized, so harness-injected messages were
 * presented as words the model had said.
 */
function harnessLabel(role: string, t: Translator): string {
	if (role === "bashExecution") {
		return t.t("chat.rowLabelCommand");
	}
	if (role === "branchSummary") {
		return t.t("chat.rowLabelSummary");
	}
	return t.t("chat.rowLabelSystem");
}

function harnessIcon(role: string): IconName {
	return role === "bashExecution" ? "terminal" : "info";
}
