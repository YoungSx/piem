import { afterAll, describe, expect, it } from "bun:test";
import { fileToPendingImage, toImageContents } from "./pendingImages";
import { stubWindowMembers } from "../testUtils/windowStub";

/*
 * Ids come from `window.crypto.randomUUID`, with a `Math.random` fallback behind
 * optional chaining. Handing over the real `crypto` rather than an empty `window`
 * keeps the assertions on the branch production takes: a bare `window` would pass
 * while only ever exercising the fallback. Without any `window` the generator
 * throws, which is why the file passed only under a full `bun test`.
 */
const restoreWindowCrypto = stubWindowMembers({ crypto: globalThis.crypto });

afterAll(() => {
	restoreWindowCrypto();
});

class StubFile extends File {
	private readonly stagedBytes: Uint8Array;
	constructor(bytes: Uint8Array, type: string, name = "stub") {
		super([], name, { type });
		this.stagedBytes = bytes;
	}
	// `File.arrayBuffer` is not implemented by Bun's `File` shim for an empty
	// blob, so return the staged bytes directly.
	override async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = this.stagedBytes;
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}
}

describe("fileToPendingImage", () => {
	it("encodes file bytes as base64 and carries the mime type", async () => {
		const bytes = new TextEncoder().encode("hi");
		const image = await fileToPendingImage(new StubFile(bytes, "image/png"));
		expect(image.mimeType).toBe("image/png");
		expect(image.data).toBe(btoa("hi"));
		expect(image.id).toBeTruthy();
	});

	it("gives each image a distinct id", async () => {
		const bytes = new TextEncoder().encode("x");
		const a = await fileToPendingImage(new StubFile(bytes, "image/png"));
		const b = await fileToPendingImage(new StubFile(bytes, "image/png"));
		expect(a.id).not.toBe(b.id);
	});
});

describe("toImageContents", () => {
	it("maps pending images to ImageContent shape", () => {
		const contents = toImageContents([
			{ id: "1", mimeType: "image/png", data: "AAAA" },
			{ id: "2", mimeType: "image/jpeg", data: "BBBB" },
		]);
		expect(contents).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "image", data: "BBBB", mimeType: "image/jpeg" },
		]);
	});

	it("returns a fresh array that does not alias the input", () => {
		const input = [{ id: "1", mimeType: "image/png", data: "AAAA" }];
		const contents = toImageContents(input);
		expect(contents).not.toBe(input);
		input.push({ id: "2", mimeType: "image/png", data: "CCCC" });
		expect(contents).toHaveLength(1);
	});

	it("returns an empty array for no images", () => {
		expect(toImageContents([])).toEqual([]);
	});
});
