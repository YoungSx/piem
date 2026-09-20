/**
 * Local structural intelligence for vault health and knowledge evolution.
 *
 * Runs 100% locally from Obsidian's memory cache (zero network, zero Token overhead):
 * 1. Parses unverified assumptions and promises (e.g. "待验证：...", "TODO(...)")
 * 2. Identifies broken links with high-probability target matches in the vault
 * 3. Discovers emergent note clusters eligible for a Map of Content (MOC)
 */

import type { App, TFile } from "obsidian";

export interface BrokenLinkFix {
	original: string;
	target: string;
}

/**
 * Extracts unverified promises, hypothesis tests, or open questions from markdown text.
 * Matches patterns like "待验证：...", "待落实：...", "TODO(...)" or "待确认".
 */
export function findUnresolvedPromises(content: string, maxItems = 3): string[] {
	if (!content || !content.trim()) return [];
	const regex = /(?:(?:待验证|待落实|待确认|TODO|FIXME)[\s:：(（])([^\n\r]+)/gi;
	const results: string[] = [];
	const seen = new Set<string>();

	let match: RegExpExecArray | null = regex.exec(content);
	while (match !== null && results.length < maxItems) {
		const raw = match[1]?.trim().replace(/^[)）\]】]+/, "").replace(/[)）\]】]+$/, "").trim();
		if (raw && raw.length > 2 && !seen.has(raw)) {
			seen.add(raw);
			results.push(raw.length > 60 ? `${raw.slice(0, 57)}...` : raw);
		}
		match = regex.exec(content);
	}
	return results;
}

/**
 * Finds broken wikilinks in a note and looks for fuzzy matches among existing vault files.
 * Example: if note links to [[Neural-Network]], and vault has [[Neural Network.md]],
 * it proposes repairing [[Neural-Network]] -> [[Neural Network]].
 */
export function findBrokenLinkFixes(app: App, file: TFile, maxFixes = 2): BrokenLinkFix[] {
	if (!app?.metadataCache?.unresolvedLinks || !app.vault?.getMarkdownFiles) return [];
	const unresolvedForFile = app.metadataCache.unresolvedLinks[file.path];
	if (!unresolvedForFile) return [];

	const deadLinkNames = Object.keys(unresolvedForFile);
	if (deadLinkNames.length === 0) return [];

	const allFiles = app.vault.getMarkdownFiles();
	if (!allFiles || allFiles.length === 0) return [];

	// Precompute index of normalized filenames (lowercase, hyphens/underscores to spaces)
	const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, " ").trim();
	const fileMap = new Map<string, string>();
	for (const f of allFiles) {
		const base = f.basename;
		fileMap.set(normalize(base), base);
	}

	const fixes: BrokenLinkFix[] = [];
	for (const dead of deadLinkNames) {
		const cleanDead = dead.split("#")[0]?.split("|")[0]?.trim();
		if (!cleanDead) continue;

		const norm = normalize(cleanDead);
		const matchedTarget = fileMap.get(norm);
		if (matchedTarget && matchedTarget !== cleanDead) {
			fixes.push({ original: cleanDead, target: matchedTarget });
			if (fixes.length >= maxFixes) break;
		}
	}
	return fixes;
}

/**
 * Detects whether a note belongs to an emergent topic cluster that lacks an index/MOC note.
 * If >= 3 notes share a tag or category, and no note named "${tag} MOC" or "${tag} 索引" exists,
 * returns the suggested topic name.
 */
export function detectEmergentMoc(app: App, file: TFile, tags: string[]): string | null {
	if (!tags || tags.length === 0 || !app?.vault?.getMarkdownFiles) return null;

	const allFiles = app.vault.getMarkdownFiles();
	if (!allFiles || allFiles.length < 3) return null;

	const filenames = new Set(allFiles.map((f) => f.basename.toLowerCase()));

	for (const rawTag of tags) {
		const tag = rawTag.replace(/^#/, "").trim();
		if (!tag || tag.length < 2) continue;

		// Check if MOC for this tag already exists
		const mocName1 = `${tag.toLowerCase()} moc`;
		const mocName2 = `${tag.toLowerCase()} 索引`;
		const mocName3 = `${tag.toLowerCase()} index`;
		const mocName4 = `${tag.toLowerCase()}`;
		if (filenames.has(mocName1) || filenames.has(mocName2) || filenames.has(mocName3) || (filenames.has(mocName4) && file.basename.toLowerCase() === mocName4)) {
			continue;
		}

		// Count how many files in vault share this tag
		let tagCount = 0;
		for (const f of allFiles) {
			const cache = app.metadataCache?.getFileCache(f);
			if (!cache) continue;
			const fileTags = (cache.tags ?? []).map((t) => t.tag.replace(/^#/, "").toLowerCase());
			const rawFmt: unknown = cache.frontmatter?.tags;
			if (Array.isArray(rawFmt)) {
				for (const item of rawFmt) {
					if (typeof item === "string") fileTags.push(item.replace(/^#/, "").toLowerCase());
				}
			} else if (typeof rawFmt === "string") {
				fileTags.push(rawFmt.replace(/^#/, "").toLowerCase());
			}
			if (fileTags.includes(tag.toLowerCase())) {
				tagCount++;
				if (tagCount >= 3) {
					return tag;
				}
			}
		}
	}

	return null;
}
