import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Component } from "obsidian";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ChatSnapshot, ObsidianAgentService } from "../agent/ObsidianAgentService";
import type { SuggestionScope } from "../agent/quickActionSuggestionRequest";
import type { QuickAction } from "./quickActionSuggestions";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import { type DraftStore } from "../session/DraftStore";
import { snapshotSubagents, snapshotsForOwner, type SubagentSnapshot } from "../subagent/inspectorModel";
import type { ChatInputController } from "./ChatInputController";
import { getActiveNotePath } from "./activeNotePath";
import { ChatBanner } from "./ChatBanner";
import { ChatComposer } from "./ChatComposer";
import { ChatHeader } from "./ChatHeader";
import { ChatStatusBar } from "./ChatStatusBar";
import { countRunSteps } from "./chatStatus";
import { ContextGauge } from "./ContextGauge";
import { contextLevel } from "./headerCopy";
import { ContextRow } from "./ContextRow";
import { openForkConfirm } from "./forkConfirmModal";
import { SubagentEntryIcon } from "./SubagentEntryIcon";
import { MessageList } from "./MessageList";
import { ModelSwitcher } from "./ModelSwitcher";
import { ThinkingLevelSelector } from "./ThinkingLevelSelector";
import { appendToDraft } from "./noteReference";
import { userText } from "./messageActions";
import { canOpenPluginSettings, openPluginSettings } from "./pluginSettings";
import { getT } from "../i18n";
import { TranslatorProvider } from "./TranslatorContext";
import { useSessionDraft } from "./useSessionDraft";
import { fileToPendingImage, newPendingImageId, toImageContents, type PendingImage } from "./pendingImages";
import type { AskUserBroker, AskUserRequest } from "../tools/askUserBroker";

interface ChatAppProps {
	service: ObsidianAgentService;
	inputController?: ChatInputController;
	/** Parent Obsidian component owning rendered Markdown child components. */
	component: Component;
	/**
	 * Persists unsent composer text per chat. Optional so a test can mount the
	 * panel without touching the vault.
	 */
	draftStore?: DraftStore;
	/**
	 * Reveals the subagent monitor, optionally already showing one run.
	 *
	 * Only the plugin can do this — it owns the workspace leaf — so it arrives as
	 * a callback rather than being reached for here. Absent means no entry icon:
	 * a tree mounted without a workspace (a test) has nowhere to navigate to, and
	 * an icon that led nowhere would be worse than none.
	 */
	onOpenSubagents?: (subagentId?: string) => void;
	/**
	 * Where `ask_user` parks a question the transcript is meant to answer.
	 *
	 * The same object the tool pushes into and the escalation modal settles, so
	 * this panel is one of three parties to it rather than the owner. Absent — a
	 * test mounting the panel without the plugin — simply means no question ever
	 * appears, which is the honest state when nothing can ask one.
	 */
	askUserBroker?: AskUserBroker;
}

export function ChatApp({ service, inputController, component, draftStore, onOpenSubagents, askUserBroker }: ChatAppProps): React.JSX.Element {
	const [snapshot, setSnapshot] = useState<ChatSnapshot>(() => service.getSnapshot());
	// Keyed by session: a half-written question belongs to the chat it was typed
	// in, not to whatever is on screen when the reader comes back.
	const draftScope = snapshot.session?.id;
	const { draft: input, setDraft: setInput, clearDraft } = useSessionDraft(draftStore, draftScope);
	const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
	const [isInitializing, setIsInitializing] = useState(true);
	// Reported upward by the composer, then handed to the transcript so its skip
	// link has something to point at. It travels through state rather than a ref
	// because the link only renders once the id exists.
	const [composerAnchorId, setComposerAnchorId] = useState<string>();
	// Images staged for the next send. Ephemeral by design (issue #48): they
	// never enter the DraftStore, which persists text per session, so they live
	// only for the turn the user is composing and clear on a successful send.
	const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
	/**
	 * Every subagent the process holds, rebuilt on registry events.
	 *
	 * A second channel alongside the chat snapshot, because the two answer
	 * different questions and change at different moments: the snapshot is this
	 * conversation, and a spawn or a settlement happens inside a tool call the
	 * snapshot has no reason to report.
	 *
	 * Registry-wide, then narrowed to this conversation for the icon below — the
	 * monitor panel is the surface that wants all of them.
	 */
	const [subagents, setSubagents] = useState<readonly SubagentSnapshot[]>([]);
	/**
	 * The question being edited, when the user has armed one: the session it
	 * belongs to, the transcript index it was offered at, the prose it said, and
	 * the draft it displaced. Sending while armed rewrites the conversation from
	 * that turn instead of appending, so the armed state is what the send path
	 * branches on — and what the composer's editing notice is driven by.
	 *
	 * `draftBefore` is restored on cancel, so arming an edit never costs the user
	 * the half-typed thought they set aside to make it.
	 */
	const [editArmed, setEditArmed] = useState<{
		sessionId: string | undefined;
		index: number;
		original: string;
		draftBefore: string;
		/** The stage as the user left it before arming; cancel restores it. */
		imagesBefore: PendingImage[];
	} | null>(null);
	/**
	 * The model-generated quick actions for whichever placement asked last, tagged
	 * with the session they belong to. An empty `actions` means "nothing yet" —
	 * the empty screen keeps its built-in chips in MessageList, the post-reply
	 * row simply stays hidden. Tagged rather than cleared on a session switch
	 * because a clearing effect would race the very fetch this state exists to
	 * serve; hiding by revision comparison cannot.
	 */
	const [suggestions, setSuggestions] = useState<{ revision: number; scope: SuggestionScope; actions: QuickAction[] }>(() => ({
		revision: snapshot.sessionRevision,
		scope: "empty",
		actions: [],
	}));
	// Serializes suggestion requests: the newest call wins, an older one landing
	// late is dropped rather than overwriting it.
	const suggestionRequestRef = useRef(0);
	// The reply row is fetched on a witnessed streaming→settled transition, so
	// opening an old session — already settled — never fires a speculative request.
	const prevStreamingRef = useRef(snapshot.isStreaming);
	const sendPromptRef = useRef<() => void>(() => undefined);
	// Read inside the prefill handler, which is registered once and must not
	// re-register on every keystroke just to see the current draft.
	const inputRef = useRef(input);

	inputRef.current = input;

	// Read inside the staging handler, which must not depend on the snapshot.
	const supportsImagesRef = useRef(snapshot.supportsImages !== false);

	supportsImagesRef.current = snapshot.supportsImages !== false;

	const app = service.getApp();
	// Link-resolution base for rendered Markdown, recomputed per render because
	// reading the workspace is cheap. It is not a render trigger: `MarkdownText`
	// reads it through a ref, so a note switch does not re-render the transcript.
	// What the model is told about is `snapshot.contextRefs`, not this.
	const sourcePath = getActiveNotePath(app);
	const canOpenSettings = canOpenPluginSettings(app);
	// The active note's path from the same refs the context row renders. The
	// boolean variant is derivable, but the path itself is what the empty
	// screen's suggestion effect must key on: a switch from note A to note B
	// never flips presence, yet changes what the chips should be about.
	const activeNotePath = snapshot.contextRefs.find((ref) => ref.kind === "active")?.path ?? null;
	/*
	 * The runs this conversation ordered, which is what the entry icon may count.
	 *
	 * The icon sits inside a conversation and its badge is read as that
	 * conversation's, so a registry-wide count would report a background chat's
	 * fan-out as this chat's — and the popover would then offer rows belonging to a
	 * transcript the reader is not looking at. When this chat has delegated
	 * nothing the icon is absent, even while another chat's children are running:
	 * the honest signal for those is the monitor panel, not a badge here.
	 */
	const ownSubagents = useMemo(
		() => (snapshot.session ? snapshotsForOwner(subagents, snapshot.session.path) : []),
		[subagents, snapshot.session],
	);
	const hasActiveNote = activeNotePath !== null;
	const [ask, setAsk] = useState<{ request: AskUserRequest | null; queued: number }>({ request: null, queued: 0 });

	useEffect(() => {
		const unsubscribe = service.subscribe(setSnapshot);
		// A failed start reports itself through the snapshot now — the service
		// records the reason on the banner instead of rejecting, so there is no
		// local error state to mirror here. This effect only closes the busy
		// window.
		void service.initialize().finally(() => setIsInitializing(false));
		return unsubscribe;
	}, [service]);

	/*
	 * The registry's own subscription, which the service snapshot cannot stand in
	 * for: a spawn and a settlement both land inside a tool call, and neither
	 * moves anything the chat snapshot reports.
	 *
	 * `Date.now()` at snapshot time is what a running child's elapsed time is
	 * measured against, so a row's duration is its age at the last event. Nothing
	 * repaints between events on purpose — a per-second re-render of the composer
	 * to advance one number in a popover nobody has open is the wrong trade, and
	 * the status word beside it already says the run is not over.
	 */
	useEffect(() => {
		const registry = service.getSubagentRegistry();
		const resnapshot = (): void => setSubagents(snapshotSubagents(registry, Date.now()));
		resnapshot();
		return registry.subscribe(resnapshot);
	}, [service]);

	/*
	 * The broker's own subscription, for the same reason the registry needs one:
	 * a question is pushed from inside a tool call, which moves nothing the chat
	 * snapshot reports.
	 *
	 * The queued count is read at the same moment as the head so the two cannot
	 * disagree — a card saying "1 more waiting" beside a head that had already
	 * advanced would be a lie assembled from two reads.
	 */
	useEffect(() => {
		if (!askUserBroker) {
			return;
		}
		const resnapshot = (): void =>
			setAsk({ request: askUserBroker.getPending(), queued: askUserBroker.getQueuedCount() });
		resnapshot();
		return askUserBroker.subscribe(resnapshot);
	}, [askUserBroker]);

	useEffect(() => {
		let cancelled = false;
		void service.listSessions().then((loaded) => {
			if (!cancelled) {
				setSessions(loaded);
			}
		});
		return () => {
			cancelled = true;
		};
		// Keyed on the revision rather than the active session: deleting or renaming
		// a different chat leaves `session.id` untouched, so the list would go stale.
	}, [service, snapshot.sessionRevision]);

	/*
	 * Empty screen: ask the model for chips the moment a blank, settled, configured
	 * panel appears. The built-in chips are already on screen — MessageList falls
	 * back to them — so a failure here changes nothing visible, exactly the
	 * contract that placement was given.
	 *
	 * The fetch is stale-while-revalidate (issue #200): a previous visit's answer
	 * for this note fills the row immediately, the fresh request still goes out,
	 * and its answer replaces the cached one — or, when the request cannot,
	 * whatever is on screen stays. A cached row must not be mistaken for a fresh
	 * answer, which is why the request runs even on a hit rather than short-
	 * circuiting: the chips shown are always at most one request old.
	 */
	useEffect(() => {
		if (!(snapshot.isConfigured ?? false) || isInitializing || snapshot.isStreaming || snapshot.messages.length > 0) {
			return;
		}
		const request = ++suggestionRequestRef.current;
		const cached = service.peekQuickActionSuggestions("empty");
		// The row is reset on every run, cached or not: "stale" means *this* note's
		// previous answer, never the previous note's. Without the miss-side reset,
		// switching to a note with no cache entry left the old note's chips in
		// state — on screen for as long as the fresh request took, forever if it
		// never landed. An empty row is the built-ins' cue in MessageList.
		setSuggestions({ revision: snapshot.sessionRevision, scope: "empty", actions: cached ?? [] });
		void service.suggestQuickActions("empty").then((actions) => {
			if (request !== suggestionRequestRef.current) {
				return;
			}
			// Null is the request's failure shape, not an answer of none: the
			// cached row stays put when there is one, and only a truly unanswered
			// key clears to let the built-in chips back in.
			setSuggestions({ revision: snapshot.sessionRevision, scope: "empty", actions: actions ?? cached ?? [] });
		});
		// Re-runs per session and per active-note change — the *path*, not just a
		// presence flip, so A→B recomputes what the chips are about (issue #168
		// follow-up). The guard above keeps it off a live turn.
	}, [service, snapshot.isConfigured, snapshot.isStreaming, snapshot.messages.length, snapshot.sessionRevision, activeNotePath, isInitializing]);

	/*
	 * Settled reply: clear whatever the previous reply suggested and fetch the
	 * model's follow-ups. A failure resolves to null and stores `[]`, leaving the
	 * row hidden — this placement has no fallback and wants none: a suggestion
	 * after a reply is a nicety, and an empty row states that honestly.
	 */
	useEffect(() => {
		const wasStreaming = prevStreamingRef.current;
		prevStreamingRef.current = snapshot.isStreaming;
		if (!wasStreaming || snapshot.isStreaming || snapshot.isCompacting || snapshot.pendingToolCalls.length > 0 || snapshot.messages.length === 0) {
			return;
		}
		const request = ++suggestionRequestRef.current;
		setSuggestions({ revision: snapshot.sessionRevision, scope: "reply", actions: [] });
		void service.suggestQuickActions("reply").then((actions) => {
			if (request !== suggestionRequestRef.current) {
				return;
			}
			setSuggestions({ revision: snapshot.sessionRevision, scope: "reply", actions: actions ?? [] });
		});
	}, [service, snapshot.isStreaming, snapshot.isCompacting, snapshot.pendingToolCalls.length, snapshot.messages.length, snapshot.sessionRevision]);

	/*
	 * The live placement's chips only: the same `actions` would leak a previous
	 * conversation's row across a session switch (revision tag) or an empty
	 * screen's row into a conversation (scope check), so the pass-through
	 * resolves which placement is on screen before handing anything over.
	 */
	const suggestedActions = useMemo(() => {
		if (suggestions.revision !== snapshot.sessionRevision) {
			return [];
		}
		const emptyPlacement = snapshot.messages.length === 0 && suggestions.scope === "empty";
		const replyPlacement = snapshot.messages.length > 0 && suggestions.scope === "reply";
		return emptyPlacement || replyPlacement ? suggestions.actions : [];
	}, [suggestions, snapshot.messages.length, snapshot.sessionRevision]);

	/*
	 * The run in flight, measured: when this turn was accepted and how many tool
	 * calls it has taken. The start is captured on the streaming edge, so a panel
	 * reopened mid-run — whose first snapshot already streams, with no edge to
	 * witness — reports no measurement rather than one that starts counting from
	 * the wrong moment; the next turn it times is the next turn it saw begin.
	 */
	const prevRunStreamingRef = useRef(snapshot.isStreaming);
	const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
	useEffect(() => {
		const wasStreaming = prevRunStreamingRef.current;
		prevRunStreamingRef.current = snapshot.isStreaming;
		if (!wasStreaming && snapshot.isStreaming) {
			setRunStartedAt(Date.now());
		} else if (!snapshot.isStreaming) {
			setRunStartedAt(null);
		}
	}, [snapshot.isStreaming]);
	const run = useMemo(() => {
		if (runStartedAt === null) {
			return null;
		}
		return {
			startedAt: runStartedAt,
			steps: countRunSteps(snapshot.messages, snapshot.pendingToolCalls.length),
		};
	}, [runStartedAt, snapshot.messages, snapshot.pendingToolCalls.length]);

	/*
	 * The context wall: while occupancy sits in the band where compaction acts
	 * on its own, the banner carries the offer the gauge's popover hides behind
	 * a hover. Derived from the same measurement the gauge colours, so the
	 * notice and the ring can never disagree about where the line is.
	 *
	 * An offer, not an outcome report: it stands until acted on or dismissed,
	 * which is why it does not ride `noticeMessage` — that slot belongs to
	 * things that happened and are read once. It also does not go through
	 * `service.dismissMessages()`: acknowledging a standing state must not be
	 * mistaken for acknowledging an outcome the service reported. Dismissal is
	 * remembered for the session; the next time occupancy *enters* the band —
	 * a session switch, a fresh wall after the earlier offer was acted on — the
	 * offer returns. A compaction pulling occupancy back under the line and a
	 * new turn easing it over again re-arms it the same way, which is correct:
	 * each entry is worth one offer.
	 */
	const [wallDismissed, setWallDismissed] = useState(false);
	const contextWall = useMemo(() => {
		if (!snapshot.contextFill || wallDismissed) {
			return undefined;
		}
		if (contextLevel(snapshot.contextFill) !== "near") {
			return undefined;
		}
		// Both busy states make the button a lie: `compactNow` returns early
		// during a stream, and a second press during an in-flight compaction
		// reads as "nothing to compact" — a wrong report about a request that is
		// actually running. The offer returns when the panel is idle again.
		if (snapshot.isStreaming || snapshot.isCompacting) {
			return undefined;
		}
		return { onTidy: () => void service.compactNow(), onDismiss: () => setWallDismissed(true) };
	}, [snapshot.contextFill, snapshot.isStreaming, snapshot.isCompacting, wallDismissed, service]);

	/*
	 * The crash-recovery offer, derived from the snapshot the service computes
	 * at session load: a run the previous process never finished left the
	 * user's words as the transcript's tail. Standing like the wall — it
	 * describes a state, not an event — so it does not ride `noticeMessage`,
	 * and dismissal goes to `service.dismissInterruptedRun()` rather than the
	 * shared clear: acknowledging an offer must not read as acknowledging an
	 * outcome. Hidden while a stream or compaction holds the panel, the same
	 * reason the wall hides — the service declines the work itself when busy.
	 */
	const recoveryOffer = useMemo(() => {
		// `isRewinding` joins the two busy states for the same reason they are
		// here: the service declines `continue()` during a retry's rewind as well,
		// so an offer standing through it invites a press that cannot land.
		if (!snapshot.canResumeInterrupted || snapshot.isStreaming || snapshot.isCompacting || snapshot.isRewinding) {
			return undefined;
		}
		return { onResume: () => void service.resumeInterruptedRun(), onDismiss: () => service.dismissInterruptedRun() };
	}, [snapshot.canResumeInterrupted, snapshot.isStreaming, snapshot.isCompacting, snapshot.isRewinding, service]);

	/*
	 * Forking a session hands the index the reply row pinned, and the confirm
	 * modal does the gate-keeping. Armed edits let go: after the fork opens the
	 * new chat, the index they stood for names a different transcript. Staged
	 * images go too — the fork switches this panel to a new chat, and pictures
	 * gathered for the old one must not ride along into whatever is typed next.
	 */
	const handleFork = useCallback(
		(index: number): void => {
			openForkConfirm(app, {
				t: getT(snapshot.language),
				onConfirm: () => {
					setEditArmed(null);
					setPendingImages([]);
					return service.forkSessionAt(index).then(() => undefined);
				},
			});
		},
		[app, service, snapshot.language],
	);

	/*
	 * Whether an armed edit still names its turn. A session switch leaves the
	 * state behind but points it at a foreign transcript; a rewind, a compaction,
	 * or a turn absorbed into a summary moves or replaces the message the index
	 * stood for. Rather than chasing each of those with effects, the armed state
	 * is validated against the transcript on every render: the message must still
	 * be a user turn saying exactly what it said when it was armed. Anything else
	 * silently disarms — the editing notice disappears and Send appends again.
	 */
	const activeEdit = useMemo(() => {
		if (!editArmed || editArmed.sessionId !== snapshot.session?.id) {
			return null;
		}
		const message = snapshot.messages[editArmed.index];
		if (message?.role !== "user" || userText(message) !== editArmed.original) {
			return null;
		}
		return editArmed;
	}, [editArmed, snapshot.session?.id, snapshot.messages]);

	/**
	 * Arms the edit on the last answered question: its words go back into the
	 * composer, and the draft they displaced is set aside for the cancel to
	 * restore. Sending then goes through {@link service.editAndResend}.
	 */
	const handleEditMessage = useCallback(
		(index: number): void => {
			const original = userText(snapshot.messages[index]);
			if (!original) {
				return;
			}
			// The original turn's images restage alongside its words: a rewrite
			// that silently dropped the pictures would answer a different
			// question than the one asked. The stage is overwritten rather than
			// merged so the armed edit shows exactly what the resend will carry —
			// and the composer is the one place the user can still unstage one.
			const previous = snapshot.messages[index];
			const priorImages =
				previous && previous.role === "user" && Array.isArray(previous.content)
					? previous.content
							.filter((part): part is ImageContent => part.type === "image")
							.map((part) => ({ id: newPendingImageId(), mimeType: part.mimeType, data: part.data }))
					: [];
			setEditArmed({
				sessionId: snapshot.session?.id,
				index,
				original,
				draftBefore: inputRef.current,
				imagesBefore: pendingImages,
			});
			setInput(original);
			setPendingImages(priorImages);
		},
		[snapshot.messages, snapshot.session?.id, setInput, pendingImages],
	);

	const handleCancelEdit = useCallback((): void => {
		setEditArmed(null);
		setInput(editArmed?.draftBefore ?? "");
		setPendingImages(editArmed?.imagesBefore ?? []);
	}, [editArmed, setInput]);

	/**
	 * Takes a queued mid-run send back into the composer for another pass
	 * (issue #289).
	 *
	 * Appended to whatever is in the draft rather than replacing it: the chip is
	 * pressed after the send already emptied the composer, so in the ordinary
	 * case this simply restores the words — and in the case where the reader has
	 * started typing again, appending is the only outcome that loses nothing.
	 * Same rule, and the same helper, as the note-reference prefill.
	 *
	 * Nothing is armed and no notice appears: unlike an edit of an answered
	 * question, this send has not happened yet, so the result is an ordinary
	 * draft that an ordinary Send will deliver.
	 */
	const handleEditQueuedPrompt = useCallback(
		(id: string): void => {
			const taken = service.removeQueuedPrompt(id);
			if (!taken) {
				return;
			}
			setInput(appendToDraft(inputRef.current, taken.text));
			// Fresh ids, like the transcript's own edit restage: these
			// `ImageContent`s never carried one, and the stage keys off it.
			setPendingImages((staged) => [
				...staged,
				...taken.images.map((image) => ({ id: newPendingImageId(), mimeType: image.mimeType, data: image.data })),
			]);
		},
		[service, setInput],
	);

	const visibleMessages = useMemo(() => {
		if (!snapshot.streamingMessage) {
			return snapshot.messages;
		}
		return [...snapshot.messages, snapshot.streamingMessage];
	}, [snapshot.messages, snapshot.streamingMessage]);

	const sendPrompt = async (): Promise<void> => {
		const prompt = input.trim();
		// A send while the agent answers is allowed: it queues (see the service).
		// The states that still refuse are a compaction with no run behind it —
		// nothing to steer, and a send racing the compactor — a rewind, which
		// holds the turn exclusively, and a panel that has not finished coming up.
		if (!prompt || isInitializing || (snapshot.isCompacting && !snapshot.isStreaming) || snapshot.isRewinding) {
			return;
		}
		const images = toImageContents(pendingImages);
		// The service resolves `false` and banners its own failures, so these
		// awaits "cannot" reject — but each one is also the moment the draft has
		// already been spent. A residual rejection would strand the send silently
		// (words gone, image cards hanging, no banner), so the catch hands the
		// text back before rethrowing for diagnosis.
		const guardedSend = async (send: () => Promise<boolean>): Promise<boolean> => {
			try {
				return await send();
			} catch (error) {
				setInput(prompt);
				throw error;
			}
		};
		if (activeEdit) {
			// An edit cannot apply mid-run — it rewinds the transcript another
			// run is reading — and arming one is blocked while streaming, so a
			// stray send from an edit armed just before the run started waits.
			if (snapshot.isStreaming) {
				return;
			}
			// An armed edit rewrites the conversation rather than appending. Same
			// draft economy as the plain send: the composer empties before the
			// rewind starts (a branch summary can hold the await for seconds, and a
			// draft lingering through it reads as "nothing happened"), and a refusal
			// hands the text back with the edit still armed.
			clearDraft();
			const sent = await guardedSend(() => service.editAndResend(activeEdit.index, prompt, images));
			if (sent) {
				setEditArmed(null);
				setPendingImages([]);
			} else {
				setInput(prompt);
			}
			return;
		}
		if (!snapshot.isConfigured) {
			// Send is disabled without a key, but the ⌘↵ submit command routes through
			// `sendPromptRef` and never sees the button's disabled state. Let it reach
			// the service so it surfaces the error banner, and deliberately skip
			// `clearDraft()` so a request that cannot go out keeps the user's text.
			await service.sendPrompt(prompt, images);
			return;
		}
		clearDraft();
		const sent = await guardedSend(() => service.sendPrompt(prompt, images));
		if (sent) {
			// A successful send consumed the staged images; clear the thumbnails.
			setPendingImages([]);
		} else {
			// Hand the text and images back rather than losing them to a failed
			// request (or a capability-gate block the user can still recover from).
			setInput(prompt);
		}
	};

	const handleAddImages = useCallback(async (files: File[]): Promise<void> => {
		// Stage nothing on a model that cannot take images: the refusal is
		// reported before any bytes are read, rather than at send time after the
		// user believes the pictures are coming along. The send-time gate in the
		// service stays as the backstop for a model switched in between staging
		// and sending. The ref, like `inputRef` above, keeps this handler from
		// re-registering on every snapshot.
		if (!supportsImagesRef.current) {
			service.notifyImagesBlocked();
			return;
		}
		const staged = await Promise.all(files.map((file) => fileToPendingImage(file)));
		setPendingImages((current) => [...current, ...staged]);
	}, [service]);

	const handleRemoveImage = useCallback((id: string): void => {
		setPendingImages((current) => current.filter((image) => image.id !== id));
	}, []);

	sendPromptRef.current = () => {
		void sendPrompt();
	};

	const handleAnchorIdChange = useCallback((id: string | undefined) => setComposerAnchorId(id), []);

	/**
	 * Sends a tapped quick-action prompt as the user's own message.
	 *
	 * The tap is the send — that is what makes the suggestion "quick" — but the
	 * composer draft is deliberately untouched: the user may have half a thought
	 * typed that a suggestion must not overwrite. A send the service declined
	 * (a gate the user can still satisfy, a race with a just-started run) lands
	 * the prompt in the draft instead, so the tap never loses its words.
	 */
	const handleQuickAction = useCallback(
		(prompt: string): void => {
			if (snapshot.isStreaming || snapshot.isCompacting || isInitializing) {
				return;
			}
			// A suggestion the user taps while an edit is armed is a different intent
			// — it appends a new turn, it does not rewrite one. The armed state lets
			// go here so the next composer send appends too; the armed text stays in
			// the draft as ordinary words the user can still send or clear.
			setEditArmed(null);
			void service.sendPrompt(prompt).then((sent) => {
				if (!sent) {
					setInput(prompt);
				}
			});
		},
		[service, setInput, snapshot.isStreaming, snapshot.isCompacting, isInitializing],
	);

	const handleFocusRequested = useCallback(
		(focus: (() => void) | null) => {
			inputController?.setFocusHandler(focus);
		},
		[inputController],
	);

	useEffect(() => {
		if (!inputController) {
			return undefined;
		}
		inputController.setSubmitHandler(() => sendPromptRef.current());
		return () => {
			inputController.setSubmitHandler(null);
		};
	}, [inputController]);

	useEffect(() => {
		if (!inputController) {
			return undefined;
		}
		inputController.setPrefillHandler((text) => {
			// Appends to the current draft instead of replacing it, so a prefill that
			// lands mid-typing never wipes the user's text.
			flushSync(() => {
				setInput(appendToDraft(inputRef.current, text));
			});
			inputController.notifyPrefillCommitted();
		});
		return () => {
			inputController.setPrefillHandler(null);
		};
	}, [inputController]);

	return (
		<TranslatorProvider language={snapshot.language}>
			<div
			className="piem-chat"
			aria-busy={snapshot.isStreaming || snapshot.isCompacting || snapshot.isRewinding || isInitializing}
		>
				<ChatHeader
					app={service.getApp()}
					snapshot={snapshot}
					sessions={sessions}
					onOpenSession={(path) => void service.openSession(path)}
					onNewSession={() => void service.newSession()}
					onRenameSession={(name) => void service.renameSession(name)}
					onDeleteSession={(path) => void service.deleteSession(path)}
					onSearchSessions={(text, options) => service.searchSessions(text, options)}
					onExportSession={
						() =>
							void service.exportSessionAsNote().then((path) => {
								if (!path) {
									return;
								}
								// An exact vault path; `openLinkText` parses `#` and `|` as
								// wikilink syntax, so open through the file API like the
								// context row above does.
								const file = app.vault.getFileByPath(path);
								if (!file) {
									return;
								}
								const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(false);
								void leaf.openFile(file);
							})
					}
					onOpenSettings={canOpenSettings ? () => openPluginSettings(app) : undefined}
				/>

				<ChatBanner
					errorMessage={snapshot.errorMessage}
					errorOpensSettings={snapshot.errorOpensSettings}
					noticeMessage={snapshot.noticeMessage}
					contextWall={contextWall}
					recoveryOffer={recoveryOffer}
					onDismiss={() => service.dismissMessages()}
					onOpenSettings={canOpenSettings ? () => openPluginSettings(app) : undefined}
				/>

				<MessageList
					messages={visibleMessages}
					isStreaming={snapshot.isStreaming}
					pendingToolCalls={snapshot.pendingToolCalls}
					unpersistedMessages={snapshot.unpersistedMessages}
					isInitializing={isInitializing}
					isConfigured={snapshot.isConfigured ?? false}
					showAgentDetails={snapshot.showAgentDetails}
					traceExpand={snapshot.traceExpand}
					onOpenSettings={canOpenSettings ? () => openPluginSettings(app) : undefined}
					onRetry={
						snapshot.isStreaming || snapshot.isCompacting || snapshot.isRewinding
							? undefined
							: (index) => void service.retryFrom(index)
					}
					onEditMessage={
						snapshot.isStreaming || snapshot.isCompacting || snapshot.isRewinding ? undefined : handleEditMessage
					}
					onFork={snapshot.isStreaming || snapshot.isCompacting || snapshot.isRewinding ? undefined : handleFork}
					app={app}
					component={component}
					sourcePath={sourcePath}
					composerAnchorId={composerAnchorId}
					hasActiveNote={hasActiveNote}
					isCompacting={snapshot.isCompacting}
					compactionEvent={snapshot.compactionEvent}
					compactionRetained={snapshot.compactionRetained}
					contextWindow={snapshot.contextFill?.contextWindow}
					onQuickAction={handleQuickAction}
					suggestedActions={suggestedActions}
					pendingQuestion={ask.request}
					queuedQuestions={ask.queued}
					onAnswerQuestion={askUserBroker ? (id, answers) => askUserBroker.answer(id, answers) : undefined}
					onDismissQuestion={askUserBroker ? (id) => askUserBroker.dismiss(id) : undefined}
				/>

				{/*
				 * Between the transcript and the composer, not under the header. It
				 * reports on the conversation above it and explains the state of the
				 * controls below it, and pinning it to the top pushed the first message
				 * down behind numbers the reader had not asked to read first.
				 */}
				<ChatStatusBar isInitializing={isInitializing} isRewinding={snapshot.isRewinding} run={run} retry={snapshot.retryNotice} />

				<ChatComposer
					input={input}
					isEditing={activeEdit !== null}
					onCancelEdit={handleCancelEdit}
					isStreaming={snapshot.isStreaming}
					isCompacting={snapshot.isCompacting}
					isRewinding={snapshot.isRewinding}
					isInitializing={isInitializing}
					isConfigured={snapshot.isConfigured ?? false}
					sendShortcut={snapshot.sendShortcut}
					onInputChange={setInput}
					onSend={() => void sendPrompt()}
					onAbort={() => service.abort()}
					onFocusRequested={handleFocusRequested}
					onAnchorIdChange={handleAnchorIdChange}
					collapsed={snapshot.mobileComposerCollapsed}
					onToggleCollapsed={() => void service.setComposerCollapsed(!snapshot.mobileComposerCollapsed)}
					commands={snapshot.availableCommands}
					modelSwitcher={
						<ModelSwitcher
							// The snapshot already carries every field a `ModelTarget` names,
							// so the switcher reads it directly rather than through a copy
							// this component would have to keep in step.
							target={snapshot}
							onSelect={(modelId) => void service.setActiveModel(modelId)}
							onOpenSettings={canOpenSettings ? () => openPluginSettings(app) : undefined}
						/>
					}
					thinkingSelector={
						<ThinkingLevelSelector
							// Same deal: the snapshot is a `ThinkingTarget` as it stands. The
							// selector hides itself for a model that takes no reasoning
							// parameter, so nothing else has to gate on support. Both this and
							// the switcher stay usable mid-run (issue #252) — the service
							// defers the choice until the run lands.
							target={snapshot}
							onSelect={(level) => void service.setThinkingLevel(level)}
						/>
					}
					pendingImages={pendingImages}
					onAddImages={(files) => void handleAddImages(files)}
					onRemoveImage={handleRemoveImage}
					queuedPrompts={snapshot.queuedPrompts}
					onSteerQueuedPrompt={(id) => void service.steerQueuedPrompt(id)}
					onEditQueuedPrompt={handleEditQueuedPrompt}
					// The words are dropped on the floor on purpose: this is the
					// discard half of the same removal, and the caller's use of the
					// return value is the only difference between the two chips.
					onDiscardQueuedPrompt={(id) => void service.removeQueuedPrompt(id)}
					contextGauge={
						<ContextGauge
							fill={snapshot.contextFill}
							usage={snapshot.usage}
							showAgentDetails={snapshot.showAgentDetails}
							isStreaming={snapshot.isStreaming}
							isCompacting={snapshot.isCompacting}
							onTidy={() => void service.compactNow()}
						/>
					}
					contextRow={
						<ContextRow
							refs={snapshot.contextRefs}
							isFollowingActive={snapshot.isFollowingActiveNote}
							onOpen={(path) => {
								// This is already an exact vault path. `openLinkText` parses `#`
								// and `|` as wikilink syntax, so use the file API instead.
								const file = app.vault.getFileByPath(path);
								if (!file) {
									return;
								}
								const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(false);
								void leaf.openFile(file);
							}}
							onPin={(path) => service.pinContextRef(path)}
							onUnpin={(path) => service.unpinContextRef(path)}
							onSetFollowActive={(follow) => service.setFollowActiveNote(follow)}
							/*
							 * Null rather than an icon that renders null: the row reads this
							 * prop's presence as "something is riding along, stay visible", so
							 * handing it a component that draws nothing would produce an empty
							 * row on every turn that never delegated.
							 */
							trailing={
								onOpenSubagents && ownSubagents.length > 0 ? (
									<SubagentEntryIcon snapshots={ownSubagents} onOpen={onOpenSubagents} />
								) : null
							}
						/>
					}
				/>
			</div>
		</TranslatorProvider>
	);
}
