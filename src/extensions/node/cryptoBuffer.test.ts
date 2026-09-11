import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { build } from "esbuild";
import vm from "node:vm";
import { stubWindowMembers } from "../../testUtils/windowStub";
import { Buffer as BrowserBuffer } from "./buffer";
import { createHash, randomBytes, randomUUID } from "./crypto";

let restoreWindow: () => void;
beforeEach(() => { restoreWindow = stubWindowMembers({ crypto: globalThis.crypto }); });
afterEach(() => { restoreWindow(); });

describe("browser Buffer and crypto bridge", () => {
	it("keeps UTF-8 and hex encodings compatible with Node", () => {
		expect(BrowserBuffer).not.toBe(Buffer);
		for (const text of ["", "ascii", "中文🌿", "broken\ud800surrogate"]) {
			expect(BrowserBuffer.byteLength(text)).toBe(Buffer.byteLength(text));
			expect(BrowserBuffer.from(text).toString("hex")).toBe(Buffer.from(text).toString("hex"));
			expect(BrowserBuffer.from(text).toString("utf8")).toBe(Buffer.from(text).toString("utf8"));
		}
		expect(BrowserBuffer.from("e4b8ade69687", "hex").toString("utf8")).toBe("中文");
	});

	it("subarray keeps Buffer methods and shares exactly its source byte range", () => {
		const bytes = BrowserBuffer.from("中文🌿tail");
		const prefix = bytes.subarray(0, 10);
		expect(BrowserBuffer.isBuffer(prefix)).toBe(true);
		if (!BrowserBuffer.isBuffer(prefix)) throw new Error("subarray lost Buffer methods");
		expect(prefix.toString("utf8")).toBe("中文🌿");
		expect(prefix.buffer).toBe(bytes.buffer);
		const tail = bytes.subarray(-4);
		tail[0] = 83;
		expect(bytes.toString("utf8")).toBe("中文🌿Sail");
		const offset = BrowserBuffer.from(bytes.buffer, bytes.byteOffset + 6, 4);
		expect(offset.toString("utf8")).toBe("🌿");
	});

	it("hashes synchronously against SHA-256 reference vectors and preserves binary view offsets", () => {
		for (const [input, expected] of [
			["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
			["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
			["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
		] as const) {
			expect(createHash("sha256").update(input).digest("hex")).toBe(expected);
		}
		const binary = new Uint8Array([0, 98, 99, 0]);
		const hash = createHash("SHA-256");
		expect(hash.update("61", "hex")).toBe(hash);
		const digest = hash.update(new DataView(binary.buffer, 1, 2)).digest();
		expect(BrowserBuffer.isBuffer(digest)).toBe(true);
		expect(digest.toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("rejects unsupported crypto contracts and finalized hashes", () => {
		const hash = createHash("sha256").update("abc");
		expect(() => hash.digest("unsupported")).toThrow("does not support");
		hash.digest();
		expect(() => hash.digest()).toThrow();
		expect(() => hash.update("")).toThrow();
		expect(() => createHash("sha512")).toThrow("does not support");
		expect(() => createHash("sha256", {})).toThrow("does not support");
		expect(() => randomUUID({ disableEntropyCache: true })).toThrow("does not support");
		expect(() => randomBytes(4, () => {})).toThrow("does not support");
		for (const size of [-1, NaN, Infinity, 0x8000_0000]) expect(() => randomBytes(size)).toThrow(RangeError);
		expect(randomBytes(1.5)).toHaveLength(1);
	});

	it("uses the host CSPRNG in bounded chunks without assuming Node's randomBytes limit", () => {
		const calls: number[] = [];
		const restore = stubWindowMembers({ crypto: {
			getRandomValues(bytes: Uint8Array) {
				calls.push(bytes.length);
				bytes.fill(calls.length);
				return bytes;
			},
		} });
		try {
			const bytes = randomBytes(65_536 + 7);
			expect(BrowserBuffer.isBuffer(bytes)).toBe(true);
			expect(calls).toEqual([65_536, 7]);
			expect(bytes[65_535]).toBe(1);
			expect(bytes[65_536]).toBe(2);
			expect(bytes.toString("hex").length).toBe((65_536 + 7) * 2);
		} finally { restore(); }
	});

	it("uses native UUIDs and fails if secure randomness is unavailable", () => {
		expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const restore = stubWindowMembers({ crypto: undefined });
		try {
			expect(() => randomUUID()).toThrow("without Web Crypto");
			expect(() => randomBytes(8)).toThrow("without Web Crypto");
			expect(randomBytes(0)).toHaveLength(0);
		} finally { restore(); }
	});

	it("bundles and runs with permanently absent Node globals", async () => {
		const built = await build({
			stdin: { contents: 'export { Buffer } from "./src/extensions/node/buffer"; export * from "./src/extensions/node/crypto";', resolveDir: process.cwd() },
			bundle: true, platform: "browser", format: "cjs", write: false, metafile: true, minify: true, logLevel: "silent",
		});
		expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
		const sandbox = { module: { exports: {} }, window: { crypto: globalThis.crypto } };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
		const api = sandbox.module.exports as typeof import("./crypto") & typeof import("./buffer");
		expect(api.createHash("sha256").update("abc").digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(api.randomBytes(16).toString("hex")).toMatch(/^[0-9a-f]{32}$/);
		expect(api.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
		const prefix = api.Buffer.from("中文🌿tail").subarray(0, 10);
		if (!api.Buffer.isBuffer(prefix)) throw new Error("subarray lost Buffer methods");
		expect(prefix.toString("utf8")).toBe("中文🌿");
		expect(vm.runInNewContext("[typeof require, typeof process, typeof Buffer, typeof Bun]", sandbox)).toEqual(Array(4).fill("undefined"));
	}, 10_000);

	it("rejects imports of unimplemented crypto APIs at build time", async () => {
		await expect(build({
			stdin: { contents: 'export { createHmac } from "./src/extensions/node/crypto";', resolveDir: process.cwd() },
			bundle: true, platform: "browser", write: false, logLevel: "silent",
		})).rejects.toThrow("No matching export");
	}, 10_000);
});
