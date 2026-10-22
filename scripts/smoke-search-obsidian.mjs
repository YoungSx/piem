/** Real release bundle search smoke: grep paging and search_notes ranking in a real Obsidian.
 * Usage: node scripts/smoke-search-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]
 * A loopback deterministic SSE fixture drives real provider rounds (a paged grep
 * call and a spawn/wait_subagent delegation). The shipped main.js is exercised as
 * loaded — no test algorithm is injected into the plugin. The installed artifact's
 * SHA256 is compared against the checkout build; a mismatch fails the pass.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || (mode && mode !== "--expect-mobile") || extra.length) {
	throw new Error("Usage: node scripts/smoke-search-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]");
}
const root = resolve(directory), mobile = mode === "--expect-mobile";

// Every provider request is recorded; a subagent's own turn is marked so its tool
// declarations can be asserted separately from the parent's. The fixture answers
// deterministically from the marker in the last user message and the tool results
// that have arrived since — no state beyond the request bodies themselves.
const requests = [];
const fixture = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
	if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(requests)); return; }
	if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
	try {
		let text = "";
		for await (const chunk of req) { text += chunk; if (text.length > 2_000_000) throw new Error("Fixture request too large"); }
		const body = JSON.parse(text);
		const system = JSON.stringify(body.messages.find(message => message.role === "system")?.content ?? "");
		const marker = body.messages.findLastIndex(message => message.role === "user" && /search-smoke-(grep-page|subagent)/.test(JSON.stringify(message.content)));
		// A child turn has the delegated-task system prompt and no marker of its own.
		const isChild = marker < 0 || system.includes("delegated task");
		const prompt = JSON.stringify(body.messages[marker]?.content ?? "");
		const results = marker >= 0 ? body.messages.slice(marker + 1).filter(message => message.role === "tool") : [];
		requests.push({ child: isChild, prompt, tools: body.tools?.map(tool => tool.function?.name) ?? [], toolResults: results.map(result => JSON.stringify(result.content)) });
		res.setHeader("Content-Type", "text/event-stream");
		const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "search-smoke", object: "chat.completion.chunk", model: "smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		const call = (id, name, args) => { chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls"); };
		chunk({ role: "assistant" });
		if (isChild) {
			chunk({ content: "Scout report: the quarry lives in smoke-search/paged." });
		} else if (prompt.includes("search-smoke-subagent")) {
			if (results.length === 0) call("ss-spawn", "spawn_subagent", { task: "Find which notes under smoke-search/paged mention UNIQUESMOKEQUARRY. Report the paths you find." });
			else if (results.length === 1) call("ss-wait", "wait_subagent", {});
			else chunk({ content: "Delegation complete." });
		} else if (prompt.includes("search-smoke-grep-page")) {
			if (results.length === 0) call("ss-grep", "grep", { pattern: "UNIQUESMOKEQUARRY", path: "smoke-search/paged", maxMatches: 30, offset: 30 });
			else chunk({ content: "Grep page received." });
		} else {
			chunk({ content: "Search smoke ready." });
		}
		chunk({}, "stop");
		res.end("data: [DONE]\n\n");
	} catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${fixture.address().port}`;

const NEEDLE = "UNIQUESMOKEQUARRY";
/** Six notes x 105 needle lines, no frontmatter: matches land on lines 1-105 each,
 * so the whole-folder corpus is exactly 630 rows in code-unit path order. */
const pagedNote = (n, needle) => Array.from({ length: 105 }, (_, i) => `log ${n}-${i} ${needle}`).join("\n") + "\n";

/** search_notes fixtures: a body-repeat loser ahead of the title/alias winner in
 * path order, a body-only hit, and an out-of-scope copy that must not leak in.
 * The repeat log's frontmatter stays clean — the needle hits only its body, so
 * ranking must put the title/alias winner first despite path order. */
const SEARCH_FIXTURES = {
	"smoke-search/notes/repeat-log.md": `---\ntitle: Repetition\naliases: [Red Herring]\n---\n${Array.from({ length: 6 }, () => `${NEEDLE} filler`).join("\n")}\n`,
	"smoke-search/notes/target-note.md": `---\ntitle: ${NEEDLE} primary\naliases: [${NEEDLE} alias]\n---\nNothing relevant here.\n`,
	"smoke-search/notes/body-only.md": `# Ordinary note\n\nThe word ${NEEDLE.toLowerCase()} appears only in this body.\n`,
	"elsewhere/out-of-scope.md": `# Out of scope\n\n${NEEDLE} ${NEEDLE} ${NEEDLE}\n`,
};

/** 60 Chinese lines, each longer than the 500-char display truncation, together
 * well past the 50 KiB output budget: a page must stop on bytes before the match
 * count, and paging must still deliver every line. */
const CJK_LINES = Array.from({ length: 60 }, (_, i) => `检索${i} ${"内容".repeat(300)}${NEEDLE}`);
const CJK_NOTE = `---\ntitle: 长行笔记\n---\n${CJK_LINES.join("\n")}\n`;

async function runSmoke(root, expectMobile, endpoint, observe, NEEDLE, SEARCH_FIXTURES, CJK_NOTE, pagedNote) {
	const report = { passed: false, checks: [], errors: [] };
	const check = (name, ok) => { if (!ok) throw new Error(name); report.checks.push(name); };
	const wait = async (test, name, budget = 20_000) => {
		const until = performance.now() + budget;
		while (performance.now() < until) { if (await test()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
		throw new Error(`Timed out: ${name}`);
	};
	const onError = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	async function assertThrows(name, run) {
		let result;
		try {
			result = await run();
		} catch {
			return;
		}
		if (result?.isError) {
			throw new Error(`${name}: returned error result instead of throwing`);
		}
		throw new Error(`Expected throw: ${name}`);
	}
	let plugin, service, audit;
	let restoreCachedRead = null; // the finally block must always restore this wrapper
	const tools = () => service.agent.state.tools;
	const tool = name => tools().find(item => item.name === name);
	const execute = async (name, args) => {
		const item = tool(name);
		if (!item) throw new Error(`Tool not found: ${name}`);
		return item.execute(`smoke-${name}`, args, new AbortController().signal);
	};
	const text = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	const details = result => result.details;
	const freshSignal = () => new AbortController().signal;
	const rowPattern = /^smoke-search\/paged\/note-\d+\.md:\d+: /;
	try {
		await wait(() => window.app?.plugins?.plugins?.piem?.agentService, "initial service");
		check("disposable vault", app.vault.adapter.getBasePath() === `${root}/vault`);
		check("official device mode", app.isMobile === expectMobile);
		if (expectMobile) check("official phone emulation", document.body.classList.contains("emulate-mobile") && document.body.classList.contains("is-phone"));
		if (!expectMobile) check("desktop viewport", innerWidth >= 900 && innerHeight >= 700);
		plugin = app.plugins.plugins.piem;
		Object.assign(plugin.settings, {
			language: "en", networkTransport: "requestUrl", shareDiagnostics: false,
			providers: [{ id: "search-smoke", name: "Local search fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "search-smoke", providerId: "search-smoke", modelApiId: "smoke", displayName: "Search fixture", reasoning: false, supportsImages: false }],
			activeModelId: "search-smoke", codemodeMode: "on",
			mcpServers: [{ id: "builtin-exa", name: "Exa", url: "https://mcp.exa.ai/mcp", token: "", secretRef: "", enabled: false }],
		});
		// Persist the loopback endpoint before reload: startup must not race a dead one.
		await plugin.saveSettings({ reconfigure: false });
		audit = expectMobile ? observe("piem", true) : undefined;
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "reloaded service");
		plugin = app.plugins.plugins.piem;
		service = plugin.agentService;
		await plugin.activateChatView();
		await service.newSession({ force: true });
		await wait(() => tool("grep") && tool("search_notes"), "search tools present");
		report.environment = { obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1], plugin: plugin.manifest.version,
			mobile: app.isMobile, width: innerWidth, height: innerHeight, engine: navigator.userAgent };
		window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);

		// --- Corpus through the real Vault API, waiting for the real metadata cache:
		// search_notes reads aliases and headings from it, so a half-warm cache would
		// be a false red, not a product bug. ---
		const indexed = path => { const file = app.vault.getAbstractFileByPath(path); return Boolean(file) && app.metadataCache.getFileCache(file) !== null; };
		const createNote = async (path, content) => {
			const existing = app.vault.getAbstractFileByPath(path);
			if (existing) {
				if (await app.vault.cachedRead(existing) !== content) { await app.vault.modify(existing, content); await wait(() => indexed(path), `re-index of ${path}`, 15_000); }
				return;
			}
			const slash = path.lastIndexOf("/");
			if (slash > 0 && !app.vault.getAbstractFileByPath(path.slice(0, slash))) await app.vault.createFolder(path.slice(0, slash)).catch(() => undefined);
			await app.vault.create(path, content);
			await wait(() => indexed(path), `metadata cache of ${path}`, 15_000);
		};
		const allFixtures = { ...SEARCH_FIXTURES, "smoke-search/cjk/长行.md": CJK_NOTE };
		for (let n = 1; n <= 6; n++) await createNote(`smoke-search/paged/note-${n}.md`, pagedNote(n, NEEDLE));
		for (const [path, content] of Object.entries(allFixtures)) await createNote(path, content);
		await wait(async () => (await Promise.all(Object.keys(allFixtures).concat(["smoke-search/paged/note-1.md"]).map(indexed))).every(Boolean), "full fixture index", 15_000);

		// --- 1: cross-file paging over 6 notes x 105 lines. Page one stops at 100
		// with hasMore; paging from offset 100 finishes at 630 with hasMore=false;
		// concatenated pages have no gap, no duplicate, and no wrong line. ---
		const pages = [];
		let offset = 0, guard = 0;
		for (;;) {
			const page = await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged", maxMatches: 100, offset });
			const d = details(page);
			pages.push(d);
			check(`page header fields (offset=${offset})`,
				typeof d.count === "number" && typeof d.hasMore === "boolean"
				&& (d.hasMore ? d.nextOffset === offset + d.count : d.nextOffset === undefined)
				&& typeof d.candidateFiles === "number" && typeof d.readFiles === "number"
				&& typeof d.fullyScannedFiles === "number" && typeof d.lineTruncated === "boolean" && "truncatedBy" in d,
				);
			const body = text(page).split("\n").filter(line => rowPattern.test(line));
			check(`page rows match count (offset=${offset})`, body.length === d.count);
			pages[pages.length - 1].rows = body;
			if (!d.hasMore) break;
			check("hasMore implies rows delivered", d.count > 0);
			offset = d.nextOffset;
			if (++guard > 20) throw new Error("grep paging did not terminate");
		}
		check("page one covers the 100-row prefix", pages[0].offset === 0 && pages[0].count === 100 && pages[0].hasMore === true && pages[0].nextOffset === 100);
		const total = pages.reduce((sum, page) => sum + page.count, 0);
		check("final page ends clean at 630", pages[pages.length - 1].hasMore === false && total === 630);
		check("full scan on the last page", pages[pages.length - 1].readFiles === 6 && pages[pages.length - 1].fullyScannedFiles === 6 && pages[pages.length - 1].candidateFiles === 6);
		const allRows = pages.flatMap(page => page.rows);
		check("no duplicated rows across pages", new Set(allRows).size === allRows.length && allRows.length === 630);
		const expectedRows = [];
		for (let n = 1; n <= 6; n++) for (let line = 1; line <= 105; line++) expectedRows.push(`smoke-search/paged/note-${n}.md:${line}:`);
		check("concatenated pages have no gap in file/line order", allRows.every((row, i) => row.startsWith(expectedRows[i])));

		// --- 2: exact page size on a single file. 105 with maxMatches=105 is
		// hasMore=false (not a false truncation); 104 pages on with nextOffset=104. ---
		const exact = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged/note-1.md", maxMatches: 105 }));
		check("exactly one page is not truncation", exact.count === 105 && exact.hasMore === false && exact.nextOffset === undefined && exact.readFiles === 1 && exact.fullyScannedFiles === 1);
		const oneShort = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged/note-1.md", maxMatches: 104 }));
		check("one short of the end pages on", oneShort.count === 104 && oneShort.hasMore === true && oneShort.nextOffset === 104);
		const tail = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged/note-1.md", maxMatches: 104, offset: 104 }));
		check("final page delivers the remainder", tail.count === 1 && tail.hasMore === false && tail.fullyScannedFiles === 1);
		const beyond = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged/note-1.md", offset: 10_000 }));
		check("offset beyond the end is an honest empty page", beyond.count === 0 && beyond.hasMore === false && beyond.nextOffset === undefined);

		// --- 3: 60 CJK lines, each ~600 chars, together past the 50 KiB budget.
		// The page stops on bytes, marks lineTruncated, and the cursor advances only
		// by delivered rows; paging delivers every remaining line with no loss. ---
		const cjkFirst = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/cjk/长行.md", maxMatches: 1000 }));
		check("CJK page stops on the byte budget, not the count", cjkFirst.count > 0 && cjkFirst.count < 60 && cjkFirst.hasMore === true && cjkFirst.truncatedBy === "bytes" && cjkFirst.lineTruncated === true && cjkFirst.nextOffset === cjkFirst.count);
		let cjkOffset = cjkFirst.nextOffset, cjkSeen = cjkFirst.count, cjkGuard = 0;
		for (;;) {
			const page = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/cjk/长行.md", maxMatches: 1000, offset: cjkOffset }));
			check("CJK continuation starts at the delivered cursor", page.offset === cjkOffset);
			cjkSeen += page.count;
			cjkOffset = page.nextOffset;
			if (!page.hasMore) break;
			if (++cjkGuard > 20) throw new Error("CJK paging did not terminate");
		}
		check("CJK paging delivers all 60 lines exactly once", cjkSeen === 60 && cjkOffset === undefined);
		const cjkRest = details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/cjk/长行.md", maxMatches: 1000, offset: 60 }));
		check("CJK line set is exhausted at offset 60", cjkRest.count === 0 && cjkRest.hasMore === false && cjkRest.fullyScannedFiles === 1);

		// --- 4: search_notes ranks the late title/alias winner over the earlier
		// body-repeat log, includes the body-only hit with evidence, and honors scope. ---
		const scopedResult = await execute("search_notes", { query: NEEDLE, path: "smoke-search/notes", maxResults: 10 });
		const scopedText = text(scopedResult);
		const scoped = details(scopedResult);
		check("search_notes reports coverage", typeof scoped.candidateFiles === "number" && typeof scoped.scannedFiles === "number"
			&& typeof scoped.matchedNotes === "number" && typeof scoped.returnedNotes === "number"
			&& typeof scoped.metadataMissingCount === "number" && scoped.candidateFiles === 3 && scoped.scannedFiles === 3);
		check("all three in-scope notes matched", scoped.matchedNotes === 3 && scoped.returnedNotes === 3);
		const rows = scopedText.split("\n");
		const winner = rows.findIndex(row => row.includes("target-note.md"));
		const loser = rows.findIndex(row => row.includes("repeat-log.md"));
		const bodyOnly = rows.findIndex(row => row.includes("body-only.md"));
		check("all three notes appear with path and reason", winner >= 0 && loser >= 0 && bodyOnly >= 0);
		check("title/alias winner outranks the earlier repeat log", scoped.matches[0].path.endsWith("target-note.md") && loser > winner && bodyOnly > winner);
		const bodyLine = rows.find(row => /body-only\.md:\d+/.test(row)) ?? "";
		check("body-only row carries its evidence line", /body-only\.md:\d+/.test(bodyLine) && bodyLine.toLowerCase().includes(NEEDLE.toLowerCase()));
		const unscoped = details(await execute("search_notes", { query: NEEDLE, maxResults: 20 }));
		const unscopedText = text(await execute("search_notes", { query: NEEDLE, maxResults: 20 }));
		// Unscoped candidates: 6 paged notes + the CJK note + the 3 in-scope notes +
		// the out-of-scope copy — every one carries the needle somewhere.
		check("unscoped search sees every copy", unscoped.matchedNotes === 11 && unscopedText.includes("out-of-scope.md"));
		check("scope excludes the out-of-scope copy", !scopedText.includes("out-of-scope.md"));
		const noMatch = details(await execute("search_notes", { query: "zzz-no-such-term-anywhere" }));
		check("no matches is an honest empty result", noMatch.matchedNotes === 0 && noMatch.returnedNotes === 0);
		const limited = details(await execute("search_notes", { query: NEEDLE, path: "smoke-search/notes", maxResults: 1 }));
		const limitedText = text(await execute("search_notes", { query: NEEDLE, path: "smoke-search/notes", maxResults: 1 }));
		check("maxResults keeps the winner first", limited.returnedNotes === 1 && limited.matchedNotes === 3 && limitedText.includes("target-note.md") && !limitedText.includes("repeat-log.md"));

		// --- 5: mid-scan abort via a cachedRead wrapper that aborts after the first
		// read (the finally restores it); bad scope/parameters throw rather than
		// returning error results; both tools survive a plugin reload. ---
		const controller = new AbortController();
		const originalCachedRead = app.vault.cachedRead;
		restoreCachedRead = () => { app.vault.cachedRead = originalCachedRead; };
		let reads = 0;
		app.vault.cachedRead = async function (file, ...rest) {
			const result = await originalCachedRead.call(this, file, ...rest);
			reads += 1;
			if (reads >= 2) controller.abort(new Error("smoke mid-scan abort"));
			return result;
		};
		let aborted = false;
		try { await tool("grep").execute("smoke-abort", { pattern: NEEDLE, path: "smoke-search/paged", maxMatches: 1000 }, controller.signal); }
		catch { aborted = true; }
		finally { restoreCachedRead(); restoreCachedRead = null; }
		check("mid-scan abort rejects instead of returning a page", aborted && reads >= 2);
		const notesController = new AbortController();
		let notesReads = 0;
		app.vault.cachedRead = async function (file, ...rest) {
			notesReads += 1;
			if (notesReads >= 2) notesController.abort(new Error("smoke mid-scan abort"));
			return originalCachedRead.call(this, file, ...rest);
		};
		let notesAborted = false;
		try { await tool("search_notes").execute("smoke-abort", { query: NEEDLE, path: "smoke-search" }, notesController.signal); }
		catch { notesAborted = true; }
		finally { app.vault.cachedRead = originalCachedRead; restoreCachedRead = null; }
		check("search_notes mid-scan abort rejects", notesAborted && notesReads >= 2);
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "service after reload");
		plugin = app.plugins.plugins.piem;
		service = plugin.agentService;
		await service.newSession({ force: true });
		await wait(() => tool("grep") && tool("search_notes"), "search tools after reload");
		const grepTool = tool("grep"), notesTool = tool("search_notes");
		await assertThrows("grep rejects a missing scope", () => grepTool.execute("t", { pattern: NEEDLE, path: "smoke-search/does-not-exist" }, freshSignal()));
		await assertThrows("grep rejects maxMatches=0", () => grepTool.execute("t", { pattern: NEEDLE, maxMatches: 0 }, freshSignal()));
		await assertThrows("grep rejects a negative offset", () => grepTool.execute("t", { pattern: NEEDLE, offset: -1 }, freshSignal()));
		await assertThrows("grep rejects a bad regex", () => grepTool.execute("t", { pattern: "([unclosed", regex: true }, freshSignal()));
		await assertThrows("search_notes rejects maxResults=0", () => notesTool.execute("t", { query: NEEDLE, maxResults: 0 }, freshSignal()));
		await assertThrows("search_notes rejects a blank query", () => notesTool.execute("t", { query: "   " }, freshSignal()));
		await assertThrows("search_notes rejects a missing scope", () => notesTool.execute("t", { query: NEEDLE, path: "no-such-folder" }, freshSignal()));
		check("reload keeps both search tools working", details(await execute("grep", { pattern: NEEDLE, path: "smoke-search/paged/note-2.md", maxMatches: 1 })).count === 1);

		// --- 6: real provider rounds on the deterministic local fixture. (a) The
		// fixture asks for grep offset=30 on the paged folder; the provider's next
		// request must carry that page's content with offset/coverage/nextOffset and
		// both search-tool declarations. (b) A spawn_subagent/wait_subagent round:
		// the child's own request must declare search_notes. (c) Code Mode reaches
		// both tools through service.getCodemodeTool(). ---
		const stats = async () => (await fetch(`${endpoint}/state`)).json();
		await service.sendPrompt("search-smoke-grep-page: continue the scan.");
		await service.agent.waitForIdle();
		const grepWire = (await stats()).filter(request => !request.child && request.prompt.includes("search-smoke-grep-page"));
		check("grep round completed without error", !service.getSnapshot().errorMessage && grepWire.length >= 2);
		check("parent declares both search tools", grepWire[0].tools.includes("grep") && grepWire[0].tools.includes("search_notes"));
		const grepResult = grepWire.find(request => request.toolResults.length > 0)?.toolResults[0] ?? "";
		check("provider receives the paged rows", grepResult.includes("note-") && grepResult.includes("UNIQUESMOKEQUARRY"));
		check("provider receives offset, coverage and nextOffset", /offset=30/.test(grepResult) && /nextOffset/.test(grepResult) && /fully scanned|readFiles|Read /.test(grepResult));
		await service.sendPrompt("search-smoke-subagent: delegate the sweep.");
		await service.agent.waitForIdle();
		const allStats = await stats();
		const childRequests = allStats.filter(request => request.child);
		const parentWire = allStats.filter(request => !request.child && request.prompt.includes("search-smoke-subagent"));
		check("subagent round completed", !service.getSnapshot().errorMessage && childRequests.length >= 1 && parentWire.length >= 2);
		check("child search_notes declaration reaches the provider", childRequests.some(request => request.tools.includes("search_notes")));
		check("child grep declaration reaches the provider", childRequests.some(request => request.tools.includes("grep")));
		check("parent folds the child report back in", parentWire.some(request => request.toolResults.some(result => result.includes("smoke-search/paged"))));
		const run = (code, signal) => service.getCodemodeTool().execute("cm", { code }, signal ?? new AbortController().signal);
		const cmText = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
		const cmGrep = await run(`return await tools.grep({pattern:"${NEEDLE}", path:"smoke-search/paged/note-3.md", maxMatches:3});`);
		check("Code Mode calls grep with paging fields", !cmGrep.isError && /nextOffset|hasMore/.test(cmText(cmGrep)));
		const cmNotes = await run(`const r = await tools.search_notes({query:"${NEEDLE}", path:"smoke-search/notes"}); return typeof r === "string" ? r : JSON.stringify(r)`);
		check("Code Mode calls search_notes", !cmNotes.isError && cmText(cmNotes).includes("target-note.md") && /scanned \d+\/\d+ Markdown/.test(cmText(cmNotes)));
		const cmDecl = await run('return ALL_TOOLS.find(t=>t.name==="search_notes").description');
		check("Code Mode declares search_notes parameters", /query/.test(cmText(cmDecl)) && /maxResults/.test(cmText(cmDecl)));

		// --- 7: mobile loader contract on the official phone emulation: the six Node
		// negative controls denied, no Node module requests, no unexpected console
		// errors. The plugin was reloaded once during this pass (two evaluations). ---
		if (audit) {
			report.nodeAudit = audit.report;
			check("mobile plugin loaded for the audit pass", audit.report.evaluations === 2);
			check("mobile loader denies Node negative controls", audit.report.controls.length === 6 && audit.report.controls.every(control => !control.provided));
			check("mobile plugin does not request Node modules", audit.report.requests.every(request => !/^(node:|fs$|child_process$|electron$)/.test(request.id)));
			check("mobile reload has no unexpected console errors", audit.report.consoleErrors.every(error => error.control));
		}
		check("no unhandled renderer errors", report.errors.length === 0);
		report.passed = true;
	} catch (error) {
		report.failure = String(error.stack ?? error);
	} finally {
		restoreCachedRead?.();
		restoreCachedRead = null;
		report.nodeAudit = audit?.report;
		audit?.restore();
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onError);
	}
	return report;
}

let socket, deadline;
const pending = new Map(); let sequence = 0;
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find(target => target.type === "page" && target.url.startsWith("app://") && target.url.includes("index.html"));
	if (!target) throw new Error("No Obsidian index.html target");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const reply = JSON.parse(event.data), waiter = pending.get(reply.id);
		if (!waiter) return;
		pending.delete(reply.id);
		reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result);
	});
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	deadline = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error("Search smoke deadline")); socket.close(); }, 300_000);
	await call("Emulation.setFocusEmulationEnabled", { enabled: true });
	const reply = await call("Runtime.evaluate", { expression: `(${runSmoke})(${JSON.stringify(root)},${mobile},${JSON.stringify(endpoint)},(${observePluginNodeAccess}),${JSON.stringify(NEEDLE)},${JSON.stringify(SEARCH_FIXTURES)},${JSON.stringify(CJK_NOTE)},(${pagedNote.toString()}))`, awaitPromise: true, returnByValue: true });
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	// Record the artifact identity the pass actually exercised: the rig deployed this
	// main.js into the disposable vault, and the report ties every check to these bytes.
	const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
	const installed = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	const manifest = JSON.parse(await readFile(resolve(root, "vault/.obsidian/plugins/piem/manifest.json"), "utf8"));
	const installedSha = sha256(installed);
	const builtSha = sha256(await readFile(new URL("../main.js", import.meta.url)));
	if (installedSha !== builtSha) throw new Error("Installed main.js differs from this checkout build.");
	report.artifact = { installedSha256: installedSha, installedBytes: installed.byteLength, manifestVersion: manifest.version };
	if (typeof installedSha !== "string" || installed.byteLength === 0) { report.passed = false; report.failure ??= "Installed main.js is missing or empty."; }
	report.fixture = { requests };
	const kind = mobile ? "mobile" : "desktop";
	await writeFile(resolve(root, `${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `${kind}.png`), Buffer.from(shot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure, report: resolve(root, `${kind}.json`) }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(deadline); socket?.close();
	fixture.closeAllConnections();
	await new Promise(resolve => fixture.close(resolve));
}
