import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIAdapter } from "./extensionUI";
import type { ExtensionLifetime, ExtensionScope } from "./extensionLifetime";
import type { CompatComponent } from "./compat/componentTree";
import type { CompatTui } from "./compat/componentRuntime";
import { createKeybindings, type CompatKeybindings } from "./compat/keys";
import { theme, type CompatTheme } from "./compat/theme";
import { NativeComponentSurface } from "./nativeComponentSurface";
import { unavailable } from "./node/unavailable";

type WidgetFactory = (tui: CompatTui, theme: CompatTheme) => CompatComponent;
type CustomFactory<T> = (tui: CompatTui, theme: CompatTheme, keys: CompatKeybindings, done: (value: T) => void) => CompatComponent | Promise<CompatComponent>;
interface Widget {
	factory: WidgetFactory;
	scope: ExtensionScope;
	options?: ExtensionWidgetOptions;
	surface?: NativeComponentSurface;
}

/** Factory lifetimes stay in the host; the adapter only mounts their native data. */
export function createNativeComponentUI(
	lifetime: ExtensionLifetime,
	getAdapter: () => ExtensionUIAdapter | undefined,
	notify: (message: string) => void,
) {
	const widgets = new Map<string, Widget>();
	const dialogs = new Set<() => void>();
	let retired = false;
	const report = (error: unknown): void => {
		if (retired || error instanceof Error && error.name === "AbortError") return;
		try { notify(error instanceof Error ? error.message : String(error)); }
		catch { /* Notification ownership may already be retired during teardown. */ }
	};
	const dispose = (surface: NativeComponentSurface | undefined): void => {
		try { surface?.dispose(); } catch (error) { report(error); }
	};
	const remove = (key: string): void => {
		const previous = widgets.get(key);
		widgets.delete(key);
		dispose(previous?.surface);
		if (previous?.surface) getAdapter()?.setComponentWidget?.(key, undefined);
	};
	const mount = (key: string, widget: Widget, adapter: ExtensionUIAdapter): void => {
		const setComponent = adapter.setComponentWidget?.bind(adapter) ?? unavailable("native component widgets in this UI adapter");
		widget.scope.assertActive();
		const retire = (error?: unknown): void => {
			if (widgets.get(key) !== widget) return;
			remove(key);
			setComponent(key, undefined);
			if (error !== undefined) report(error);
		};
		const surface = new NativeComponentSurface(lifetime, widget.scope, false, () => retire(), error => retire(error));
		widget.surface = surface;
		try {
			const component = lifetime.withScope(widget.scope, () => widget.factory(surface.tui, theme));
			surface.install(component);
			if (widgets.get(key) !== widget) { dispose(surface); return; }
			setComponent(key, surface, widget.options);
		} catch (error) { if (widgets.get(key) === widget) remove(key); else dispose(surface); throw error; }
	};
	return {
		setWidget: (key: string, factory: NonNullable<Parameters<ExtensionUIContext["setWidget"]>[1]>, options?: ExtensionWidgetOptions): void => {
			const adapter = getAdapter() ?? unavailable("native extension UI is not attached");
			if (typeof factory !== "function") throw new Error("A component factory is required.");
			remove(key);
			// Upstream requires a concrete TUI class. This single seam supplies only
			// the documented browser subset, whose other member reads fail clearly.
			const widget: Widget = { factory: factory as unknown as WidgetFactory, scope: lifetime.capture(), options };
			widgets.set(key, widget);
			mount(key, widget, adapter);
		},
		remove,
		retire: (): void => { retired = true; },
		custom: <T>(factory: Parameters<ExtensionUIContext["custom"]>[0], options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> => lifetime.run(async scope => {
			if (options && Object.keys(options).some(key => key !== "overlay")) unavailable("terminal custom overlay positioning or handles");
			const adapter = getAdapter() ?? unavailable("native extension UI is not attached");
			const show = adapter.showComponent?.bind(adapter) ?? unavailable("native custom components in this UI adapter");
			const controller = new AbortController();
			let settled = false;
			let resolveResult!: (value: T) => void;
			let rejectResult!: (error: unknown) => void;
			const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
			const finish = (value: T): void => {
				if (settled) return;
				settled = true;
				controller.abort();
				dispose(surface);
				resolveResult(value);
			};
			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				controller.abort();
				dispose(surface);
				rejectResult(error);
			};
			// Pi custom selectors conventionally use null for native dismissal.
			const cancel = (): void => finish(null as T);
			const surface = new NativeComponentSurface(lifetime, scope, true, cancel, fail);
			dialogs.add(cancel);
			try {
				const create = factory as unknown as CustomFactory<T>;
				const created = lifetime.withScope(scope, () => create(surface.tui, theme, createKeybindings(), finish));
				void Promise.resolve(created).then(async component => {
					if (settled) { component.dispose?.(); return; }
					surface.install(component);
					if (settled) return;
					await show(surface, controller.signal);
					if (!settled) surface.cancel();
				}).catch(fail);
				return await result;
			} finally {
				settled = true;
				controller.abort();
				dialogs.delete(cancel);
				dispose(surface);
			}
		}),
		detach: (): void => {
			for (const cancel of dialogs) cancel();
			for (const widget of widgets.values()) { dispose(widget.surface); widget.surface = undefined; }
		},
		restore: (adapter: ExtensionUIAdapter): void => {
			for (const [key, widget] of widgets) {
				try { widget.scope.assertActive(); }
				catch { remove(key); continue; }
				mount(key, widget, adapter);
			}
		},
		clear: (): void => {
			for (const cancel of dialogs) cancel();
			for (const key of widgets.keys()) remove(key);
		},
	};
}
