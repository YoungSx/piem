import type { AutocompleteProviderFactory, ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifetime, ExtensionScope } from "./extensionLifetime";
import { abortable, linkedAbortSignal } from "./extensionLifetime";
import type { ExtensionUIAdapter } from "./extensionUI";
import { unavailable } from "./node/unavailable";
import { createNativeComponentUI } from "./nativeComponentUI";
import { theme } from "./compat/theme";

export function createNativeExtensionUI(
	lifetime: ExtensionLifetime,
	getAdapter: () => ExtensionUIAdapter | undefined,
	notify: (message: string) => void,
) {
	const statuses = new Map<string, string>();
	const widgets = new Map<string, { content: string[]; options?: ExtensionWidgetOptions }>();
	const components = createNativeComponentUI(lifetime, getAdapter, notify);
	let autocomplete: Array<{ factory: AutocompleteProviderFactory; scope: ExtensionScope }> = [];
	const adapter = (): ExtensionUIAdapter => {
		lifetime.assertActive();
		return getAdapter() ?? unavailable("native extension UI is not attached");
	};
	const dialog = <T>(run: (ui: ExtensionUIAdapter, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> => lifetime.run(async scope => {
		const linked = linkedAbortSignal(scope.signal, caller);
		try {
			const value = await abortable(run(adapter(), linked.signal), linked.signal);
			scope.assertActive();
			return value;
		} finally { linked.dispose(); }
	});
	const deny = (): never => unavailable("terminal-only extension UI");
	const ui: ExtensionUIContext = {
		notify: message => { lifetime.assertActive(); notify(message); },
		select: (title, options, opts) => dialog((ui, signal) => ui.select(title, options, { ...opts, signal }), opts?.signal),
		confirm: (title, message, opts) => dialog((ui, signal) => ui.confirm(title, message, { ...opts, signal }), opts?.signal),
		input: (title, placeholder, opts) => dialog((ui, signal) => ui.input(title, placeholder, { ...opts, signal }), opts?.signal),
		editor: (title, prefill) => dialog((ui, signal) => ui.editor(title, prefill, signal)),
		setStatus: (key, text) => {
			adapter().setStatus(key, text);
			if (text === undefined) statuses.delete(key); else statuses.set(key, text);
		},
		setWidget: (key, content, options) => {
			if (typeof content === "function") {
				adapter();
				components.setWidget(key, content, options);
				widgets.delete(key);
				return;
			}
			components.remove(key);
			adapter().setWidget(key, content ? [...content] : undefined, options);
			if (content) widgets.set(key, { content: [...content], options }); else widgets.delete(key);
		},
		getEditorText: () => adapter().getEditorText(),
		setEditorText: text => adapter().setEditorText(text),
		pasteToEditor: text => adapter().pasteToEditor(text),
		addAutocompleteProvider: factory => {
			const scope = lifetime.capture();
			const scopedFactory: AutocompleteProviderFactory = base => {
				const provider = lifetime.withScope(scope, () => factory(base));
				// A cancelled registration falls back to the provider it wrapped;
				// it must not disable ordinary slash commands in the mounted panel.
				return new Proxy(provider, {
					get(target, key): unknown {
						const current = scope.signal.aborted ? base : target;
						const value: unknown = Reflect.get(current, key, current);
						return typeof value === "function" ? (...args: unknown[]): unknown => {
							if (scope.signal.aborted) {
								const fallback: unknown = Reflect.get(base, key, base);
								return typeof fallback === "function" ? Reflect.apply(fallback, base, args) : fallback;
							}
							return lifetime.withScope(scope, (): unknown => Reflect.apply(value, current, args));
						} : value;
					},
				});
			};
			adapter().addAutocompleteProvider(scopedFactory);
			autocomplete.push({ factory: scopedFactory, scope });
		},
		onTerminalInput: deny, setWorkingMessage: deny, setWorkingVisible: deny,
		setWorkingIndicator: deny, setHiddenThinkingLabel: deny, setFooter: deny,
		setHeader: deny, setTitle: deny, custom: components.custom, setEditorComponent: deny,
		getEditorComponent: deny, get theme() { lifetime.assertActive(); return theme as ExtensionUIContext["theme"]; },
		getAllThemes: deny, getTheme: deny, setTheme: deny, getToolsExpanded: deny, setToolsExpanded: deny,
	};
	return {
		ui,
		retire: components.retire,
		detach: components.detach,
		restore: (target: ExtensionUIAdapter): void => {
			for (const [key, text] of statuses) target.setStatus(key, text);
			for (const [key, value] of widgets) target.setWidget(key, [...value.content], value.options);
			autocomplete = autocomplete.filter(({ scope }) => !scope.signal.aborted);
			for (const { factory } of autocomplete) target.addAutocompleteProvider(factory);
			components.restore(target);
		},
		clear: (): void => { components.clear(); statuses.clear(); widgets.clear(); autocomplete.length = 0; },
	};
}
