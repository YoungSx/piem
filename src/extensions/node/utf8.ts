import { unavailable } from "./unavailable";

/** The audited truncateHead helper only needs the UTF-8 byte count. */
export const Buffer = Object.freeze({
	byteLength(text: string, encoding = "utf8"): number {
		if (encoding !== "utf8" && encoding !== "utf-8") return unavailable("non-UTF-8 byte counts");
		return new TextEncoder().encode(text).byteLength;
	},
});
