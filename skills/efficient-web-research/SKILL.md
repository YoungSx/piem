---
name: efficient-web-research
description: "Fetch and summarize web content token-efficiently with web_fetch: skim first, fetch the minimum needed, stop when you can answer. Use when the user gives a URL, a GitHub repo or file link, several links, or a topic to look up."
compatibility: Requires Piem's web_fetch tool (and web_search when an extension provides it); uses no vault tools.
---

# Efficient Web Research

Piem reaches the web through one core tool, `web_fetch` (an HTTP request that returns the
response body as text). There is no browser, no shell, and no separate HTTP client. Some
setups also expose a `web_search` tool through an enabled extension or provider-native
search — treat it as optional, not guaranteed.

## Core Principle

> Fetch the minimum needed to answer. Skim before you dive. Stop when you can answer.

Escalate fetch depth only when the shallower layer fails. Every unnecessary fetch wastes
tokens and adds noise.

## Fetching a page

Use when the user gives a specific URL (docs, article, raw file).

1. Skim — `web_fetch` the URL, read only the headings and the first paragraph of each. Answered? Stop.
2. Target — if the page has section anchors, re-fetch with the anchor and keep only the relevant section. Answered? Stop.
3. Full — read the whole body, ignore the nav/ads/footer boilerplate, and summarize before using it.

`web_fetch` shows only the first 50 KB of a body. For a large or unknown-size page, pass a
`Range: bytes=0-65535` header to read one window; a `206` reply with `Content-Range: …/TOTAL`
tells you how much remains, so you can page instead of gulping the whole thing.

`web_fetch` runs no JavaScript. If a page returns an empty shell or a "please enable
JavaScript" placeholder, say the content is JS-rendered and unavailable — there is no browser
fallback, so do not pretend to have read it.

## Search Protocol

Use when the user gives a topic or question, not a URL.

First sharpen the query — never search the raw user sentence:

```
"how to deploy fastapi on aws"      → "fastapi AWS deployment guide"
"python async vs threads"           → "Python asyncio vs threading performance"
"best way to structure react proj"  → "React project folder structure best practices"
```

Add specificity (versions, framework names, "guide"/"comparison"), add the current year only
when recency matters, and drop filler ("how do I", "what is the").

Then:
- If a `web_search` tool is available, run it with the sharpened query, scan titles and snippets only, and `web_fetch` the top 1–2 results (3 at most) — preferring official docs and primary sources. If a snippet already answers a simple factual question, don't fetch at all.
- If no search tool is available, either construct the likely documentation URL and `web_fetch` it, or tell the user you have no search tool and ask for a URL. Never invent results.

## GitHub

`web_fetch` reaches GitHub directly (this transport has no CORS limit):

- A specific file → `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` (plain text, cheapest).
- Repo overview → fetch the README the same way. It answers most "what is this repo" questions — try it first.
- File list / metadata → `https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1` returns JSON. Unauthenticated calls are rate-limited, so prefer raw files for content.

Never fetch every file — README plus the 1–3 files the question points to.

## Multiple URLs

Skim each link first, keep the 1–3 most relevant, summarize each in a few sentences, then
combine. Never dump raw content from several pages.

## Output

Lead with the answer, then attribute it:

```
Answer: <direct answer>
Source: <URL, or "web search: query">   (Confidence: High / Medium / Low)
```

For multiple sources, summarize per-source first, then give the combined answer. Never paste
raw HTML or full-page dumps.

## Limitations

- No JavaScript rendering: JS-only SPAs and infinite-scroll pages may return little, and there is no browser fallback — report it rather than fabricate.
- No CAPTCHA or paywall bypass.
- PDFs and other binaries come back as text and may be unreadable — say so instead of guessing their contents.
- Unauthenticated GitHub API calls can hit rate limits.
