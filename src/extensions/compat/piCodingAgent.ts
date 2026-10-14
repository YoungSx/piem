/** Browser exports only; never import the CLI root or its filesystem configuration. */
export { BorderedLoader, DynamicBorder } from "./loader";
export { theme, getSelectListTheme } from "./theme";
import { EXTENSION_CONFIG_ROOT } from "../extensionConfigStore";

/**
 * The one virtual agent directory, shared with the scoped platform's own
 * `getAgentDir`.
 *
 * This used to answer `/vault/.pi/agent` while the scoped platform answered
 * `/extensions/config`, which meant a non-scoped extension resolving a config
 * path built one no reader could serve: the resource `fs` only holds each
 * audited package's `package.json`, so every such read returned ENOENT and the
 * extension silently fell back to its defaults. Two values could only ever
 * agree by accident, so there is now one.
 */
export const getAgentDir = (): string => EXTENSION_CONFIG_ROOT;

/**
 * Pi's config directory name, `.pi`. Upstream extensions join it with a home or
 * cwd to spell their storage path (`<cwd>/.pi/<file>.json`); the platform's
 * config bridge translates that `.pi` root into the owner's namespace.
 */
export const CONFIG_DIR_NAME = ".pi";

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					chars += b.text.length;
				} else if (b.type === "image") {
					chars += ESTIMATED_IMAGE_CHARS;
				}
			}
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const msg = message as Record<string, unknown>;
	let chars = 0;
	switch (msg.role) {
		case "system": {
			chars = estimateTextAndImageContentChars(msg.content);
			if (msg.sections && typeof msg.sections === "object") {
				for (const section of Object.values(msg.sections as Record<string, unknown>)) {
					if (typeof section === "string") chars += section.length;
				}
			}
			if (msg.toolsAdded) chars += JSON.stringify(msg.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
		case "user": {
			chars = estimateTextAndImageContentChars(msg.content);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block && typeof block === "object") {
						const b = block as Record<string, unknown>;
						if (b.type === "text" && typeof b.text === "string") {
							chars += b.text.length;
						} else if (b.type === "thinking" && typeof b.thinking === "string") {
							chars += b.thinking.length;
						} else if (b.type === "toolCall") {
							const nameLen = typeof b.name === "string" ? b.name.length : 0;
							const argsLen = b.arguments ? JSON.stringify(b.arguments).length : 2;
							chars += nameLen + argsLen;
						}
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(msg.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			const cmdLen = typeof msg.command === "string" ? msg.command.length : 0;
			const outLen = typeof msg.output === "string" ? msg.output.length : 0;
			chars = cmdLen + outLen;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = typeof msg.summary === "string" ? msg.summary.length : 0;
			return Math.ceil(chars / 4);
		}
		default:
			return 0;
	}
}
