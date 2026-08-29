import { describe, expect, it } from "bun:test";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MERGED_UNVERIFIED_MARKER } from "@oh-my-pi/pi-coding-agent/session/settle-gates";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";

function textOnlyStop(text = "Task complete."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

function host(unverified: { value: boolean }): {
	host: TodoTrackerHost;
	messages: unknown[];
	continuations: { count: number };
} {
	const messages: unknown[] = [];
	const continuations = { count: 0 };
	const built: TodoTrackerHost = {
		agent: { appendMessage: (message: unknown) => messages.push(message) } as unknown as Agent,
		sessionManager: {
			appendMessage: (message: unknown) => messages.push(message),
			getBranch: () => [],
		} as unknown as TodoTrackerHost["sessionManager"],
		settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 3 }),
		model: (): Model | undefined => undefined,
		agentKind: () => "main",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {
			continuations.count++;
		},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		getActiveToolNames: () => ["todo"],
		getEnabledToolNames: () => ["todo"],
		toolRegistry: () => new Map<string, AgentTool>(),
		planModeEnabled: () => false,
		consumeLastServedToolChoiceLabel: () => undefined,
		hasUnverifiedMerge: () => unverified.value,
		clearUnverifiedMerge: () => {
			unverified.value = false;
		},
	};
	return { host: built, messages, continuations };
}

describe("unverified isolated merge latch", () => {
	it("continues when todos are empty but a merge is unverified", async () => {
		const unverified = { value: true };
		const ctx = host(unverified);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
	});

	it("settles after a successful parent bash result clears the latch", async () => {
		const unverified = { value: true };
		const ctx = host(unverified);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);
		tracker.onToolResult("bash", false);

		expect(unverified.value).toBe(false);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("does not clear the latch on a failed bash result", async () => {
		const unverified = { value: true };
		const ctx = host(unverified);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolResult("bash", true);
		expect(unverified.value).toBe(true);
	});

	it("fires the merge gate even when todo reminders are disabled", async () => {
		// Merge verification is an acceptance latch, not a todo nudge: turning
		// todo.reminders/todo.enabled off must not strand an unverified merge.
		const unverified = { value: true };
		const ctx = host(unverified);
		(ctx.host.settings as Settings).set("todo.enabled", false);
		(ctx.host.settings as Settings).set("todo.reminders", false);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
	});
});
