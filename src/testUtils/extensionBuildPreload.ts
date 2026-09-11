import { plugin } from "bun";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildScopedFactory, SCOPED_FACTORIES, SCOPED_FACTORY_PREFIX } from "../../scripts/pi-scoped-factories.mjs";

const root = resolve(import.meta.dir, "../..");

/**
 * Source-only tooling uses the production compiler and its audit snapshot.
 * Bun loads the emitted static module normally; no eval, generated files or
 * previous main.js are needed. Heavy compiler imports stay lazy so unrelated
 * single-file tests do not start an esbuild service.
 */
plugin({
	name: "pi-audited-extension-sources",
	setup(build) {
		for (const name of Object.keys(SCOPED_FACTORIES)) {
			build.module(`${SCOPED_FACTORY_PREFIX}${name}`, async () => {
				const snapshot = await readFile(resolve(root, "scripts/pi-extension-packages.json"), "utf8");
				const audits = JSON.parse(snapshot) as Record<string, { entry: string; version: string; files: Record<string, string> }>;
				const audit = audits[name];
				if (!audit) throw new Error(`Missing extension audit: ${name}`);
				const { contents } = await buildScopedFactory(root, name, audit);
				return { contents, loader: "js" };
			});
		}
	},
});
