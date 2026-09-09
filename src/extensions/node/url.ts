export function fileURLToPath(input: string | URL): string {
	const url = new URL(input);
	if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost") || /%2f|%5c/i.test(url.pathname)) {
		throw new Error("Expected a local virtual file URL.");
	}
	return decodeURIComponent(url.pathname);
}
export function pathToFileURL(path: string): URL {
	if (!path.startsWith("/")) throw new Error("Expected an absolute virtual path.");
	return new URL(`file://${path.split("/").map(encodeURIComponent).join("/")}`);
}
