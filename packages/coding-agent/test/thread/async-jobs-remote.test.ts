/**
 * A worker's `RemoteAsyncJobManager` over main's `AsyncJobManager`, across a real worker link: which of main's job
 * rows the live `process` / `widgetInputs` of a job the worker registered show up on, and when the worker lets
 * go of them. The worker side is `test/fixtures/runtime-service-worker.ts`.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../../src/async/job-manager";
import { settingsThreadService } from "../../src/thread/services/settings";
import { collectGarbage } from "../helpers/heap-snapshot";
import { rejectionMessage, rejectionOf } from "../helpers/rejection";
import { type Probe, ResultFrames, RuntimeWorkers } from "../helpers/runtime-service-workers";

/** The timeout of each case's teardown: far past what stopping its workers takes. */
const TEARDOWN_TIMEOUT_MS = 30_000;

const workers = new RuntimeWorkers();

afterEach(() => workers.stop(), TEARDOWN_TIMEOUT_MS);

/** A job the fixture registers with `options` (see its `registerJob` probe); its owner is `Worker`. */
async function registerJob(
	probe: Probe,
	manager: AsyncJobManager,
	options: { id?: string; foreground?: boolean; inputs?: boolean },
): Promise<string> {
	const id = await probe("registerJob", manager, "Worker", options);
	if (typeof id !== "string") throw new Error("registerJob returned no id");
	return id;
}

/** Main's promise that its row of `id` settles; the row must be there now. */
function rowSettles(manager: AsyncJobManager, id: string): Promise<void> {
	const settled = manager.getJob(id)?.promise;
	if (!settled) throw new Error(`no row ${id} on main`);
	return settled;
}

/** Run the body of `id` to its end and wait until main's row settled. */
async function settle(probe: Probe, manager: AsyncJobManager, id: string): Promise<void> {
	const settled = rowSettles(manager, id);
	await probe("finish", id, "done");
	await settled;
}

/**
 * Release `id` from the worker's foreground call, then end its body with `text`, its result held on main's side by
 * `frames`. Resolves, once the held result reaches main (within `heldMs`, when given), with what lets it through.
 */
async function endReleased(
	probe: Probe,
	frames: ResultFrames,
	manager: AsyncJobManager,
	id: string,
	text: string,
	heldMs?: number,
): Promise<() => void> {
	await probe("appendHeld", id, `${text}\n`);
	await probe("releaseForeground", manager, id);
	const held = frames.hold(text);
	await probe("finish", id, text);
	return heldMs === undefined
		? held
		: withTimeout(held, heldMs, `held result frame of ${id}: missed its ${heldMs} ms deadline`);
}

/** Main's row of `id`: whether it is there, settled, and listed as a background job. */
function mainRow(manager: AsyncJobManager, id: string): { status?: string; foreground?: boolean } | null {
	const row = manager.getJob(id);
	return row ? { status: row.status, foreground: row.foreground } : null;
}

/** Full collections in both threads; the second round lets the release frames of the first one land. */
async function collectBothThreads(probe: Probe): Promise<void> {
	for (let round = 0; round < 2; round++) {
		await probe("gc");
		await collectGarbage();
	}
}

describe("a worker's live inputs of its jobs across main's job rows", () => {
	it("keeps a foreground job's live output on the worker when main promoted the job before the worker released it", async () => {
		// If this regresses, a worker subagent's foreground bash call that main moved to the background loses its
		// output on the worker (`proc://<id>/streams`) once the call returns, though main still lists the job; or
		// main drops the promoted job's row once its run settles.
		const manager = workers.newManager();
		const probe = await workers.start();

		// Settled, then promoted by main, then released by the worker's foreground call.
		const settledFirst = await registerJob(probe, manager, { id: "settled-first", foreground: true, inputs: true });
		await probe("appendHeld", settledFirst, "settled first\n");
		await settle(probe, manager, settledFirst);
		expect(manager.backgroundJob(settledFirst)).toBe(true);
		await probe("releaseForeground", manager, settledFirst);

		// Released by the worker's foreground call while it ran, then promoted by main, then settled.
		const releasedFirst = await registerJob(probe, manager, { id: "released-first", foreground: true, inputs: true });
		await probe("appendHeld", releasedFirst, "released first\n");
		await probe("releaseForeground", manager, releasedFirst);
		expect(manager.backgroundJob(releasedFirst)).toBe(true);
		await settle(probe, manager, releasedFirst);

		const seen = async (id: string) => ({
			main: mainRow(manager, id),
			workerRow: await probe("localInputs", manager, id),
			workerListing: await probe("listedInputs", manager, id),
			workerSources: await probe("localSources", manager, id),
		});
		const kept = { hasWidgetInputs: true, pids: [4242] };
		expect({ settledFirst: await seen(settledFirst), releasedFirst: await seen(releasedFirst) }).toEqual({
			settledFirst: {
				main: { status: "completed", foreground: undefined },
				workerRow: kept,
				workerListing: kept,
				workerSources: [{ text: "settled first\n", open: false }],
			},
			releasedFirst: {
				main: { status: "completed", foreground: undefined },
				workerRow: kept,
				workerListing: kept,
				workerSources: [{ text: "released first\n", open: false }],
			},
		});
	}, 30_000);

	it("keeps a released foreground job's live output on the worker when main promotes the job after its body ended but before main has its result, and drops it once main discards the row of one it did not promote", async () => {
		// If this regresses, a worker subagent's foreground bash call that main moves to the background just as the
		// call ends loses its output on the worker (`proc://<id>/streams`) though main keeps listing the job; or a
		// call main did not move keeps its output on the worker for ten minutes after main dropped its row.
		const frames = new ResultFrames();
		const manager = workers.newManager();
		const probe = await workers.start({ frames });

		const promoted = await registerJob(probe, manager, { id: "promoted", foreground: true, inputs: true });
		const promotedSettles = rowSettles(manager, promoted);
		const deliverPromoted = await endReleased(probe, frames, manager, promoted, "promoted result");
		const promotedBeforeResult = mainRow(manager, promoted);
		expect(manager.backgroundJob(promoted)).toBe(true);
		deliverPromoted();
		await promotedSettles;

		// The control: released the same way, and main discards its row once the result arrives.
		const discarded = await registerJob(probe, manager, { id: "discarded", foreground: true, inputs: true });
		const discardedSettles = rowSettles(manager, discarded);
		const deliverDiscarded = await endReleased(probe, frames, manager, discarded, "discarded result");
		const discardedBeforeResult = mainRow(manager, discarded);
		deliverDiscarded();
		await discardedSettles;

		// No lookup on the worker before this point: only main's notice that it discarded the row lets the worker
		// drop the job's inputs, which alone keep its tap (the fixture holds it weakly).
		await collectBothThreads(probe);
		expect({
			promoted: {
				mainBeforeResult: promotedBeforeResult,
				main: mainRow(manager, promoted),
				workerTap: await probe("tapAlive", promoted),
				workerRow: await probe("localInputs", manager, promoted),
				workerSources: await probe("localSources", manager, promoted),
			},
			discarded: {
				mainBeforeResult: discardedBeforeResult,
				main: mainRow(manager, discarded),
				workerTap: await probe("tapAlive", discarded),
				workerRow: await probe("localInputs", manager, discarded),
			},
		}).toEqual({
			promoted: {
				mainBeforeResult: { status: "running", foreground: true },
				main: { status: "completed", foreground: undefined },
				workerTap: true,
				workerRow: { hasWidgetInputs: true, pids: [4242] },
				workerSources: [{ text: "promoted result\n", open: false }],
			},
			discarded: {
				mainBeforeResult: { status: "running", foreground: true },
				main: null,
				workerTap: false,
				workerRow: { hasWidgetInputs: false, pids: null },
			},
		});
	}, 30_000);

	it("never shows a worker job's live inputs on a later row main gives the same id", async () => {
		// If this regresses, a job id main gives out again (after it evicted the job that had it) shows, on the
		// worker that registered the earlier job, that job's process and output: in `proc://<id>` and in job
		// listings, for a result or a failure published here, a result published on main, or another worker's job.
		const manager = workers.newManager();
		const [probe, other] = await Promise.all([workers.start(), workers.start()]);
		const ids = ["published-here", "failed-here", "published-on-main", "registered-elsewhere"];
		for (const id of ids) {
			await registerJob(probe, manager, { id, inputs: true });
			await probe("appendHeld", id, "the earlier job's output\n");
			await settle(probe, manager, id);
		}
		expect(manager.evictCompletedJobs({ ownerId: "Worker" })).toBe(ids.length);

		expect(await probe("publishCompleted", manager, "published-here", "published here")).toBe("published-here");
		expect(await probe("publishFailed", manager, "failed-here", "failed here")).toBe("failed-here");
		expect(
			manager.publishCompleted(
				"task",
				"main result",
				{ text: "published on main" },
				{
					id: "published-on-main",
					ownerId: "Worker",
				},
			),
		).toBe("published-on-main");
		expect(await registerJob(other, manager, { id: "registered-elsewhere", inputs: true })).toBe(
			"registered-elsewhere",
		);

		// Listings first: a row lookup would let go of the earlier job's inputs before the listing reads them.
		const listed = {
			publishedHere: await probe("listedInputs", manager, "published-here"),
			failedHere: await probe("listedInputs", manager, "failed-here"),
			publishedOnMain: await probe("listedInputs", manager, "published-on-main"),
			registeredElsewhere: await probe("listedInputs", manager, "registered-elsewhere"),
		};
		const rows = {
			publishedHere: await probe("localInputs", manager, "published-here"),
			failedHere: await probe("localInputs", manager, "failed-here"),
			publishedOnMain: await probe("localInputs", manager, "published-on-main"),
			registeredElsewhere: await probe("localInputs", manager, "registered-elsewhere"),
			registeredElsewhereOnItsWorker: await other("localInputs", manager, "registered-elsewhere"),
		};
		const none = { hasWidgetInputs: false, pids: null };
		// The other worker's process as main projects it: main pulled no pids from that worker yet.
		const projected = { hasWidgetInputs: false, pids: [] };
		expect({ listed, rows }).toEqual({
			listed: { publishedHere: none, failedHere: none, publishedOnMain: none, registeredElsewhere: projected },
			rows: {
				publishedHere: none,
				failedHere: none,
				publishedOnMain: none,
				registeredElsewhere: projected,
				registeredElsewhereOnItsWorker: { hasWidgetInputs: true, pids: [4242] },
			},
		});
		await settle(other, manager, "registered-elsewhere");
	}, 30_000);
});

/** Resolves once the worker {@link RuntimeWorkers.start} spawned last has closed; it must be recorded already. */
function latestClosed(): Promise<void> {
	const worker = workers.latest;
	if (!worker) throw new Error("the worker fixture did not record its worker at its spawn");
	const { promise, resolve } = Promise.withResolvers<void>();
	worker.addEventListener("close", () => resolve(), { once: true });
	return promise;
}

describe("this file's worker fixture", () => {
	it("fails at once, naming the step, when a worker misses its readiness deadline or a held result never reaches main, and its teardown stops every worker and lets a still-held result through even when an exit hook throws", async () => {
		// If this regresses, a worker that never reports ready, or a job result that never reaches main, hangs a case
		// until the test's timeout without naming the step; or the case's teardown leaves a worker running, or a
		// job's result held so its row ends without it, once one of its steps throws.
		// No worker reports ready within 1 ms of its spawn. It is recorded at its spawn, before its readiness.
		const unready = rejectionMessage(workers.start({ startMs: 1 }));
		const closes = [latestClosed()];
		const readiness = await unready;

		// Both linked workers start at once, each recorded and watched for its close at its spawn, so their 20 s
		// readiness caps run side by side inside the case's 30 s timeout.
		const frames = new ResultFrames();
		const plainStart = workers.start();
		closes.push(latestClosed());
		const holdingStart = workers.start({ frames });
		closes.push(latestClosed());
		const [probe, holding] = await Promise.all([plainStart, holdingStart]);

		const manager = workers.newManager();
		// A hold on frames this worker's link never shows it: the held result never reaches it.
		const unseen = await registerJob(probe, manager, { id: "unseen", foreground: true, inputs: true });
		const heldResult = await rejectionMessage(
			endReleased(probe, new ResultFrames(), manager, unseen, "unseen result", 50),
		);

		// A result still held when teardown starts.
		const kept = await registerJob(holding, manager, { id: "kept", inputs: true });
		const keptRow = manager.getJob(kept);
		const keptSettles = rowSettles(manager, kept);
		const held = frames.hold("kept result");
		await holding("finish", kept, "kept result");
		await held;

		// The settings exit hook does its real work, then throws, for each linked worker; the steps after it still run.
		const realExit = settingsThreadService.onWorkerExit;
		const exitHook = spyOn(settingsThreadService, "onWorkerExit").mockImplementation((peer, reason) => {
			realExit?.call(settingsThreadService, peer, reason);
			throw new Error("exit hook failed in the control");
		});
		let stopped: unknown;
		try {
			stopped = await rejectionOf(workers.stop());
		} finally {
			exitHook.mockRestore();
		}
		await keptSettles;
		await Promise.all(closes);
		expect({
			readiness,
			heldResult,
			kept: { resultText: keptRow?.resultText, errorText: keptRow?.errorText },
			stopped:
				stopped instanceof AggregateError
					? stopped.errors.map(error => (error instanceof Error ? error.message : String(error)))
					: stopped,
		}).toEqual({
			readiness: "worker start: not ready within 1 ms",
			heldResult: "held result frame of unseen: missed its 50 ms deadline",
			kept: { resultText: "kept result", errorText: undefined },
			stopped: ["exit hook failed in the control", "exit hook failed in the control"],
		});
	}, 30_000);
});
