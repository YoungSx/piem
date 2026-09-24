import { describe, expect, it } from "bun:test";
import { journalKey } from "./journal";

describe("journalKey", () => {
	it("is a stable 32-char hex over the fields that decide the work", async () => {
		const key = await journalKey({ prompt: "do a thing" });
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		expect(await journalKey({ prompt: "do a thing" })).toBe(key);
	});

	it("ignores phase-only changes but reacts to prompt, model, effort, schema", async () => {
		const base = { prompt: "p", model: "m", effort: "high" };
		const baseKey = await journalKey(base);
		// Same decision fields → same key.
		expect(await journalKey({ ...base })).toBe(baseKey);
		// Each decision field changes it.
		expect(await journalKey({ ...base, prompt: "q" })).not.toBe(baseKey);
		expect(await journalKey({ ...base, model: "n" })).not.toBe(baseKey);
		expect(await journalKey({ ...base, effort: "low" })).not.toBe(baseKey);
		expect(await journalKey({ ...base, schema: '{"type":"object"}' })).not.toBe(baseKey);
	});

	it("keys a schema-less call identically whether schema is absent or undefined", async () => {
		expect(await journalKey({ prompt: "p", schema: undefined })).toBe(await journalKey({ prompt: "p" }));
	});
});
