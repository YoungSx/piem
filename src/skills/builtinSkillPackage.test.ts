import { describe, expect, it } from "bun:test";
import { readBuiltinSkillPackage, type BuiltinSkillPackage } from "./builtinSkillPackage";
import { sha256Hex } from "./skillHash";

const version = "2.0.0";
async function packet(data: unknown) {
	const text = JSON.stringify(data);
	return { text, asset: { sha256: await sha256Hex(text), bytes: new TextEncoder().encode(text).byteLength, names: ["summarize"] } };
}
const valid: BuiltinSkillPackage = { schema: 1, version, files: [{ path: "summarize/SKILL.md", content: "# 中文内容" }] };

describe("official skill package validation", () => {
	it("validates UTF-8 bytes and the pinned digest before accepting the file list", async () => {
		const { text, asset } = await packet(valid);
		expect(await readBuiltinSkillPackage(text, asset, version)).toEqual(valid);
		await expect(readBuiltinSkillPackage(`${text} `, asset, version)).rejects.toThrow("checksum");
		await expect(readBuiltinSkillPackage(text.replace("中文", "篡改"), asset, version)).rejects.toThrow("checksum");
	});

	it("rejects schema/version mismatches, duplicates, escapes, scripts and missing entries", async () => {
		for (const data of [
			{ ...valid, schema: 2 },
			{ ...valid, version: "3.0.0" },
			{ ...valid, files: [...valid.files, ...valid.files] },
			...['../outside.md', '/absolute.md', 'summarize/../../outside.md', 'summarize/scripts/run.js', 'different/SKILL.md'].map((path) => ({ ...valid, files: [{ path, content: "X" }] })),
			{ ...valid, files: [{ path: "summarize/reference.md", content: "X" }] },
		]) {
			const { text, asset } = await packet(data);
			await expect(readBuiltinSkillPackage(text, asset, version)).rejects.toThrow();
		}
	});
});
