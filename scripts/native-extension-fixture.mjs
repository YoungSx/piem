import path from "node:path";
import { extensionCompatEntry } from "./pi-extensions.mjs";

/** Tests opt in by filename. This resolver is never installed in production builds. */
export function nativeExtensionFixturePlugin(root = process.cwd()) {
	const fixture = path.join(root, "scripts/fixtures/native-extension-contract.mjs");
	return {
		name: "native-extension-contract-fixture",
		setup(build) {
			build.onResolve({ filter: /^@(mariozechner|earendil-works)\/pi-(ai|tui|coding-agent)$/ }, args => {
				if (args.importer !== fixture) return;
				return { path: extensionCompatEntry(args.path, root) };
			});
		},
	};
}
