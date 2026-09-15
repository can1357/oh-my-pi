import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { TodoTracker } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";

function textOnlyStop(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Task complete. All work is done." }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("TodoTracker text-only stop regression", () => {
	it("keeps pending work non-terminal after the reminder budget and forces todo", async () => {
		const messages: unknown[] = [];
		const attempts: number[] = [];
		let continuations = 0;
		let forcedTodoCalls = 0;
		const host: TodoTrackerHost = {
			agent: { appendMessage: (message: unknown) => messages.push(message) } as unknown as TodoTrackerHost["agent"],
			sessionManager: {
				appendMessage: (message: unknown) => messages.push(message),
				getBranch: () => [],
			} as unknown as TodoTrackerHost["sessionManager"],
			settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 3 }),
			model: (): Model | undefined => undefined,
			agentKind: () => "main",
			emitSessionEvent: async event => {
				if (event.type === "todo_reminder") attempts.push(event.attempt);
			},
			scheduleAgentContinue: () => {
				continuations++;
			},
			promptGeneration: () => 1,
			hasPendingAsyncWake: () => false,
			getActiveToolNames: () => ["todo"],
			getEnabledToolNames: () => ["todo"],
			toolRegistry: () => new Map(),
			planModeEnabled: () => false,
			consumeLastServedToolChoiceLabel: () => undefined,
			forceTodoToolChoice: () => {
				forcedTodoCalls++;
				return true;
			},
			clearForcedTodoToolChoice: () => {},
		};
		const tracker = new TodoTracker(host);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "Finish the fix", status: "pending" }] }]);

		for (let index = 0; index < 4; index++) {
			expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		}

		expect(attempts).toEqual([1, 2, 3, 3]);
		expect(continuations).toBe(4);
		expect(forcedTodoCalls).toBe(1);
		expect(JSON.stringify(messages.at(-1))).toContain("Do not close with prose");
	});
});
