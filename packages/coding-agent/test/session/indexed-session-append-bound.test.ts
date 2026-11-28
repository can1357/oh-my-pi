/**
 * Indexed storage (`IndexedSessionStorage`, which SQL and Redis session
 * storage build on) under a backend that falls behind: a turn waits for
 * admission while every path of its store together holds more than 64 MiB
 * of queued appends, and never for another store's, the wait ends once
 * enough of them settle (or the turn is aborted), a wait that lasts 10 s
 * logs one warning, a writer's append resolves once its own line is stored,
 * and a path's lines queued behind an append in flight go to a backend that
 * has `appendBatch` in one call, the index rolling back as it does for
 * failed appends one at a time.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	IndexedSessionStorage,
	SessionAppendBatchRolledBackError,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { MemoryBackend } from "../helpers/memory-session-backend";

const MiB = 1024 * 1024;
/** The queued append bytes past which a turn waits for admission. */
const BOUND = 64 * MiB;
/** One line of exactly 1 MiB; every queued copy is this one string. */
const MIB_LINE = `${"x".repeat(MiB - 1)}\n`;

/**
 * Let every microtask queued so far run, and those they queue: settling one
 * write sets off several promise hops, whose count is the code's, not the
 * test's. A zero-delay sleep, so nothing here waits on the clock.
 */
function flushMicrotasks(): Promise<void> {
	return Bun.sleep(0);
}

/** The appends of every {@link HeldBackend}, held in arrival order until the test releases them. */
class Releases {
	readonly #held: Array<() => void> = [];
	#arrival = Promise.withResolvers<void>();

	hold(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#held.push(resolve);
		this.#arrival.resolve();
		return promise;
	}

	/** Release the oldest held append, once one is held, and let what its settling sets off run. */
	async releaseOne(): Promise<void> {
		await this.#oneHeld();
		this.#held.shift()?.();
		await flushMicrotasks();
	}

	/** Release the oldest held append, once one is held, waiting on no clock: for a test on fake timers. */
	async releaseOneNow(): Promise<void> {
		await this.#oneHeld();
		this.#held.shift()?.();
	}

	/** Release held appends, oldest first, until `done` settles. */
	async releaseUntil(done: Promise<unknown>): Promise<void> {
		let settled = false;
		const finished = done.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (;;) {
			await Promise.race([this.#oneHeld(), finished]);
			if (settled) return;
			this.#held.shift()?.();
			await flushMicrotasks();
		}
	}

	async #oneHeld(): Promise<void> {
		while (this.#held.length === 0) {
			this.#arrival = Promise.withResolvers<void>();
			await this.#arrival.promise;
		}
	}
}

/** A {@link MemoryBackend} whose appends store a line once {@link Releases} releases them. */
class HeldBackend extends MemoryBackend {
	readonly #storedBytes = new Map<string, number>();

	constructor(readonly releases: Releases) {
		super();
	}

	override async append(path: string, line: string): Promise<void> {
		await this.releases.hold();
		await super.append(path, line);
		this.#storedBytes.set(path, this.storedBytes(path) + Buffer.byteLength(line));
	}

	/** The bytes the released appends to `path` stored. */
	storedBytes(path: string): number {
		return this.#storedBytes.get(path) ?? 0;
	}
}

async function heldStorage(releases: Releases): Promise<{ storage: IndexedSessionStorage; backend: HeldBackend }> {
	const backend = new HeldBackend(releases);
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return { storage, backend };
}

type HeldStore = { storage: IndexedSessionStorage; backend: HeldBackend; paths: string[] };

/** The bytes queued on `paths` (what each store's index holds past what its backend stored), and those indexed. */
function measure(stores: readonly HeldStore[]): { indexed: number; queued: number } {
	let indexed = 0;
	let stored = 0;
	for (const { storage, backend, paths } of stores) {
		for (const path of paths) {
			if (storage.existsSync(path)) indexed += storage.statSync(path).size;
			stored += backend.storedBytes(path);
		}
	}
	return { indexed, queued: indexed - stored };
}

function queuedBytes(stores: readonly HeldStore[]): number {
	return measure(stores).queued;
}

/** Whether `promise` has settled after the work it set off ran. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await flushMicrotasks();
	return settled;
}

/** `wait`, which a store past its threshold answers with a promise to await. */
function pendingWait(wait: Promise<void> | undefined): Promise<void> {
	if (!wait) throw new Error("Expected the store to make the turn wait");
	return wait;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("indexed session storage bounds the appends it queues", () => {
	it("shares one store's threshold among its sessions: a turn that would pass it waits until writes on any of the store's paths settle", async () => {
		// If this regresses, a store whose database falls behind holds every queued transcript line of its
		// sessions in memory (159 MB of them at ten subagents), or a waiting turn never resumes after the
		// writes drain.
		const releases = new Releases();
		const store = {
			...(await heldStorage(releases)),
			paths: ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl", "/s/d.jsonl"],
		};
		// The session manager's synchronous writes, which never wait, queue 70 MiB on two of the store's
		// paths, each under the threshold alone.
		const writerA = store.storage.openWriter("/s/a.jsonl");
		const writerB = store.storage.openWriter("/s/b.jsonl");
		for (let n = 0; n < 40; n++) writerA.appendSync?.(MIB_LINE);
		for (let n = 0; n < 30; n++) writerB.appendSync?.(MIB_LINE);
		// Two more sessions on the store run three turns each: a turn waits for admission, then appends a
		// line with the async writer, which resolves once the line is stored.
		let stopTurns = false;
		const turns = async (path: string): Promise<void> => {
			const writer = store.storage.openWriter(path);
			for (let turn = 0; turn < 3; turn++) {
				await store.storage.waitForAppendAdmission();
				if (stopTurns) return;
				await writer.append(MIB_LINE);
			}
		};
		const turnsInFlight = [turns("/s/c.jsonl"), turns("/s/d.jsonl")];
		const sessions = Promise.all(turnsInFlight);
		const queuedAt = () => ({ c: store.storage.existsSync("/s/c.jsonl"), d: store.storage.existsSync("/s/d.jsonl") });
		try {
			expect({ ...measure([store]), waiting: queuedAt() }).toEqual({
				indexed: 70 * MiB,
				queued: 70 * MiB,
				waiting: { c: false, d: false },
			});

			// Release the held writes one at a time, all 76. A step that admits nothing only lowers the queue by
			// the write it settled; a step that admits lines admits them only once the queue is at or under the
			// threshold, so what queues past it is what that step admitted.
			const steps: Array<{ before: number; queued: number; admitted: number }> = [];
			let { indexed: indexedBefore, queued: queuedBefore } = measure([store]);
			let firstAdmission: { step: number; waiting: { c: boolean; d: boolean } } | undefined;
			for (let step = 1; step <= 76; step++) {
				await releases.releaseOne();
				const { indexed, queued } = measure([store]);
				steps.push({ before: queuedBefore, queued, admitted: indexed - indexedBefore });
				if (!firstAdmission && indexed > indexedBefore) firstAdmission = { step, waiting: queuedAt() };
				indexedBefore = indexed;
				queuedBefore = queued;
			}
			await sessions;
			expect(
				steps.filter(step =>
					step.admitted === 0 ? step.queued !== step.before - MiB : step.queued - step.admitted > BOUND,
				),
			).toEqual([]);
			// The sixth write that settles brings the queue to the threshold: both waiting turns are admitted
			// together, and from then on the queue peaks at the threshold plus their 2 MiB. Each line is 1 MiB.
			expect({
				firstAdmission,
				peak: Math.max(...steps.slice((firstAdmission?.step ?? 1) - 1).map(step => step.queued)),
				storedLines: Object.fromEntries(store.paths.map(path => [path, store.backend.storedBytes(path) / MiB])),
				queued: queuedBytes([store]),
			}).toEqual({
				firstAdmission: { step: 6, waiting: { c: true, d: true } },
				peak: BOUND + 2 * MiB,
				storedLines: { "/s/a.jsonl": 40, "/s/b.jsonl": 30, "/s/c.jsonl": 3, "/s/d.jsonl": 3 },
				queued: 0,
			});
		} finally {
			stopTurns = true;
			const drained = Promise.allSettled(turnsInFlight).then(() => store.storage.drain());
			await releases.releaseUntil(drained);
			await drained;
		}
	});

	it("never holds a store's turns or appends for another store's backlog", async () => {
		// If this regresses, one store whose backend hangs (a dropped Redis connection, a locked SQL row)
		// stalls every turn and every awaited append of the process, sessions on healthy stores included.
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const releases = new Releases();
		const hung = { ...(await heldStorage(releases)), paths: ["/s/hung.jsonl"] };
		const hungWriter = hung.storage.openWriter("/s/hung.jsonl");
		for (let n = 0; n < 65; n++) hungWriter.appendSync?.(MIB_LINE);
		const healthyBackend = new MemoryBackend();
		const healthy = new IndexedSessionStorage(healthyBackend);
		await healthy.initialize();
		const hungTurn = pendingWait(hung.storage.waitForAppendAdmission());
		const appended = healthy.openWriter("/s/healthy.jsonl").append(MIB_LINE);
		try {
			expect({
				hungTurnSettled: await hasSettled(hungTurn),
				healthyTurn: healthy.waitForAppendAdmission(),
				healthyAppendSettled: await hasSettled(appended),
				healthyStored: healthyBackend.sessions.get("/s/healthy.jsonl"),
			}).toEqual({
				hungTurnSettled: false,
				healthyTurn: undefined,
				healthyAppendSettled: true,
				healthyStored: MIB_LINE,
			});
		} finally {
			const drained = hung.storage.drain();
			await releases.releaseUntil(drained);
			await drained;
			await appended;
		}
	});

	it("answers at once, with nothing to await, while the store is at or under its threshold", async () => {
		// If this regresses, every tool result and model request on indexed storage takes an extra promise hop
		// even when nothing is queued, or a turn past the threshold no longer waits.
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const releases = new Releases();
		const session = { ...(await heldStorage(releases)), paths: ["/s/at.jsonl"] };
		const writer = session.storage.openWriter("/s/at.jsonl");
		const idle = session.storage.waitForAppendAdmission();
		for (let n = 0; n < 64; n++) writer.appendSync?.(MIB_LINE);
		const atThreshold = session.storage.waitForAppendAdmission();
		writer.appendSync?.(MIB_LINE);
		const past = session.storage.waitForAppendAdmission();
		try {
			expect({ idle, atThreshold, pastIsPromise: past instanceof Promise }).toEqual({
				idle: undefined,
				atThreshold: undefined,
				pastIsPromise: true,
			});
			await releases.releaseOne();
			await past;
			expect(session.storage.waitForAppendAdmission()).toBeUndefined();
		} finally {
			const drained = session.storage.drain();
			await releases.releaseUntil(drained);
			await drained;
		}
	});

	it("keeps a writer's lines in call order past the threshold: append(A) then appendSync(B) store A then B, and append(A) resolves once A is stored", async () => {
		// If this regresses, a title change the session manager appends with the async writer while the
		// database falls behind lands after the entries it wrote synchronously after it, so the stored
		// transcript's order differs from the session's; or the async append, which the session manager
		// awaits on its serial disk queue, waits for the store's whole backlog after its own line is stored,
		// and every flush, dispose and rewrite queued behind it waits too.
		const releases = new Releases();
		const store = { ...(await heldStorage(releases)), paths: ["/s/other.jsonl", "/s/order.jsonl"] };
		const other = store.storage.openWriter("/s/other.jsonl");
		for (let n = 0; n < 65; n++) other.appendSync?.(MIB_LINE);
		const writer = store.storage.openWriter("/s/order.jsonl");
		const appendA = writer.append("A\n");
		writer.appendSync?.("B\n");
		try {
			// Both lines queue at once, in call order.
			expect({ size: store.storage.statSync("/s/order.jsonl").size, settled: await hasSettled(appendA) }).toEqual({
				size: 4,
				settled: false,
			});

			// The other path's first line, then A, are stored: the store is still past the threshold, and
			// append(A) has resolved all the same.
			await releases.releaseOne();
			await releases.releaseOne();
			expect({
				stored: store.backend.sessions.get("/s/order.jsonl"),
				queued: queuedBytes([store]),
				settled: await hasSettled(appendA),
			}).toEqual({ stored: "A\n", queued: 64 * MiB + 2, settled: true });

			await releases.releaseUntil(Promise.all([writer.flush(), other.flush()]));
			expect(store.backend.sessions.get("/s/order.jsonl")).toBe("A\nB\n");
		} finally {
			const drained = store.storage.drain();
			await releases.releaseUntil(drained);
			await drained;
		}
	});

	it("never waits on capacity that only its own later writes would free", async () => {
		// If this regresses, a session whose own transcript lines fill the threshold stalls its next turn
		// until more of the queue drains than the threshold asks for, or its append waits on capacity only
		// the line it appends would free.
		const releases = new Releases();
		const session = { ...(await heldStorage(releases)), paths: ["/s/own.jsonl"] };
		const writer = session.storage.openWriter("/s/own.jsonl");
		// The session's own earlier writes fill the threshold.
		for (let n = 0; n < 65; n++) writer.appendSync?.(MIB_LINE);
		// Its next turn waits only for those writes: once one settles the queue is at the threshold, and it goes on.
		const turn = pendingWait(session.storage.waitForAppendAdmission());
		try {
			expect(await hasSettled(turn)).toBe(false);
			await releases.releaseOne();
			expect(await hasSettled(turn)).toBe(true);

			// Its next line, 10 MiB, queues at once behind the rest of its own lines, past the threshold. The
			// append resolves once that line is stored, as the last of the queue.
			const ownLine = `${"y".repeat(10 * MiB - 1)}\n`;
			const own = writer.append(ownLine);
			expect({ size: session.storage.statSync("/s/own.jsonl").size, queued: queuedBytes([session]) }).toEqual({
				size: 75 * MiB,
				queued: 74 * MiB,
			});
			for (let n = 0; n < 64; n++) await releases.releaseOne();
			expect({ queued: queuedBytes([session]), settled: await hasSettled(own) }).toEqual({
				queued: 10 * MiB,
				settled: false,
			});
			await releases.releaseOne();
			expect(await hasSettled(own)).toBe(true);
			const stored = session.backend.sessions.get("/s/own.jsonl") ?? "";
			expect({ bytes: session.backend.storedBytes("/s/own.jsonl"), lastIsOwn: stored.endsWith(ownLine) }).toEqual({
				bytes: 75 * MiB,
				lastIsOwn: true,
			});
		} finally {
			const drained = session.storage.drain();
			await releases.releaseUntil(drained);
			await drained;
		}
	});

	it("ends the admission wait when the turn is aborted", async () => {
		// If this regresses, aborting a turn while the database falls behind leaves it waiting for the
		// queue to drain, or fails it with an error instead of letting it stop.
		const releases = new Releases();
		const session = { ...(await heldStorage(releases)), paths: ["/s/abort.jsonl"] };
		const writer = session.storage.openWriter("/s/abort.jsonl");
		for (let n = 0; n < 65; n++) writer.appendSync?.(MIB_LINE);

		const turn = new AbortController();
		const wait = pendingWait(session.storage.waitForAppendAdmission(turn.signal));
		const unbounded = pendingWait(session.storage.waitForAppendAdmission());
		try {
			expect(await hasSettled(wait)).toBe(false);
			turn.abort();
			await expect(wait).resolves.toBeUndefined();
			// A signal that fired already answers a new wait at once, with nothing to await; a wait without
			// one still waits.
			expect({
				aborted: session.storage.waitForAppendAdmission(turn.signal),
				unbounded: await hasSettled(unbounded),
			}).toEqual({ aborted: undefined, unbounded: false });

			await releases.releaseUntil(Promise.all([unbounded, writer.flush()]));
		} finally {
			const drained = session.storage.drain();
			await releases.releaseUntil(drained);
			await drained;
		}
	});

	it("logs one warning once an admission has waited 10 s, with the bytes queued, and none for a wait that ends sooner", async () => {
		// If this regresses, a backend whose connection hangs stops every turn on its store at the next
		// model request with nothing in the log until the turn is aborted, or the log takes a line per wait.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const releases = new Releases();
		const session = { ...(await heldStorage(releases)), paths: ["/s/slow.jsonl"] };
		const writer = session.storage.openWriter("/s/slow.jsonl");
		for (let n = 0; n < 65; n++) writer.appendSync?.(MIB_LINE);
		const stillWaiting = () =>
			warn.mock.calls
				.filter(([message]) => message === "Session append admission still waiting")
				.map(([, data]) => data);
		const warning = { queuedBytes: 65 * MiB, admissionBytes: BOUND, waitMs: 10_000 };

		vi.useFakeTimers();
		try {
			const slow = pendingWait(session.storage.waitForAppendAdmission());
			vi.advanceTimersByTime(9_999);
			const before = stillWaiting();
			vi.advanceTimersByTime(1);
			const at = stillWaiting();
			vi.advanceTimersByTime(60_000);
			expect({ before, at, later: stillWaiting() }).toEqual({ before: [], at: [warning], later: [warning] });
			await releases.releaseOneNow();
			await slow;

			// Past 64 MiB again: this wait ends after 5 s, and its warning never comes.
			writer.appendSync?.(MIB_LINE);
			const fast = pendingWait(session.storage.waitForAppendAdmission());
			vi.advanceTimersByTime(5_000);
			await releases.releaseOneNow();
			await fast;
			vi.advanceTimersByTime(60_000);
			expect(stillWaiting()).toEqual([warning]);
		} finally {
			vi.useRealTimers();
			// Leave none of this store's appends held, also when this test fails.
			await releases.releaseUntil(writer.flush());
			await session.storage.drain();
		}
	});
});

/** A {@link MemoryBackend} with `appendBatch` that records each call, holds an append until released, and fails on request. */
class BatchingBackend extends MemoryBackend {
	readonly calls: Array<{ call: "append" | "appendBatch"; lines: string[] }> = [];
	#hold: { gate: Promise<void>; reached: () => void } | undefined;
	/** What the next `appendBatch` throws, storing nothing. */
	failBatch: Error | undefined;
	/** A line whose `append` throws this, storing nothing. */
	failAppend: { line: string; error: Error } | undefined;

	/** Hold the next append or batch until `release` runs; `reached` resolves once it waits. */
	holdNext(): { reached: Promise<void>; release: () => void } {
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		this.#hold = { gate: gate.promise, reached: reached.resolve };
		return { reached: reached.promise, release: () => gate.resolve() };
	}

	async #wait(): Promise<void> {
		const hold = this.#hold;
		if (!hold) return;
		this.#hold = undefined;
		hold.reached();
		await hold.gate;
	}

	override async append(path: string, line: string): Promise<void> {
		this.calls.push({ call: "append", lines: [line] });
		await this.#wait();
		if (this.failAppend?.line === line) throw this.failAppend.error;
		await super.append(path, line);
	}

	async appendBatch(path: string, lines: readonly string[]): Promise<void> {
		this.calls.push({ call: "appendBatch", lines: [...lines] });
		await this.#wait();
		const failure = this.failBatch;
		this.failBatch = undefined;
		if (failure) throw failure;
		await super.append(path, lines.join(""));
	}
}

/** What `promise` settled as: its value's absence, or the error it rejected with. */
function outcome(promise: Promise<unknown>): Promise<{ ok: true } | { error: unknown }> {
	return promise.then(
		() => ({ ok: true }) as const,
		(error: unknown) => ({ error }),
	);
}

describe("indexed session storage batches a path's queued appends", () => {
	it("batches a path's queued lines through a backend's appendBatch and rolls the index back when the batch fails", async () => {
		// If this regresses, a busy SQL session sends each transcript line in its own transaction, so the
		// queue outruns the database; or a failed batch leaves the index describing lines the store never
		// accepted, and the session's next recovery rewrite carries a size the backend refuses.
		const backend = new BatchingBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const path = "/s/batch.jsonl";
		const header = '{"type":"session"}\n';
		await storage.writeText(path, header);
		const size = (...lines: string[]) => Buffer.byteLength(header + lines.join(""));

		// The lines queued while one append is in flight go to the backend in one appendBatch, in order.
		const writer = storage.openWriter(path);
		const held = backend.holdNext();
		const first = writer.append("first\n");
		await held.reached;
		const gathered = ["second\n", "third ✓\n", "fourth\n"].map(line => writer.append(line));
		held.release();
		await Promise.all([first, ...gathered]);
		expect(backend.calls).toEqual([
			{ call: "append", lines: ["first\n"] },
			{ call: "appendBatch", lines: ["second\n", "third ✓\n", "fourth\n"] },
		]);
		const landed = ["first\n", "second\n", "third ✓\n", "fourth\n"];
		expect({ stored: backend.sessions.get(path), size: storage.statSync(path).size }).toEqual({
			stored: header + landed.join(""),
			size: size(...landed),
		});

		// A batch that fails with its outcome unknown fails every line, none sent again, and the index
		// falls back to the last line that landed.
		backend.calls.length = 0;
		const heldAgain = backend.holdNext();
		const fifth = writer.append("fifth\n");
		await heldAgain.reached;
		const lost = ["sixth\n", "seventh\n"].map(line => outcome(writer.append(line)));
		const commitLost = new Error("connection lost during COMMIT");
		backend.failBatch = commitLost;
		heldAgain.release();
		await fifth;
		expect(await Promise.all(lost)).toEqual([{ error: commitLost }, { error: commitLost }]);
		expect({
			calls: backend.calls,
			stored: backend.sessions.get(path),
			size: storage.statSync(path).size,
			writerError: writer.getError(),
		}).toEqual({
			calls: [
				{ call: "append", lines: ["fifth\n"] },
				{ call: "appendBatch", lines: ["sixth\n", "seventh\n"] },
			],
			stored: header + [...landed, "fifth\n"].join(""),
			size: size(...landed, "fifth\n"),
			writerError: commitLost,
		});
		await storage.drain().catch(() => undefined);

		// A batch the backend rolled back runs again one append each: the lines before a failing one
		// land, it and the lines after it fail with its error, and the index ends after the last that landed.
		const other = "/s/replay.jsonl";
		await storage.writeText(other, header);
		const replayWriter = storage.openWriter(other);
		backend.calls.length = 0;
		const heldReplay = backend.holdNext();
		const one = replayWriter.append("one\n");
		await heldReplay.reached;
		const replayed = ["two\n", "three\n", "four\n"].map(line => outcome(replayWriter.append(line)));
		const conflict = new SessionWriteConflictError(other, size("one\n", "two\n"), size("one\n", "two\n", "x\n"));
		backend.failBatch = new SessionAppendBatchRolledBackError(other, new Error("statement timeout"));
		backend.failAppend = { line: "three\n", error: conflict };
		heldReplay.release();
		await one;
		expect(await Promise.all(replayed)).toEqual([{ ok: true }, { error: conflict }, { error: conflict }]);
		expect({
			calls: backend.calls,
			stored: backend.sessions.get(other),
			size: storage.statSync(other).size,
		}).toEqual({
			calls: [
				{ call: "append", lines: ["one\n"] },
				{ call: "appendBatch", lines: ["two\n", "three\n", "four\n"] },
				{ call: "append", lines: ["two\n"] },
				{ call: "append", lines: ["three\n"] },
			],
			stored: `${header}one\ntwo\n`,
			size: size("one\n", "two\n"),
		});
		await storage.drain().catch(() => undefined);
	});
});
