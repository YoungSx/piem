/**
 * Messages the user typed while the agent was already answering.
 *
 * The panel used to refuse them outright: a send during a streaming reply set
 * the "agent is already responding" banner and dropped the text back into the
 * composer. That is a lie about what the agent can do, and it is also the wrong
 * shape for a chat panel, where the natural correction ("no, not that file")
 * arrives *because* the reply is already underway.
 *
 * ## Three ways out, one queue (issue #289)
 *
 * *When* a waiting message is let through is the user's choice, not this
 * module's — see `queueStrategy.ts` for the two timings and why the whole
 * answer is the default. What this module owns is the list, and the three exits
 * from it:
 *
 * - {@link drain} takes everything, for the run's end. The `afterRun` timing,
 *   and also the rescue for a queue a run left behind.
 * - {@link settle} drops one entry by identity, for the `afterTurn` timing,
 *   where pi is the one that injected it.
 * - {@link remove} takes one back by the chip's id and hands the whole entry
 *   over. Two chips press it: the steer, which sends that message now and cuts
 *   the reply short, and the take-back, which puts the words and pictures into
 *   the composer so the user can rewrite rather than retype.
 *
 * ## pi's steering queue is empty except for an instant
 *
 * The `afterTurn` timing is implemented by offering pi the waiting messages
 * *from* the turn-boundary hook (`shouldStopAfterTurn`), which pi calls
 * immediately before it polls its steering queue. Push then drain, in one
 * iteration of pi's own loop — so between boundaries pi holds nothing.
 *
 * That invariant is what keeps this module simple, and it was bought by a real
 * defect: an earlier revision handed pi each message as it was queued, which
 * meant an abort landing while tools were still finishing had pi inject the
 * message into a run that then ended — the user's words in the transcript with
 * nothing answering them. It also meant {@link remove} had to rebuild pi's
 * queue from the survivors, since pi cannot drop a single message. Neither
 * problem exists for a queue pi is only ever holding for one poll.
 *
 * Ids come from a counter rather than a uuid because the list dies with the
 * panel: nothing persists an id, so uniqueness within one process is all it has
 * to buy.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * One waiting message, as the panel renders it.
 *
 * Deliberately without the `AgentMessage` and without the image bytes: the UI
 * needs the words, a count, and a handle, and handing it the object the agent
 * will be prompted with invites a component to mutate it.
 */
export interface QueuedPrompt {
	/** Stable handle for take-back. Session-scoped and never persisted. */
	id: string;
	/** What the user typed, before command expansion — that is what they recognize. */
	text: string;
	/** How many images ride along, so the chip can say so without holding bytes. */
	imageCount: number;
}

/** A queued message plus what dispatching or taking it back needs. */
export interface QueueEntry extends QueuedPrompt {
	/**
	 * The message the model will be given: expanded text plus every image.
	 *
	 * Handed to pi by identity — either as a prompt, or through `steer()` at a
	 * turn boundary — which is what lets {@link settle} drop the right entry when
	 * the same words were queued twice.
	 */
	message: AgentMessage;
	/**
	 * Only the images the user had staged in the composer, for the take-back.
	 *
	 * A subset of `message`'s images, not a copy of them — the same objects, so
	 * the base64 is held once. The rest of `message`'s images were resolved out
	 * of `![[…]]` embeds that are still written in {@link QueuedPrompt.text},
	 * and restaging those would send each picture twice on the next send.
	 */
	stagedImages: readonly ImageContent[];
}

/** What the composer refills from when the user takes a queued message back. */
export interface TakenPrompt {
	/** The words as typed, ready to go back into the draft. */
	text: string;
	/** The pictures to restage beside them; empty when there were none. */
	images: readonly ImageContent[];
}

/**
 * The panel's queue of mid-run sends, oldest first.
 *
 * Not a general queue: `add` is append-only, and the only bulk exit is
 * {@link drain}, which is what keeps "what the chips say" and "what will be
 * sent" the same list rather than two that have to be kept in step.
 */
export class PromptQueue {
	private entries: QueueEntry[] = [];
	private nextId = 1;

	/** Records a message waiting to go out. Returns the panel's view of it. */
	add(input: {
		text: string;
		imageCount: number;
		stagedImages: readonly ImageContent[];
		message: AgentMessage;
	}): QueuedPrompt {
		const entry: QueueEntry = {
			id: `queued-${this.nextId}`,
			text: input.text,
			imageCount: input.imageCount,
			stagedImages: input.stagedImages,
			message: input.message,
		};
		this.nextId += 1;
		this.entries.push(entry);
		return { id: entry.id, text: entry.text, imageCount: entry.imageCount };
	}

	/**
	 * Drops the entry for a message that has just been injected.
	 *
	 * Returns whether one was found, which is how the service tells an injected
	 * queued message from every other `message_end` — a plain prompt, an
	 * assistant reply, a tool result — without inspecting roles. Identity, not
	 * text: a user who queued the same words twice gets the right one settled.
	 */
	settle(message: AgentMessage): boolean {
		const index = this.entries.findIndex((entry) => entry.message === message);
		if (index === -1) {
			return false;
		}
		this.entries.splice(index, 1);
		return true;
	}

	/**
	 * Takes one entry out by the chip's id and hands the whole thing over.
	 *
	 * The caller decides what the entry is for: the steer chip prompts with its
	 * `message`, the take-back chip refills the composer from its `text` and
	 * `stagedImages`. One removal primitive rather than two, because "which
	 * fields does the caller read" is not a difference the queue can act on.
	 *
	 * `undefined` for an unknown id: a chip can outlive its entry by one render
	 * if the queue is dispatched just as the user reaches for the button, and
	 * that race is not an error — the message went out, which is what the user
	 * would have been told anyway.
	 */
	remove(id: string): QueueEntry | undefined {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index === -1) {
			return undefined;
		}
		const [removed] = this.entries.splice(index, 1);
		return removed;
	}

	/** Forgets everything. Pairs with the abort, and with a session change. */
	clear(): void {
		this.entries = [];
	}

	/**
	 * Takes every entry for dispatch, oldest first.
	 *
	 * A pair with {@link restore} — take, then put back on failure — so the
	 * chips do not lie either way: while the prompt is in flight they are gone
	 * because the words are, and if it never departed they are back.
	 */
	drain(): QueueEntry[] {
		const taken = this.entries;
		this.entries = [];
		return taken;
	}

	/** Puts drained entries back, oldest first. The failure path of {@link drain}. */
	restore(entries: readonly QueueEntry[]): void {
		this.entries.unshift(...entries);
	}

	/**
	 * The messages themselves, oldest first, for the turn-boundary hand-off.
	 *
	 * Unlike {@link drain} this leaves the queue intact: under the `afterTurn`
	 * timing pi is *offered* the messages and takes them down by injecting them,
	 * which arrives back here as {@link settle}. Draining here instead would
	 * empty the chips a poll before the model had actually been given the words.
	 */
	messages(): AgentMessage[] {
		return this.entries.map((entry) => entry.message);
	}

	/** The waiting messages, oldest first, without the bytes or the agent's objects. */
	list(): QueuedPrompt[] {
		return this.entries.map((entry) => ({
			id: entry.id,
			text: entry.text,
			imageCount: entry.imageCount,
		}));
	}

	/** How many messages are waiting. */
	get size(): number {
		return this.entries.length;
	}
}
