import { plainText } from "./textMetrics";

/** The structural part of Pi's Component contract; no terminal is constructed. */
export interface CompatComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void | Promise<void>;
	dispose?(): void;
}

export interface NativeSelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** Data and explicit callbacks only. Text is never HTML or an interaction protocol. */
export type NativeComponentNode =
	| { readonly kind: "container"; readonly children: readonly NativeComponentNode[] }
	| { readonly kind: "text"; readonly text: string; readonly paddingX: number; readonly paddingY: number }
	| { readonly kind: "select"; readonly items: readonly NativeSelectItem[]; readonly selectedIndex: number; readonly maxVisible: number;
		readonly onSelect: (index: number) => void | Promise<void>; readonly onSelectionChange: (index: number) => void | Promise<void>; readonly onCancel: () => void | Promise<void> }
	| { readonly kind: "border" }
	| { readonly kind: "loader"; readonly text: string; readonly cancellable: boolean; readonly aborted: boolean; readonly onCancel: () => void | Promise<void> };

const nativeRenders = new WeakMap<readonly string[], { lines: readonly string[]; tree: NativeComponentNode }>();

function snapshotTree(node: NativeComponentNode): NativeComponentNode {
	if (node.kind === "container") return Object.freeze({ ...node, children: Object.freeze(node.children.map(snapshotTree)) });
	if (node.kind === "select") return Object.freeze({ ...node, items: Object.freeze(node.items.map(item => Object.freeze({ ...item }))) });
	return Object.freeze({ ...node });
}

/** Internal component seam: wrappers returning these exact lines retain the tree. */
export function bindNativeTree(lines: string[], tree: NativeComponentNode): string[] {
	nativeRenders.set(lines, { lines: [...lines], tree: snapshotTree(tree) });
	return lines;
}

/** Array copying/rewriting deliberately loses semantics rather than guessing UI. */
export function readNativeTree(lines: readonly string[]): NativeComponentNode | undefined {
	const render = nativeRenders.get(lines);
	if (!render || render.lines.length !== lines.length || render.lines.some((line, i) => line !== lines[i])) return undefined;
	return snapshotTree(render.tree);
}

export function plainTextNode(lines: readonly string[]): NativeComponentNode {
	return { kind: "text", text: plainText(lines.join("\n")), paddingX: 0, paddingY: 0 };
}

export function renderNativeComponent(component: CompatComponent, width: number): NativeComponentNode {
	const lines = component.render(width);
	return readNativeTree(lines) ?? plainTextNode(lines);
}
