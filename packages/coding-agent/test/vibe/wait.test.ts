import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import type { ToolSession } from "../../src/tools";
import { VibeWaitTool } from "../../src/tools/vibe";
import { VibeSessionRegistry } from "../../src/vibe/runtime";

const OWNER = "test-owner";
const WORKER = "test-worker";

interface TestTurn {
	jobId: string;
	complete: (text: string) => void;
}

let manager: AsyncJobManager;
let session: ToolSession;

function startTurn(options?: { onDelivery?: (jobId: string, text: string) => void }): TestTurn {
	const completion = Promise.withResolvers<string>();
	if (options?.onDelivery) {
		manager.registerDeliverySink(OWNER, options.onDelivery);
	}
	const jobId = manager.register(
		"task",
		"test vibe turn",
		async ({ signal }) => {
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(new Error("cancelled"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([completion.promise, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		{ ownerId: OWNER },
	);
	VibeSessionRegistry.global().registerRecordForTests({ id: WORKER, ownerId: OWNER, jobId });
	return { jobId, complete: completion.resolve };
}

beforeEach(() => {
	manager = new AsyncJobManager({});
	session = {
		getAgentId: () => OWNER,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
});

afterEach(async () => {
	vi.useRealTimers();
	await manager.dispose({ timeoutMs: 100 });
	VibeSessionRegistry.resetGlobalForTests();
});

describe("vibe wait completion classification", () => {
	it("reports a true timer expiry as timed out", async () => {
		vi.useFakeTimers();
		startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 10 });
		vi.advanceTimersByTime(10);

		const outcome = await pending;

		expect(outcome.timedOut).toBe(true);
		expect(outcome.settled).toEqual([]);
		expect(outcome.stillRunning).toEqual([WORKER]);
	});

	it("returns a settled worker result instead of timing out", async () => {
		const turn = startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 1_000 });
		turn.complete("worker result");

		const outcome = await pending;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toEqual([
			{ id: WORKER, jobId: turn.jobId, status: "completed", resultText: "worker result" },
		]);
	});

	it("does not render an abort as an elapsed wait window, even with a long timeout", async () => {
		startTurn();
		const controller = new AbortController();
		controller.abort();

		const result = await new VibeWaitTool(session).execute("wait-call", { timeout: 900 }, controller.signal);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details?.wait?.timedOut).toBe(false);
		expect(text).toContain("Still running");
		expect(text).not.toContain("Wait window elapsed");
		expect(text).not.toContain("re-issue vibe_wait");
	});

	it("restores async self-delivery after an interrupted wait", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const turn = startTurn({ onDelivery: (jobId, text) => deliveries.push({ jobId, text }) });
		const controller = new AbortController();
		const pending = VibeSessionRegistry.global().wait(session, {
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		controller.abort();

		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		turn.complete("delivered later");
		await manager.getJob(turn.jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		expect(deliveries).toEqual([{ jobId: turn.jobId, text: "delivered later" }]);
	});

	it("returns a cancelled worker settlement without classifying it as timeout", async () => {
		const turn = startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 1_000 });
		manager.cancel(turn.jobId, { ownerId: OWNER });

		const outcome = await pending;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled[0]).toMatchObject({ id: WORKER, jobId: turn.jobId, status: "cancelled" });
	});
});
