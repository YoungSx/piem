import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	convertToLlm,
	loadSkills,
	prepareCompaction,
	serializeConversation,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { composeSystemPrompt, expandSkill } from "../src/agent/skillLoader.ts";
import { compactIfNeeded } from "../src/agent/compaction.ts";
import { SkillImporter } from "../src/skills/skillImport.ts";
import { createReadSkillTool } from "../src/tools/skillTools.ts";
import { installObsidianStub } from "../src/testUtils/obsidianStub.ts";
import { createSkillVault } from "../src/testUtils/skillVault.ts";

// Historical audit, not a CI gate: some assertions reproduce known limitations.
// Run with `bun scripts/probe-skill-standard.mjs`. Uses temporary files, a fake
// Vault, and a deterministic summary provider; never sends a model request.
const metadata = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-agent-core/package.json", import.meta.url), "utf8"));
assert.equal(metadata.version, "0.84.3", "Re-audit against the installed Pi version before updating this probe.");
const directory = await mkdtemp(path.join(tmpdir(), "piem-skill-audit-"));
const env = new NodeExecutionEnv({ cwd: directory });
const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error("Network disabled during skill audit"); };

try {
	const skillDir = path.join(directory, "audit-skill");
	const skillPath = path.join(skillDir, "SKILL.md");
	const referencePath = path.join(skillDir, "references/detail.md");
	const body = "BODY_MARKER: Follow the detailed procedure.\n[Details](references/detail.md)";
	await mkdir(path.dirname(referencePath), { recursive: true });
	await writeFile(skillPath, `---\nname: audit-skill\ndescription: A small audit fixture\ncompatibility: ENVIRONMENT_MARKER\nallowed-tools: Read\n---\n${body}\n`);
	await writeFile(referencePath, "REFERENCE_MARKER");
	const reads = [];
	const readTextFile = env.readTextFile.bind(env);
	env.readTextFile = async (...args) => { reads.push(args[0]); return readTextFile(...args); };
	const loaded = await loadSkills(env, directory);
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	const skill = loaded.skills[0];
	const prompt = composeSystemPrompt("Audit agent", loaded.skills);
	const disclosure = {
		bodyCachedAtDiscovery: skill.content.includes("BODY_MARKER"),
		catalogNamesSkill: prompt.includes("<name>audit-skill</name>"),
		catalogContainsBody: prompt.includes("BODY_MARKER"),
		catalogContainsReference: prompt.includes("REFERENCE_MARKER"),
		referenceReadAtDiscovery: reads.includes(referencePath),
		optionalCompatibilityRetained: JSON.stringify(skill).includes("ENVIRONMENT_MARKER"),
	};
	assert.equal(disclosure.bodyCachedAtDiscovery, true);
	assert.equal(disclosure.catalogNamesSkill, true);
	assert.equal(disclosure.catalogContainsBody, false);
	assert.equal(disclosure.catalogContainsReference, false);
	assert.equal(disclosure.referenceReadAtDiscovery, false);
	assert.equal(disclosure.optionalCompatibilityRetained, false);
	const tool = createReadSkillTool(() => loaded.skills);
	const readsBeforeActivation = reads.length;
	const activated = await tool.execute("activate", { name: skill.name });
	assert(activated.content[0].text.includes("BODY_MARKER"));
	assert.equal(reads.length, readsBeforeActivation);
	assert(expandSkill(skill).includes("BODY_MARKER"));

	const longBody = `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\nEND_OF_SKILL`;
	const longTool = createReadSkillTool(() => [{ ...skill, content: longBody }]);
	const longResult = await longTool.execute("long", { name: skill.name });
	const longSkill = {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
		truncated: longResult.details.truncated === true,
		tailVisible: longResult.content[0].text.includes("END_OF_SKILL"),
		parameters: Object.keys(longTool.parameters.properties),
		slashTailVisible: expandSkill({ ...skill, content: longBody }).includes("END_OF_SKILL"),
	};
	assert.equal(longSkill.truncated, true);
	assert.equal(longSkill.tailVisible, false);
	assert.deepEqual(longSkill.parameters, ["name"]);
	assert.equal(longSkill.slashTailVisible, true);

	installObsidianStub();
	const host = await import("obsidian");
	const { VaultExecutionEnv } = await import("../src/vault/VaultExecutionEnv.ts");
	const { vault } = createSkillVault(host);
	const vaultEnv = new VaultExecutionEnv({ vault });
	try {
		await vault.create("Piem/skills/audit-skill/references/detail.md", "VAULT_REFERENCE_MARKER");
		const inside = await vaultEnv.readTextFile("/Piem/skills/audit-skill/references/detail.md");
		const outside = await vaultEnv.readTextFile(referencePath);
		assert.equal(inside.ok, true);
		assert.equal(outside.ok, false);
		assert.equal(outside.error.code, "not_found");
		disclosure.vaultReferenceReadable = inside.ok;
		disclosure.existingHostReferenceReadableThroughVault = outside.ok;
	} finally {
		await vaultEnv.cleanup();
	}

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const model = { id: "audit", name: "Audit", api: "openai-completions", provider: "audit", contextWindow: 32768, maxTokens: 1024, reasoning: false };
	const assistant = (content) => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 1 });
	const skillResult = {
		role: "toolResult", toolCallId: "skill-call", toolName: "read_skill", isError: false, timestamp: 2,
		content: [{ type: "text", text: `SKILL_START\n${"instruction\n".repeat(250)}SKILL_END` }],
	};
	const history = [
		{ role: "user", content: "Use the skill", timestamp: 0 },
		{ ...assistant([{ type: "toolCall", id: "skill-call", name: "read_skill", arguments: { name: skill.name } }]), stopReason: "toolUse" },
		skillResult,
		assistant([{ type: "text", text: "Followed the instructions" }]),
		{ role: "user", content: `Continue\n${"recent work\n".repeat(800)}`, timestamp: 3 },
		assistant([{ type: "text", text: "Recent answer" }]),
	];
	const settings = { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 };
	const entries = history.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, seq: i + 1, timestamp: message.timestamp, message }));
	const prepared = prepareCompaction(entries, settings);
	assert(prepared.ok && prepared.value);
	const summarized = [...prepared.value.messagesToSummarize, ...prepared.value.turnPrefixMessages];
	assert(summarized.includes(skillResult));
	const serialized = serializeConversation(convertToLlm(summarized));
	assert(serialized.includes("SKILL_START"));
	assert(!serialized.includes("SKILL_END"));
	const compacted = await compactIfNeeded({
		messages: history, model, thinkingLevel: "off", settings, force: true,
		models: { completeSimple: async () => assistant([{ type: "text", text: "Deterministic audit summary" }]) },
	});
	assert.equal(compacted.status, "compacted");
	assert(!JSON.stringify(compacted.messages).includes("SKILL_START"));
	const compaction = {
		oldSkillBodySentToSummary: true,
		summaryInputRetainsSkillTail: serialized.includes("SKILL_END"),
		compactedContextRetainsOriginalBody: false,
		realModelCalled: false,
	};

	// Compare a collection URL with a URL pointing directly at one skill folder.
	const tree = ["skills/example/SKILL.md", "skills/example/references/detail.md", "skills/example/scripts/run.py"];
	const requested = [];
	const fetchFixture = async (input) => {
		const url = String(input);
		requested.push(url);
		if (url === "https://api.github.com/repos/acme/skills/git/trees/main?recursive=1") {
			return Response.json({ sha: "audit-tree", tree: tree.map((file) => ({ path: file, type: "blob", size: 100 })) });
		}
		const prefix = "https://raw.githubusercontent.com/acme/skills/main/";
		assert(url.startsWith(prefix) && tree.includes(url.slice(prefix.length)), "Unexpected fixture URL");
		return new Response(url.endsWith("SKILL.md") ? "---\nname: example\ndescription: Import fixture\n---\nRead references/detail.md" : "Fixture resource");
	};
	const importer = new SkillImporter(fetchFixture, env);
	const collection = await importer.fetchSource("https://github.com/acme/skills/tree/main/skills");
	const direct = await importer.fetchSource("https://github.com/acme/skills/tree/main/skills/example");
	const imports = {
		collectionFiles: collection.skills[0].files.map((file) => file.path),
		directSkillFolderFiles: direct.skills[0].files.map((file) => file.path),
		fixtureRequests: requested.length,
	};
	assert(imports.collectionFiles.includes("references/detail.md"));
	assert(imports.collectionFiles.includes("scripts/run.py"));
	assert.deepEqual(imports.directSkillFolderFiles, ["SKILL.md"]);
	assert.equal(networkRequests, 0);
	console.log(JSON.stringify({ piVersion: metadata.version, disclosure, longSkill, compaction, imports, networkRequests }, null, 2));
} finally {
	globalThis.fetch = originalFetch;
	try {
		await env.cleanup();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
