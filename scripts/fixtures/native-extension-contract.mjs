/** Local contract fixture only. No community package or production factory is added. */
import { complete } from "@mariozechner/pi-ai";
import { Container, Text, SelectList, Key } from "@mariozechner/pi-tui";
import { BorderedLoader, DynamicBorder, getSelectListTheme } from "@mariozechner/pi-coding-agent";

export function createContractFactory(record) {
	return pi => {
		pi.on("session_start", (_event, ctx) => {
			record.context = ctx;
			if (!ctx.hasUI) return;
			ctx.ui.setWidget("contract-text", ["Bridge contract fixture"]);
			ctx.ui.setWidget("contract-component", (_tui, theme) => {
				record.widgetMounts = (record.widgetMounts ?? 0) + 1;
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", "Native component ready")));
				container.addChild(new Text("<script>literal text</script>"));
				return {
					render: width => container.render(width), invalidate: () => container.invalidate(),
					dispose() { record.widgetDisposals = (record.widgetDisposals ?? 0) + 1; container.dispose(); },
				};
			});
		});
		pi.registerShortcut(Key.ctrlShift("j"), {
			description: "Choose a bridge item",
			handler: async ctx => {
				const selected = await ctx.ui.custom((tui, theme, _keys, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder(text => theme.fg("accent", text)));
					container.addChild(new Text("Choose an item"));
					const list = new SelectList([
						{ value: "review", label: "Review notes", description: "Read the current notes" },
						{ value: "organize", label: "Organize notes", description: "Prepare a draft" },
					], 5, getSelectListTheme());
					list.onSelect = item => done(item.value);
					list.onCancel = () => done(null);
					container.addChild(list);
					return {
						render: width => container.render(width), invalidate: () => container.invalidate(),
						handleInput(data) { list.handleInput(data); tui.requestRender(); },
						dispose() { record.pickerDisposals = (record.pickerDisposals ?? 0) + 1; container.dispose(); },
					};
				});
				record.selection = selected;
				if (selected !== null) ctx.ui.setEditorText(`Selected: ${selected}`);
			},
		});
		pi.registerShortcut(Key.alt("l"), {
			description: "Open cancellable bridge task",
			handler: async ctx => {
				record.loaderResult = await ctx.ui.custom((tui, theme, _keys, done) => {
					const loader = new BorderedLoader(tui, theme, "Waiting for cancellation");
					record.loaderSignal = loader.signal;
					loader.onAbort = () => done(null);
					return loader;
				});
			},
		});
		pi.registerShortcut(Key.alt("m"), {
			description: "Run bridge model request",
			handler: async ctx => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) throw new Error(auth.error);
				record.auth = auth;
				record.completion = await complete(ctx.model, {
					messages: [{ role: "user", content: "GENERIC_BRIDGE_REQUEST", timestamp: Date.now() }],
				}, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 128 });
			},
		});
	};
}
