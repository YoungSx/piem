import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createExtensionHost, type ExtensionHost, type ExtensionHostCallbacks } from "./extensionHost";
import { invisibleContinue, modelSwitch, provenance } from "./communityFactories.mjs";

/** Stable shipped identities; installing code remains a build/release operation. */
const factories = [
	{ id: "pi-invisible-continue", factory: invisibleContinue },
	{ id: "pi-assistant-provenance", factory: provenance },
	{ id: "pi-model-switch", factory: modelSwitch },
];

/** Captures synchronous Pi message actions, so the caller can await their real dispatch. */
export class CommunityHost {
	private host!: ExtensionHost;
	private pending: AgentMessage[] | undefined;
	private disposed = false;

	static async create(callbacks: Omit<ExtensionHostCallbacks, "sendMessage">): Promise<CommunityHost> {
		const owner = new CommunityHost();
		owner.host = await createExtensionHost(factories, {
			...callbacks,
			sendMessage: (message, options) => {
				if (owner.disposed || !owner.pending) throw new Error("Extension message escaped its command.");
				if (!options?.triggerTurn || options.deliverAs !== "followUp") throw new Error("Only queued follow-up turns are supported.");
				if (owner.pending.length >= 16) throw new Error("Too many extension messages in one command.");
				owner.pending.push({ ...structuredClone(message), role: "custom", timestamp: Date.now() });
			},
		});
		for (const tool of owner.host.tools) {
			if (tool.name === "switch_model") tool.description += " In Piem, only unambiguous models with a configured API key are available. A switch changes the next request in this conversation and saves the default choice; that provider receives the conversation. Pricing is unknown. Local aliases.json configuration is not mounted.";
		}
		return owner;
	}

	get tools() { return this.host.tools; }
	get commands() { return this.host.commands; }

	async run(name: string, args = ""): Promise<AgentMessage[]> {
		if (this.pending) throw new Error("Another extension command is already running.");
		this.pending = [];
		try {
			await this.host.run(name, args);
			if (this.disposed || !this.pending) throw new Error("Extension host was disposed.");
			return this.pending;
		} finally { this.pending = undefined; }
	}

	transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		return this.host.transformContext(messages);
	}

	dispose(): void {
		this.disposed = true;
		this.host.dispose();
		this.pending = undefined;
	}
}
