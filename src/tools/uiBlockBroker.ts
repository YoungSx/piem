import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";

/**
 * The live interactive UI blocks a conversation has on screen, and the two
 * channels through which the user's actions on them reach the agent.
 *
 * The shape here is the one every published agent-UI protocol converged on —
 * MCP Apps, OpenAI's Apps SDK, A2UI — and it rests on one rule:
 *
 *   **A UI instance's lifetime is not the tool call's lifetime.**
 *
 * `present_ui` used to *be* its card: the promise the tool awaited was the
 * card's existence, so returning a result and destroying the view were one
 * operation. Three defects followed from that single coupling, and none of them
 * were reachable without it:
 *
 * - A dashboard could not exist. Anything the user was meant to *read* rather
 *   than submit held the tool call open until they dismissed it.
 * - Inside `codemode`, a card lived at most two minutes. The sandbox deadline
 *   (`codemode/sandbox.ts`) is wall-clock over the whole script, so a human
 *   taking longer than the deadline aborted the pending call, and the abort
 *   path tore the card off the screen mid-interaction.
 * - One card per conversation. The queue presented only each owner's head, so a
 *   card nobody had answered yet blocked every later one behind it.
 *
 * So delivery and interaction are separated. `present` resolves once the card
 * has *mounted* — a sub-second round trip through React, not a wait on a
 * person — and the instance then outlives the call that created it. What the
 * user does afterwards arrives through one of two channels, and which one a
 * script picks is the whole of its contract with the agent:
 *
 * - {@link update} — **state, read on the next turn.** Filter changes, an
 *   expanded row, a selected tab. Stored here, rendered into the next request's
 *   context block, and handed back to the script when it remounts. The agent is
 *   not woken.
 * - {@link sendMessage} — **a new turn, now.** "File it under Projects",
 *   "approve". Routed to the conversation that owns the instance, where it joins
 *   the same queue a typed message would.
 *
 * Not waking the agent for every click is the point of having two channels
 * rather than one. A dashboard whose every keystroke started a turn would be
 * unusable, and a form whose submit did nothing would be broken.
 *
 * What this owns:
 *
 * - **Instance lifetime.** Ends on {@link close}, {@link fail}, session
 *   teardown or {@link clear} — never on a tool call returning.
 * - **Whose instance it is.** Every instance carries its originating
 *   conversation, including those from its subagents, so a card's message
 *   cannot land in a conversation the user merely happens to be reading.
 * - **The state each instance last published**, for the context block and for
 *   the script's own remount.
 * - **Exactly one settle per delivery.** `ready`, `fail`, `close` and `clear`
 *   all drop the waiter before settling it.
 *
 * What it deliberately does not own: the DOM, the script, how a message reaches
 * the agent (a sink is injected), or any opinion about what the state means.
 */

export const OWNER_UNKNOWN = "";

/** A live UI block, as the surfaces see it. */
export interface UIBlockRequest {
	id: string;
	ownerId: string;
	code: string;
	title?: string;
}

export type UIBlockPayload = Record<string, unknown>;

/**
 * What {@link UIBlockBroker.present} resolves with.
 *
 * `delivered` is the honest half of the contract: true means the script ran and
 * the card is on screen, false means it was closed before it got there — a
 * dismissal during mount, or teardown. An init error is not reported here; it
 * rejects, because the model wrote code that does not work and that is a tool
 * failure rather than an outcome.
 */
export interface UIBlockDelivery {
	id: string;
	delivered: boolean;
}

/**
 * How a UI block's message reaches the agent.
 *
 * Injected rather than reached for: the broker is built in the plugin's
 * composition root, before the agent service exists, and it has no business
 * knowing what a conversation or a runtime is. The service registers itself
 * with {@link UIBlockBroker.setMessageSink}; a test supplies a recorder.
 *
 * `ownerId` is the conversation that created the instance, never the one on
 * screen. The sink is expected to deliver there — queueing if that conversation
 * is busy — and to drop the message if that conversation is gone.
 */
export type UIBlockMessageSink = (message: {
	ownerId: string;
	id: string;
	title?: string;
	payload: UIBlockPayload;
}) => void;

export interface UIBlockBrokerOptions {
	logger?: LoggerLike;
	sendMessage?: UIBlockMessageSink;
}

type Listener = () => void;
type Settle = (delivery: UIBlockDelivery) => void;
type Reject = (error: Error) => void;

/** A waiter exists only between `present` and the card's mount. */
interface Waiter {
	settle: Settle;
	reject: Reject;
	detach: () => void;
}

interface Instance {
	request: UIBlockRequest;
	/** Dropped once the card mounts; a live instance has no waiter. */
	waiter: Waiter | null;
	/** Published by `update`, read by the context block and by a remount. */
	state: UIBlockPayload | null;
}

export class UIBlockBroker {
	private readonly listeners = new Set<Listener>();
	private instances: Instance[] = [];
	private nextId = 0;
	private readonly log: LoggerLike;
	private sink: UIBlockMessageSink | undefined;

	constructor(options?: UIBlockBrokerOptions) {
		this.log = (options?.logger ?? NOOP_LOGGER).child("ui_block");
		this.sink = options?.sendMessage;
	}

	/**
	 * Where {@link sendMessage} delivers.
	 *
	 * Set after construction because the agent service is built after the
	 * broker — it takes the broker as a dependency. Replacing a sink is allowed
	 * and is what a reload does.
	 */
	setMessageSink(sink: UIBlockMessageSink | undefined): void {
		this.sink = sink;
	}

	/**
	 * Mounts a UI block for `ownerId` and resolves once it is on screen.
	 *
	 * The returned promise is about *delivery*, not about the user: it settles
	 * when the card reports {@link ready}, which is the next React commit. The
	 * instance then stays live until something closes it, and the tool call that
	 * created it is free to return.
	 *
	 * `signal` covers the mount only. Once the card is live the listener is
	 * detached, because the run's abort firing later must not reach through a
	 * returned tool call and tear down a view the user is still using — that was
	 * the old coupling in its most damaging form.
	 */
	present(
		request: { code: string; title?: string },
		signal?: AbortSignal,
		ownerId: string = OWNER_UNKNOWN,
	): Promise<UIBlockDelivery> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Operation aborted"));
		}

		return new Promise<UIBlockDelivery>((resolve, reject) => {
			const id = `ui-${this.nextId++}`;
			const waiter: Waiter = {
				settle: resolve,
				reject,
				detach: () => undefined,
			};
			const instance: Instance = {
				request: { id, ownerId, code: request.code, title: request.title },
				waiter,
				state: null,
			};

			if (signal) {
				const onAbort = (): void => {
					// Only a still-mounting instance is reachable here: `ready` detaches.
					const removed = this.take(id);
					if (!removed) return;
					this.log.debug("UI block aborted before mount", () => ({ id, ownerId }));
					reject(new Error("Operation aborted"));
					this.notify();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				waiter.detach = () => signal.removeEventListener("abort", onAbort);
			}

			this.instances.push(instance);
			this.log.debug("UI block mounting", () => ({
				id,
				ownerId,
				...(request.title ? { title: request.title } : {}),
				live: this.getLive(ownerId).length,
			}));
			this.notify();
		});
	}

	/**
	 * Every live block in `ownerId`'s transcript, oldest first.
	 *
	 * All of them, not a head: nothing here waits on the user's attention any
	 * more, so there is nothing to serialize. A conversation with a dashboard and
	 * a form open has both on screen.
	 */
	getLive(ownerId: string = OWNER_UNKNOWN): UIBlockRequest[] {
		return this.instances
			.filter((instance) => instance.request.ownerId === ownerId)
			.map((instance) => instance.request);
	}

	/** The state a live block should be remounted with, or `null`. */
	getState(id: string): UIBlockPayload | null {
		return this.instances.find((instance) => instance.request.id === id)?.state ?? null;
	}

	/**
	 * What `ownerId`'s live blocks have published, for the next request's context
	 * block. Empty array when there is nothing to report, which keeps the block
	 * byte-identical to a conversation with no UI at all.
	 */
	getContext(ownerId: string = OWNER_UNKNOWN): { title: string; state: UIBlockPayload }[] {
		const reported: { title: string; state: UIBlockPayload }[] = [];
		for (const instance of this.instances) {
			if (instance.request.ownerId !== ownerId || instance.state === null) continue;
			reported.push({
				title: instance.request.title ?? instance.request.id,
				state: instance.state,
			});
		}
		return reported;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * The card mounted. Settles the delivery and keeps the instance.
	 *
	 * Idempotent: a remount of an already-live instance calls this again and must
	 * not disturb anything.
	 */
	ready(id: string): void {
		const instance = this.find(id);
		if (!instance?.waiter) return;
		const { settle, detach } = instance.waiter;
		instance.waiter = null;
		detach();
		this.log.debug("UI block live", () => ({ id, ownerId: instance.request.ownerId }));
		settle({ id, delivered: true });
	}

	/**
	 * Channel 2 — the user did something the agent has to answer.
	 *
	 * Does not close the instance. A dashboard's button is pressed many times,
	 * and a form that wants to close says so with {@link close}.
	 */
	sendMessage(id: string, payload: UIBlockPayload): void {
		const instance = this.find(id);
		if (!instance) return;
		this.log.debug("UI block message", () => ({
			id,
			ownerId: instance.request.ownerId,
			dataKeys: Object.keys(payload).slice(0, 10),
		}));
		if (!this.sink) {
			this.log.warn("UI block message dropped: no sink", () => ({ id }));
			return;
		}
		this.sink({
			ownerId: instance.request.ownerId,
			id,
			title: instance.request.title,
			payload,
		});
	}

	/**
	 * Channel 1 — state for the next turn, and for this block's own remount.
	 *
	 * No listener notification: the script already rendered whatever changed into
	 * its own DOM, and re-rendering the panel here would remount the card and
	 * destroy the very interaction that called this.
	 */
	update(id: string, state: UIBlockPayload): void {
		const instance = this.find(id);
		if (!instance) return;
		instance.state = state;
		this.log.debug("UI block state updated", () => ({
			id,
			ownerId: instance.request.ownerId,
			stateKeys: Object.keys(state).slice(0, 10),
		}));
	}

	/**
	 * Closes a live block. Settles a delivery that never landed as `delivered:
	 * false`, which is the honest report for a card dismissed while mounting.
	 */
	close(id: string): void {
		const instance = this.take(id);
		if (!instance) return;
		this.log.debug("UI block closed", () => ({ id, ownerId: instance.request.ownerId }));
		instance.waiter?.settle({ id, delivered: false });
		this.notify();
	}

	/** The script threw while mounting. Rejects the delivery and drops the block. */
	fail(id: string, error: string): void {
		const instance = this.take(id);
		if (!instance) return;
		this.log.warn("UI block failed", () => ({ id, error }));
		instance.waiter?.reject(new Error(`UI component error: ${error}`));
		this.notify();
	}

	/**
	 * Drops every block.
	 *
	 * For teardown: a plugin unload leaves deliveries nobody will settle, and
	 * "closed before it was delivered" is an outcome the tool already reports.
	 */
	clear(): void {
		const dropped = this.instances;
		this.instances = [];
		if (dropped.length > 0) {
			this.log.info("UI blocks cleared", () => ({ dropped: dropped.length }));
		}
		for (const instance of dropped) {
			instance.waiter?.detach();
			instance.waiter?.settle({ id: instance.request.id, delivered: false });
		}
		this.notify();
	}

	/** Drops every block belonging to `ownerId`; for a closed conversation. */
	clearOwner(ownerId: string): void {
		const kept: Instance[] = [];
		const dropped: Instance[] = [];
		for (const instance of this.instances) {
			(instance.request.ownerId === ownerId ? dropped : kept).push(instance);
		}
		if (dropped.length === 0) return;
		this.instances = kept;
		this.log.debug("UI blocks cleared for conversation", () => ({
			ownerId,
			dropped: dropped.length,
		}));
		for (const instance of dropped) {
			instance.waiter?.detach();
			instance.waiter?.settle({ id: instance.request.id, delivered: false });
		}
		this.notify();
	}

	private find(id: string): Instance | undefined {
		return this.instances.find((instance) => instance.request.id === id);
	}

	/** Removes and returns the instance for `id`, detaching any abort listener. */
	private take(id: string): Instance | null {
		const index = this.instances.findIndex((instance) => instance.request.id === id);
		if (index < 0) {
			return null;
		}
		const instance = this.instances[index];
		if (!instance) {
			return null;
		}
		this.instances.splice(index, 1);
		instance.waiter?.detach();
		return instance;
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
