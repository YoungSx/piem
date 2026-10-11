import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";

export const OWNER_UNKNOWN = "";

export interface UIBlockRequest {
	id: string;
	ownerId: string;
	code: string;
	title?: string;
}

export type UIBlockPayload = Record<string, unknown>;

export interface UIBlockBrokerOptions {
	logger?: LoggerLike;
}

type Listener = () => void;
type Settle = (payload: UIBlockPayload | null) => void;
type Reject = (error: Error) => void;

interface Entry {
	request: UIBlockRequest;
	settle: Settle;
	reject: Reject;
	detach: () => void;
}

export class UIBlockBroker {
	private readonly listeners = new Set<Listener>();
	private queue: Entry[] = [];
	private nextId = 0;
	private readonly presented = new Set<string>();
	private readonly log: LoggerLike;

	constructor(options?: UIBlockBrokerOptions) {
		this.log = (options?.logger ?? NOOP_LOGGER).child("ui_block");
	}

	present(
		request: { code: string; title?: string },
		signal?: AbortSignal,
		ownerId: string = OWNER_UNKNOWN,
	): Promise<UIBlockPayload | null> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Operation aborted"));
		}

		return new Promise<UIBlockPayload | null>((resolve, reject) => {
			const id = `ui-${this.nextId++}`;
			const entry: Entry = {
				request: {
					id,
					ownerId,
					code: request.code,
					title: request.title,
				},
				settle: resolve,
				reject,
				detach: () => undefined,
			};

			if (signal) {
				const onAbort = (): void => {
					this.take(id);
					this.log.debug("UI block aborted", () => ({ id, ownerId }));
					reject(new Error("Operation aborted"));
					this.pump();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.detach = () => signal.removeEventListener("abort", onAbort);
			}

			this.queue.push(entry);
			this.log.debug("UI block queued", () => ({
				id,
				ownerId,
				...(request.title ? { title: request.title } : {}),
				queued: this.getQueuedCount(ownerId),
			}));
			this.pump();
		});
	}

	getPending(ownerId: string = OWNER_UNKNOWN): UIBlockRequest | null {
		const head = this.queue.find((entry) => entry.request.ownerId === ownerId);
		return head && this.presented.has(head.request.id) ? head.request : null;
	}

	getQueuedCount(ownerId: string = OWNER_UNKNOWN): number {
		let waiting = 0;
		for (const entry of this.queue) {
			if (entry.request.ownerId === ownerId) {
				waiting += 1;
			}
		}
		return Math.max(0, waiting - 1);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	commit(id: string, payload: UIBlockPayload): void {
		this.log.debug("UI block committed", () => ({
			id,
			dataKeys: Object.keys(payload).slice(0, 10),
		}));
		this.finish(id, payload);
	}

	dismiss(id: string): void {
		this.log.debug("UI block dismissed", () => ({ id }));
		this.finish(id, null);
	}

	fail(id: string, error: string): void {
		this.log.warn("UI block failed", () => ({ id, error }));
		const entry = this.take(id);
		if (!entry) {
			return;
		}
		entry.reject(new Error(`UI component error: ${error}`));
		this.pump();
	}

	clear(): void {
		const dropped = this.queue;
		this.queue = [];
		this.presented.clear();
		if (dropped.length > 0) {
			this.log.info("UI block queue cleared", () => ({ dropped: dropped.length }));
		}
		for (const entry of dropped) {
			entry.detach();
			entry.settle(null);
		}
		this.notify();
	}

	private finish(id: string, payload: UIBlockPayload | null): void {
		const entry = this.take(id);
		if (!entry) {
			return;
		}
		entry.settle(payload);
		this.pump();
	}

	private take(id: string): Entry | null {
		const index = this.queue.findIndex((entry) => entry.request.id === id);
		if (index < 0) {
			return null;
		}
		const entry = this.queue[index];
		if (!entry) {
			return null;
		}
		this.queue.splice(index, 1);
		this.presented.delete(id);
		entry.detach();
		return entry;
	}

	private pump(): void {
		const owners = new Set<string>();
		for (const { request } of this.queue) {
			if (owners.has(request.ownerId)) continue;
			owners.add(request.ownerId);
			if (!this.presented.has(request.id)) {
				this.presented.add(request.id);
				this.log.debug("UI block presented", () => ({
					id: request.id,
					ownerId: request.ownerId,
					...(request.title ? { title: request.title } : {}),
				}));
			}
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
