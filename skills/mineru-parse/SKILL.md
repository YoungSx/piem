---
name: mineru-parse
description: "Parse a PDF, image, Office, or scanned document into Markdown with MinerU's API over web_fetch. Use when the user gives a document URL (or asks to extract/OCR/read tables or formulas from one) and wants its text, tables, or formulas as Markdown. Default anonymous; use the token channel only for large or batch jobs."
compatibility: Requires Piem's web_fetch tool and a publicly reachable document URL.
---

# Parse documents with MinerU

MinerU turns a document (PDF, image, Word, PPT, Excel — not HTML on the free
channel) into Markdown. Both channels are **asynchronous**: submit a job, get a
`task_id`, poll until `state` is `done`, then fetch the result. You drive all of
it through `web_fetch`, which sends a JSON string body and reads the response as
text — so JSON request/response works end to end.

## One constraint that decides everything

`web_fetch` cannot PUT raw file bytes. So MinerU's **file-upload** paths (the
signed-OSS `PUT` step) are out of reach here. Parse **by URL**: the document must
already live at a public HTTP(S) URL MinerU can download. A note or attachment
sitting only inside the vault has no such URL — tell the user it must be
reachable online first, don't try to upload it.

## Which channel

Start anonymous. Reach for the token channel only when a limit below bites.

| | ⚡ Anonymous (default) | 🎯 Token |
| --- | --- | --- |
| Auth | none (IP rate-limited) | `Authorization: Bearer <token>` header |
| Submit URL | `POST https://mineru.net/api/v1/agent/parse/url` | `POST https://mineru.net/api/v4/extract/task` |
| Size / pages | ≤ 10 MB, ≤ 20 pages | ≤ 200 MB, ≤ 200 pages |
| Batch | no | yes (`.../extract/task/batch`, ≤ 50 URLs) |
| Output | Markdown CDN link | Zip (Markdown + JSON; `extra_formats` for docx/html/latex) |
| HTML input | no | yes (`model_version: "MinerU-HTML"`) |

The token comes from MinerU's API-management page and is stored in the Obsidian
keychain. You do **not** paste it: put the header in the request and Piem injects
the credential from the keychain if one is configured. If the user has no token,
stay on the anonymous channel.

## Anonymous channel — the whole flow

**1. Submit.** POST JSON to `.../api/v1/agent/parse/url`, no auth header:

```json
{ "url": "https://example.com/paper.pdf", "language": "ch",
  "page_range": "1-10", "enable_table": true, "is_ocr": false, "enable_formula": true }
```

Only `url` is required. Optional fields (all PDF-only): `file_name`, `language`
(default `ch`), `enable_table` (default true), `is_ocr` (default false),
`enable_formula` (default true), `page_range` (`1-10` or a single page `5`; no
commas). Response: `{ "code": 0, "data": { "task_id": "..." }, "msg": "ok" }`.
A non-zero `code`, or HTTP `429`, means back off — the free channel is IP
rate-limited per minute.

**2. Poll.** `GET https://mineru.net/api/v1/agent/parse/{task_id}`, no auth.
`data.state` walks `pending` → `running` → `done` (or `failed`). Wait a few
seconds between polls; don't hammer it.

**3. Fetch result.** When `state` is `done`, `data.markdown_url` is a CDN link to
the `.md` file. `web_fetch` it to get the Markdown. On `failed`, read
`data.err_msg` / `data.err_code`.

## Token channel — what changes

Add `Authorization: Bearer <token>` and `Content-Type: application/json` to every
request. Submit to `.../api/v4/extract/task` with `url` plus optional `is_ocr`,
`enable_formula`, `enable_table`, `language`, `model_version`
(`pipeline` default / `vlm` recommended / `MinerU-HTML` for HTML), `data_id`, and
`extra_formats` (e.g. `["docx","html","latex"]`). Poll
`GET .../api/v4/extract/task/{task_id}`; on `done` the result is `data.full_zip_url`
(a zip, not a bare `.md`). Batch: submit to `.../api/v4/extract/task/batch` with
`{ "files": [{"url": "...", "data_id": "..."}], "model_version": "vlm" }`, get a
`batch_id`, poll `GET .../api/v4/extract-results/batch/{batch_id}`.

## `language` values (PDF OCR only)

Default `ch` (Chinese + English). Others: `en`, `japan`, `korean`, `chinese_cht`,
`ch_server`, `th`, `el`, `ta`, `te`, `ka`. Only set it when the document is
mainly one of these; the default handles Chinese/English fine.

## When it fails

| Code | Meaning | Do |
| --- | --- | --- |
| `-30001` | file > 10 MB (anonymous) | switch to token channel |
| `-30002` | unsupported type (anonymous) | must be PDF/image/Doc/PPT/Excel |
| `-30003` | too many pages (anonymous) | set `page_range` or use token channel |
| `-30004` / `-500` | bad request | check required params and `Content-Type` |
| `A0202` / `A0211` | token wrong / expired | check the `Bearer` prefix, or renew |
| `-60005` / `-60006` | file too big / too many pages | split the file |
| `-60018` | daily quota reached | try tomorrow |
| HTTP `429` | anonymous rate limit | wait, then retry |

Foreign URLs (github, aws) often time out — MinerU downloads server-side, so the
URL must be reachable from China. Report the `err_msg` verbatim rather than
guessing.
