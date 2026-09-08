import { describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";
import type { McpServerConfig } from "../../mcp/mcpConfig";

// A Modal subclass needs a document to build its scaffold in, the settings rows
// call Obsidian's prototype helpers on it, and the stub has to be registered
// before the import below resolves. Installed here rather than relied on from a
// sibling test file, so this one passes when run alone.
installDom();
installObsidianDomHelpers();
installObsidianStub();
const { McpServerModal } = await import("./McpServerModal");

const t = getT("en");

/**
 * A row bound to a keychain entry, carrying the plaintext as plugin load left
 * it — which may be stale, because the keychain can be edited mid-session.
 */
function boundRow(token: string): McpServerConfig {
	return { id: "srv1", name: "Gateway", url: "https://gw.example.com/mcp", token, secretRef: "kc-gateway", enabled: true };
}

/** A form, opened, with what the probe saw and what a save would persist. */
function openForm(server: McpServerConfig, readSecret: (id: string) => string): {
	modal: InstanceType<typeof McpServerModal>;
	content: HTMLElement;
	tested: McpServerConfig[];
	saved: McpServerConfig[];
} {
	const tested: McpServerConfig[] = [];
	const saved: McpServerConfig[] = [];
	const modal = new McpServerModal({
		app: {} as App,
		server,
		// The plainest tier: its key row is one text field, so the draft's token
		// is visible without modelling the keychain picker. The resolution under
		// test happens in the constructor, before any tier-dependent rendering.
		secretStorage: "manual",
		readSecret,
		t,
		test: async (draft) => {
			tested.push(draft);
			return 0;
		},
		onSubmit: async (row) => {
			saved.push(row);
		},
	});
	modal.open();
	return { modal, content: modal.contentEl, tested, saved };
}

function clickButton(root: HTMLElement, label: string): void {
	const button = Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
	if (!button) {
		throw new Error(`no button labelled "${label}"`);
	}
	button.click();
}

/** Drains the probe's async chain: every await in it is a microtask. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The keychain is the home of a bound token; the settings object only holds the
 * snapshot read at plugin load. Opening the form has to resolve the binding
 * against the keychain as it stands, or the probe reports against — and a save
 * persists — a credential the user has already rotated or deleted.
 */
describe("McpServerModal keychain resolution at open", () => {
	it("probes the keychain's current token, not the row's load-time copy", async () => {
		const { content, tested } = openForm(boundRow("stale-from-load"), (id) => (id === "kc-gateway" ? "fresh-from-keychain" : ""));

		clickButton(content, t.t("test.button"));
		await flush();

		expect(tested).toHaveLength(1);
		expect(tested[0]?.token).toBe("fresh-from-keychain");
	});

	it("persists the resolved token when saving without edits", async () => {
		const { content, saved } = openForm(boundRow("stale-from-load"), (id) => (id === "kc-gateway" ? "fresh-from-keychain" : ""));

		clickButton(content, t.t("mcp.saveButton"));
		await flush();

		expect(saved).toHaveLength(1);
		expect(saved[0]?.token).toBe("fresh-from-keychain");
		expect(saved[0]?.secretRef).toBe("kc-gateway");
	});

	it("closes without a discard warning, since resolving is not an edit", () => {
		// The resolution runs before the dirty baseline, so a form opened on a
		// rotated entry closes on the first Esc. A regression that counted the
		// resolution as an edit would leave the modal open here.
		const { modal } = openForm(boundRow("stale-from-load"), (id) => (id === "kc-gateway" ? "fresh-from-keychain" : ""));

		modal.close();

		expect(modal.contentEl.childElementCount).toBe(0);
	});

	it("resolves a dangling binding to an empty token, not the stale one", async () => {
		// The entry was deleted from Obsidian's own UI. An empty token is the
		// honest starting value — it is what the probe would send.
		const { content, tested } = openForm(boundRow("stale-from-load"), () => "");

		clickButton(content, t.t("test.button"));
		await flush();

		expect(tested[0]?.token).toBe("");
	});

	it("leaves an inline token exactly as saved", () => {
		// With no binding there is nothing to resolve: the typed value is the
		// storage itself, and readSecret must not overwrite it.
		const row = boundRow("typed-inline");
		row.secretRef = "";
		const { content } = openForm(row, () => "should-not-be-read");

		const field = content.querySelector<HTMLInputElement>("input[type=password]");
		expect(field?.value).toBe("typed-inline");
	});
});
