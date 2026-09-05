import { afterAll, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { FileLogSink } from "./FileLogSink";
import type { LogRecord } from "./logRecord";
import { stubWindowTimers } from "../testUtils/windowStub";

/**
 * The disk half of logging.
 *
 * These cover the three properties the class exists for: writes are batched
 * rather than issued per record, concurrent flushes cannot interleave partial
 * lines, and a failing disk disables the sink instead of throwing into whatever
 * was being logged.
 *
 * A local adapter double rather than `MemoryAdapter`: that one throws on
 * `remove` for anything but a `.tmp` file, which is exactly right for chat logs
 * (the only copy of a conversation) and exactly wrong here — rotation removes
 * the previous `.log.1`, which is plumbing nobody needs recovered. It also needs
 * a failure switch and a write-order record, neither of which session tests use.
 */

class LogAdapterDouble {
	private readonly files = new Map<string, string>();
	/** Every append in the order it was applied, so serialization can be asserted. */
	readonly appends: string[] = [];
	readonly removed: string[] = [];
	readonly renames: Array<[string, string]> = [];
	/** Makes every append reject, standing in for a full disk or lost permission. */
	failAppends = false;
	/** Resolves the next append only when released, to force overlapping flushes. */
	private gate: (() => void) | null = null;

	async append(path: string, data: string): Promise<void> {
		if (this.gate) {
			await new Promise<void>((resolve) => {
				const release = this.gate;
				this.gate = null;
				release?.();
				setTimeout(resolve, 0);
			});
		}
		if (this.failAppends) {
			throw new Error("disk full");
		}
		this.appends.push(data);
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}

	async stat(path: string): Promise<{ type: "file"; ctime: number; mtime: number; size: number } | null> {
		const content = this.files.get(path);
		if (content === undefined) {
			return null;
		}
		return { type: "file", ctime: 0, mtime: 0, size: new TextEncoder().encode(content).length };
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async remove(path: string): Promise<void> {
		this.removed.push(path);
		this.files.delete(path);
	}

	async rename(path: string, newPath: string): Promise<void> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		this.renames.push([path, newPath]);
		this.files.delete(path);
		this.files.set(newPath, content);
	}

	contentOf(path: string): string | undefined {
		return this.files.get(path);
	}

	/** Test-only: seeds a file, standing in for a log left by a previous load. */
	seed(path: string, content: string): void {
		this.files.set(path, content);
	}

	asAdapter(): DataAdapter {
		return this as unknown as DataAdapter;
	}
}

const PATH = `.${"obsidian"}/plugins/piem/piem.log`;
const ROTATED = `${PATH}.1`;

function record(seq: number, message = `m${seq}`): LogRecord {
	return { time: 0, level: "info", scope: "net", message, seq };
}

/**
 * A sink whose timer never fires on its own.
 *
 * Every test drives `flush()` explicitly, so the debounce is captured rather than
 * scheduled: a real `setTimeout` would make these depend on wall-clock timing and
 * leave a timer running past the test.
 */
function createSink(adapter: LogAdapterDouble, options: { maxBytes?: number } = {}): FileLogSink {
	return new FileLogSink({
		adapter: adapter.asAdapter(),
		path: PATH,
		rotatedPath: ROTATED,
		maxBytes: options.maxBytes,
		schedule: () => 0,
	});
}

describe("FileLogSink", () => {
	// `schedule` is injectable but the cancel half is not: `dispose` reaches
	// `window.clearTimeout` directly, so even a sink handed a fake scheduler needs
	// a `window` to hand its handle back to. Without this the file passed only
	// under a full `bun test`, on a `window` some UI test installed first.
	const restoreWindowTimers = stubWindowTimers();

	afterAll(() => {
		restoreWindowTimers();
	});

	it("batches queued records into one write", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		sink.write(record(1));
		sink.write(record(2));
		sink.write(record(3));
		await sink.flush();

		// One append, not three: a filesystem round trip per log line is what would
		// make the logger the slow part of the path it is observing.
		expect(adapter.appends).toHaveLength(1);
		expect(adapter.contentOf(PATH)).toBe(
			"00:00:00.000 INFO  [net] m1\n00:00:00.000 INFO  [net] m2\n00:00:00.000 INFO  [net] m3\n",
		);
	});

	it("writes nothing when nothing was queued", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		await sink.flush();

		// Unload flushes unconditionally; an empty flush must not create the file.
		expect(adapter.appends).toEqual([]);
		expect(adapter.contentOf(PATH)).toBeUndefined();
	});

	it("ends every write with a newline so appends never splice lines", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		sink.write(record(1));
		await sink.flush();
		sink.write(record(2));
		await sink.flush();

		// Without the trailing newline the second batch would continue the last line
		// of the first, producing a record no reader can parse.
		expect(adapter.contentOf(PATH)).toBe("00:00:00.000 INFO  [net] m1\n00:00:00.000 INFO  [net] m2\n");
	});

	it("serializes overlapping flushes instead of interleaving them", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		sink.write(record(1, "first"));
		const slow = sink.flush();
		sink.write(record(2, "second"));
		const fast = sink.flush();
		await Promise.all([slow, fast]);

		// Order matters more than count here: two concurrent appends can interleave
		// partial lines, corrupting exactly the record someone is trying to read.
		expect(adapter.appends).toHaveLength(2);
		expect(adapter.appends[0]).toContain("first");
		expect(adapter.appends[1]).toContain("second");
	});

	it("forces a write once the queue hits its ceiling", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		// The debounce alone cannot bound memory: a tight loop keeps resetting the
		// timer, so the queue would grow until the loop ends.
		for (let index = 0; index < 500; index += 1) {
			sink.write(record(index));
		}
		await sink.flush();

		expect(adapter.appends.length).toBeGreaterThanOrEqual(1);
		expect(adapter.contentOf(PATH)?.split("\n").filter(Boolean)).toHaveLength(500);
	});

	it("counts the file it inherited from a previous load", async () => {
		const adapter = new LogAdapterDouble();
		adapter.seed(PATH, "x".repeat(95));
		const sink = createSink(adapter, { maxBytes: 100 });

		sink.write(record(1));
		await sink.flush();

		// Appending without accounting for what was already there would let the file
		// grow to the cap plus whatever it started at, load after load.
		expect(adapter.renames).toEqual([[PATH, ROTATED]]);
		expect(adapter.contentOf(ROTATED)).toBe("x".repeat(95));
	});

	it("rotates rather than growing past the cap", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter, { maxBytes: 40 });

		sink.write(record(1));
		await sink.flush();
		sink.write(record(2));
		await sink.flush();

		expect(adapter.renames).toEqual([[PATH, ROTATED]]);
		expect(adapter.contentOf(ROTATED)).toBe("00:00:00.000 INFO  [net] m1\n");
		expect(adapter.contentOf(PATH)).toBe("00:00:00.000 INFO  [net] m2\n");
	});

	it("keeps exactly one rotated generation", async () => {
		const adapter = new LogAdapterDouble();
		adapter.seed(ROTATED, "older still");
		const sink = createSink(adapter, { maxBytes: 40 });

		sink.write(record(1));
		await sink.flush();
		sink.write(record(2));
		await sink.flush();

		// Removed, not trashed: a rotated log is not the only copy of anything the
		// user wrote, and dropping a megabyte of plumbing in their trash is litter.
		expect(adapter.removed).toEqual([ROTATED]);
	});

	it("measures bytes rather than characters", async () => {
		const adapter = new LogAdapterDouble();
		// Each CJK character is three bytes in UTF-8, so counting characters would
		// let the file grow to roughly triple the cap — and log lines routinely carry
		// note titles.
		const wide = "笔记标题很长".repeat(4);
		const sink = createSink(adapter, { maxBytes: 80 });

		sink.write(record(1, wide));
		await sink.flush();
		sink.write(record(2, wide));
		await sink.flush();

		expect(adapter.renames).toEqual([[PATH, ROTATED]]);
	});

	it("disables itself after a failed write instead of throwing", async () => {
		const adapter = new LogAdapterDouble();
		adapter.failAppends = true;
		const sink = createSink(adapter);

		sink.write(record(1));
		// The sink is called from inside catch blocks and from teardown; a rejection
		// here would turn an observability feature into a new class of crash.
		await sink.flush();

		adapter.failAppends = false;
		sink.write(record(2));
		await sink.flush();

		// A disk that rejected one write will reject the next, and retrying per
		// record would make the log the source of the errors.
		expect(adapter.appends).toEqual([]);
	});

	it("drops queued records when disposed", async () => {
		const adapter = new LogAdapterDouble();
		const sink = createSink(adapter);

		sink.write(record(1));
		sink.dispose();
		await sink.flush();

		// `dispose` only cancels the timer, so a caller that wants the tail on disk
		// has to flush first — which is what unload does.
		expect(adapter.appends).toHaveLength(1);
	});
});
