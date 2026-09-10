import { bindNativeTree, plainTextNode, readNativeTree, type CompatComponent, type NativeComponentNode } from "./componentTree";
import { runComponentCleanups } from "./componentRuntime";
import { plainText, visibleWidth, wrapPlainText } from "./textMetrics";

export class Container implements CompatComponent {
	children: CompatComponent[] = [];
	private disposed = false;

	addChild(component: CompatComponent): void { if (!this.disposed) this.children.push(component); }
	removeChild(component: CompatComponent): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
	}
	clear(): void { this.children = []; }
	invalidate(): void { if (!this.disposed) for (const child of this.children) child.invalidate(); }
	render(width: number): string[] {
		const lines: string[] = [];
		const children: NativeComponentNode[] = [];
		if (!this.disposed) for (const child of this.children) {
			const rendered = child.render(width);
			lines.push(...rendered);
			children.push(readNativeTree(rendered) ?? plainTextNode(rendered));
		}
		return bindNativeTree(lines, { kind: "container", children });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const children = this.children;
		this.children = [];
		runComponentCleanups(children.map(child => () => child.dispose?.()));
	}
}

export class Text implements CompatComponent {
	private disposed = false;
	constructor(private text = "", private paddingX = 1, private paddingY = 1, private customBgFn?: (text: string) => string) {}
	setText(text: string): void { if (!this.disposed) this.text = text; }
	setCustomBgFn(customBgFn?: (text: string) => string): void { this.customBgFn = customBgFn; }
	invalidate(): void { /* no terminal layout cache */ }
	render(width: number): string[] {
		const text = this.disposed ? "" : plainText(this.text);
		const available = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		const paddingX = Math.min(Math.max(0, Math.floor(this.paddingX)), Math.floor((available - 1) / 2));
		const paddingY = Math.max(0, Math.floor(this.paddingY));
		const lines = text.trim() ? wrapPlainText(text, available - paddingX * 2).map(line => {
			const padded = " ".repeat(paddingX) + line + " ".repeat(Math.max(paddingX, available - paddingX - visibleWidth(line)));
			return plainText(this.customBgFn?.(padded) ?? padded);
		}) : [];
		if (lines.length) {
			const empty = " ".repeat(available);
			lines.unshift(...Array<string>(paddingY).fill(empty));
			lines.push(...Array<string>(paddingY).fill(empty));
		}
		return bindNativeTree(lines, { kind: "text", text, paddingX, paddingY });
	}
	dispose(): void { this.disposed = true; this.text = ""; this.customBgFn = undefined; }
}
