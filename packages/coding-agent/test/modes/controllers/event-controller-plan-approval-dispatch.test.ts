import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

/**
 * A completed `write xd://propose` execution with `mode: "execute"` — the event
 * that drives `#handleToolExecutionEnd` into `ctx.handlePlanApproval`.
 */
function proposeExecuteEnd(): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "propose-1",
		toolName: "write",
		isError: false,
		result: {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				xdev: {
					tool: PROPOSE_DEVICE_NAME,
					mode: "execute",
					args: { title: "demo" },
					inner: { planFilePath: "local://demo-plan.md", title: "demo", planExists: true },
				},
			},
		},
	} as unknown as AgentSessionEvent;
}

describe("EventController plan-approval dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps dispatching session events while the approved plan's execution turn runs (issue #7684)", async () => {
		// Contract: the fullscreen Plan Review closes and the approved plan begins
		// executing, but `handlePlanApproval` -> `#approvePlan` awaits
		// `session.prompt` for the WHOLE run. The propose write's
		// `tool_execution_end` handler runs inside `EventController`'s serialized
		// dispatch chain (`#runSerialized`), so awaiting the approval there froze
		// the chain and every later agent_start / message_start / tool /
		// message_update event queued behind it — the chat stayed blank until
		// execution finished. The approval must instead be detached so later events
		// keep dispatching mid-execution.
		let listener: ((event: AgentSessionEvent) => void | Promise<void>) | undefined;
		// A pending gate stands in for the still-running execution turn: it never
		// resolves during the assertions, so a later event that dispatches proves
		// it did not wait for the run to finish. If a regression re-adds the
		// blocking await, `dispatch(...)` below never settles and the test times
		// out — the deadlock IS the failure.
		const executionTurn = Promise.withResolvers<void>();
		const handlePlanApproval = vi.fn(() => executionTurn.promise);

		const ctx = createInteractiveModeContext({
			session: {
				subscribe: fn => {
					listener = fn;
					return () => {};
				},
			},
			handlePlanApproval,
		});

		const controller = new EventController(ctx);
		controller.subscribeToAgent();
		if (!listener) throw new Error("subscribeToAgent did not register a listener");
		const dispatch = listener;

		const handleEventSpy = vi.spyOn(controller, "handleEvent");

		// Propose completion approved for execution. Awaiting the callback resolves
		// only once its `#runSerialized` link settles: after the fix the approval is
		// detached, so the link settles even though the execution turn is unresolved.
		await dispatch(proposeExecuteEnd());
		expect(handlePlanApproval).toHaveBeenCalledTimes(1);

		// A later session event arrives while the execution turn is still running.
		// `turn_start` rides the exact same `#runSerialized` gate that carries
		// agent_start / message_start / tool events / the coalesced message_update
		// flush, so its dispatch proves the gate is open mid-execution.
		await dispatch({ type: "turn_start" } as AgentSessionEvent);
		expect(handleEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "turn_start" }));

		executionTurn.resolve();
		await executionTurn.promise;
	});
});
