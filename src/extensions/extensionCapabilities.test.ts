import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createExtensionHost, type ExtensionHostCallbacks } from "./extensionHost";
import { commandInfoList, toolInfoList, type CommandEntry } from "./extensionRegistry";
import { stubWindowTimers } from "../testUtils/windowStub";

// Self-sufficient: the host arms `window.setTimeout` on the disposal path, and
// `bun test` runs every file in one process, so a file that borrowed another's
// DOM would fail the moment it ran alone.
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

/**
 * A tool whose `execute` is the thing the projection must never forward.
 *
 * Calling it flips `executed`, so a test can assert the *absence* of a route to
 * it rather than merely the absence of a property called "execute".
 */
function spyTool(name: string, executed: { calls: number }): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({ path: Type.String({ description: "Vault-relative path." }) }),
		execute: async () => { executed.calls++; return { content: [{ type: "text", text: "ran" }], details: {} }; },
	};
}

async function makeHost(factory: ExtensionFactory, callbacks: Partial<ExtensionHostCallbacks> = {}) {
	return createExtensionHost([{ id: "capabilities", factory }], {
		getEntries: () => [], getBranch: () => [], getSessionId: () => "capability-session",
		notify: () => {}, isIdle: () => true, getSystemPrompt: () => "system", ...callbacks,
	});
}

describe("thinking level reaches the owning conversation", () => {
	it("applies the level and awaits the write before the operation settles", async () => {
		const levels: ThinkingLevel[] = [];
		const write = deferred<void>();
		const tracked: Promise<void>[] = [];
		const host = await makeHost(pi => {
			pi.registerCommand("think", { handler: async () => { pi.setThinkingLevel("high"); } });
		}, {
			setThinkingLevel: async level => { levels.push(level); await write.promise; },
			trackRequest: settled => { tracked.push(settled); },
		});
		try {
			// Pi's contract is synchronous `void`, so the command returns before the
			// Vault write lands — but the promise is handed to the host's tracker,
			// which is what keeps the turn from reporting settled ahead of it.
			await host.run("think");
			expect(levels).toEqual(["high"]);
			expect(tracked).toHaveLength(1);
			let settled = false;
			void tracked[0]!.then(() => { settled = true; });
			await Promise.resolve();
			expect(settled).toBe(false);
			write.resolve();
			await tracked[0];
			expect(settled).toBe(true);
		} finally { host.dispose(); }
	});

	it("surfaces a failed write instead of reporting success", async () => {
		const reported: Array<[string, string | undefined]> = [];
		const host = await makeHost(pi => {
			pi.registerCommand("think", { handler: async () => { pi.setThinkingLevel("max"); } });
		}, {
			setThinkingLevel: async () => { throw new Error("Session log is read-only."); },
			notify: (message, type) => { reported.push([message, type]); },
		});
		try {
			await host.run("think");
			// The command itself cannot fail — upstream types the action as void — so
			// the failure has to arrive on the panel's error channel. Silence here
			// would be a write that failed while the extension believed it landed.
			await Promise.resolve();
			await Promise.resolve();
			expect(reported).toEqual([["Session log is read-only.", "error"]]);
		} finally { host.dispose(); }
	});

	it("refuses a level set after the handler's first await", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		const finished = deferred<void>();
		const levels: ThinkingLevel[] = [];
		let failure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("late", { handler: async () => {
				entered.resolve();
				await resume.promise;
				try { pi.setThinkingLevel("low"); } catch (error) { failure = error; }
				finished.resolve();
			} });
		}, { setThinkingLevel: async level => { levels.push(level); } });
		try {
			const run = host.run("late");
			await entered.promise;
			host.cancel();
			await expect(run).rejects.toThrow("cancelled");
			resume.resolve();
			await finished.promise;
			// The same rule every other shared pi mutation follows: a stale host may
			// not reach through and move the current conversation's configuration.
			expect(String(failure)).toContain("synchronously");
			expect(levels).toEqual([]);
		} finally { resume.resolve(); host.dispose(); }
	});

	it("refuses a level set through a disposed host", async () => {
		const levels: ThinkingLevel[] = [];
		let captured: ExtensionAPI | undefined;
		const host = await makeHost(pi => { captured = pi; }, { setThinkingLevel: async level => { levels.push(level); } });
		host.dispose();
		expect(() => captured!.setThinkingLevel("medium")).toThrow();
		expect(levels).toEqual([]);
	});
});

describe("session name reaches the owning conversation", () => {
	it("renames through the host and awaits the write", async () => {
		const names: string[] = [];
		const tracked: Promise<void>[] = [];
		const host = await makeHost(pi => {
			pi.registerCommand("name", { handler: async () => { pi.setSessionName("Release notes"); } });
		}, {
			setSessionName: async name => { names.push(name); },
			getSessionName: () => names.at(-1),
			trackRequest: settled => { tracked.push(settled); },
		});
		try {
			await host.run("name");
			await Promise.all(tracked);
			expect(names).toEqual(["Release notes"]);
		} finally { host.dispose(); }
	});

	it("reports a rename that could not be written", async () => {
		const reported: string[] = [];
		const host = await makeHost(pi => {
			pi.registerCommand("name", { handler: async () => { pi.setSessionName("Blocked"); } });
		}, {
			setSessionName: async () => { throw new Error("Save the conversation first."); },
			notify: message => { reported.push(message); },
		});
		try {
			await host.run("name");
			await Promise.resolve();
			await Promise.resolve();
			expect(reported).toEqual(["Save the conversation first."]);
		} finally { host.dispose(); }
	});

	it("refuses a rename resumed after cancellation", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		const finished = deferred<void>();
		const names: string[] = [];
		let failure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("late", { handler: async () => {
				entered.resolve();
				await resume.promise;
				try { pi.setSessionName("stale"); } catch (error) { failure = error; }
				finished.resolve();
			} });
		}, { setSessionName: async name => { names.push(name); } });
		try {
			const run = host.run("late");
			await entered.promise;
			host.cancel();
			await expect(run).rejects.toThrow("cancelled");
			resume.resolve();
			await finished.promise;
			expect(String(failure)).toContain("synchronously");
			expect(names).toEqual([]);
		} finally { resume.resolve(); host.dispose(); }
	});
});

describe("compaction is triggered without being awaited", () => {
	it("returns before the summary lands and tracks it to completion", async () => {
		const started = deferred<void>();
		const summarized = deferred<boolean>();
		const tracked: Promise<void>[] = [];
		let calls = 0;
		const host = await makeHost(pi => {
			pi.registerCommand("tidy", { handler: async (_args, ctx) => { ctx.compact(); } });
		}, {
			compact: async () => { calls++; started.resolve(); return summarized.promise; },
			trackRequest: settled => { tracked.push(settled); },
		});
		try {
			// Upstream's own words: "Trigger compaction without awaiting completion."
			// The command finishes while the summarization is still in flight.
			await host.run("tidy");
			await started.promise;
			expect(calls).toBe(1);
			let settled = false;
			void tracked[0]!.then(() => { settled = true; });
			await Promise.resolve();
			expect(settled).toBe(false);
			summarized.resolve(true);
			await tracked[0];
			expect(settled).toBe(true);
		} finally { summarized.resolve(false); host.dispose(); }
	});

	it("reports a failed compaction through onError, and through notify without one", async () => {
		const errors: string[] = [];
		const reported: string[] = [];
		const host = await makeHost(pi => {
			pi.registerCommand("handled", { handler: async (_args, ctx) => {
				ctx.compact({ onError: error => { errors.push(error.message); } });
			} });
			pi.registerCommand("unhandled", { handler: async (_args, ctx) => { ctx.compact(); } });
		}, {
			compact: async () => { throw new Error("Summarization failed."); },
			notify: message => { reported.push(message); },
		});
		try {
			await host.run("handled");
			await Promise.resolve();
			await Promise.resolve();
			expect(errors).toEqual(["Summarization failed."]);
			// An extension that supplied onError owns the report; one that did not
			// must still not lose the failure.
			expect(reported).toEqual([]);
			await host.run("unhandled");
			await Promise.resolve();
			await Promise.resolve();
			expect(reported).toEqual(["Summarization failed."]);
		} finally { host.dispose(); }
	});

	it("refuses the options it cannot honour rather than ignoring them", async () => {
		let calls = 0;
		let instructions: unknown;
		let results: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("instructed", { handler: async (_args, ctx) => {
				try { ctx.compact({ customInstructions: "Keep the API notes." }); }
				catch (error) { instructions = error; }
			} });
			pi.registerCommand("watched", { handler: async (_args, ctx) => {
				try { ctx.compact({ onComplete: () => {} }); }
				catch (error) { results = error; }
			} });
		}, { compact: async () => { calls++; return true; } });
		try {
			await host.run("instructed");
			await host.run("watched");
			// Both fail loudly: piem's pipeline has nowhere truthful to put custom
			// instructions, and its compaction entry has no `firstKeptEntryId` for
			// Pi's CompactionResult. A silently ignored option is worse than an
			// explicit refusal — the extension would believe its summary honoured it.
			expect(String(instructions)).toContain("does not support");
			expect(String(results)).toContain("does not support");
			expect(calls).toBe(0);
		} finally { host.dispose(); }
	});

	it("refuses compaction requested after the handler's first await", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		const finished = deferred<void>();
		let calls = 0;
		let failure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("late", { handler: async (_args, ctx) => {
				entered.resolve();
				await resume.promise;
				try { ctx.compact(); } catch (error) { failure = error; }
				finished.resolve();
			} });
		}, { compact: async () => { calls++; return true; } });
		try {
			const run = host.run("late");
			await entered.promise;
			host.cancel();
			await expect(run).rejects.toThrow("cancelled");
			resume.resolve();
			await finished.promise;
			expect(failure).toBeInstanceOf(DOMException);
			expect(calls).toBe(0);
		} finally { resume.resolve(); host.dispose(); }
	});
});

describe("tool and command metadata", () => {
	it("answers from the conversation's own registries", async () => {
		const executed = { calls: 0 };
		const tools = [spyTool("read_note", executed), spyTool("write_note", executed)];
		const commands: CommandEntry[] = [
			{ name: "context", description: "Show context usage", kind: "extension" },
			{ name: "summarize", description: "Summarize the note", kind: "template" },
			{ name: "distill-skill", description: "Distill a skill", kind: "skill" },
		];
		let seenTools: ReturnType<typeof toolInfoList> = [];
		let seenCommands: ReturnType<typeof commandInfoList> = [];
		const host = await makeHost(pi => {
			pi.registerCommand("inspect", { handler: async () => {
				seenTools = pi.getAllTools();
				seenCommands = pi.getCommands();
			} });
		}, { getAllTools: () => tools, getCommands: () => commands });
		try {
			await host.run("inspect");
			expect(seenTools.map(tool => tool.name)).toEqual(["read_note", "write_note"]);
			expect(seenTools[0]?.description).toBe("read_note description");
			expect(seenTools[0]?.sourceInfo.source).toBe("piem");
			// The `kind` piem's panel uses maps onto Pi's SlashCommandSource; a
			// template is a "prompt" upstream.
			expect(seenCommands.map(command => [command.name, command.source])).toEqual([
				["context", "extension"], ["summarize", "prompt"], ["distill-skill", "skill"],
			]);
		} finally { host.dispose(); }
	});

	it("exposes no executable reference or credential through the returned metadata", async () => {
		const executed = { calls: 0 };
		// A tool carrying exactly the members that must not travel: the live
		// `execute` closure, and a header holding a real secret.
		const leaky: AgentTool & { headers?: Record<string, string> } = {
			...spyTool("web_fetch", executed),
			headers: { Authorization: "Bearer sk-live-secret" },
		};
		let seen: ReturnType<typeof toolInfoList> = [];
		let commandSeen: ReturnType<typeof commandInfoList> = [];
		const host = await makeHost(pi => {
			pi.registerCommand("audit", { handler: async () => {
				seen = pi.getAllTools();
				commandSeen = pi.getCommands();
			} });
		}, {
			getAllTools: () => [leaky],
			getCommands: () => [{ name: "clarify", description: "Rewrite a draft", kind: "extension" }],
		});
		try {
			await host.run("audit");

			// Walk the whole returned graph. Asserting "no property named execute"
			// would pass on a copy that renamed it; this asserts no function and no
			// secret is reachable by any path at all.
			const functions: string[] = [];
			const secrets: string[] = [];
			const walk = (value: unknown, path: string, seenObjects: Set<object>): void => {
				if (typeof value === "function") { functions.push(path); return; }
				if (typeof value === "string") {
					if (value.includes("sk-live-secret") || value.includes("Bearer")) secrets.push(path);
					return;
				}
				if (!value || typeof value !== "object" || seenObjects.has(value)) return;
				seenObjects.add(value);
				// Own keys, including non-enumerable and symbol-keyed ones: a stripped
				// copy that hid the closure behind a symbol would still be a leak.
				for (const key of Reflect.ownKeys(value)) {
					walk(Reflect.get(value, key), `${path}.${String(key)}`, seenObjects);
				}
			};
			walk(seen, "getAllTools()", new Set());
			walk(commandSeen, "getCommands()", new Set());
			expect(functions).toEqual([]);
			expect(secrets).toEqual([]);
			expect(executed.calls).toBe(0);

			// The live tool is untouched: the projection copied out, it did not strip
			// in place, so the agent can still call what it holds.
			expect(typeof leaky.execute).toBe("function");
			expect(leaky.headers?.Authorization).toBe("Bearer sk-live-secret");
		} finally { host.dispose(); }
	});

	it("hands out a schema copy an extension cannot use to edit the live tool", async () => {
		const executed = { calls: 0 };
		const tool = spyTool("read_note", executed);
		const original = JSON.stringify(tool.parameters);
		const host = await makeHost(pi => {
			pi.registerCommand("mutate", { handler: async () => {
				const [info] = pi.getAllTools();
				// The schemas are built once per tool and shared with the request the
				// agent sends the provider, so a live reference would let an extension
				// rewrite what the model is told a parameter means.
				Reflect.set(info!.parameters as object, "properties", { hijacked: { type: "string" } });
			} });
		}, { getAllTools: () => [tool] });
		try {
			await host.run("mutate");
			expect(JSON.stringify(tool.parameters)).toBe(original);
		} finally { host.dispose(); }
	});

	it("refuses both reads through a disposed host", async () => {
		let captured: ExtensionAPI | undefined;
		let toolReads = 0;
		const host = await makeHost(pi => { captured = pi; }, {
			getAllTools: () => { toolReads++; return []; }, getCommands: () => [],
		});
		host.dispose();
		expect(() => captured!.getAllTools()).toThrow();
		expect(() => captured!.getCommands()).toThrow();
		expect(toolReads).toBe(0);
	});

	it("identifies the missing capability rather than answering empty", async () => {
		let toolFailure: unknown;
		let commandFailure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("probe", { handler: async () => {
				try { pi.getAllTools(); } catch (error) { toolFailure = error; }
				try { pi.getCommands(); } catch (error) { commandFailure = error; }
			} });
		});
		try {
			await host.run("probe");
			// A host wired without these callbacks must say so. An empty array would
			// read as "this conversation has no tools", which is a different claim.
			expect(String(toolFailure)).toContain("host.getAllTools");
			expect(String(commandFailure)).toContain("host.getCommands");
		} finally { host.dispose(); }
	});
});

describe("registry projection in isolation", () => {
	it("keeps reading a tool list an extension already mutated", () => {
		const executed = { calls: 0 };
		const info = toolInfoList([spyTool("one", executed)]);
		info.length = 0;
		expect(toolInfoList([spyTool("one", executed)])).toHaveLength(1);
	});

	it("names each entry's own kind in its source path", () => {
		const [template, skill] = commandInfoList([
			{ name: "summarize", description: "", kind: "template" },
			{ name: "vault-memory", description: "", kind: "skill" },
		]);
		expect(template?.sourceInfo.path).toBe("<piem:template:summarize>");
		expect(skill?.sourceInfo.path).toBe("<piem:skill:vault-memory>");
		// Synthetic, because nothing here is a file an extension could open: a
		// vault tool is compiled into main.js and a builtin skill is a string.
		expect(template?.sourceInfo.scope).toBe("temporary");
	});
});
