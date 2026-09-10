import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "@earendil-works/pi-tui";
import { bindNativeTree, type CompatComponent } from "./componentTree";
import { matchesKey } from "./keys";
import { plainText, truncateToWidth, visibleWidth } from "./textMetrics";
import { nativeCallbackResult } from "./callbackResult";

export type { SelectItem, SelectListLayoutOptions, SelectListTheme };

export class SelectList implements CompatComponent {
	private filteredItems: SelectItem[];
	private selectedIndex = 0;
	private disposed = false;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(private items: SelectItem[], private maxVisible: number, private theme: SelectListTheme, private layout: SelectListLayoutOptions = {}) {
		this.filteredItems = items;
	}

	setFilter(filter: string): void {
		if (this.disposed) return;
		this.filteredItems = this.items.filter(item => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.selectedIndex = 0;
	}
	setSelectedIndex(index: number): void {
		if (this.disposed) return;
		this.selectedIndex = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), this.filteredItems.length - 1)) : 0;
	}
	getSelectedItem(): SelectItem | null { return this.disposed ? null : this.filteredItems[this.selectedIndex] ?? null; }
	invalidate(): void { /* Native controls do not cache terminal styling. */ }

	private choose(items: readonly SelectItem[], index: number, confirm: boolean): void | Promise<void> {
		if (this.disposed || !Number.isInteger(index)) return;
		const item = items[index];
		if (!item) return;
		const currentIndex = this.filteredItems.indexOf(item);
		if (currentIndex < 0) return;
		const changed = this.selectedIndex !== currentIndex;
		this.selectedIndex = currentIndex;
		return nativeCallbackResult([
			() => { if (changed) return this.onSelectionChange?.(item); },
			() => { if (confirm && !this.disposed) return this.onSelect?.(item); },
		]);
	}

	private displayText(item: SelectItem, index: number, columnWidth: number): string {
		const text = item.label || item.value;
		const value = this.layout.truncatePrimary?.({ text, maxWidth: columnWidth, columnWidth, item, isSelected: index === this.selectedIndex }) ?? text;
		return plainText(value);
	}

	render(width: number): string[] {
		const items = this.disposed ? [] : [...this.filteredItems];
		const maxVisible = Number.isFinite(this.maxVisible) ? Math.max(1, Math.floor(this.maxVisible)) : 5;
		const min = this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? 32;
		const max = this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? 32;
		const widest = items.reduce((used, item) => Math.max(used, visibleWidth(item.label || item.value) + 2), 0);
		const columnWidth = Math.max(1, Math.min(width - 4, Math.max(Math.min(min, max), Math.min(widest, Math.max(min, max)))));
		const nativeItems = items.map((item, index) => ({
			value: item.value,
			label: plainText(index === this.selectedIndex ? this.theme.selectedText(this.displayText(item, index, columnWidth)) : this.displayText(item, index, columnWidth)),
			description: item.description === undefined ? undefined : plainText(this.theme.description(item.description)),
		}));
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const visible = nativeItems.slice(start, start + maxVisible);
		const lines = visible.map((item, offset) => truncateToWidth(`${start + offset === this.selectedIndex ? "→ " : "  "}${item.label}${item.description ? `  ${item.description.replace(/[\r\n]+/g, " ")}` : ""}`, width, ""));
		if (!items.length) lines.push(plainText(this.theme.noMatch("  No matching commands")));
		if (items.length > maxVisible) lines.push(plainText(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${items.length})`)));
		return bindNativeTree(lines, {
			kind: "select", items: nativeItems, selectedIndex: this.selectedIndex, maxVisible,
			onSelect: index => this.choose(items, index, true),
			onSelectionChange: index => this.choose(items, index, false),
			onCancel: () => nativeCallbackResult([() => { if (!this.disposed) return this.onCancel?.(); }]),
		});
	}

	handleInput(data: string): void | Promise<void> {
		if (this.disposed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return nativeCallbackResult([() => this.onCancel?.()]);
		if (matchesKey(data, "enter")) { const item = this.getSelectedItem(); if (item) return nativeCallbackResult([() => this.onSelect?.(item)]); return; }
		if (!this.filteredItems.length) return;
		if (matchesKey(data, "up")) this.selectedIndex = (this.selectedIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
		else if (matchesKey(data, "down")) this.selectedIndex = (this.selectedIndex + 1) % this.filteredItems.length;
		else return;
		const item = this.getSelectedItem();
		if (item) return nativeCallbackResult([() => this.onSelectionChange?.(item)]);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.items = [];
		this.filteredItems = [];
		this.onSelect = undefined;
		this.onCancel = undefined;
		this.onSelectionChange = undefined;
	}
}
