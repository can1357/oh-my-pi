import { describe, expect, it } from "bun:test";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { applyUserMarkdownPhases, markdownToPhases, phasesToMarkdown } from "@oh-my-pi/pi-coding-agent/tools/todo";

function textOnlyStop(text = "All work is done."): AssistantMessage {
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

function host(overrides: Partial<TodoTrackerHost> = {}): {
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
		...overrides,
	};
	return { host: built, messages, continuations };
}

describe("abandoned todos keep settle incomplete", () => {
	it("reminds after every item is dropped", async () => {
		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Ship feature", status: "abandoned" },
					{ content: "Write tests", status: "abandoned" },
				],
			},
		]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain("dropped");
		expect(JSON.stringify(ctx.messages)).toContain("Ship feature");
	});

	it("does not remind when the user explicitly dropped via /todo drop", async () => {
		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Ship feature", status: "abandoned", droppedBy: "user" },
					{ content: "Write tests", status: "abandoned", droppedBy: "user" },
				],
			},
		]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("still reminds when a model drop remains alongside a user drop", async () => {
		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Ship feature", status: "abandoned", droppedBy: "user" },
					{ content: "Write tests", status: "abandoned" },
				],
			},
		]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain("Write tests");
		expect(JSON.stringify(ctx.messages)).not.toContain("Ship feature");
	});

	it("still reminds after the model rm-abandons every item", async () => {
		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Ship feature", status: "abandoned" },
					{ content: "Write tests", status: "abandoned" },
				],
			},
		]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
	});

	it("does not remind when remaining work is only blocked", async () => {
		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [{ content: "Wait for owner", status: "blocked", blocker: "user" }],
			},
		]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("does not remind when the user forced stop", async () => {
		const ctx = host({ consumeLastServedToolChoiceLabel: () => "user-force" });
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "Ship feature", status: "abandoned" }] }]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("still reminds after a no-op edit of model-abandoned items", async () => {
		const prior = [
			{
				name: "Work",
				tasks: [{ content: "Ship feature", status: "abandoned" as const }],
			},
		];
		const md = phasesToMarkdown(prior);
		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const merged = applyUserMarkdownPhases(prior, parsed);
		expect(merged[0]?.tasks[0]).toEqual({ content: "Ship feature", status: "abandoned" });

		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases(merged);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
	});

	it("does not remind when edit newly abandons a pending item", async () => {
		const prior = [
			{
				name: "Work",
				tasks: [{ content: "Ship feature", status: "pending" as const }],
			},
		];
		const { phases: parsed, errors } = markdownToPhases("# Work\n- [-] Ship feature\n");
		expect(errors).toEqual([]);
		const merged = applyUserMarkdownPhases(prior, parsed);
		expect(merged[0]?.tasks[0]).toEqual({
			content: "Ship feature",
			status: "abandoned",
			droppedBy: "user",
		});

		const ctx = host();
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases(merged);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});
});
