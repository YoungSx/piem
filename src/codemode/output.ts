import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";

/**
 * Pi's output policy: retain text head/tail and preserve images. Buffer only the
 * text budget while the worker runs; return values and errors use the same sink.
 * Obsidian cannot spill to the CLI's temp directory, so truncation says so.
 */
export class ScriptOutput {
	private items: CodemodeOutputItem[] = [];
	private readonly images: CodemodeOutputItem[] = [];
	private chars = 0;
	private lines = 0;
	private textItems = 0;
	private head = "";
	private tail = "";
	private readonly budget: number;

	constructor(maxTokens: number) { this.budget = maxTokens * 4; }

	push(item: CodemodeOutputItem): void {
		if (item.type === "image") {
			this.images.push(item);
			if (this.chars <= this.budget) this.items.push(item);
			return;
		}
		const text = (this.textItems++ ? "\n" : "") + item.text;
		this.chars += text.length;
		for (const char of text) if (char === "\n") this.lines++;
		const headChars = Math.floor(this.budget / 2);
		const tailChars = this.budget - headChars;
		if (this.head.length < headChars) this.head += text.slice(0, headChars - this.head.length);
		this.tail = tailChars ? (this.tail + text.slice(-tailChars)).slice(-tailChars) : "";
		if (this.chars <= this.budget) this.items.push(item);
		else this.items = [];
	}

	content(): CodemodeOutputItem[] {
		if (this.chars <= this.budget) return this.items;
		return [{ type: "text", text:
			`Warning: truncated output (original token count: ${Math.ceil(this.chars / 4)})\n`
			+ `Total output lines: ${this.lines + 1}\n\n${this.head}…${Math.ceil((this.chars - this.budget) / 4)} tokens truncated…${this.tail}`
			+ "\n\n[Full output was not saved. Rerun with filtering or a larger max_output_tokens.]",
		}, ...this.images];
	}
}
