import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PROPOSE_COMMAND_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

type ToolExecutionEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

const PLAN_DETAILS = { planFilePath: "local://demo-plan.md", title: "demo", planExists: true };

/**
 * A completed `propose <slug>` bash command: the run's tool-command record
 * carries the approval payload on its `inner` details.
 */
function proposeCommandEnd(exitCode = 0): ToolExecutionEnd {
	return {
		type: "tool_execution_end",
		toolCallId: "propose-1",
		toolName: "bash",
		isError: false,
		result: {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				toolCommands: [
					{
						tool: PROPOSE_COMMAND_NAME,
						mode: "execute",
						exitCode,
						args: { title: "demo" },
						inner: PLAN_DETAILS,
					},
				],
			},
		},
	};
}

/** A direct `propose` call whose result details are the plan approval payload. */
function proposeToolEnd(): ToolExecutionEnd {
	return {
		type: "tool_execution_end",
		toolCallId: "propose-2",
		toolName: PROPOSE_COMMAND_NAME,
		isError: false,
		result: {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: PLAN_DETAILS,
		},
	};
}

describe("EventController plan-approval dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps dispatching session events while the approved plan's execution turn runs (issue #7684)", async () => {
		// Contract: the fullscreen Plan Review closes and the approved plan begins
		// executing, but `handlePlanApproval` -> `#approvePlan` awaits
		// `session.prompt` for the WHOLE run. The propose command's
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
		await dispatch(proposeCommandEnd());
		expect(handlePlanApproval).toHaveBeenCalledTimes(1);

		// A later session event arrives while the execution turn is still running.
		// `turn_start` rides the exact same `#runSerialized` gate that carries
		// agent_start / message_start / tool events / the coalesced message_update
		// flush, so its dispatch proves the gate is open mid-execution.
		await dispatch({ type: "turn_start" });
		expect(handleEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "turn_start" }));

		executionTurn.resolve();
		await executionTurn.promise;
	});

	it("opens the plan approval overlay for a direct propose result", async () => {
		const handlePlanApproval = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			session: { subscribe: () => () => {} },
			handlePlanApproval,
		});
		const controller = new EventController(ctx);

		await controller.handleEvent(proposeToolEnd());

		expect(handlePlanApproval).toHaveBeenCalledTimes(1);
		expect(handlePlanApproval).toHaveBeenCalledWith(PLAN_DETAILS);
	});

	it("does not open the plan approval overlay for a failed propose command", async () => {
		const handlePlanApproval = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			session: { subscribe: () => () => {} },
			handlePlanApproval,
		});
		const controller = new EventController(ctx);

		await controller.handleEvent(proposeCommandEnd(1));

		expect(handlePlanApproval).not.toHaveBeenCalled();
	});
});
