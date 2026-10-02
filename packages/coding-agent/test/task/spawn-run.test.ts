/**
 * An adopted SpawnRun binds its owner's abort signal. Owners pass long-lived
 * signals (session- or job-scoped, often never aborted), so a settled run must
 * not stay reachable from that signal: otherwise every subagent run, its last
 * progress update and the owner's progress closures live as long as the signal.
 */
import { expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SpawnRun } from "@oh-my-pi/pi-coding-agent/task/spawn-run";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const permit = { acquire: async () => {}, release: () => {} };
const done = { content: [{ type: "text", text: "done" }] } as AgentToolResult<TaskToolDetails>;

/** Runs an adopted SpawnRun to completion; kept out of the test body so no strong local binding survives. */
async function settledRunRef(signal: AbortSignal): Promise<WeakRef<SpawnRun>> {
	const run = new SpawnRun(permit, async () => done, { detached: false });
	run.attach({ signal, onUpdate: () => {} });
	await run.result;
	return new WeakRef(run);
}

/** Collects across a few event-loop turns: Bun's conservative stack scan can pin a just-dropped object once. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		await Bun.sleep(0);
	}
	return false;
}

it("does not stay reachable from a long-lived owner signal once it settles", async () => {
	const owner = new AbortController();
	const ref = await settledRunRef(owner.signal);
	expect(await collected(ref)).toBe(true);
	// The owner signal is still live and unaborted; only the run was released.
	expect(owner.signal.aborted).toBe(false);
});

it("still aborts an unsettled run when the owner signal aborts", async () => {
	const owner = new AbortController();
	const run = new SpawnRun(
		permit,
		({ signal }) => {
			const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
			signal.addEventListener("abort", () => resolve(done), { once: true });
			return promise;
		},
		{ detached: false },
	);
	run.attach({ signal: owner.signal });
	await run.started;
	owner.abort(new Error("owner cancelled"));
	expect(await run.result).toBe(done);
});
