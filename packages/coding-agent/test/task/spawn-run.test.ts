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

/**
 * Collects across a few event-loop turns and returns how many runs are still reachable. Bun's
 * conservative stack scan can pin the most recently dropped object in a stale native stack slot
 * (deterministically so on Windows), so callers settle several runs and tolerate one survivor.
 */
async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
	let live = refs.length;
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		live = refs.filter(ref => ref.deref() !== undefined).length;
		if (live === 0) break;
		await Bun.sleep(0);
	}
	return live;
}

it("does not stay reachable from a long-lived owner signal once it settles", async () => {
	const owner = new AbortController();
	const refs: WeakRef<SpawnRun>[] = [];
	// A signal that retained settled runs would pin every one of them, not just a stale-slot survivor.
	for (let i = 0; i < 8; i++) refs.push(await settledRunRef(owner.signal));
	expect(await liveAfterGc(refs)).toBeLessThanOrEqual(1);
	// The owner signal is still live and unaborted; only the runs were released.
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
