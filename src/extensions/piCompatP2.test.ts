import { describe, expect, it } from "bun:test";
import { createExtensionHost, type ExtensionHostCallbacks } from "./extensionHost";
import type { ExtensionFactory, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { createNativeExtensionUI } from "./nativeExtensionUI";
import { ExtensionLifetime } from "./extensionLifetime";
import type { ExtensionUIAdapter, NativeExtensionSurface } from "./extensionUI";

function baseCallbacks(overrides: Partial<ExtensionHostCallbacks> = {}): ExtensionHostCallbacks {
	return {
		getEntries: () => [],
		notify: () => {},
		...overrides,
	};
}

describe("Pi Compat Phase 2 - Tree navigation & session lifecycle", () => {
	it("intercepts navigateTree when session_before_tree cancels it", async () => {
		let beforeTreeFired = false;
		let receivedTargetId = "";
		let navResult: { cancelled: boolean } | undefined;

		const factory: ExtensionFactory = pi => {
			pi.on("session_before_tree", (event: SessionBeforeTreeEvent) => {
				beforeTreeFired = true;
				receivedTargetId = event.preparation.targetId;
				return { cancel: true };
			});
			pi.registerCommand("test-nav", {
				handler: async (_args, ctx) => {
					navResult = await ctx.navigateTree("target-node");
				},
			});
		};

		let innerNavigateCalled = false;
		const mockSession = {
			getLeafId: () => "leaf-1",
			getEntry: (_id: string) => undefined,
			flush: async () => {},
			navigateTree: async () => {
				innerNavigateCalled = true;
				return { cancelled: false };
			},
		};

		const host = await createExtensionHost(
			[{ id: "test-ext", factory }],
			baseCallbacks({ session: mockSession as any }),
		);
		try {
			await host.run("test-nav", "");

			expect(beforeTreeFired).toBe(true);
			expect(receivedTargetId).toBe("target-node");
			expect(navResult).toEqual({ cancelled: true });
			expect(innerNavigateCalled).toBe(false);
		} finally {
			host.dispose();
		}
	});

	it("wires newSession, fork, and switchSession callbacks", async () => {
		let newSessionCalled = false;
		let forkedEntryId = "";
		let switchedPath = "";

		const factory: ExtensionFactory = pi => {
			pi.registerCommand("test-session-cmds", {
				handler: async (_args, ctx) => {
					await ctx.newSession();
					await ctx.fork("entry-123", { position: "at" });
					await ctx.switchSession("/target.jsonl");
				},
			});
		};

		const host = await createExtensionHost(
			[{ id: "test-cmds", factory }],
			baseCallbacks({
				newSession: async () => {
					newSessionCalled = true;
					return { cancelled: false };
				},
				fork: async (entryId: string) => {
					forkedEntryId = entryId;
					return { cancelled: false };
				},
				switchSession: async (path: string) => {
					switchedPath = path;
					return { cancelled: false };
				},
			}),
		);
		try {
			await host.run("test-session-cmds", "");

			expect(newSessionCalled).toBe(true);
			expect(forkedEntryId).toBe("entry-123");
			expect(switchedPath).toBe("/target.jsonl");
		} finally {
			host.dispose();
		}
	});
});

describe("Pi Compat Phase 2 - Provider lifecycle & unregistration", () => {
	it("registers providers and automatically unregisters them on host disposal", async () => {
		const registeredProviders: string[] = [];
		const unregisteredProviders: string[] = [];

		const factory: ExtensionFactory = pi => {
			pi.registerProvider("custom-llm", {
				baseUrl: "https://custom.llm/v1",
			} as any);
		};

		const host = await createExtensionHost(
			[{ id: "provider-ext", factory }],
			baseCallbacks({
				registerProvider: (name: string) => {
					registeredProviders.push(name);
				},
				unregisterProvider: (name: string) => {
					unregisteredProviders.push(name);
				},
			}),
		);
		try {
			expect(registeredProviders).toContain("custom-llm");
			expect(unregisteredProviders).toEqual([]);

			host.dispose();
			expect(unregisteredProviders).toContain("custom-llm");
		} finally {
			host.dispose();
		}
	});
});

describe("Pi Compat Phase 2 - Message & Entry renderers", () => {
	it("preserves message and entry renderers without ignoring them", async () => {
		const factory: ExtensionFactory = pi => {
			pi.registerMessageRenderer("custom-card", () => undefined);
			pi.registerEntryRenderer("custom-entry", () => undefined);
		};

		const host = await createExtensionHost(
			[{ id: "renderers-ext", factory }],
			baseCallbacks(),
		);
		try {
			expect(host.getMessageRenderer("custom-card")).toBeDefined();
			expect(host.getEntryRenderer("custom-entry")).toBeDefined();
			expect(host.getMessageRenderer("nonexistent")).toBeUndefined();
		} finally {
			host.dispose();
		}
	});
});

describe("Pi Compat Phase 2 - UI Widgets (setTitle, setHeader, setFooter)", () => {
	it("delegates setTitle, setHeader, setFooter to adapter gracefully", () => {
		let currentTitle = "";
		let headerSurface: NativeExtensionSurface | undefined;
		let footerSurface: NativeExtensionSurface | undefined;

		const mockAdapter: Partial<ExtensionUIAdapter> = {
			setStatus: () => {},
			setWidget: () => {},
			setTitle: (title?: string) => {
				currentTitle = title ?? "";
			},
			setHeaderComponent: (surface?: NativeExtensionSurface) => {
				headerSurface = surface;
			},
			setFooterComponent: (surface?: NativeExtensionSurface) => {
				footerSurface = surface;
			},
		};

		const lifetime = new ExtensionLifetime();
		const nativeUI = createNativeExtensionUI(
			lifetime,
			() => mockAdapter as ExtensionUIAdapter,
			() => {},
		);
		try {
			nativeUI.ui.setTitle?.("Session Alpha");
			expect(currentTitle).toBe("Session Alpha");

			nativeUI.ui.setHeader?.((() => ({
				render: () => ["Header text"],
				invalidate: () => {},
			})) as any);
			expect(headerSurface).toBeDefined();

			nativeUI.ui.setFooter?.((() => ({
				render: () => ["Footer text"],
				invalidate: () => {},
			})) as any);
			expect(footerSurface).toBeDefined();
		} finally {
			lifetime.dispose();
		}
	});

	it("gracefully ignores setTitle, setHeader, setFooter when UI is unavailable", () => {
		const lifetime = new ExtensionLifetime();
		const nativeUI = createNativeExtensionUI(
			lifetime,
			() => undefined,
			() => {},
		);
		try {
			const factory = (() => ({
				render: () => ["headless"],
				invalidate: () => {},
			})) as any;
			expect(() => nativeUI.ui.setTitle?.("Headless")).not.toThrow();
			expect(() => nativeUI.ui.setHeader?.(undefined)).not.toThrow();
			expect(() => nativeUI.ui.setFooter?.(undefined)).not.toThrow();
			expect(() => nativeUI.ui.setHeader?.(factory)).not.toThrow();
			expect(() => nativeUI.ui.setFooter?.(factory)).not.toThrow();
		} finally {
			lifetime.dispose();
		}
	});
});
