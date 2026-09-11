import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "./buffer";
import { unavailable } from "./unavailable";

/** No entropy cache or Node process is shared with the extension. */
export function randomUUID(options?: unknown): string {
	if (options !== undefined) return unavailable("crypto.randomUUID options");
	const crypto = window.crypto;
	if (!crypto?.randomUUID) return unavailable("crypto.randomUUID without Web Crypto");
	return crypto.randomUUID();
}

/** Synchronous Node shape, with Web Crypto's per-call 64 KiB quota respected. */
export function randomBytes(size: number, callback?: unknown): Buffer {
	if (callback !== undefined) return unavailable("asynchronous crypto.randomBytes");
	if (typeof size !== "number") throw new TypeError("crypto.randomBytes size must be a number.");
	if (!Number.isFinite(size) || size < 0 || size > 0x7fff_ffff) throw new RangeError("crypto.randomBytes size is out of range.");
	const bytes = Buffer.alloc(Math.floor(size));
	if (!bytes.length) return bytes;
	const crypto = window.crypto;
	if (!crypto?.getRandomValues) return unavailable("crypto.randomBytes without Web Crypto");
	for (let offset = 0; offset < bytes.length; offset += 65_536) {
		crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
	}
	return bytes;
}

/** Node's update/digest contract stays synchronous; Web Crypto's digest is async. */
class Hash {
	private readonly state = sha256.create();

	update(data: string | ArrayBufferView, encoding = "utf8"): this {
		if (typeof data === "string") this.state.update(Buffer.from(data, encoding));
		else if (ArrayBuffer.isView(data)) this.state.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		else throw new TypeError("Hash.update requires a string, Buffer, TypedArray or DataView.");
		return this;
	}

	digest(): Buffer;
	digest(encoding: string): string;
	digest(encoding?: string): Buffer | string {
		if (encoding !== undefined && !Buffer.isEncoding(encoding)) return unavailable(`crypto digest encoding ${encoding}`);
		const bytes = Buffer.from(this.state.digest());
		return encoding === undefined ? bytes : bytes.toString(encoding);
	}
}

/** Only the audited SHA-256 algorithm is exposed; no streams or native fallback. */
export function createHash(algorithm: string, options?: unknown): Hash {
	if (options !== undefined) return unavailable("crypto.createHash options");
	if (typeof algorithm !== "string") throw new TypeError("crypto.createHash algorithm must be a string.");
	if (!/^sha-?256$/i.test(algorithm)) return unavailable(`crypto.createHash(${algorithm})`);
	return new Hash();
}

export default { randomUUID, randomBytes, createHash };
