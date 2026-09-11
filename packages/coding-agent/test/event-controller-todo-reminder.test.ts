import { beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

function createContext() {
	const ctx = createInteractiveModeContext();
	return { ctx, present: vi.spyOn(ctx, "present") };
}

function reminder(attempt: number, content = "pending task"): Extract<AgentSessionEvent, { type: "todo_reminder" }> {
	return {
		type: "todo_reminder",
		todos: [{ content, status: "pending" }],
		attempt,
		maxAttempts: 3,
	};
}

describe("EventController todo reminder", () => {
	it("commits each reminder into durable chat history", async () => {
		const { ctx, present } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(reminder(1, "old task"));
		expect(present).toHaveBeenCalledTimes(1);

		// A second reminder is a distinct escalation, committed as its own block —
		// not merged into or replacing the first.
		await controller.handleEvent(reminder(2, "new task"));
		expect(present).toHaveBeenCalledTimes(2);
		expect(present.mock.calls[0]![0]).not.toBe(present.mock.calls[1]![0]);
	});

	it("leaves committed reminders untouched when a todo tool succeeds", async () => {
		const { ctx, present } = createContext();
		const controller = new EventController(ctx);
		const phases = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" as const }] }];

		await controller.handleEvent(reminder(1));
		expect(present).toHaveBeenCalledTimes(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: { content: [{ type: "text", text: "" }], details: { phases } },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		// The reminder stays in history (no retroactive removal); only the sticky
		// HUD updates via setTodos.
		expect(present).toHaveBeenCalledTimes(1);
		expect(ctx.setTodos).toHaveBeenCalledWith(phases);
	});
});
