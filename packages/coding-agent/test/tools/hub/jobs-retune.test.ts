/**
 * `hub` monitor against background job ids: retune a running job's progress
 * delivery mode in place. Every assertion goes through the tool's `execute`,
 * because the contract the model depends on is the tool surface (per-id
 * outcome, reported mode, error text), not the manager call underneath.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager, type AsyncJobProgressDelivery } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { CoordinationDetails, HubDetails, JobSnapshot } from "@oh-my-pi/pi-tui/tools/hub";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

const SELF_ID = "Main";
const PEER_ID = "Peer";

type HubCall = Parameters<HubTool["execute"]>[1];

function makeSession(manager: AsyncJobManager | undefined, agentId: string = SELF_ID): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "irc.timeoutMs") return 120_000;
				// Process supervision stays enabled so a job-path regression that
				// fell through to the launch broker would fail loudly instead of
				// being masked by a "supervision disabled" error.
				if (key === "launch.enabled") return true;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** A job that never settles on its own; `finish` completes it with result text. */
function registerHangingJob(
	manager: AsyncJobManager,
	label: string,
	options: { ownerId: string; progressDelivery?: AsyncJobProgressDelivery },
): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register("bash", label, async () => promise, options);
	return { id, finish: resolve };
}

type HubCallOutcome = AgentToolResult<HubDetails> & { text: string; details: CoordinationDetails };

async function callHub(tool: HubTool, call: HubCall): Promise<HubCallOutcome> {
	const result = await tool.execute("call", call);
	const first = result.content[0];
	return {
		...result,
		text: first?.type === "text" ? first.text : "",
		details: result.details as CoordinationDetails,
	};
}

/** The caller's own view of one job row, as `hub jobs` reports it. */
async function jobRow(tool: HubTool, id: string): Promise<JobSnapshot | undefined> {
	const snapshot = await callHub(tool, { op: "jobs" });
	return snapshot.details.jobs?.find(job => job.id === id);
}

describe("hub monitor — background job progress retune", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		manager = new AsyncJobManager({ onJobComplete: () => {} });
	});

	afterEach(() => {
		for (const job of manager.getRunningJobs()) manager.cancel(job.id);
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a running progress-carrying job flips mode, then reports the settled mode as unchanged", async () => {
		const job = registerHangingJob(manager, "tail -f build.log", {
			ownerId: SELF_ID,
			progressDelivery: "wake",
		});
		const tool = new HubTool(makeSession(manager));

		const flipped = await callHub(tool, { op: "monitor", ids: [job.id], progress: "ambient" });
		expect(flipped.isError).not.toBe(true);
		expect(flipped.details.retuned).toEqual([{ id: job.id, status: "retuned", progress: "ambient" }]);
		expect(flipped.text).toContain(
			`\`${job.id}\` progress → ambient; output already queued under the old mode was merged into the new queue.`,
		);
		// The row carried by the retune result already shows the new mode, so a
		// model reading only this result never sees the stale one.
		expect(flipped.details.jobs).toEqual([expect.objectContaining({ id: job.id, progress: "ambient" })]);
		expect(await jobRow(tool, job.id)).toMatchObject({ status: "running", progress: "ambient" });

		// Re-requesting the mode in effect is a reported no-op, not an error, and
		// repeated ids collapse to one outcome.
		const again = await callHub(tool, { op: "monitor", ids: [job.id, job.id], progress: "ambient" });
		expect(again.isError).not.toBe(true);
		expect(again.details.retuned).toEqual([{ id: job.id, status: "unchanged", progress: "ambient" }]);
		expect(again.text).toContain(`\`${job.id}\` is already delivering progress as ambient.`);
	});

	test("another agent's job is not_found and keeps its mode", async () => {
		const peerJob = registerHangingJob(manager, "peer work", { ownerId: PEER_ID, progressDelivery: "wake" });
		const tool = new HubTool(makeSession(manager));

		const result = await callHub(tool, { op: "monitor", ids: [peerJob.id], progress: "ambient" });
		expect(result.isError).toBe(true);
		expect(result.details.retuned).toEqual([{ id: peerJob.id, status: "not_found" }]);
		expect(result.text).toContain(`\`${peerJob.id}\` is not a background job you own.`);
		// No cross-agent leak: the foreign row is absent from the caller's view.
		expect(result.details.jobs).toEqual([]);

		const peerTool = new HubTool(makeSession(manager, PEER_ID));
		expect(await jobRow(peerTool, peerJob.id)).toMatchObject({ status: "running", progress: "wake" });
	});

	test("malformed retune requests are rejected verbatim and mutate nothing", async () => {
		const job = registerHangingJob(manager, "tail -f build.log", { ownerId: SELF_ID, progressDelivery: "wake" });
		const tool = new HubTool(makeSession(manager));

		const rejections: Array<{ call: HubCall; text: string }> = [
			{
				call: { op: "monitor", name: "web", ids: [job.id], progress: "ambient" },
				text: "`monitor` addresses either a process `name` or background job `ids`, not both.",
			},
			{
				call: { op: "monitor", ids: [job.id] },
				text: "`monitor` on background job ids requires `progress`: wake or ambient.",
			},
			{
				call: { op: "monitor", ids: [job.id], progress: "off" },
				text: '`progress: "off"` detaches a process monitor; a background job\'s progress channel cannot be detached — let it finish or cancel it.',
			},
		];

		for (const rejection of rejections) {
			const result = await callHub(tool, rejection.call);
			expect(result.isError).toBe(true);
			expect(result.text).toBe(rejection.text);
			expect(result.details.retuned).toBeUndefined();
			expect(await jobRow(tool, job.id)).toMatchObject({ status: "running", progress: "wake" });
		}
	});

	test("a job launched without progress cannot gain a channel after launch", async () => {
		const job = registerHangingJob(manager, "silent job", { ownerId: SELF_ID });
		const tool = new HubTool(makeSession(manager));

		const result = await callHub(tool, { op: "monitor", ids: [job.id], progress: "wake" });
		expect(result.isError).toBe(true);
		expect(result.details.retuned).toEqual([{ id: job.id, status: "unmonitored" }]);
		expect(result.text).toContain(
			`\`${job.id}\` was launched without \`progress\`; a progress channel cannot be added after launch — relaunch with \`progress\`.`,
		);

		const row = await jobRow(tool, job.id);
		expect(row).toMatchObject({ status: "running" });
		expect(row && Object.hasOwn(row, "progress")).toBe(false);
	});

	test("a settled job reports not_running and its result stays recoverable", async () => {
		const job = registerHangingJob(manager, "quick job", { ownerId: SELF_ID, progressDelivery: "wake" });
		const tool = new HubTool(makeSession(manager));
		job.finish("build succeeded");
		await manager.getJob(job.id)?.promise;
		expect(manager.getJob(job.id)?.status).toBe("completed");

		const result = await callHub(tool, { op: "monitor", ids: [job.id], progress: "ambient" });
		expect(result.isError).toBe(true);
		expect(result.details.retuned).toEqual([{ id: job.id, status: "not_running", progress: "wake" }]);
		expect(result.text).toContain(`\`${job.id}\` already settled; only a running job's progress can be retuned.`);

		// The retune is not a result recovery: the completion text is still
		// waiting for the first snapshot that consumes it.
		const snapshot = await callHub(tool, { op: "jobs" });
		expect(snapshot.details.jobs?.find(row => row.id === job.id)?.resultText).toBe("build succeeded");
		expect(snapshot.text).toContain("build succeeded");
	});
});
