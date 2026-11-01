import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import {
	borrowVmContext,
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import type { WorkerInbound, WorkerOutbound } from "../../src/eval/js/worker-protocol";
import { executeJs } from "../../src/eval/js/executor";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { ToolSession } from "../../src/tools";

// The reclaim is deliberately deferred, so these exercise a real timer. The
// grace is shortened to milliseconds, which is the behaviour under test. Fake
// timers cannot stand in: the grace races real worker threads, whose startup,
// messages and exit run on the platform clock.
const TEST_GRACE_MS = 50;
/** Slept through to let an armed grace expire at least once. */
const PAST_GRACE_MS = TEST_GRACE_MS * 8;
/**
 * The longest a reclaimed worker gets to exit. The wait ends on the thread's
 * own `close` event, so the budget only matters when the thread never ends;
 * it is generous because the suite may share a loaded machine.
 */
const EXIT_BUDGET_MS = 15_000;
/** The production close handshake's bound before teardown falls back to `terminate()`. */
const CLOSE_HANDSHAKE_MS = 1_000;

/** A session shaped as the executor consumes it: settings, jobs and a session file. */
function makeSession(cwd: string, sessionFile: string): ToolSession {
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		asyncJobManager: new AsyncJobManager({}),
		taskDepth: 0,
		enableLsp: false,
		agentOutputManager: new AgentOutputManager(() => artifactsDir),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

/**
 * Worker identity as the kernel itself sees it: a fresh context answers with a
 * new mark, a retained one answers with the mark it was given. The mark is
 * matched rather than taken as the whole output, so a notice a cell carries
 * ahead of its result does not change the answer.
 */
async function contextId(cwd: string, sessionId: string, ownerId: string): Promise<string> {
	const sessionFile = path.join(cwd, "session.jsonl");
	const result = await executeJs(
		"globalThis.__contextMark ??= 'ctx-' + Math.random().toString(36).slice(2); return globalThis.__contextMark;",
		{ cwd, sessionId, kernelOwnerId: ownerId, session: makeSession(cwd, sessionFile), timeoutMs: 30_000 },
	);
	if (result.exitCode !== 0) throw new Error(`cell failed: ${result.output}`);
	const mark = /ctx-[0-9a-z]+/.exec(result.output)?.[0];
	if (mark === undefined) throw new Error(`cell answered without a context mark: ${result.output}`);
	return mark;
}

/** One eval worker thread, observed from outside the handle the context manager drives. */
interface ObservedWorker {
	/** Resolves when the thread has exited, whatever made it exit. */
	readonly exited: Promise<void>;
	readonly hasExited: boolean;
}

interface WorkerObservation {
	/** Every thread spawned since the observation began, in spawn order. */
	readonly workers: readonly ObservedWorker[];
	/** Resolves once the first thread exists. */
	readonly firstSpawned: Promise<void>;
	/** Put the previous worker factories back. */
	restore(): void;
	/** End every thread still running, so a failed test cannot leave one behind. */
	terminateAll(): void;
}

/**
 * Run every context on a real eval worker thread, and observe each thread from
 * outside: its `close` event is listened for at spawn, so `hasExited` reports
 * the thread really ending — not that the context manager asked it to, and
 * not that the registry forgot the context, which hands back a fresh one on
 * the next cell whether or not the old thread is still running.
 *
 * The handle's teardown is the production one: a `close` request the worker
 * acknowledges before it exits, bounded, then `terminate()`.
 *
 * `holdFirstReady`, when given, holds back the first worker's `ready` until it
 * resolves. A cold start that finishes after a later key's cell cannot be
 * produced any other way: the delay is in worker startup, which the public
 * surface does not expose.
 */
function observeWorkers(holdFirstReady?: Promise<void>): WorkerObservation {
	const workers: ObservedWorker[] = [];
	const threads: Worker[] = [];
	const firstSpawned = Promise.withResolvers<void>();
	const spawn = (): JsEvalWorkerHandle => {
		const worker = new Worker(new URL("../../src/eval/js/worker-entry.ts", import.meta.url).href, {
			type: "module",
		});
		const exited = Promise.withResolvers<void>();
		const observed = { exited: exited.promise, hasExited: false };
		worker.addEventListener("close", () => {
			observed.hasExited = true;
			exited.resolve();
		});
		const held = workers.length === 0 ? holdFirstReady : undefined;
		workers.push(observed);
		threads.push(worker);
		firstSpawned.resolve();
		return {
			mode: "worker",
			send: message => worker.postMessage(message),
			onMessage(handler) {
				const wrap = (event: MessageEvent): void => {
					const message: WorkerOutbound = event.data;
					if (held && message.type === "ready") void held.then(() => handler(message));
					else handler(message);
				};
				worker.addEventListener("message", wrap);
				return () => worker.removeEventListener("message", wrap);
			},
			onError(handler) {
				const onError = (event: ErrorEvent): void => handler(new Error(event.message || "worker error"));
				const onClose = (): void => handler(new Error("JS eval worker exited"));
				worker.addEventListener("error", onError);
				worker.addEventListener("close", onClose);
				return () => {
					worker.removeEventListener("error", onError);
					worker.removeEventListener("close", onClose);
				};
			},
			async close() {
				const acknowledged = Promise.withResolvers<void>();
				const onMessage = (event: MessageEvent): void => {
					const message: WorkerOutbound = event.data;
					if (message.type === "closed") acknowledged.resolve();
				};
				const closed = Promise.withResolvers<boolean>();
				const timeout = setTimeout(() => closed.resolve(false), CLOSE_HANDSHAKE_MS);
				void Promise.all([acknowledged.promise, exited.promise]).then(() => closed.resolve(true));
				worker.addEventListener("message", onMessage);
				worker.postMessage({ type: "close" } satisfies WorkerInbound);
				try {
					return await closed.promise;
				} finally {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
				}
			},
			async terminate() {
				worker.terminate();
			},
		};
	};
	const restore = setJsEvalWorkerFactoriesForTests({ spawnProcess: spawn, spawnWorker: spawn });
	return {
		workers,
		firstSpawned: firstSpawned.promise,
		restore,
		terminateAll() {
			for (const thread of threads) thread.terminate();
		},
	};
}

/** Whether `worker`'s thread exits within `budgetMs`; settles as soon as it does. */
async function endsWithin(worker: ObservedWorker, budgetMs: number): Promise<boolean> {
	if (worker.hasExited) return true;
	const ended = Promise.withResolvers<boolean>();
	const timeout = setTimeout(() => ended.resolve(false), budgetMs);
	void worker.exited.then(() => ended.resolve(true));
	try {
		return await ended.promise;
	} finally {
		clearTimeout(timeout);
	}
}

describe("superseded JavaScript contexts", () => {
	let observation: WorkerObservation;

	/** The `index`-th worker thread spawned in this test. */
	function spawned(index: number): ObservedWorker {
		const worker = observation.workers[index];
		if (worker === undefined) {
			throw new Error(`worker ${index} was never spawned (${observation.workers.length} were)`);
		}
		return worker;
	}

	beforeEach(() => {
		observation = observeWorkers();
	});

	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
		observation.restore();
		observation.terminateAll();
	});

	it("ends the worker a session leaves behind when its next cell runs under another key", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-superseded-a-");
		using secondDir = TempDir.createSync("@js-superseded-b-");
		const owner = "agent-session:js-superseded";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);

		// The stranded thread itself ends, rather than staying up for the life
		// of the host process; the key its owner moved to keeps its own.
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(spawned(1).hasExited).toBe(false);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).not.toBe(first);
	}, 60_000);

	it("keeps the context and its globals when the session returns inside the grace", async () => {
		// Long enough that the round trip below lands inside it on a loaded
		// machine; the key left behind afterwards is then watched expiring.
		const roundTripGraceMs = 5_000;
		setSupersededKernelGraceMs(roundTripGraceMs);
		using firstDir = TempDir.createSync("@js-roundtrip-a-");
		using secondDir = TempDir.createSync("@js-roundtrip-b-");
		const owner = "agent-session:js-roundtrip";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).toBe(first);

		// Returning left the second key behind. Its thread ending shows a grace
		// was armed and ran out in this test, so the first thread outliving it
		// is the return's doing, not a reclaim that never runs.
		expect(await endsWithin(spawned(1), roundTripGraceMs + EXIT_BUDGET_MS)).toBe(true);
		expect(spawned(0).hasExited).toBe(false);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).toBe(first);
	}, 60_000);

	it("keeps a context a second agent still holds, and ends it once both agents have moved on", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using sharedDir = TempDir.createSync("@js-shared-a-");
		using oneDir = TempDir.createSync("@js-shared-b-");
		using twoDir = TempDir.createSync("@js-shared-c-");
		const sessionId = `js:cwd:${sharedDir.path()}`;
		const first = await contextId(sharedDir.path(), sessionId, "agent-session:js-one");
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);

		await contextId(oneDir.path(), `js:cwd:${oneDir.path()}`, "agent-session:js-one");
		await Bun.sleep(PAST_GRACE_MS);
		expect(spawned(0).hasExited).toBe(false);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);

		// Neither move drops an id from the shared context, so only where each
		// agent is working now can tell that nobody is left on it.
		await contextId(twoDir.path(), `js:cwd:${twoDir.path()}`, "agent-session:js-two");
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-one")).not.toBe(first);
	}, 60_000);

	it("keeps a context a borrower holds past the grace, and ends it once the borrow ends with no further cell there", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-borrow-a-");
		using secondDir = TempDir.createSync("@js-borrow-b-");
		const owner = "agent-session:js-borrow";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const first = await contextId(firstDir.path(), firstKey, owner);

		// A subagent given this kernel's tools can call them between cells, so
		// it holds the context even while its owner runs elsewhere.
		const release = borrowVmContext(firstKey);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		// The grace expires while the borrow holds the context, so that attempt
		// declines.
		await Bun.sleep(PAST_GRACE_MS);
		expect(spawned(0).hasExited).toBe(false);

		// Releasing it is the only thing that happens afterwards.
		release();
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);

	it("ends a context borrowed after its owner had already moved on", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-late-borrow-a-");
		using secondDir = TempDir.createSync("@js-late-borrow-b-");
		const owner = "agent-session:js-late-borrow";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const first = await contextId(firstDir.path(), firstKey, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);

		// The borrow arrives after the move, so it is what spares the context
		// from the grace already running. Ending it is the last event this
		// context sees: its owner is elsewhere and runs no further cell here.
		const release = borrowVmContext(firstKey);
		release();
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);

	it("ends a shared context after the agent whose move armed it is disposed", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using sharedDir = TempDir.createSync("@js-co-owner-a-");
		using oneDir = TempDir.createSync("@js-co-owner-b-");
		using twoDir = TempDir.createSync("@js-co-owner-c-");
		const sessionId = `js:cwd:${sharedDir.path()}`;
		const first = await contextId(sharedDir.path(), sessionId, "agent-session:js-co-one");
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-co-two")).toBe(first);
		await contextId(oneDir.path(), `js:cwd:${oneDir.path()}`, "agent-session:js-co-one");
		await contextId(twoDir.path(), `js:cwd:${twoDir.path()}`, "agent-session:js-co-two");

		// Disposing one of the two drops only its registration from the shared
		// context, and cancels the grace on the way. The agent left registered
		// moved away earlier and never comes back to arm another one.
		await disposeVmContextsByOwner("agent-session:js-co-two");
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-co-one")).not.toBe(first);
	}, 60_000);

	it("ends a context whose cold start finished after a newer key's cell", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-overlap-a-");
		using secondDir = TempDir.createSync("@js-overlap-b-");
		const owner = "agent-session:js-overlap";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const gate = Promise.withResolvers<void>();
		observation.restore();
		observation = observeWorkers(gate.promise);
		try {
			const older = contextId(firstDir.path(), firstKey, owner);
			// The older key is registered as starting, and its worker will not
			// report ready until the newer key's cell is done.
			await observation.firstSpawned;
			await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
			gate.resolve();
			const first = await older;

			// Nothing the newer cell could scan knew the older context existed,
			// and the owner has been at the newer key since before the older
			// worker was ready.
			expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
			expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
		} finally {
			gate.resolve();
		}
	}, 60_000);

	it("ends a context when the key its owner moved to cannot start a worker", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-failed-move-a-");
		using secondDir = TempDir.createSync("@js-failed-move-b-");
		const owner = "agent-session:js-failed-move";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const first = await contextId(firstDir.path(), firstKey, owner);

		const refuse = (): never => {
			throw new Error("worker spawn refused");
		};
		const restore = setJsEvalWorkerFactoriesForTests({ spawnProcess: refuse, spawnWorker: refuse });
		try {
			// The move is recorded before a worker exists there, so the owner has
			// left the first key even though no context was ever built at the
			// second one.
			const failed = await executeJs("return 1", {
				cwd: secondDir.path(),
				sessionId: `js:cwd:${secondDir.path()}`,
				kernelOwnerId: owner,
				session: makeSession(secondDir.path(), path.join(secondDir.path(), "session.jsonl")),
				timeoutMs: 30_000,
			});
			expect(failed.exitCode).not.toBe(0);
		} finally {
			restore();
		}

		// The failed cell is the last thing the registry sees; no later cell
		// arrives to arm the first key's grace.
		expect(await endsWithin(spawned(0), EXIT_BUDGET_MS)).toBe(true);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);
});
