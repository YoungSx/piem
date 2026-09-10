import { describe, expect, test } from "bun:test";
import { SelectList as PiSelectList } from "../../../node_modules/@earendil-works/pi-tui/dist/components/select-list.js";
import { visibleWidth as piVisibleWidth } from "../../../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { readNativeTree, renderNativeComponent, type CompatComponent, type NativeComponentNode } from "./componentTree";
import { createTui, disposeTui, registerTuiCleanup } from "./componentRuntime";
import { Container, Text } from "./components";
import { createKeybindings, Key, matchesKey } from "./keys";
import { BorderedLoader, DynamicBorder } from "./loader";
import { SelectList } from "./selectList";
import { getSelectListTheme, theme } from "./theme";
import { plainText, truncateToWidth, visibleWidth } from "./textMetrics";

function selectNode(component: CompatComponent): Extract<NativeComponentNode, { kind: "select" }> {
	const node = renderNativeComponent(component, 80);
	if (node.kind !== "select") throw new Error("Expected native selection");
	return node;
}

function loaderNode(component: CompatComponent): Extract<NativeComponentNode, { kind: "loader" }> {
	const node = renderNativeComponent(component, 80);
	if (node.kind !== "container") throw new Error("Expected native loader container");
	const loader = node.children.find(child => child.kind === "loader");
	if (!loader || loader.kind !== "loader") throw new Error("Expected native loader");
	return loader;
}

describe("native Pi component compatibility", () => {
	test("keeps synchronous callbacks synchronous and surfaces returned promise failures", async () => {
		const select = new SelectList([{ value: "a", label: "First" }, { value: "b", label: "Second" }], 2, getSelectListTheme());
		let selected = "";
		select.onSelect = item => { selected = item.value; };
		expect(selectNode(select).onSelect(0)).toBeUndefined();
		expect(selected).toBe("a");
		select.onSelect = async () => { throw new Error("Async selection failed"); };
		await expect(selectNode(select).onSelect(1)).rejects.toThrow("Async selection failed");
		select.onSelectionChange = async () => { throw new Error("Async highlight failed"); };
		await expect(selectNode(select).onSelectionChange(0)).rejects.toThrow("Async highlight failed");
		select.onCancel = async () => { throw new Error("Async cancel failed"); };
		await expect(selectNode(select).onCancel()).rejects.toThrow("Async cancel failed");
		const tui = createTui(() => undefined);
		const loader = new BorderedLoader(tui, theme, "Working");
		loader.onAbort = async () => { throw new Error("Async loader failed"); };
		await expect(loaderNode(loader).onCancel()).rejects.toThrow("Async loader failed");
		disposeTui(tui);
	});

	test("preserves the installed Pi SelectList state and callback contract", () => {
		const items = [{ value: "alpha", label: "First" }, { value: "alpine", label: "Second" }, { value: "beta", label: "Third" }];
		const native = new SelectList(items, 2, getSelectListTheme());
		const upstream = new PiSelectList(items, 2, getSelectListTheme());
		const nativeEvents: string[] = [];
		const upstreamEvents: string[] = [];
		for (const [select, events] of [[native, nativeEvents], [upstream, upstreamEvents]] as const) {
			select.onSelectionChange = item => events.push(`change:${item.value}`);
			select.onSelect = item => events.push(`select:${item.value}`);
			select.onCancel = () => events.push("cancel");
			select.setSelectedIndex(10);
			select.setFilter("AL");
			for (const input of ["\u001b[A", "\r", "\u001b[B", "\r", "\u0003"]) select.handleInput(input);
		}
		expect(nativeEvents).toEqual(upstreamEvents);
		expect(native.getSelectedItem()).toBe(upstream.getSelectedItem());
	});

	test("keeps semantic components through arbitrary wrappers returning the same lines", () => {
		const select = new SelectList([{ value: "a", label: "First" }], 5, getSelectListTheme());
		const chosen: string[] = [];
		select.onSelect = item => chosen.push(item.value);
		let wrapped: CompatComponent = select;
		for (let i = 0; i < 24; i++) {
			const child = wrapped;
			wrapped = { render: width => child.render(width), invalidate: () => child.invalidate() };
		}
		const container = new Container();
		container.addChild(new Text("Choices", 0, 0));
		container.addChild(wrapped);
		const node = renderNativeComponent(container, 80);
		expect(node.kind).toBe("container");
		if (node.kind !== "container") throw new Error("Expected container");
		expect(node.children.map(child => child.kind)).toEqual(["text", "select"]);
		const options = node.children[1];
		if (options?.kind !== "select") throw new Error("Expected selection");
		options.onSelect(0);
		expect(chosen).toEqual(["a"]);
	});

	test("copies, arbitrary text and mutations cannot fabricate selectable controls", () => {
		const select = new SelectList([{ value: "a", label: "First" }], 5, getSelectListTheme());
		const copied = { render: (width: number) => [...select.render(width)], invalidate: () => undefined };
		expect(renderNativeComponent(copied, 80).kind).toBe("text");
		const lines = select.render(80);
		lines.push("Another button");
		expect(readNativeTree(lines)).toBeUndefined();
		const text = { render: () => ["→ Delete vault", "<button>Cancel</button>"], invalidate: () => undefined };
		expect(renderNativeComponent(text, 80)).toEqual({ kind: "text", text: "→ Delete vault\n<button>Cancel</button>", paddingX: 0, paddingY: 0 });
	});

	test("returns isolated readonly arrays and preserves original selected items", () => {
		const item = { value: "a", label: "First", description: "Description" };
		const select = new SelectList([item], 3, getSelectListTheme());
		const lines = select.render(80);
		const first = readNativeTree(lines);
		const second = readNativeTree(lines);
		if (first?.kind !== "select" || second?.kind !== "select") throw new Error("Expected selection");
		expect(first.items).not.toBe(second.items);
		expect(first.items[0]).not.toBe(second.items[0]);
		expect(Object.isFrozen(first.items)).toBe(true);
		let selected: unknown;
		select.onSelect = value => { selected = value; };
		first.onSelect(0);
		expect(selected).toBe(item);
	});

	test("filter uses Pi value prefix semantics and wraps keyboard selection", () => {
		const first = { value: "alpha", label: "One" };
		const second = { value: "alpine", label: "Two" };
		const items = [first, second, { value: "beta", label: "Alpha label" }];
		const select = new SelectList(items, 2, getSelectListTheme());
		const changes: string[] = [];
		select.onSelectionChange = item => changes.push(item.value);
		select.setSelectedIndex(2);
		select.setFilter("AL");
		expect(selectNode(select).items.map(item => item.value)).toEqual(["alpha", "alpine"]);
		expect(select.getSelectedItem()).toBe(first);
		select.handleInput(Key.up);
		expect(select.getSelectedItem()).toBe(second);
		select.handleInput("\u001b[B");
		expect(select.getSelectedItem()).toBe(first);
		expect(changes).toEqual(["alpine", "alpha"]);
		select.setSelectedIndex(99);
		expect(select.getSelectedItem()).toBe(second);
		select.setFilter("no match");
		select.handleInput(Key.up);
		expect(select.getSelectedItem()).toBeNull();
	});

	test("native selection, cancel and late snapshots preserve live state", () => {
		const items = [{ value: "a", label: "First" }, { value: "b", label: "Second" }];
		const select = new SelectList(items, 2, getSelectListTheme());
		const events: string[] = [];
		select.onSelect = item => events.push(`select:${item.value}`);
		select.onSelectionChange = item => events.push(`change:${item.value}`);
		select.onCancel = () => events.push("cancel");
		const original = selectNode(select);
		original.onSelectionChange(1);
		expect(selectNode(select).selectedIndex).toBe(1);
		original.onSelect(1);
		original.onCancel();
		expect(events).toEqual(["change:b", "select:b", "cancel"]);
		select.setFilter("a");
		original.onSelect(1);
		expect(events).toHaveLength(3);
		select.dispose();
		original.onSelect(0);
		original.onCancel();
		select.handleInput("enter");
		expect(events).toHaveLength(3);
	});

	test("text changes and clear/remove keep tree ordering without parsing markup", () => {
		const container = new Container();
		const text = new Text(theme.bold("<b>Literal</b>"), 2, 0);
		const border = new DynamicBorder();
		container.addChild(text);
		container.addChild(border);
		expect(renderNativeComponent(text, 10)).toEqual({ kind: "text", text: "<b>Literal</b>", paddingX: 2, paddingY: 0 });
		text.setText("Changed");
		expect(renderNativeComponent(text, 10)).toMatchObject({ text: "Changed" });
		container.removeChild(border);
		expect(renderNativeComponent(container, 10)).toMatchObject({ children: [{ kind: "text", text: "Changed" }] });
		container.clear();
		expect(renderNativeComponent(container, 10)).toEqual({ kind: "container", children: [] });
		container.addChild(text);
		container.dispose();
		container.dispose();
		expect(renderNativeComponent(container, 10)).toEqual({ kind: "container", children: [] });
	});

	test("loader cancels once with native signal and retires without spinning", () => {
		let renders = 0;
		let aborts = 0;
		const tui = createTui(() => renders++);
		const loader = new BorderedLoader(tui, theme, "Working");
		loader.onAbort = () => aborts++;
		expect(loader.signal.aborted).toBe(false);
		expect(renders).toBe(0);
		const node = loaderNode(loader);
		node.onCancel();
		node.onCancel();
		loader.handleInput(Key.escape);
		expect(loader.signal.aborted).toBe(true);
		expect(loaderNode(loader).aborted).toBe(true);
		expect(aborts).toBe(1);
		expect(renders).toBe(1);
		disposeTui(tui);
		disposeTui(tui);
		tui.requestRender();
		expect(renders).toBe(1);
	});

	test("disposing a surface aborts nested noncancellable loaders and late construction", () => {
		const tui = createTui(() => undefined);
		const loader = new BorderedLoader(tui, theme, "Working", { cancellable: false });
		let aborts = 0;
		loader.onAbort = () => aborts++;
		loaderNode(loader).onCancel();
		loader.handleInput(Key.escape);
		expect(loader.signal.aborted).toBe(false);
		disposeTui(tui);
		expect(loader.signal.aborted).toBe(true);
		expect(aborts).toBe(0);
		const late = new BorderedLoader(tui, theme, "Late");
		expect(late.signal.aborted).toBe(true);
	});

	test("a throwing cleanup does not strand sibling components or resources", () => {
		const tui = createTui(() => undefined);
		registerTuiCleanup(tui, () => { throw new Error("Broken cleanup"); });
		const loader = new BorderedLoader(tui, theme, "Working");
		expect(() => disposeTui(tui)).toThrow("Broken cleanup");
		expect(loader.signal.aborted).toBe(true);
		expect(() => disposeTui(tui)).not.toThrow();
		const container = new Container();
		let disposed = 0;
		container.addChild({ render: () => [], invalidate: () => {}, dispose: () => { throw new Error("Broken child"); } });
		container.addChild({ render: () => [], invalidate: () => {}, dispose: () => { disposed++; } });
		expect(() => container.dispose()).toThrow("Broken child");
		expect(disposed).toBe(1);
		expect(() => container.dispose()).not.toThrow();
	});

	test("native keybindings have a finite supported surface", () => {
		expect(matchesKey("ArrowUp", Key.up)).toBe(true);
		expect(matchesKey("Escape", Key.escape)).toBe(true);
		expect(matchesKey("\u0003", Key.ctrl("c"))).toBe(true);
		expect(matchesKey("ctrl+shift+p", Key.shiftCtrl("p"))).toBe(true);
		expect(matchesKey("+", Key.plus)).toBe(true);
		expect(matchesKey("A", Key.shift("a"))).toBe(true);
		expect(matchesKey("not-an-input", Key.enter)).toBe(false);
		const keys = createKeybindings();
		expect(keys.matches("\u0003", "tui.select.cancel")).toBe(true);
		expect(keys.getKeys("tui.select.confirm")).toEqual(["enter"]);
		expect(() => keys.getKeys("app.suspend")).toThrow("native keybinding");
		const tui = createTui(() => undefined);
		expect(() => Reflect.get(tui, "terminal")).toThrow("terminal operation");
		expect(() => Reflect.get(theme, "getFgAnsi")).toThrow("terminal theme");
		expect(() => Reflect.apply(theme.fg, theme, ["invented", "text"])).toThrow("theme color");
		expect(() => Reflect.apply(theme.bg, theme, ["invented", "text"])).toThrow("theme background");
		expect(() => Reflect.apply(theme.getThinkingBorderColor, theme, ["invented"])).toThrow("thinking border");
	});
});

describe("native text metrics", () => {
	test("matches installed Pi width arithmetic for representative scripts without importing its runtime in production", () => {
		for (const value of ["ASCII", "中文", "é", "👩🏽‍💻", "🇨🇳", "1️⃣", "क", "का", "कि", "क्ष", "가", "한", "กำ", "ཀཿ", "ေန", "©️", "☀︎", "\uFE0F"]) {
			expect(visibleWidth(value)).toBe(piVisibleWidth(value));
		}
	});

	test("counts Unicode graphemes including CJK, combining marks, flags and joined emoji", () => {
		expect(visibleWidth("abc")).toBe(3);
		expect(visibleWidth("中文")).toBe(4);
		expect(visibleWidth("e\u0301")).toBe(1);
		expect(visibleWidth("\u0301")).toBe(0);
		expect(visibleWidth("👩🏽‍💻")).toBe(2);
		expect(visibleWidth("🇨🇳")).toBe(2);
		expect(visibleWidth("1️⃣")).toBe(2);
		expect(visibleWidth("\t")).toBe(3);
		expect(visibleWidth("का")).toBe(2);
		expect(visibleWidth("क्ष")).toBe(2);
		expect(visibleWidth("가")).toBe(2);
		expect(visibleWidth("กำ")).toBe(2);
		expect(visibleWidth("ေန")).toBe(2);
		expect(visibleWidth("\uFE0F")).toBe(0);
	});

	test("truncates at whole graphemes, sizes the ellipsis and pads exact columns", () => {
		expect(truncateToWidth("A👩🏽‍💻中文", 5, "…")).toBe("A👩🏽‍💻…");
		expect(truncateToWidth("e\u0301xyz", 2, "")).toBe("e\u0301x");
		expect(truncateToWidth("中文", 1)).toBe(".");
		expect(truncateToWidth("中文", 0)).toBe("");
		expect(truncateToWidth("中", 4, "", true)).toBe("中  ");
		expect(visibleWidth(truncateToWidth("A👩🏽‍💻中文", 5, "…", true))).toBe(5);
	});

	test("removes terminal controls while preserving ordinary text and literal HTML", () => {
		const input = "\u001b[31mRed\u001b[0m \u001b]8;;https://example.com\u0007Link\u001b]8;;\u0007\u001b_pi:c\u0007 <b>Text</b>";
		expect(plainText(input)).toBe("Red Link <b>Text</b>");
		expect(visibleWidth("\u001b[31m中文\u001b[0m")).toBe(4);
		expect(truncateToWidth("\u001b[31m中文\u001b[0m", 3, "")).toBe("中");
		expect(plainText("a\u0000b\u001b[2Jc")).toBe("abc");
	});
});
