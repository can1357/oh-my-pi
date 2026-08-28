/**
 * Contract: the two ways out of plan mode over RPC are not the same event.
 *
 * Toggling plan mode off is the user saying stop planning, and the turn still
 * running under the plan-mode toolset has to stop with it — the terminal's
 * `/plan` toggle has aborted it since #9699, while the RPC path cleared the
 * state and left the turn planning on a toolset the user had already left.
 *
 * Approving a plan leaves plan mode from inside the turn that wrote to
 * `xd://propose`. Aborting there kills the execution the approval exists to
 * start, so that exit stays quiet even though the session is streaming.
 *
 * What this file cannot cover is the wiring — that the command handler passes
 * `interruptActiveTurn: true` and the approval passes `false`. That is held by
 * the type instead: the option is required, so deleting it does not compile.
 */
import { describe, expect, it } from "bun:test";
import { exitRpcPlanMode, type RpcPlanModeExitTarget } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

interface Recorded {
	session: RpcPlanModeExitTarget;
	calls: string[];
	abortReasons: Array<string | undefined>;
	restored: Array<string[] | undefined>;
}

function recordingSession(isStreaming: boolean): Recorded {
	const calls: string[] = [];
	const abortReasons: Array<string | undefined> = [];
	const restored: Array<string[] | undefined> = [];
	const session: RpcPlanModeExitTarget = {
		isStreaming,
		async abort(options) {
			calls.push("abort");
			abortReasons.push(options?.reason);
		},
		async runModeExitTeardown(teardown) {
			calls.push("teardown:start");
			await teardown();
			calls.push("teardown:end");
		},
		async setPlanMode(_enabled, options) {
			calls.push("setPlanMode");
			restored.push(options?.restoreTools);
			return [];
		},
	};
	return { session, calls, abortReasons, restored };
}

describe("leaving plan mode over RPC", () => {
	it("stops the turn running under the plan-mode toolset when the client toggles the mode off", async () => {
		const { session, calls, abortReasons, restored } = recordingSession(true);
		await exitRpcPlanMode(session, { restoreTools: ["read", "bash"], interruptActiveTurn: true });
		// The order is the assertion: aborting inside the teardown guard is what
		// stops a steer queued behind the aborted turn from restarting on the
		// plan-mode tools and having them removed underneath it.
		expect(calls).toEqual(["teardown:start", "abort", "setPlanMode", "teardown:end"]);
		expect(abortReasons).toEqual([USER_INTERRUPT_LABEL]);
		expect(restored).toEqual([["read", "bash"]]);
	});

	it("does not abort the turn that is carrying out an approved plan", async () => {
		const { session, calls } = recordingSession(true);
		await exitRpcPlanMode(session, { restoreTools: ["read"], interruptActiveTurn: false });
		expect(calls).toEqual(["setPlanMode"]);
	});

	it("raises no interruption when there is no turn to interrupt", async () => {
		const { session, calls } = recordingSession(false);
		await exitRpcPlanMode(session, { restoreTools: undefined, interruptActiveTurn: true });
		expect(calls).toEqual(["setPlanMode"]);
	});
});
