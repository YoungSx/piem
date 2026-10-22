import type { App, CachedMetadata, TFile } from "obsidian";

export interface SearchFixture {
	path: string;
	content: string;
	metadata?: CachedMetadata | null;
}

/** An indexed in-memory vault; production tools still own matching and ranking. */
export function searchVault(fixtures: SearchFixture[]): { app: App; reads: string[] } {
	const files = fixtures.map(({ path }) => ({ path, name: path.split("/").pop(), basename: path.split("/").pop()?.replace(/\.[^.]+$/, ""), extension: path.split(".").pop() } as TFile));
	const reads: string[] = [];
	const app = {
		vault: {
			getFiles: () => files.slice(),
			getMarkdownFiles: () => files.filter((file) => file.extension === "md"),
			getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
			getFolderByPath: (path: string) => files.some((file) => file.path.startsWith(`${path}/`)) ? { path } : null,
			cachedRead: async (file: TFile) => {
				reads.push(file.path);
				return fixtures.find((fixture) => fixture.path === file.path)!.content;
			},
		},
		metadataCache: { getFileCache: (file: TFile) => fixtures.find((fixture) => fixture.path === file.path)?.metadata ?? null },
	} as unknown as App;
	return { app, reads };
}
