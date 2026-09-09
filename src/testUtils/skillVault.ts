/** A writable Vault using the constructors supplied by the host under test. */
interface HostFile {
	path: string;
	name: string;
	stat: { ctime: number; mtime: number; size: number };
}
interface HostFolder {
	path: string;
	name: string;
	children: Array<HostFile | HostFolder>;
}

export function createSkillVault(host: { TFile: new () => HostFile; TFolder: new () => HostFolder }) {
	const contents = new Map<string, string>();
	const entries = new Map<string, HostFile | HostFolder>();
	const folder = (path: string): HostFolder => {
		const existing = entries.get(path);
		if (existing) return existing as HostFolder;
		const created = Object.assign(new host.TFolder(), { path, name: path.split("/").pop() ?? "", children: [] as Array<HostFile | HostFolder> });
		entries.set(path, created);
		if (path) folder(path.split("/").slice(0, -1).join("/")).children.push(created);
		return created;
	};
	const vault = {
		configDir: ".obsidian",
		getName: () => "Test",
		getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		getFileByPath: (path: string) => { const file = entries.get(path); return file instanceof host.TFile ? file : null; },
		getFolderByPath: (path: string) => { const entry = entries.get(path); return entry instanceof host.TFolder ? entry : null; },
		getRoot: () => folder(""),
		getFiles: () => [...entries.values()].filter((entry) => entry instanceof host.TFile),
		getMarkdownFiles: () => [...entries.values()].filter((entry) => entry instanceof host.TFile),
		read: async (file: HostFile) => {
			const content = contents.get(file.path);
			if (content === undefined) throw new Error(`Missing file: ${file.path}`);
			return content;
		},
		createFolder: async (path: string) => folder(path),
		create: async (path: string, content: string) => {
			if (entries.has(path)) throw new Error(`File already exists: ${path}`);
			const parent = folder(path.split("/").slice(0, -1).join("/"));
			const file = Object.assign(new host.TFile(), { path, name: path.split("/").pop() ?? "", stat: { ctime: 0, mtime: 0, size: content.length } });
			entries.set(path, file);
			parent.children.push(file);
			contents.set(path, content);
			return file;
		},
		process: async (file: HostFile, transform: (text: string) => string) => {
			const content = transform(await vault.read(file));
			contents.set(file.path, content);
			file.stat.size = content.length;
			return content;
		},
	};
	folder("");
	return { vault, contents };
}
