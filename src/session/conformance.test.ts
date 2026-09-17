import { describe, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { type SessionRepo, JsonlSessionRepo, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type {
	ForkOptions,
	JsonlSessionMetadata,
	SessionCreateOptions,
} from "@earendil-works/pi-agent-core";
import {
	createSessionRepoConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { MemoryAdapter } from "../testUtils/memoryAdapter";

/**
 * pi's official session-backend conformance suite, pointed at our own layer.
 *
 * The hand-written part of piem's session stack is not the storage semantics —
 * pi's `JsonlSessionRepo` owns those — it is the twelve `DataAdapter` methods in
 * {@link ObsidianSessionFileSystem} that pi calls through. Those methods were
 * built against a handful of call sites; this suite is the upstream contract
 * they have to hold up under, and it exercises paths our own tests never reach
 * (forks, lane moves, operation ledgers, concurrent appends, query cursors).
 *
 * Each case gets a fresh in-memory vault, so cases are isolated by construction
 * and the suite stays deterministic: no disk, no clock skew beyond the
 * timestamps pi itself assigns, no state leaking between cases.
 */

const SESSIONS_ROOT = "Piem/chats";
/** The cwd a piem chat is recorded under; conformance cases never pick their own. */
const CWD = "piem";

/**
 * Adapts `JsonlSessionRepo` to the shape the conformance cases call.
 *
 * pi's own conformance is written against the generic `SessionRepo` contract,
 * where `cwd` is not part of `create`/`fork` — a backend is free to decide where
 * sessions live. The JSONL backend makes the caller supply it, so the wrapper
 * fills in the one piem uses. Test-only: production goes through
 * {@link ObsidianSessionManager}, which passes `cwd` itself.
 *
 * The metadata the wrapper accepts is `JsonlSessionMetadata` — path and cwd
 * included — rather than the generic contract's bare `SessionMetadata`. Sound
 * because the conformance suite only ever hands back metadata it got from this
 * same repository: the generic contract lets a backend mint its own metadata
 * shape, and that is exactly what happened here.
 */
function adaptRepo(repo: JsonlSessionRepo): SessionRepo {
	const pending = new Set<string>();
	return {
		create: async (options: SessionCreateOptions, context = BACKGROUND_CONTEXT) => {
			if (options.id && pending.has(options.id)) throw new Error(`Session already exists: ${options.id}`);
			if (options.id) pending.add(options.id);
			try {
				return await repo.create({ ...options, cwd: CWD }, context);
			} finally {
				if (options.id) pending.delete(options.id);
			}
		},
		open: (metadata: JsonlSessionMetadata, context = BACKGROUND_CONTEXT) => repo.open(metadata, context),
		list: (options?: any, context = BACKGROUND_CONTEXT) => repo.list(options, context),
		delete: (metadata: JsonlSessionMetadata, context = BACKGROUND_CONTEXT) => repo.delete(metadata, context),
		fork: async (source: JsonlSessionMetadata, options: ForkOptions & SessionCreateOptions, context = BACKGROUND_CONTEXT) => {
			if (options.id && pending.has(options.id)) throw new Error(`Session already exists: ${options.id}`);
			if (options.id) pending.add(options.id);
			try {
				return await repo.fork(source, options, context);
			} finally {
				if (options.id) pending.delete(options.id);
			}
		},
	};
}

const createFixture = async (): Promise<SessionRepo> => {
	const adapter = new MemoryAdapter();
	const fs = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter);
	return adaptRepo(new JsonlSessionRepo({ fileSystem: fs, fs, sessionsRoot: SESSIONS_ROOT } as any));
};

describe("session backend conformance", () => {
	for (const testCase of createSessionRepoConformance(createFixture)) {
		it(`${testCase.group} — ${testCase.name}`, async () => {
			await testCase.run();
		});
	}
});
