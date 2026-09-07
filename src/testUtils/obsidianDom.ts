/**
 * Obsidian's DOM convenience helpers, for tests that render settings UI.
 *
 * Obsidian patches `createEl`, `createDiv`, `createSpan`, `setText`,
 * `toggleClass`, `addClass`, and `removeClass` onto `HTMLElement.prototype` at
 * runtime, and the settings rows call them directly. `installDom` provides the
 * two the chat panel needs (`empty`, `setCssProps`); the rest live here so a test
 * that renders a settings row does not have to reimplement them.
 *
 * The prototype is reached through an untyped record rather than a declared
 * interface: `obsidian`'s own declarations already augment `HTMLElement` with
 * these members, and restating them produces a structurally incompatible
 * override of the tag-generic `createEl` rather than a compatible one.
 *
 * Deliberately minimal — only the option fields production code actually passes.
 * A helper that accepted more than Obsidian does would let a test pass on markup
 * the real app would not produce.
 */

interface DomElementOptions {
	cls?: string | string[];
	text?: string;
	href?: string;
	attr?: Record<string, string | number | boolean>;
}

type Helpers = Record<string, unknown>;

let installed = false;

export function installObsidianDomHelpers(): void {
	if (installed) {
		return;
	}
	const prototype = (globalThis as unknown as { HTMLElement: { prototype: Helpers } }).HTMLElement.prototype;

	function createEl(this: HTMLElement, tag: string, options: DomElementOptions = {}): HTMLElement {
		const element = this.ownerDocument.createElement(tag);
		if (options.cls) {
			element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
		}
		if (options.text !== undefined) {
			element.textContent = options.text;
		}
		if (options.href !== undefined) {
			element.setAttribute("href", options.href);
		}
		for (const [name, value] of Object.entries(options.attr ?? {})) {
			element.setAttribute(name, String(value));
		}
		this.appendChild(element);
		return element;
	}

	prototype.createEl = createEl;
	prototype.createDiv = function createDiv(this: HTMLElement, options: DomElementOptions = {}): HTMLElement {
		return createEl.call(this, "div", options);
	};
	prototype.createSpan = function createSpan(this: HTMLElement, options: DomElementOptions = {}): HTMLElement {
		return createEl.call(this, "span", options);
	};
	prototype.setText = function setText(this: HTMLElement, text: string): void {
		this.textContent = text;
	};
	prototype.toggleClass = function toggleClass(this: HTMLElement, cls: string, value: boolean): void {
		this.classList.toggle(cls, value);
	};
	// Unconditional siblings of `toggleClass`. Present because production reaches
	// for them where the condition is already decided — a modal that is always a
	// settings modal, a verdict line that is already known to be a warning — and a
	// missing one fails as `addClass is not a function` in whichever test first
	// renders that path, rather than where the gap actually is.
	prototype.addClass = function addClass(this: HTMLElement, ...classes: string[]): void {
		this.classList.add(...classes);
	};
	prototype.removeClass = function removeClass(this: HTMLElement, ...classes: string[]): void {
		this.classList.remove(...classes);
	};
	// Obsidian's array form (`removeClasses(classes: string[])`), which the
	// connection-test verdict uses to drop several state classes at once.
	prototype.removeClasses = function removeClasses(this: HTMLElement, classes: string[]): void {
		this.classList.remove(...classes);
	};
	prototype.hide = function hide(this: HTMLElement): void {
		this.style.display = "none";
	};
	prototype.show = function show(this: HTMLElement): void {
		this.style.display = "";
	};

	installed = true;
}
