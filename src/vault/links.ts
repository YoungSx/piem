/**
 * Reads Obsidian's link index: a note's outgoing links, its unresolved ones, and
 * the notes pointing at it.
 *
 * Extracted from `linkTools` when the per-turn `<context>` block started needing
 * backlinks too. Duplicating it was not an option: the backlink read is not a
 * map lookup but a feature probe with a whole-vault fallback, and two copies of
 * that would drift into two different answers to the same question.
 *
 * Lives under `vault/` rather than `tools/` because the dependency runs that way
 * everywhere else in this codebase — tools reach into vault, never the reverse.
 * That is also why the abort check below is three inlined lines instead of
 * `tools/toolResult`'s `throwIfAborted`: the message is identical, and importing
 * it would invert the layering for the sake of one `if`.
 */

import type { App, TFile } from "obsidian";

/** One end of a link, with how many times it occurs. */
export interface LinkReference {
	target: string;
	count: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

/**
 * Readiness for the link graph: the note's own row in `resolvedLinks`, not just
 * a non-empty map — a vault mid-index has rows for some notes and not others.
 */
export function resolvedLinkRowReady(app: App, path: string): boolean {
	return app.metadataCache.resolvedLinks[path] !== undefined;
}

/**
 * Obsidian exposes no public backlinks API — `getBacklinksForFile` is absent
 * from `obsidian.d.ts` — but the method exists at runtime behind the backlinks
 * panel, so backlinks feature-detect it and fall back to inverting the forward
 * link graph.
 *
 * The fast path borrows only the index's *source list*; counts still come from
 * `resolvedLinks`, the same map the fallback reads. The two paths are therefore
 * equal by construction: keys the index carries that `resolvedLinks` does not
 * (e.g. unresolved mentions) drop out of the count lookup, and the only trust
 * left is that the index lists every resolved backlink source — the assumption
 * Obsidian's own backlinks panel runs on. The scan stays a whole-vault walk,
 * hence the per-source abort check; the fast path's loop is bounded by the
 * note's backlink count, and the same check guards it for symmetry.
 *
 * Iterating keys rather than `Object.entries` keeps the scan's check meaningful:
 * `Object.entries` reads every source's target map up front, so an abort would
 * only be noticed after the full scan it was supposed to cut short.
 */
export function collectBacklinks(app: App, file: TFile, signal?: AbortSignal): LinkReference[] {
	const resolvedLinks = app.metadataCache.resolvedLinks;
	const backlinks: LinkReference[] = [];
	const candidates = backlinkSources(app, file) ?? Object.keys(resolvedLinks);
	for (const sourcePath of candidates) {
		throwIfAborted(signal);
		const count = resolvedLinks[sourcePath]?.[file.path];
		if (count !== undefined) {
			backlinks.push({ target: sourcePath, count });
		}
	}
	return sortLinkReferences(backlinks);
}

/**
 * The undocumented runtime shape behind Obsidian's backlinks panel: the internal
 * `CustomArrayDict`, whose `data` maps backlink source paths to their link
 * caches. Declared nowhere in `obsidian.d.ts`, so typed locally; a version that
 * returns the map bare, or anything else entirely, fails the probe and takes
 * the scan.
 */
interface BacklinkIndex {
	data?: Map<string, unknown>;
}

function backlinkSources(app: App, file: TFile): string[] | undefined {
	const cache = app.metadataCache as unknown as {
		getBacklinksForFile?: (file: TFile) => BacklinkIndex | Map<string, unknown> | undefined;
	};
	const getBacklinksForFile = cache.getBacklinksForFile;
	if (typeof getBacklinksForFile !== "function") {
		return undefined;
	}
	let index: BacklinkIndex | Map<string, unknown> | undefined;
	try {
		index = getBacklinksForFile.call(cache, file);
	} catch {
		return undefined;
	}
	const data = index instanceof Map ? index : index?.data;
	if (!(data instanceof Map)) {
		return undefined;
	}
	const sources: string[] = [];
	for (const sourcePath of data.keys()) {
		if (typeof sourcePath === "string") {
			sources.push(sourcePath);
		}
	}
	return sources;
}

/**
 * Backlink sources whose written link text names `file` by path — the links
 * that go stale when the note moves and Obsidian's update is skipped.
 *
 * Deliberately narrower than {@link collectBacklinks}: a short-name link
 * (`[[Idea]]`) re-resolves to the new location on its own, so listing it would
 * send the caller off to "fix" links that still work. The written form lives
 * in each source's link cache (`getCache().links`), not in `resolvedLinks`,
 * which is keyed by *resolved* target either way; a link counts as pathed when
 * its text still names the file's path once the `.md` is stripped. A source
 * whose cache cannot be read (mid-index vault, test stub) stays listed —
 * reporting a link that turned out fine is cheaper than silently hiding one
 * that broke.
 */
export function collectPathedBacklinkSources(app: App, file: TFile, signal?: AbortSignal): string[] {
	const sources: string[] = [];
	for (const backlink of collectBacklinks(app, file, signal)) {
		if (namesPathTo(app, backlink.target, file.path)) {
			sources.push(backlink.target);
		}
	}
	return sources;
}

/** Whether any written link in `sourcePath` names `targetPath` by path. */
function namesPathTo(app: App, sourcePath: string, targetPath: string): boolean {
	const metadataCache = app.metadataCache as Partial<App["metadataCache"]> | undefined;
	if (typeof metadataCache?.getCache !== "function") {
		return true;
	}
	const suffix = targetPath.replace(/\.md$/i, "").toLowerCase();
	const links = metadataCache.getCache(sourcePath)?.links ?? [];
	return links.some((link) => link.link.replace(/\.md$/i, "").toLowerCase().endsWith(suffix));
}

/** One note's own link map, so this is bounded by that note rather than the vault. */
export function toLinkReferences(links: Record<string, number> | undefined): LinkReference[] {
	return sortLinkReferences(Object.entries(links ?? {}).map(([target, count]) => ({ target, count })));
}

/** Strongest connections first so truncation keeps the most relevant links. */
export function sortLinkReferences(references: LinkReference[]): LinkReference[] {
	return references.sort((left, right) => {
		const countOrder = right.count - left.count;
		return countOrder === 0 ? left.target.localeCompare(right.target) : countOrder;
	});
}
