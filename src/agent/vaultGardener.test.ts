import { describe, expect, it } from "bun:test";
import { detectEmergentMoc, findBrokenLinkFixes, findUnresolvedPromises } from "./vaultGardener";
import type { App, TFile } from "obsidian";

describe("findUnresolvedPromises", () => {
	it("extracts promises with Chinese prefixes", () => {
		const content = `# Architecture Note\n\n待验证：分布式事务在网络分区下的补偿机制。\n\n待落实：编写基准压测报告。\n`;
		const promises = findUnresolvedPromises(content);
		expect(promises).toHaveLength(2);
		expect(promises[0]).toBe("分布式事务在网络分区下的补偿机制。");
		expect(promises[1]).toBe("编写基准压测报告。");
	});

	it("extracts TODO and FIXME format items", () => {
		const content = `TODO(auth): verify JWT refresh token rotation\nFIXME: handle null pointer in parser\n`;
		const promises = findUnresolvedPromises(content);
		expect(promises).toHaveLength(2);
		expect(promises[0]).toBe("auth): verify JWT refresh token rotation");
		expect(promises[1]).toBe("handle null pointer in parser");
	});

	it("returns empty array for text with no promises", () => {
		expect(findUnresolvedPromises("")).toEqual([]);
		expect(findUnresolvedPromises("Plain text with no pending items.")).toEqual([]);
	});
});

describe("findBrokenLinkFixes", () => {
	it("identifies matching filenames with different formatting", () => {
		const mockFile = { path: "Notes/Research.md", basename: "Research" } as TFile;
		const mockApp = {
			metadataCache: {
				unresolvedLinks: {
					"Notes/Research.md": {
						"Vector-Database": 1,
						"Completely-Unknown-Link": 1,
					},
				},
			},
			vault: {
				getMarkdownFiles: () => [
					{ basename: "Vector Database", path: "Knowledge/Vector Database.md" } as TFile,
					{ basename: "Other Note", path: "Notes/Other Note.md" } as TFile,
				],
			},
		} as unknown as App;

		const fixes = findBrokenLinkFixes(mockApp, mockFile);
		expect(fixes).toHaveLength(1);
		expect(fixes[0]).toEqual({
			original: "Vector-Database",
			target: "Vector Database",
		});
	});

	it("returns empty array if no unresolved links", () => {
		const mockFile = { path: "Notes/Clean.md", basename: "Clean" } as TFile;
		const mockApp = {
			metadataCache: { unresolvedLinks: {} },
			vault: { getMarkdownFiles: () => [] },
		} as unknown as App;
		expect(findBrokenLinkFixes(mockApp, mockFile)).toEqual([]);
	});
});

describe("detectEmergentMoc", () => {
	it("detects tag cluster when >= 3 notes share tag and no MOC exists", () => {
		const currentFile = { basename: "Note1" } as TFile;
		const mockApp = {
			vault: {
				getMarkdownFiles: () => [
					{ basename: "Note1" } as TFile,
					{ basename: "Note2" } as TFile,
					{ basename: "Note3" } as TFile,
				],
			},
			metadataCache: {
				getFileCache: (f: TFile) => ({
					tags: [{ tag: "#distributed" }],
				}),
			},
		} as unknown as App;

		const mocTag = detectEmergentMoc(mockApp, currentFile, ["distributed"]);
		expect(mocTag).toBe("distributed");
	});

	it("returns null if MOC note already exists in vault", () => {
		const currentFile = { basename: "Note1" } as TFile;
		const mockApp = {
			vault: {
				getMarkdownFiles: () => [
					{ basename: "Note1" } as TFile,
					{ basename: "Note2" } as TFile,
					{ basename: "Note3" } as TFile,
					{ basename: "Distributed MOC" } as TFile,
				],
			},
			metadataCache: {
				getFileCache: () => ({
					tags: [{ tag: "#distributed" }],
				}),
			},
		} as unknown as App;

		const mocTag = detectEmergentMoc(mockApp, currentFile, ["distributed"]);
		expect(mocTag).toBeNull();
	});
});
