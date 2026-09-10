import type { NativeExtensionSurface } from "./extensionUI";
import type { ExtensionLifetime, ExtensionScope } from "./extensionLifetime";
import { createTui, disposeTui } from "./compat/componentRuntime";
import { plainTextNode, readNativeTree, type CompatComponent, type NativeComponentNode } from "./compat/componentTree";
import { unavailable } from "./node/unavailable";

const EMPTY: NativeComponentNode = Object.freeze({ kind: "container", children: Object.freeze([]) });

function hasInteraction(node: NativeComponentNode): boolean {
	return node.kind === "select" || node.kind === "loader"
		|| node.kind === "container" && node.children.some(hasInteraction);
}

/** A component's renderer and callbacks retire together, including retained trees. */
export class NativeComponentSurface implements NativeExtensionSurface {
	readonly tui = createTui(() => this.requestRender());
	private component: CompatComponent | undefined;
	private snapshot: NativeComponentNode = EMPTY;
	private columns = 80;
	private disposed = false;
	private cancelled = false;
	private scheduled = false;
	private rendering = false;
	private readonly listeners = new Set<() => void>();
	private readonly abort = (): void => this.fail(new DOMException("Extension component was cancelled.", "AbortError"));

	constructor(
		private readonly lifetime: ExtensionLifetime,
		private readonly scope: ExtensionScope,
		private readonly interactive: boolean,
		private readonly onCancel: () => void,
		private readonly onError: (error: unknown) => void,
	) {
		scope.assertActive();
		scope.signal.addEventListener("abort", this.abort, { once: true });
	}

	install(component: CompatComponent): void {
		if (!component || typeof component.render !== "function" || typeof component.invalidate !== "function") {
			throw new Error("Extension component must implement render and invalidate.");
		}
		if (this.disposed) { component.dispose?.(); return; }
		this.component = component;
		this.render();
	}

	getSnapshot = (): NativeComponentNode => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		if (!this.disposed) this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	resize = (columns: number): void => {
		if (this.disposed || !Number.isFinite(columns)) return;
		const next = Math.max(1, Math.min(500, Math.floor(columns)));
		if (this.columns === next) return;
		this.columns = next;
		this.requestRender();
	};
	cancel = (): void => {
		if (this.disposed || this.cancelled) return;
		this.cancelled = true;
		try {
			this.scope.assertActive();
			this.lifetime.withScope(this.scope, () => this.cancelNode(this.snapshot));
		} catch (error) { this.fail(error); }
		finally { this.onCancel(); }
	};

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.scope.signal.removeEventListener("abort", this.abort);
		this.listeners.clear();
		this.snapshot = EMPTY;
		const component = this.component;
		this.component = undefined;
		try { component?.dispose?.(); }
		finally { disposeTui(this.tui); }
	}

	private requestRender(): void {
		if (this.disposed || this.scheduled || this.rendering || !this.component) return;
		this.scheduled = true;
		// One microtask per burst, with no polling or persistent animation timer.
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.disposed) return;
			try { this.render(); } catch (error) { this.fail(error); }
		});
	}

	private render(): void {
		this.scope.assertActive();
		const component = this.component;
		if (!component) return;
		let node: NativeComponentNode;
		this.rendering = true;
		try {
			node = this.lifetime.withScope(this.scope, () => {
				component.invalidate();
				const lines = component.render(this.columns);
				if (!Array.isArray(lines) || lines.some(line => typeof line !== "string")) throw new Error("Extension render must return text lines.");
				const structured = readNativeTree(lines);
				if (this.interactive && component.handleInput && (!structured || !hasInteraction(structured))) unavailable("custom input without supported native components");
				return structured ?? plainTextNode(lines);
			});
		} finally { this.rendering = false; }
		if (this.disposed) return;
		this.snapshot = this.guard(node);
		for (const listener of this.listeners) listener();
	}

	private guard(node: NativeComponentNode): NativeComponentNode {
		const action = <A extends unknown[]>(callback: (...args: A) => void | Promise<void>) => (...args: A): void => {
			if (this.disposed) return;
			try {
				this.scope.assertActive();
				const result = this.lifetime.withScope(this.scope, () => callback(...args));
				if (result) void Promise.resolve(result).then(() => this.requestRender(), error => this.fail(error));
				this.requestRender();
			} catch (error) { this.fail(error); }
		};
		if (node.kind === "container") return { ...node, children: node.children.map(child => this.guard(child)) };
		if (node.kind === "select") return { ...node, onSelect: action(node.onSelect), onSelectionChange: action(node.onSelectionChange), onCancel: action(node.onCancel) };
		if (node.kind === "loader") return { ...node, onCancel: action(node.onCancel) };
		return node;
	}

	private cancelNode(node: NativeComponentNode): boolean {
		// snapshot callbacks already observe returned promises in guard().
		if (node.kind === "select" || node.kind === "loader") { void node.onCancel(); return true; }
		if (node.kind === "container") return node.children.some(child => this.cancelNode(child));
		return false;
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		try { this.dispose(); }
		finally { this.onError(error); }
	}
}
