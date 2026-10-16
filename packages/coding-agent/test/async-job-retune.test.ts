import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { retuneJobProgress, snapshotJobs, visibleJobs } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { AsyncJobManager, type AsyncJobProgressDelivery } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const SELF_ID = "Main";
const PEER_ID = "Peer";

function makeSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false }),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	} as unknown as ToolSession;
}

/** A job that stays running until completed explicitly or cancelled by cleanup. */
function registerHangingJob(
	manager: AsyncJobManager,
	label: string,
	options: { ownerId: string; progressDelivery?: AsyncJobProgressDelivery },
): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register(
		"bash",
		label,
		async ({ signal }) => {
			signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
			return promise;
		},
		options,
	);
	return { id, finish: resolve };
}

describe("background job progress retune", () => {
	let manager: AsyncJobManager;
	let session: ToolSession;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		session = makeSession(manager);
	});

	afterEach(async () => {
		await manager.dispose();
	});

	test("retunes a running job and deduplicates unchanged outcomes", () => {
		const job = registerHangingJob(manager, "build output", { ownerId: SELF_ID, progressDelivery: "wake" });

		const flipped = retuneJobProgress(session, manager, SELF_ID, [job.id], "ambient");
		expect(flipped.isError).not.toBe(true);
		expect(flipped.details?.retuned).toEqual([{ id: job.id, status: "retuned", progress: "ambient" }]);
		expect(flipped.details?.jobs).toEqual([
			expect.objectContaining({ id: job.id, status: "running", progress: "ambient" }),
		]);
		expect(manager.getJob(job.id)?.progressDelivery).toBe("ambient");

		const again = retuneJobProgress(session, manager, SELF_ID, [job.id, job.id], "ambient");
		expect(again.isError).not.toBe(true);
		expect(again.details?.retuned).toEqual([{ id: job.id, status: "unchanged", progress: "ambient" }]);
	});

	test("does not expose or change another agent's job", () => {
		const peerJob = registerHangingJob(manager, "peer work", { ownerId: PEER_ID, progressDelivery: "wake" });

		const result = retuneJobProgress(session, manager, SELF_ID, [peerJob.id], "ambient");
		expect(result.isError).toBe(true);
		expect(result.details?.retuned).toEqual([{ id: peerJob.id, status: "not_found" }]);
		expect(result.details?.jobs).toEqual([]);
		expect(snapshotJobs(session, visibleJobs(manager, [peerJob.id], PEER_ID))).toEqual([
			expect.objectContaining({ id: peerJob.id, status: "running", progress: "wake" }),
		]);
	});

	test("proc progress writes reject invalid modes and cannot detach a job's channel", async () => {
		const job = registerHangingJob(manager, "build output", { ownerId: SELF_ID, progressDelivery: "wake" });
		const protocol = new ProcProtocolHandler();
		const url = parseInternalUrl(`proc://${job.id}/progress`);

		for (const content of ["", "invalid", "off"]) {
			await expect(protocol.write(url, content, { session })).rejects.toThrow();
			expect(manager.getJob(job.id)?.progressDelivery).toBe("wake");
			expect(manager.getJob(job.id)?.status).toBe("running");
		}

		const result = await protocol.write(url, "ambient", { session });
		expect(result.isError).not.toBe(true);
		expect(result.details?.proc).toMatchObject({
			retuned: [{ id: job.id, status: "retuned", progress: "ambient" }],
			jobs: [{ id: job.id, status: "running", progress: "ambient" }],
		});
		expect(manager.getJob(job.id)?.progressDelivery).toBe("ambient");
	});

	test("a job launched without progress cannot gain a channel after launch", () => {
		const job = registerHangingJob(manager, "silent job", { ownerId: SELF_ID });

		const result = retuneJobProgress(session, manager, SELF_ID, [job.id], "wake");
		expect(result.isError).toBe(true);
		expect(result.details?.retuned).toEqual([{ id: job.id, status: "unmonitored" }]);
		expect(result.details?.jobs).toEqual([expect.objectContaining({ id: job.id, status: "running" })]);
		expect(result.details?.jobs?.[0]).not.toHaveProperty("progress");
		expect(manager.getJob(job.id)?.progressDelivery).toBeUndefined();
	});

	test("a settled job reports not_running and its result stays recoverable", async () => {
		const job = registerHangingJob(manager, "quick job", { ownerId: SELF_ID, progressDelivery: "wake" });
		job.finish("build succeeded");
		await manager.getJob(job.id)?.promise;

		const result = retuneJobProgress(session, manager, SELF_ID, [job.id], "ambient");
		expect(result.isError).toBe(true);
		expect(result.details?.retuned).toEqual([{ id: job.id, status: "not_running", progress: "wake" }]);
		expect(manager.isJobResultConsumed(job.id)).toBe(false);

		const snapshot = await new ProcProtocolHandler().resolve(parseInternalUrl(`proc://${job.id}`), { session });
		expect(snapshot.details?.proc?.job).toMatchObject({
			id: job.id,
			status: "completed",
			progress: "wake",
			resultText: "build succeeded",
		});
		expect(snapshot.content).toContain("build succeeded");
	});
});
