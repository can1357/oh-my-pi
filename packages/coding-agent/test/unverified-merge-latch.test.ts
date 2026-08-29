import { describe, expect, it } from "bun:test";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MERGED_UNVERIFIED_MARKER, UnverifiedMergeLatch } from "@oh-my-pi/pi-coding-agent/session/settle-gates";
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

function host(latch: UnverifiedMergeLatch): {
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
		hasUnverifiedMerge: () => latch.latched,
		unverifiedMergeGeneration: () => latch.generation,
		clearUnverifiedMergeIfGeneration: (generationAtStart: number) => latch.clearIfGeneration(generationAtStart),
	};
	return { host: built, messages, continuations };
}

describe("unverified isolated merge latch", () => {
	it("continues when todos are empty but a merge is unverified", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
	});

	it("settles after a successful parent bash that started after the latch", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);
		tracker.onToolExecutionStart("bash", "call-1");
		tracker.onToolResult("bash", false, undefined, "call-1");

		expect(latch.latched).toBe(false);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("does not clear the latch on a failed bash result", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-1");
		tracker.onToolResult("bash", true, undefined, "call-1");
		expect(latch.latched).toBe(true);
	});

	it("does not clear the latch on a background bash still running", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-bg");
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "job-bg" } }, "call-bg");
		expect(latch.latched).toBe(true);
	});

	it("clears the latch when a background bash job completes via async delivery", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);
		tracker.onToolExecutionStart("bash", "call-bg");
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "job-bg" } }, "call-bg");
		expect(latch.latched).toBe(true);

		tracker.onAsyncJobTerminal("job-bg", "bash", "completed");
		expect(latch.latched).toBe(false);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("does not clear the latch when a background bash job fails", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-bg");
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "job-fail" } }, "call-bg");
		tracker.onAsyncJobTerminal("job-fail", "bash", "failed");
		expect(latch.latched).toBe(true);
	});

	it("does not clear when bash started before the merge was marked", async () => {
		const latch = new UnverifiedMergeLatch();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-pre");
		latch.mark();
		tracker.onToolResult("bash", false, undefined, "call-pre");
		expect(latch.latched).toBe(true);
	});

	it("does not clear the latch on lsp success:false without isError", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-lsp");
		tracker.onToolResult("lsp", false, { success: false }, "call-lsp");
		expect(latch.latched).toBe(true);
	});

	it("clears the latch on clean lsp diagnostics", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-lsp");
		tracker.onToolResult(
			"lsp",
			false,
			{ action: "diagnostics", success: true, diagnosticErrorCount: 0 },
			"call-lsp",
		);
		expect(latch.latched).toBe(false);
	});

	it("does not clear the latch on lsp hover or error diagnostics", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-hover");
		tracker.onToolResult("lsp", false, { action: "hover", success: true }, "call-hover");
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("lsp", "call-diag");
		tracker.onToolResult(
			"lsp",
			false,
			{ action: "diagnostics", success: true, diagnosticErrorCount: 2 },
			"call-diag",
		);
		expect(latch.latched).toBe(true);
	});

	it("does not clear the latch on tautological bash", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-pwd", { command: "pwd" });
		tracker.onToolResult("bash", false, undefined, "call-pwd");
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("bash", "call-test", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, undefined, "call-test");
		expect(latch.latched).toBe(false);
	});

	it("one parent bash does not clear two overlapping merges", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-1", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, undefined, "call-1");
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("bash", "call-2", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, undefined, "call-2");
		expect(latch.latched).toBe(false);
	});

	it("re-arms after an ignored merge reminder instead of settling", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(2);
		expect(latch.latched).toBe(true);
	});

	it("fires the merge gate even when todo reminders are disabled", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		(ctx.host.settings as Settings).set("todo.enabled", false);
		(ctx.host.settings as Settings).set("todo.reminders", false);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
	});

	it("keeps the merge gate armed after the todo reminder budget is exhausted", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		(ctx.host.settings as Settings).set("todo.remindersMax", 1);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		// Budget spent; latch still armed — settle must remain blocked.
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(2);
		expect(latch.latched).toBe(true);
	});

	it("does not treat a post-task user-force settle as an exemption from the merge latch", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		ctx.host.consumeLastServedToolChoiceLabel = () => "user-force";
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
	});
});
