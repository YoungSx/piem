import { bindNativeTree, type CompatComponent } from "./componentTree";
import { type CompatTui, registerTuiCleanup } from "./componentRuntime";
import { Container } from "./components";
import { matchesKey } from "./keys";
import { theme as defaultTheme, type CompatTheme } from "./theme";
import { plainText } from "./textMetrics";
import { nativeCallbackResult } from "./callbackResult";

export class DynamicBorder implements CompatComponent {
	private disposed = false;
	constructor(private color: (text: string) => string = text => defaultTheme.fg("border", text)) {}
	invalidate(): void { /* The browser owns the border geometry. */ }
	render(width: number): string[] {
		if (this.disposed) return bindNativeTree([], { kind: "container", children: [] });
		const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		return bindNativeTree([plainText(this.color("─".repeat(columns)))], { kind: "border" });
	}
	dispose(): void { this.disposed = true; }
}

/** Native progress is static and accessible; no spinner interval is created. */
export class BorderedLoader extends Container {
	private readonly controller = new AbortController();
	private readonly cancellable: boolean;
	private onAbortCallback: (() => void) | undefined;
	private cleanup: (() => void) | undefined;
	private retired = false;

	constructor(private tui: CompatTui, theme: CompatTheme, message: string, options?: { cancellable?: boolean }) {
		super();
		this.cancellable = options?.cancellable ?? true;
		const text = plainText(theme.fg("muted", message));
		this.addChild(new DynamicBorder(value => theme.fg("border", value)));
		this.addChild({
			invalidate: () => undefined,
			render: () => bindNativeTree([text], { kind: "loader", text, cancellable: this.cancellable, aborted: this.controller.signal.aborted, onCancel: () => this.cancel() }),
		});
		this.addChild(new DynamicBorder(value => theme.fg("border", value)));
		this.cleanup = registerTuiCleanup(tui, () => this.dispose());
	}

	get signal(): AbortSignal { return this.controller.signal; }
	set onAbort(fn: (() => void) | undefined) { if (!this.retired && this.cancellable) this.onAbortCallback = fn; }

	private cancel(): void | Promise<void> {
		if (this.retired || !this.cancellable || this.controller.signal.aborted) return;
		this.controller.abort();
		this.tui.requestRender();
		return nativeCallbackResult([() => this.onAbortCallback?.()]);
	}

	handleInput(data: string): void | Promise<void> { if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.cancel(); }

	override dispose(): void {
		if (this.retired) return;
		this.retired = true;
		this.onAbortCallback = undefined;
		this.cleanup?.();
		this.cleanup = undefined;
		this.controller.abort();
		super.dispose();
	}
}
