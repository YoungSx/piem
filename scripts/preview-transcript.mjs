/*
 * Renders the transcript's real CSS against the markup the chat panel emits, so
 * the overflow behaviour can be measured instead of reasoned about.
 *
 * Sibling of `preview-command-menu.mjs` and built the same way — the rules come
 * out of `styles.css` rather than being restated here, because a copy would only
 * prove the copy works. What differs is what gets extracted: the command menu's
 * harness drops every `@media`/`@container` block, since a coarse-pointer touch
 * floor would make a desktop screenshot lie. This one keeps them. The question
 * it exists to answer — "does a wide code block drag the column sideways on a
 * phone" — is a question *about* the narrow breakpoint, so dropping the
 * container queries would remove the very rules under test.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const styles = readFileSync("styles.css", "utf8");

/*
 * Inside the repo by default, never `/tmp`: a snap-packaged Chromium runs with a
 * private `/tmp` and cannot see anything written to the real one. `PREVIEW_DIR`
 * is the escape hatch for a checkout the sandbox also refuses — snap confinement
 * covers non-hidden paths under `$HOME`, so an agent worktree under `~/.paseo/…`
 * needs the page regenerated somewhere else. `measure-transcript.mjs` says so
 * when it hits that.
 */
const OUT_DIR = process.env.PREVIEW_DIR ?? ".preview";
const OUT_FILE = `${OUT_DIR}/transcript.html`;

/*
 * The whole stylesheet, minus the halves that would misrender this page.
 *
 * Extracting "every rule that mentions the transcript" the way the command-menu
 * harness does is wrong here: the bug under test is about *containment*, which is
 * a property of the ancestor chain — `.piem-chat` establishing the query
 * container, `.piem-chat__messages` owning the scroll. Filtering by selector
 * would drop whichever link in that chain happens not to match the pattern and
 * quietly change the layout being measured. So the file is used whole, and only
 * the settings half (which never renders inside a leaf) is left to be inert.
 */
const rules = styles;

/*
 * The guard covers the harness's *scaffolding*, not the behaviour under test —
 * and the distinction is what makes the measurement worth anything.
 *
 * The first cut of this listed `overflow-x: hidden` here. That inverted the whole
 * point: deleting the fix then failed at this line with "the harness would
 * measure a layout the plugin does not ship", so the one regression the harness
 * exists to catch was reported as the harness being broken, and the measurement
 * never ran. A guard must never assert what the assertions assert.
 *
 * What is left is what the page cannot render honestly without: the container
 * query the narrow-panel rules bind to, the scroll container itself, and the two
 * text faces the fixtures wear. Losing any of those means the harness is
 * measuring different markup than the plugin ships, which is a harness fault.
 */
for (const required of ["container-type: inline-size", ".piem-chat__messages {", ".piem-chat__markdown ", ".piem-chat__text {"]) {
	if (!rules.includes(required)) {
		throw new Error(`styles.css no longer carries ${required}; the harness would measure different markup than the plugin ships`);
	}
}

/*
 * Obsidian's own values for the tokens the stylesheet reads. Enough of them that
 * no declaration falls back to an initial value and changes the layout: an unset
 * `--size-4-2` would render every gap as `0` and hide a real overflow.
 */
const TOKENS = `
	--size-4-1: 4px;
	--size-4-2: 8px;
	--size-4-3: 12px;
	--size-4-4: 16px;
	--size-4-5: 20px;
	--size-4-6: 24px;
	--size-4-8: 32px;
	--size-4-9: 36px;
	--size-4-10: 40px;
	--size-4-12: 48px;
	--size-2-1: 2px;
	--size-2-2: 4px;
	--size-2-3: 6px;
	--radius-s: 4px;
	--radius-m: 8px;
	--radius-l: 12px;
	--font-ui-smaller: 12px;
	--font-ui-small: 13px;
	--font-ui-medium: 15px;
	--font-text-size: 16px;
	--line-height-normal: 1.5;
	--p-spacing: 1rem;
	--font-semibold: 600;
	--font-medium: 500;
	--font-interface: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	--font-monospace: ui-monospace, SFMono-Regular, Menlo, monospace;
	--icon-s: 16px;
	--icon-size: 16px;
	--icon-color: #b3b3b3;
	--icon-color-hover: #dcddde;
	--icon-opacity: 0.85;
	--background-primary: #1e1e1e;
	--background-primary-alt: #161616;
	--background-secondary: #262626;
	--background-secondary-alt: #1a1a1a;
	--background-modifier-border: #3f3f3f;
	--background-modifier-border-hover: #555;
	--background-modifier-border-focus: #888;
	--background-modifier-hover: rgba(255, 255, 255, 0.075);
	--background-modifier-error: #a33;
	--background-modifier-error-rgb: 170, 51, 51;
	--background-modifier-success: #2a2;
	--text-normal: #dcddde;
	--text-muted: #b3b3b3;
	--text-faint: #6e6e6e;
	--text-error: #e55;
	--text-accent: #a882ff;
	--text-on-accent: #fff;
	--text-success: #2a2;
	--interactive-accent: #7c3aed;
	--interactive-accent-hover: #6d28d9;
	--interactive-normal: #2a2a2a;
	--interactive-hover: #333;
	--code-background: #2a2a2a;
	--pre-background: #2a2a2a;
	--code-size: 0.9em;
	--tag-background: #333;
	--shadow-s: 0 1px 2px rgba(0, 0, 0, 0.5);
	--shadow-l: 0 4px 12px rgba(0, 0, 0, 0.5);
	--layer-menu: 65;
	--scrollbar-thumb-bg: #555;
`;

/*
 * What `MarkdownRenderer.render` emits for each construct that can be wider than
 * a phone panel. Written as HTML rather than Markdown because the renderer is
 * Obsidian's and cannot run here; these are its documented outputs — a fenced
 * block as `<pre><code>`, a table as `<table>` (optionally inside Obsidian's own
 * `.table-wrapper`), math as `.math-block`.
 *
 * Every fixture is pathological on purpose. A construct that merely *might*
 * overflow proves nothing: the point is to hold the panel to a case that has no
 * line-break opportunity at all, because that is the case `pre-wrap` and
 * `word-wrap` silently fail.
 */
const LONG_PATH = "/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyVault/attachments/2026-09-01-screenshot-of-the-settings-pane.png";
const LONG_TOKEN = "a".repeat(96);

/*
 * A body taller than the bound that is supposed to cap it.
 *
 * The horizontal fixtures above are one or two lines each, which is all their own
 * axis needs — and is why the vertical bound went unmeasured for as long as it
 * did: at two lines, a rule capping the box at 18rem and no rule at all produce
 * the same layout. Forty lines is past the cap at every panel width in this page,
 * so the box either scrolls or the bound is not biting.
 */
const TALL_BODY = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a think that outruns the column`).join("\n");

/*
 * A provider error as the panel receives one: `\n`-joined, with an unbreakable
 * path and token in it. Both halves of `.piem-chat__cutoff-raw`'s contract are in
 * here — the breaks it must keep, and the tokens it must break inside.
 */
const RAW_ERROR = `request failed: 401 invalid key\nat ${LONG_PATH}\ntoken ${LONG_TOKEN}`;

const MARKDOWN_CASES = {
	"long-url": `<p>See <a href="#">https://example.com/very/long/path/segment-that-never-breaks-anywhere?query=${LONG_TOKEN}</a> for details.</p>`,
	"inline-code": `<p>Run <code>bun test --filter ${LONG_TOKEN}</code> and check the output.</p>`,
	"fenced-code": `<pre><code>const value = "${LONG_TOKEN}";\nshort();\n</code></pre>`,
	"table-bare": `<table><thead><tr><th>path</th><th>lines</th><th>symbol</th><th>kind</th><th>owner</th></tr></thead><tbody><tr><td>src/ui/MessageList.tsx</td><td>812</td><td>MessageRow</td><td>function</td><td>ui</td></tr></tbody></table>`,
	"table-wrapped": `<div class="table-wrapper"><table><thead><tr><th>path</th><th>lines</th><th>symbol</th><th>kind</th><th>owner</th></tr></thead><tbody><tr><td>src/ui/MessageList.tsx</td><td>812</td><td>MessageRow</td><td>function</td><td>ui</td></tr></tbody></table></div>`,
	"wide-image": `<p><img alt="" width="1400" height="320" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1400' height='320'%3E%3Crect width='1400' height='320' fill='%23444'/%3E%3C/svg%3E"></p>`,
	"blockquote": `<blockquote><p>${LONG_TOKEN}</p></blockquote>`,
	"heading": `<h2>${LONG_TOKEN}</h2>`,
	"list-path": `<ul><li>${LONG_PATH}</li><li>short</li></ul>`,
	"math-block": `<div class="math math-block"><span style="white-space: nowrap">x = ${LONG_TOKEN}</span></div>`,
};

/** A conversational row, exactly as `MessageList.tsx` nests it. */
function messageRow(role, name, inner) {
	return `<article class="piem-chat__message piem-chat__message--${role}" data-case="${role}/${name}" aria-label="${role}">
	<div class="piem-chat__bubble">
		<div class="piem-chat__message-content">${inner}</div>
	</div>
</article>`;
}

/** The rendered-Markdown face. */
function markdownBlock(html) {
	return `<div class="piem-chat__markdown markdown-rendered piem-chat__text--prose">${html}</div>`;
}

/** The plain `<pre>` face, used for streaming prose and machine output. */
function plainBlock(face, text) {
	return `<pre class="piem-chat__text piem-chat__text--${face}">${text}</pre>`;
}

/**
 * A trace row, bodied or flat.
 *
 * A call whose payload is hidden is the flat case, and it is here because it is
 * the one with nothing bounding it: the `result` and `harness` variants bound
 * their own height and so were already scroll containers on both axes, while a
 * flat row has only its detail span holding a path to the panel's width.
 *
 * `variant` names the case for `data-case` but only reaches the class list when
 * the row has a body. A flat row wears no variant of its own — `traceClasses` in
 * `MessageList.tsx` returns nothing for a call with neither a result nor a live
 * marker — so a `--call` modifier here would be a class the plugin never sets, in
 * a page whose whole claim is that it renders what the plugin does.
 */
function traceRow(variant, name, detail, body) {
	const summary = `<summary class="piem-chat__trace-summary">
		<span class="piem-chat__trace-name piem-chat__trace-name--identifier">read_note</span>
		<span class="piem-chat__trace-detail">${detail}</span>
	</summary>`;
	if (!body) {
		return `<div class="piem-chat__trace piem-chat__trace--flat" data-case="trace-${variant}/${name}">
		<span class="piem-chat__trace-name piem-chat__trace-name--identifier">read_note</span>
		<span class="piem-chat__trace-detail">${detail}</span>
	</div>`;
	}
	return `<details class="piem-chat__trace piem-chat__trace--${variant}" data-case="trace-${variant}/${name}" open>${summary}
	<div class="piem-chat__trace-body"><pre>${body}</pre></div>
</details>`;
}

/**
 * A thinking row in one of its three states, which is three different boxes.
 *
 * `live` is the row while the model is still writing it: it wears
 * `--running`, and the bound deliberately does not apply — the reader is
 * following the newest sentence, and an inner scrollbox would park it out of
 * reach of the transcript's own follow-scroll.
 *
 * The other two are both settled and differ only in what the body holds, which is
 * not cosmetic here: `MessageList.tsx` renders a thinking block through
 * `MarkdownText`, which emits a bare `<pre>` while the message streams and a
 * rendered Markdown container once it settles. The cap has to bite on both, and
 * they are different enough boxes — one replaced-content block, one flow of
 * paragraphs — that measuring only the `pre` would leave the shape the reader
 * actually ends up looking at unmeasured.
 */
function thinkingRow(state, body) {
	const running = state === "live" ? " piem-chat__trace--running" : "";
	const inner = state === "settled-markdown"
		? `<div class="piem-chat__markdown markdown-rendered piem-chat__text--prose">${body
				.split("\n")
				.map((line) => `<p>${line}</p>`)
				.join("")}</div>`
		: `<pre class="piem-chat__text piem-chat__text--prose">${body}</pre>`;
	return `<details class="piem-chat__trace piem-chat__trace--thinking${running}" data-case="trace-thinking/${state}"${state === "live" ? ' aria-busy="true"' : ""} open>
	<summary class="piem-chat__trace-summary"><span class="piem-chat__trace-name piem-chat__trace-name--label">${state === "live" ? "Thinking…" : "Thought it through"}</span></summary>
	<div class="piem-chat__trace-body">${inner}</div>
</details>`;
}

/**
 * One assistant turn, split across rows the way `pi` splits it.
 *
 * This is the fixture for the *vertical* half of what this page measures, and it
 * has to be built by hand rather than out of `messageRow` because the shape that
 * misrendered is specifically a message whose first and last children are trace
 * rows, followed by a bare trace row, followed by another such message. Three
 * boundaries, each between a different pair of row kinds. Their spacing follows
 * the visible content: process rows stay close, prose has a larger pause.
 *
 * `data-rhythm` marks the blocks whose spacing is asserted; the page's script
 * reads consecutive pairs of them and reports each gap along with whether the
 * pair shares a message. `data-case` stays on the rows for the horizontal checks,
 * which walk the same markup.
 */
function rhythmTurn() {
	const thinking = (mark) => `<details class="piem-chat__trace piem-chat__trace--thinking" data-rhythm="${mark}">
		<summary class="piem-chat__trace-summary"><span class="piem-chat__trace-name piem-chat__trace-name--label">Thought it through</span></summary>
		<div class="piem-chat__trace-body"><pre>weighing two endpoints</pre></div>
	</details>`;
	const said = (mark, text) => `<div class="piem-chat__markdown markdown-rendered piem-chat__text--prose" data-rhythm="${mark}"><p>${text}</p></div>`;
	const asked = (mark, text) => `<div class="piem-chat__markdown markdown-rendered piem-chat__text--prose" data-rhythm="${mark}"><p>${text}</p></div>`;
	const fold = (mark) => `<details class="piem-chat__trace piem-chat__trace--fold" data-rhythm="${mark}">
		<summary class="piem-chat__trace-summary"><span class="piem-chat__trace-name piem-chat__trace-name--label">Fetched 3 pages</span></summary>
		<div class="piem-chat__trace-body"><div class="piem-chat__trace piem-chat__trace--flat"><span class="piem-chat__trace-name piem-chat__trace-name--identifier">web_fetch</span></div></div>
	</details>`;
	return [
		`<article class="piem-chat__message piem-chat__message--user" data-case="rhythm/asks" aria-label="you">
	<div class="piem-chat__bubble">
		<div class="piem-chat__message-content">${asked("asks", "Which endpoint does Cline use?")}</div>
	</div>
</article>`,
		`<article class="piem-chat__message piem-chat__message--assistant" data-case="rhythm/opens" data-first-block="trace" data-last-block="trace" aria-label="assistant">
	<div class="piem-chat__bubble">
		<div class="piem-chat__message-content">${thinking("opens/thinking")}${said("opens/prose", "Looking up the endpoint now.")}${fold("opens/fold")}</div>
	</div>
</article>`,
		`<details class="piem-chat__trace piem-chat__trace--result" data-case="rhythm/result" data-rhythm="result">
	<summary class="piem-chat__trace-summary"><span class="piem-chat__trace-name piem-chat__trace-name--label">Edited a note</span><span class="piem-chat__trace-detail">+8 -0</span></summary>
	<div class="piem-chat__trace-body"><pre>@@ -1 +1 @@</pre></div>
</details>`,
		`<article class="piem-chat__message piem-chat__message--assistant" data-case="rhythm/closes" data-first-block="trace" data-last-block="prose" aria-label="assistant">
	<div class="piem-chat__bubble">
		<div class="piem-chat__message-content">${thinking("closes/thinking")}${said("closes/prose", "Written back to the note.")}</div>
	</div>
</article>`,
		`<article class="piem-chat__message piem-chat__message--assistant" data-case="rhythm/prose-edge" data-first-block="prose" data-last-block="trace" aria-label="assistant">
	<div class="piem-chat__bubble"><div class="piem-chat__message-content">${said("edge/prose", "The two sources agree.")}${said("edge/paragraph", "The original notes are preserved.")}${thinking("edge/thinking")}</div></div>
</article>`,
		`<article class="piem-chat__message piem-chat__message--assistant" data-case="rhythm/trace-to-prose" data-first-block="prose" data-last-block="prose" aria-label="assistant">
	<div class="piem-chat__bubble"><div class="piem-chat__message-content">${said("edge/answer", "Ready to review.")}</div></div>
</article>`,
		`<article class="piem-chat__message piem-chat__message--assistant" data-case="rhythm/prose-to-trace" data-first-block="trace" data-last-block="trace" aria-label="assistant">
	<div class="piem-chat__bubble"><div class="piem-chat__message-content">${thinking("edge/check")}${fold("edge/fold")}</div></div>
</article>`,
	];
}

const rows = [];
for (const [name, html] of Object.entries(MARKDOWN_CASES)) {
	rows.push(messageRow("assistant", name, markdownBlock(html)));
	rows.push(messageRow("user", name, markdownBlock(html)));
}
// The plain face, both typefaces: prose is the streaming branch, machine is tool
// output — and only the second has columns worth scrolling for.
rows.push(messageRow("assistant", "plain-machine", plainBlock("machine", `path\tlines\n${LONG_PATH}\t812`)));
rows.push(messageRow("assistant", "plain-prose", plainBlock("prose", `Reading ${LONG_PATH} now`)));
// Trace rows: a bounded result, a bounded harness block, and the unbounded call.
rows.push(traceRow("result", "long-output", LONG_PATH, `${LONG_PATH}\n${LONG_TOKEN}`));
rows.push(traceRow("harness", "wide-columns", LONG_PATH, `col_a\tcol_b\n${LONG_PATH}\t1`));
rows.push(traceRow("call", "flat", LONG_PATH, ""));
/*
 * The vertical bound, on every variant that carries it and the one that is exempt.
 * The bodies here are deliberately tall; the rows above are deliberately wide.
 */
rows.push(traceRow("result", "tall-output", LONG_PATH, TALL_BODY));
rows.push(traceRow("harness", "tall-output", LONG_PATH, TALL_BODY));
rows.push(thinkingRow("live", TALL_BODY));
rows.push(thinkingRow("settled-pre", TALL_BODY));
rows.push(thinkingRow("settled-markdown", TALL_BODY));
/*
 * The question card, both lives.
 *
 * It is a new construct in this column and the only interactive one: an option label
 * and its description are model-written text, so they are exactly the kind of content
 * that arrives unbreakable. A row that pushed the column open instead of wrapping
 * would drag the whole transcript sideways, which is the invariant this page holds.
 * The pathological label and the long path are the cases `pre-wrap` and `word-wrap`
 * silently fail on.
 */
rows.push(`<section class="piem-ask-card piem-ask-card--pending" data-case="ask-card/pending" aria-label="Question from Piem" tabindex="-1">
	<div class="piem-ask-card__state" role="status">
		<span class="piem-icon piem-ask-card__state-icon"></span>
		<span class="piem-ask-card__state-text">Piem needs your call</span>
	</div>
	<div class="piem-ask">
		<div class="piem-ask-question">
			<div class="piem-ask-question-text" id="ask-q0">Which of these should the merged note keep? ${LONG_TOKEN}</div>
			<div class="piem-ask-options" role="group" aria-labelledby="ask-q0" aria-label="What to keep" data-select="one">
				<button type="button" class="piem-ask-option" aria-pressed="false">
					<span class="piem-ask-option-marker" aria-hidden="true"></span>
					<span class="piem-ask-option-body">
						<span class="piem-ask-option-label">${LONG_PATH}</span>
						<span class="piem-ask-option-description">${LONG_TOKEN}</span>
					</span>
				</button>
				<button type="button" class="piem-ask-option" aria-pressed="true">
					<span class="piem-ask-option-marker" aria-hidden="true"></span>
					<span class="piem-ask-option-body"><span class="piem-ask-option-label">Keep both</span></span>
				</button>
				<label class="piem-ask-other-row">
					<span class="piem-ask-option-marker" aria-hidden="true"></span>
					<input type="text" class="piem-ask-other" placeholder="Something else…" aria-label="Your own answer for: What to keep">
				</label>
			</div>
		</div>
		<div class="piem-ask-footer">
			<span class="piem-ask-remaining"></span>
			<button type="button" class="piem-ask-dismiss">Let Piem decide</button>
			<button type="button" class="piem-ask-confirm mod-cta" disabled>Confirm</button>
		</div>
	</div>
</section>`);
rows.push(`<section class="piem-ask-card piem-ask-card--answered" data-case="ask-card/answered" aria-label="Question from Piem">
	<div class="piem-ask-card__state">
		<span class="piem-icon piem-ask-card__state-icon"></span>
		<span class="piem-ask-card__state-text">You answered</span>
	</div>
	<dl class="piem-ask-card__record">
		<div class="piem-ask-card__pair">
			<dt class="piem-ask-card__question">Which of these should the merged note keep? ${LONG_TOKEN}</dt>
			<dd class="piem-ask-card__answer"><span class="piem-ask-card__picked">${LONG_PATH}</span></dd>
		</div>
	</dl>
</section>`);
/*
 * The tidying seam, opened onto the summary it wrote.
 *
 * This fixture drew the compaction divider until `e578694` replaced that divider
 * with a trace row and took `.piem-chat__compaction` out of the stylesheet with
 * it. The fixture kept emitting the dead class, so its `<pre>` matched no rule the
 * plugin ships and rendered at browser defaults — and the page reported the
 * transcript scrolling sideways by 1816px at every width, blaming a stylesheet
 * that was holding the column still. A fixture bound to a class nothing styles
 * does not measure nothing; it measures the absence of every rule, and files the
 * result against the wrong file. `transcriptOverflow.test.ts` pins the pair now.
 *
 * The seam is a child of the column rather than of a message, like a bare tool
 * result: it is the conversation being cut, not something a turn said. Its body
 * bounds height only — the block inside owns the width — which is the half this
 * page is here to check.
 *
 * `open` because a closed `<details>` renders no body, and the body is where the
 * unbreakable content is. The glyph holder is empty: `setIcon` paints it in the
 * app and this page has no icon shim, which `preview-visual.mjs` is the harness
 * for. It is a flex item on the summary line either way, and 16px cannot decide a
 * question the fixtures overshoot by hundreds of pixels.
 */
rows.push(`<details class="piem-chat__trace piem-chat__trace--seam" data-case="seam/long-summary" open>
	<summary class="piem-chat__trace-summary">
		<span class="piem-icon piem-chat__trace-icon" aria-hidden="true"></span>
		<span class="piem-chat__trace-name piem-chat__trace-name--label">Thoughts tidied</span>
	</summary>
	<div class="piem-chat__trace-body"><pre class="piem-chat__text piem-chat__text--prose">${LONG_PATH} ${LONG_TOKEN}</pre></div>
</details>`);
/*
 * The provider's own words, behind a failed reply's pill.
 *
 * The one construct in this column that has to *wrap* rather than scroll: its
 * horizontal extent carries nothing, so it breaks mid-token instead of owning a
 * scroll box. That makes it the only one with nothing between it and the column —
 * `.piem-chat__trace--failed` gives its body no overflow of its own — so if the
 * break stopped biting, the transcript itself is what would move.
 * `transcriptOverflow.test.ts` asserts the two declarations that make it break;
 * only a layout engine can say whether they do.
 *
 * Nested the way `MessageList` nests it — a sibling of the message's content
 * inside the bubble, not another block within it — and opened, because it ships
 * closed and a reader who opens it is the case worth measuring.
 */
rows.push(`<article class="piem-chat__message piem-chat__message--assistant" data-case="cutoff/raw" aria-label="assistant">
	<div class="piem-chat__bubble">
		<div class="piem-chat__message-content">${markdownBlock("<p>Half an answer, then the provider gave up.</p>")}</div>
		<details class="piem-chat__trace piem-chat__trace--failed" open>
			<summary class="piem-chat__trace-summary">
				<span class="piem-icon piem-chat__trace-icon" aria-hidden="true"></span>
				<span class="piem-chat__trace-name piem-chat__trace-name--label">The provider rejected the key. Check it in settings, then ask again.</span>
			</summary>
			<div class="piem-chat__trace-body"><p class="piem-chat__cutoff-raw">${RAW_ERROR}</p></div>
		</details>
	</div>
</article>`);

rows.push(...rhythmTurn());

/*
 * Three panels, each a real leaf.
 *
 * The 390px one is the phone the issue was filed against. The 300px one is the
 * default desktop right sidebar, which is *narrower* and so the harder case —
 * and the reason the `@container` blocks are kept: at 300px and 390px the
 * narrow-leaf rules fire, at 560px they do not, so the middle column is where a
 * fix that only works below the breakpoint would show up.
 *
 * `contain: strict` and `isolation: isolate` mirror what `app.css` puts on
 * `.workspace-leaf`; without them the panel would be free to grow into the page
 * and every measurement would read zero overflow.
 */
function panel(label, width) {
	return `<div class="harness-panel">
	<h3>${label}</h3>
	<div class="harness-leaf" style="width: ${width}px" data-panel="${label}" data-width="${width}">
		<div class="view-content piem-chat-view">
			<div class="piem-chat">
				<div class="piem-chat__transcript">
					<div class="piem-chat__messages" tabindex="0">${rows.join("\n")}</div>
				</div>
			</div>
		</div>
	</div>
</div>`;
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>piem transcript overflow</title><style>
:root {${TOKENS}}
body { background: #111; color: var(--text-normal); font-family: var(--font-interface); margin: 0; padding: 16px; display: flex; gap: 20px; align-items: flex-start; }
.harness-panel h3 { color: #888; font-size: 11px; font-weight: 400; margin: 0 0 6px; }
/* The leaf, as app.css builds it: a fixed-width containment and stacking box. */
.harness-leaf { background: var(--background-secondary); contain: strict; isolation: isolate; height: 620px; }
.view-content { height: 100%; width: 100%; }
/*
 * Obsidian's own form-control rule, reproduced so the element-qualified resets in
 * styles.css have the thing they exist to outrank. The question card's rows are
 * buttons, and without this the page would measure a layout the plugin never
 * produces — and would pass while the reset was broken. No backticks in this
 * comment: it lives inside the page template literal and one would close it.
 */
button:not(.clickable-icon) { background: var(--interactive-normal, #2a2a2a); border: none; color: var(--text-normal); font-family: inherit; font-size: var(--font-ui-small); height: 30px; padding: 0 12px; text-align: center; white-space: nowrap; }
${rules}
</style></head><body>
${panel("300px sidebar", 300)}
${panel("390px phone", 390)}
${panel("560px wide leaf", 560)}
<pre id="results" style="display: none"></pre>
<script>
/*
 * Measures what the engine produced, inline so a plain \`--dump-dom\` run carries
 * the numbers back out.
 *
 * The verdict is deliberately not "is any element wider than the panel". A table
 * inside its own horizontally scrollable box is *supposed* to be wider than the
 * panel — that is the fix, not the bug. Two separate questions are asked instead:
 *
 *   1. Does the transcript itself scroll sideways? It must never, on any width.
 *      This is the user-visible symptom the issue reports.
 *   2. Does any element push a box that absorbs nothing? Walking up from each
 *      element to the first ancestor with \`overflow-x: auto|scroll\` answers it —
 *      content inside such an ancestor is contained by design, content that
 *      reaches the transcript without meeting one is a leak.
 *
 * Clipping alone is not containment, and the distinction is the whole point:
 * \`overflow-x: hidden\` on the transcript would make symptom 1 disappear while
 * silently truncating a wide table to whatever fits. So \`hidden\` does not count
 * as absorbing in check 2 — only a scrollable ancestor does, because only that
 * one leaves the content reachable.
 */
const out = [];
for (const leaf of document.querySelectorAll(".harness-leaf")) {
	const label = leaf.dataset.panel;
	const msgs = leaf.querySelector(".piem-chat__messages");
	const scrollsX = (el) => { const ox = getComputedStyle(el).overflowX; return ox === "auto" || ox === "scroll"; };
	const clipsX = (el) => scrollsX(el) || getComputedStyle(el).overflowX === "hidden";

	// Which direct children set the transcript's scrollWidth — the ones to blame.
	const pushers = [...msgs.children]
		.filter((el) => el.scrollWidth > msgs.clientWidth + 1)
		.map((el) => ({ case: el.dataset.case ?? el.className, scrollWidth: el.scrollWidth }));

	const leaks = [];
	const contained = [];
	for (const el of msgs.querySelectorAll("*")) {
		let host = null;
		for (let p = el.parentElement; p; p = p.parentElement) {
			if (clipsX(p)) { host = p; break; }
		}
		host = host ?? document.documentElement;
		const over = Math.round(el.getBoundingClientRect().right - host.getBoundingClientRect().right);
		// Contained when something between this element and the transcript scrolls.
		let absorbed = false;
		for (let p = el.parentElement; p && p !== msgs; p = p.parentElement) {
			if (scrollsX(p)) { absorbed = true; break; }
		}
		const row = el.closest("[data-case]");
		const id = { case: row ? row.dataset.case : "(none)", tag: el.tagName.toLowerCase(), cls: el.className || "" };
		if (over > 1 && !scrollsX(el) && !absorbed) {
			leaks.push({ ...id, pushesBy: over });
		}
		if (scrollsX(el) && el.scrollWidth > el.clientWidth + 1) {
			contained.push({ ...id, inner: el.scrollWidth, box: el.clientWidth });
		}
	}
	/*
	 * Whether a wide block's own scrollbar is reachable, i.e. whether the block's
	 * right edge is inside the column. A scroll box that starts beyond the panel's
	 * edge is a scrollbar nobody can grab.
	 */
	const reachable = [];
	for (const el of msgs.querySelectorAll("*")) {
		if (!scrollsX(el) || el.scrollWidth <= el.clientWidth + 1) continue;
		const r = el.getBoundingClientRect(), m = msgs.getBoundingClientRect();
		const row = el.closest("[data-case]");
		reachable.push({ case: row ? row.dataset.case : "(none)", tag: el.tagName.toLowerCase(),
			rightInside: Math.round(m.right - r.right) >= -1, overhang: Math.round(r.right - m.right) });
	}
	/*
	 * The vertical half. Consecutive data-rhythm blocks, with the gap the engine
	 * left between them and whether the pair shares a message. The visible kinds
	 * determine the rhythm; message wrappers must not change it.
	 *
	 * Read off border boxes rather than text boxes on purpose: a trace row is
	 * padded to a touch target on coarse pointers, and asserting text-to-text
	 * distance would fold that floor into a spacing number and make the same
	 * stylesheet measure differently per device.
	 *
	 * The third question a boundary can answer is whether the conversation changed
	 * hands across it — true when exactly one side sits inside the user's turn,
	 * which is where the transcript is allowed to spend more than a seam.
	 *
	 * Which pair of boxes gets measured depends on the answer to the first, and has
	 * to: inside a message the blocks are what the spacing is between, but across a
	 * boundary the rows are, and a row can hold its blocks off its own edge. The
	 * user's turn does exactly that — its bubble is the box with the fill, so it
	 * carries 8px of padding and a border that are the bubble's inset and not the
	 * column's spacing. Measuring block-to-block there would read 25px for what the
	 * eye and the stylesheet both call 16px.
	 */
	const marks = [...msgs.querySelectorAll("[data-rhythm]")];
	const rhythm = [];
	for (let i = 0; i < marks.length - 1; i++) {
		const a = marks[i], b = marks[i + 1];
		const contentOf = (el) => el.closest(".piem-chat__message-content");
		const asksIn = (el) => el.closest(".piem-chat__message--user") !== null;
		// The row this block belongs to: the child of the column that contains it,
		// which for a bare trace row is the block itself.
		const rowOf = (el) => { let p = el; while (p.parentElement && p.parentElement !== msgs) p = p.parentElement; return p; };
		const within = contentOf(a) !== null && contentOf(a) === contentOf(b);
		const [boxA, boxB] = within ? [a, b] : [rowOf(a), rowOf(b)];
		rhythm.push({
			from: a.dataset.rhythm,
			to: b.dataset.rhythm,
			speakerChange: asksIn(a) !== asksIn(b),
			withinMessage: within,
			fromKind: a.classList.contains("piem-chat__trace") ? "trace" : "prose",
			toKind: b.classList.contains("piem-chat__trace") ? "trace" : "prose",
			gap: Math.round((boxB.getBoundingClientRect().top - boxA.getBoundingClientRect().bottom) * 10) / 10,
		});
	}
	/*
	 * The vertical bound on machine traffic. Read as consequences, not
	 * declarations: a max-height resolving to a pixel value says a cap was
	 * declared, while a scroll height past the client height with a scrollable
	 * overflow is the only evidence it actually clipped anything — a cap on a box
	 * whose ancestor never gave it a height is a cap that does nothing, which is
	 * exactly the failure no substring check can see.
	 *
	 * The live thinking row is measured the same way and asserted the other way
	 * round: it must come out unbounded, because its reader is following a stream
	 * the transcript is scrolling for them.
	 *
	 * No backticks in this comment: it lives inside the page template literal and
	 * one would close it.
	 */
	const bounds = [];
	for (const body of msgs.querySelectorAll("[data-case] .piem-chat__trace-body")) {
		const host = body.closest("[data-case]");
		const style = getComputedStyle(body);
		/*
		 * Whether this body is one the bound is supposed to hold, decided off the
		 * classes the plugin sets rather than off a list of case names here: the
		 * variants are what the rule names, and a fixture renamed in the section above
		 * must not quietly drop out of the assertion.
		 *
		 * A live think is the exemption and is the one row asserted the other way, so
		 * it is excluded here rather than being absent: a settled think, a tool result
		 * and a harness block are bounded, and the same row while running is not.
		 */
		const trace = body.closest(".piem-chat__trace");
		const running = trace.classList.contains("piem-chat__trace--running");
		const bounded = !running && ["piem-chat__trace--result", "piem-chat__trace--harness", "piem-chat__trace--thinking"].some((cls) => trace.classList.contains(cls));
		/*
		 * A seam carries a bound of its own, at its own number and for its own reason
		 * (a conversation summary is long, and it is not machine traffic). It is
		 * neither the trio nor the exemption, so it is reported and left to the
		 * consumer rather than being forced into a yes/no this collector cannot
		 * honestly answer.
		 */
		const seam = trace.classList.contains("piem-chat__trace--seam");
		// The absence of a cap (the engine spells it "none") is reported as null, so
		// the consumer never has to know which spelling came back.
		const cap = style.maxHeight === "none" ? null : Math.round(parseFloat(style.maxHeight));
		const scrollable = style.overflowY === "auto" || style.overflowY === "scroll";
		bounds.push({
			case: host.dataset.case,
			shouldBound: bounded,
			ownBound: seam,
			maxHeight: cap,
			overflowY: style.overflowY,
			clientHeight: body.clientHeight,
			scrollHeight: body.scrollHeight,
			/*
			 * Whether this body holds more than its cap allows. Only a body that does
			 * can testify that the cap bites: a two-line result is shorter than any
			 * bound and correctly scrolls nothing, and asking it for a scrollbar would
			 * fail the fixtures that are right. The tall fixtures are the witnesses,
			 * and this flag is what marks them as such.
			 */
			overflows: cap !== null && body.scrollHeight > cap + 1,
			// The cap biting, which is the only thing that distinguishes a rule that
			// works from one declared on a box no ancestor ever gave a height.
			clips: scrollable && body.scrollHeight > body.clientHeight + 1,
		});
	}
	out.push({
		panel: label,
		bounds,
		rhythm,
		reachable,
		width: Number(leaf.dataset.width),
		client: msgs.clientWidth,
		scrollWidth: msgs.scrollWidth,
		overflowX: getComputedStyle(msgs).overflowX,
		panelScrollsSideways: msgs.scrollWidth > msgs.clientWidth + 1,
		pushers,
		leaks,
		contained,
	});
}
document.getElementById("results").textContent = JSON.stringify(out);
</script>
</body></html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, html);
console.log(`wrote ${OUT_FILE} — open it in a browser, or run: node scripts/measure-transcript.mjs`);
