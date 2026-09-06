Help the user discover skills from the open agent-skills ecosystem. This workflow is adapted from Vercel's MIT-licensed find-skills skill for Piem's vault-only environment.

1. Clarify the domain and exact task. Prefer a reusable skill only when the request is common and specialized enough to benefit from one.
2. If web_fetch is available, inspect skills.sh and the source repository. If it is unavailable, say that live results cannot be verified and give the user the skills.sh URL instead of inventing results.
3. Verify install count, repository owner, GitHub reputation, license, recent maintenance, the complete SKILL.md, and any published security audit. Never recommend from a search title alone.
4. Present a short list with the skill name, purpose, source, evidence, URL, and any compatibility limits. Piem cannot run npx or install outside the vault.
5. Only when the user explicitly asks to install, fetch and inspect the full SKILL.md, then write it under Piem/skills/<name>/SKILL.md. Never execute remote code, never copy hidden scripts, and never overwrite an existing vault skill without confirmation.
