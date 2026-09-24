/**
 * The one place a keychain value enters an outbound request without ever
 * entering the model's context.
 *
 * The problem this solves is a genuine bind. The agent must be able to
 * authenticate an HTTP call — a bearer token in a header, an API key in a query
 * string — against credentials the user keeps in Obsidian's keychain, and it
 * must be able to reach *any* entry, because a whitelist is a capability the
 * agent does not have (AGENTS.md, "Agent capability"). But the value of a live
 * credential must not land in the transcript, where it would be synced, logged,
 * and read back by the model on every subsequent turn.
 *
 * A tool that returns the plaintext cannot both be true. So there is no such
 * tool. Instead the model writes a **placeholder** — `{{secret:my-token-id}}` —
 * into the `url`, a header value, or the body of a `web_fetch` call, naming the
 * keychain entry by the id the user chose. The id is not sensitive (it is a
 * user-picked label, the same string `data.json` already stores for provider
 * bindings). The substitution happens here, at the boundary, after the model
 * has authored the call and before the request leaves the vault — so the model
 * authors with the placeholder, the transcript records the placeholder, and the
 * cleartext exists only in the argument handed to the transport.
 *
 * What this does *not* cover, by design (issue-scoped decision): a server that
 * echoes the credential back in its response body is not scrubbed. The response
 * is the model's to read, and blanket-scrubbing every tool result for anything
 * that looks like a secret is both lossy and out of scope here. The placeholder
 * keeps the value out of *authoring*; a hostile echo is a separate risk the
 * user accepted when scoping this to substitution only.
 *
 * Free of `obsidian` imports: the store arrives as a {@link Keychain}, so the
 * substitution rule is checkable without a platform.
 */

import type { Keychain } from "../keychain";

/**
 * Matches `{{secret:<id>}}`, where `<id>` obeys the same grammar Obsidian
 * enforces on a keychain entry id (lowercase alphanumerics and dashes, 1–64
 * chars — see {@link isValidSecretId}).
 *
 * Global so every occurrence in a string is replaced, and the id class is
 * pinned to the real grammar so a malformed `{{secret:...}}` is left verbatim
 * rather than treated as a lookup that then dangles — a typo in the braces is
 * the model's mistake to see, not a silent empty substitution.
 */
const SECRET_PLACEHOLDER = /\{\{secret:([a-z0-9-]{1,64})\}\}/g;

/** The human-facing form of the placeholder, for tool descriptions and errors. */
export const SECRET_PLACEHOLDER_SYNTAX = "{{secret:<entry-id>}}";

/**
 * Replaces every `{{secret:id}}` in `text` with the keychain value for `id`.
 *
 * Unknown ids — well-formed placeholders naming an entry the keychain does not
 * hold — are collected into `unknownIds` rather than substituted to `""`. An
 * empty substitution would send a request that fails auth for a reason the
 * model cannot see; naming the id back (the id is not sensitive) lets the caller
 * fail the tool with something actionable. A `text` with no placeholder is
 * returned unchanged and `unknownIds` stays empty, so the common no-secret call
 * pays only one regex scan.
 */
export function resolveSecretPlaceholders(
 text: string,
 keychain: Keychain,
): { resolved: string; unknownIds: string[] } {
 const unknown = new Set<string>();
 const resolved = text.replace(SECRET_PLACEHOLDER, (_match, id: string) => {
  const value = keychain.read(id);
  if (value === "") {
   unknown.add(id);
   return _match;
  }
  return value;
 });
 return { resolved, unknownIds: [...unknown] };
}

/** The three request fields a placeholder may appear in. */
export interface PlaceholderFields {
 url: string;
 headers?: Record<string, string>;
 body?: string;
}

/**
 * Resolves placeholders across a whole `web_fetch` argument set at once.
 *
 * Returns the fields with every known placeholder substituted, plus the union
 * of unknown ids seen anywhere in them, so the caller reports one error naming
 * all of them rather than failing on the first. `headers` and `body` are only
 * walked when present, and the returned shape reuses the input's own optional
 * fields so a call with no headers stays a call with no headers.
 */
export function resolveRequestSecrets(
 fields: PlaceholderFields,
 keychain: Keychain,
): { resolved: PlaceholderFields; unknownIds: string[] } {
 const unknown = new Set<string>();
 const take = (text: string): string => {
  const { resolved, unknownIds } = resolveSecretPlaceholders(text, keychain);
  for (const id of unknownIds) unknown.add(id);
  return resolved;
 };

 const resolved: PlaceholderFields = { url: take(fields.url) };
 if (fields.headers) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields.headers)) {
   headers[name] = take(value);
  }
  resolved.headers = headers;
 }
 if (fields.body !== undefined) {
  resolved.body = take(fields.body);
 }
 return { resolved, unknownIds: [...unknown] };
}
