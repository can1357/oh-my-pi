import { afterEach, describe, expect, it } from "bun:test";
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
// grace is shortened to milliseconds, which is the behaviour under test.
const TEST_GRACE_MS = 50;

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
 * new id, a retained one answers with the id it was given.
 */
async function contextId(cwd: string, sessionId: string, ownerId: string): Promise<string> {
	const sessionFile = path.join(cwd, "session.jsonl");
	const result = await executeJs(
		"globalThis.__contextMark ??= `ctx-${Math.random()}`; return globalThis.__contextMark;",
		{ cwd, sessionId, kernelOwnerId: ownerId, session: makeSession(cwd, sessionFile), timeoutMs: 30_000 },
	);
	if (result.exitCode !== 0) throw new Error(`cell failed: ${result.output}`);
	return result.output.trim();
}

/**
 * Run every context on a real eval worker thread, holding back the first
 * worker's `ready` until `gate` resolves, and resolve `spawned` once that
 * worker exists. A cold start that finishes after a later key's cell cannot be
 * produced any other way: the delay is in worker startup, which the public
 * surface does not expose. Returns the restore from
 * {@link setJsEvalWorkerFactoriesForTests}.
 */
function holdFirstWorkerReady(gate: Promise<void>, spawned: PromiseWithResolvers<void>): () => void {
	let holdNext = true;
	const spawn = (): JsEvalWorkerHandle => {
		const worker = new Worker(new URL("../../src/eval/js/worker-entry.ts", import.meta.url).href, {
			type: "module",
		});
		const held = holdNext ? gate : undefined;
		holdNext = false;
		const handle: JsEvalWorkerHandle = {
			mode: "worker",
			send: message => worker.postMessage(message),
			onMessage(handler) {
				const wrap = (event: MessageEvent): void => {
					const message = event.data as WorkerOutbound;
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
				const exited = Promise.withResolvers<void>();
				const onClose = (): void => exited.resolve();
				worker.addEventListener("close", onClose);
				worker.postMessage({ type: "close" } satisfies WorkerInbound);
				await exited.promise;
				worker.removeEventListener("close", onClose);
				return true;
			},
			async terminate() {
				worker.terminate();
			},
		};
		spawned.resolve();
		return handle;
	};
	return setJsEvalWorkerFactoriesForTests({ spawnProcess: spawn, spawnWorker: spawn });
}

describe("superseded JavaScript contexts", () => {
	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
	});

	it("drops the context a session leaves behind when its next cell runs under another key", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-superseded-a-");
		using secondDir = TempDir.createSync("@js-superseded-b-");
		const owner = "agent-session:js-superseded";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);

		// Past the grace, returning to the first key must answer from a fresh
		// context: the retained one was shut down rather than kept for the life
		// of the host process.
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).not.toBe(first);
	}, 60_000);

	it("keeps the context and its globals when the session returns inside the grace", async () => {
		setSupersededKernelGraceMs(60_000);
		using firstDir = TempDir.createSync("@js-roundtrip-a-");
		using secondDir = TempDir.createSync("@js-roundtrip-b-");
		const owner = "agent-session:js-roundtrip";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).toBe(first);
	}, 60_000);

	it("keeps a context a second agent still holds", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using sharedDir = TempDir.createSync("@js-shared-a-");
		using otherDir = TempDir.createSync("@js-shared-b-");
		const sessionId = `js:cwd:${sharedDir.path()}`;
		const first = await contextId(sharedDir.path(), sessionId, "agent-session:js-one");
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);

		await contextId(otherDir.path(), `js:cwd:${otherDir.path()}`, "agent-session:js-one");
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);
	}, 60_000);

	it("keeps a context a borrower still holds past the grace", async () => {
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
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), firstKey, owner)).toBe(first);
		release();
	}, 60_000);

	it("drops a context two agents shared once both have moved on", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using sharedDir = TempDir.createSync("@js-both-left-a-");
		using oneDir = TempDir.createSync("@js-both-left-b-");
		using twoDir = TempDir.createSync("@js-both-left-c-");
		const sessionId = `js:cwd:${sharedDir.path()}`;
		const first = await contextId(sharedDir.path(), sessionId, "agent-session:js-left-one");
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-left-two")).toBe(first);

		await contextId(oneDir.path(), `js:cwd:${oneDir.path()}`, "agent-session:js-left-one");
		await contextId(twoDir.path(), `js:cwd:${twoDir.path()}`, "agent-session:js-left-two");
		await Bun.sleep(TEST_GRACE_MS * 8);
		// Neither move drops an id from the shared context, so only where each
		// agent is working now can tell that nobody is left on it.
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-left-one")).not.toBe(first);
	}, 60_000);

	it("drops a borrowed context after the borrow ends, with no further cell there", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-rearm-a-");
		using secondDir = TempDir.createSync("@js-rearm-b-");
		const owner = "agent-session:js-rearm";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const first = await contextId(firstDir.path(), firstKey, owner);

		const release = borrowVmContext(firstKey);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		// The grace expires while the borrow holds the context, so that attempt
		// declines; releasing it is the only thing that happens afterwards.
		await Bun.sleep(TEST_GRACE_MS * 8);
		release();
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);

	it("drops a context borrowed after its owner had already moved on", async () => {
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
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);

	it("drops a shared context after the agent whose move armed it is disposed", async () => {
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
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-co-one")).not.toBe(first);
	}, 60_000);

	it("drops a context whose cold start finished after a newer key's cell", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-overlap-a-");
		using secondDir = TempDir.createSync("@js-overlap-b-");
		const owner = "agent-session:js-overlap";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const gate = Promise.withResolvers<void>();
		const spawned = Promise.withResolvers<void>();
		const restore = holdFirstWorkerReady(gate.promise, spawned);
		try {
			const older = contextId(firstDir.path(), firstKey, owner);
			// The older key is registered as starting, and its worker will not
			// report ready until the newer key's cell is done.
			await spawned.promise;
			await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
			gate.resolve();
			const first = await older;

			// Nothing the newer cell could scan knew the older context existed,
			// and the owner has been at the newer key since before the older
			// worker was ready.
			await Bun.sleep(TEST_GRACE_MS * 8);
			expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
		} finally {
			gate.resolve();
			restore();
		}
	}, 60_000);

	it("drops a context when the key its owner moved to cannot start a worker", async () => {
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
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), firstKey, owner)).not.toBe(first);
	}, 60_000);
});
