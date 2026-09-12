/** Only the page lifecycle events used by browser SDKs, never the host DOM. */
export interface ExtensionDocument {
	readonly visibilityState: DocumentVisibilityState;
	addEventListener(type: string, listener: PageListener | null, options?: boolean | AddEventListenerOptions): void;
	removeEventListener(type: string, listener: PageListener | null, options?: boolean | EventListenerOptions): void;
}
interface PageEvent {
	readonly type: string;
	readonly timeStamp: number;
	readonly target: ExtensionDocument;
	readonly currentTarget: ExtensionDocument;
}
type PageListener = ((this: ExtensionDocument, event: PageEvent) => unknown) | { handleEvent(event: PageEvent): unknown };
interface Registration {
	type: string;
	listener: PageListener;
	capture: boolean;
	remove: () => void;
}

/** Only background factories receive globals that expose the page lifecycle. */
export function createExtensionDocument(signal: AbortSignal | undefined, shutdown: AbortSignal | undefined, onError: (error: unknown) => void): ExtensionDocument | undefined {
	if (!signal || !shutdown) throw new Error("Extension document requires an owned background lifetime.");
	const native = typeof window === "undefined" ? undefined : window.document;
	if (!native) return undefined;
	const registrations = new Set<Registration>();
	const assertActive = (): void => {
		if (signal.aborted || shutdown.aborted) throw new DOMException("Extension document was disposed.", "AbortError");
	};
	const close = (): void => {
		for (const registration of registrations) registration.remove();
		signal.removeEventListener("abort", close);
		shutdown.removeEventListener("abort", close);
	};
	const allowed = (type: string): void => {
		if (type !== "visibilitychange" && type !== "pagehide") throw new Error("Extension document supports only visibilitychange and pagehide events.");
	};
	const report = (error: unknown): void => {
		if (signal.aborted || shutdown.aborted) return;
		try { onError(error); } catch { /* Reporting must not create an unhandled event rejection. */ }
	};
	const members: ExtensionDocument = {
		get visibilityState() { assertActive(); return native.visibilityState; },
		addEventListener(type, listener, options) {
			assertActive(); allowed(type);
			if (!listener) return;
			if (typeof listener !== "function" && typeof listener.handleEvent !== "function") throw new TypeError("Extension document requires an event listener.");
			const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
			const extra = typeof options === "object" ? options.signal : undefined;
			if (extra?.aborted || [...registrations].some(item => item.type === type && item.listener === listener && item.capture === capture)) return;
			if (registrations.size >= 64) throw new Error("At most 64 extension document listeners are supported.");
			const registration: Registration = {
				type, listener, capture,
				remove: () => {
					if (!registrations.delete(registration)) return;
					native.removeEventListener(type, dispatch, capture);
					extra?.removeEventListener("abort", registration.remove);
				},
			};
			const dispatch = (event: Event): void => {
				if (signal.aborted || shutdown.aborted || !registrations.has(registration)) return;
				if (typeof options === "object" && options.once) registration.remove();
				// Never hand an extension native target/currentTarget or composedPath.
				const snapshot = Object.freeze(Object.assign(Object.create(null) as PageEvent, { type: event.type, timeStamp: event.timeStamp, target: view, currentTarget: view }));
				try {
					const result = typeof listener === "function" ? listener.call(view, snapshot) : listener.handleEvent(snapshot);
					void Promise.resolve(result).catch(report);
				} catch (error) { report(error); }
			};
			registrations.add(registration);
			try {
				native.addEventListener(type, dispatch, { capture, passive: true });
				extra?.addEventListener("abort", registration.remove, { once: true });
			} catch (error) { registration.remove(); throw error; }
		},
		removeEventListener(type, listener, options) {
			allowed(type);
			const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
			for (const item of registrations) if (item.type === type && item.listener === listener && item.capture === capture) item.remove();
		},
	};
	const view: ExtensionDocument = Object.freeze(Object.defineProperties(Object.create(null) as ExtensionDocument, Object.getOwnPropertyDescriptors(members)));
	assertActive();
	signal.addEventListener("abort", close, { once: true });
	shutdown.addEventListener("abort", close, { once: true });
	return view;
}

/** Read-only Web API views do not expose ambient network or listener methods. */
export function createExtensionPerformance() {
	return Object.freeze({
		now: () => window.performance.now(),
		get timeOrigin() { return window.performance.timeOrigin; },
	});
}
export function createExtensionCrypto() {
	return Object.freeze({
		getRandomValues: <T extends ArrayBufferView | null>(array: T): T => window.crypto.getRandomValues(array),
		randomUUID: () => window.crypto.randomUUID(),
	});
}

/** A private registry for one factory, not a JavaScript security sandbox. */
export function createExtensionGlobals(capabilities: Record<string, unknown>): Record<PropertyKey, unknown> {
	const values: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>;
	const standard = {
		Object, Array, ArrayBuffer, DataView, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
		String, Number, Boolean, BigInt, Date, RegExp, Error, TypeError, RangeError, SyntaxError, Promise, Map, Set, WeakMap, WeakSet, Symbol, Reflect, Math, JSON,
		URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
	};
	for (const [name, value] of Object.entries({ ...standard, ...capabilities })) {
		Object.defineProperty(values, name, { value, enumerable: true });
	}
	// Property writes (including Symbol.for SDK registrations) stay private.
	// A prototype cannot expose ambient properties that the view omitted.
	const view = new Proxy(values, { setPrototypeOf: () => false });
	for (const name of ["globalThis", "window", "self", "global"]) Object.defineProperty(values, name, { value: view, enumerable: true });
	return view;
}
