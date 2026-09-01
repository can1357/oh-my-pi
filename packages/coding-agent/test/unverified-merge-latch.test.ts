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

function host(
	latch: UnverifiedMergeLatch,
	options: { cwd?: string; repoRoot?: string; activeTools?: string[] } = {},
): {
	host: TodoTrackerHost;
	messages: unknown[];
	events: unknown[];
	continuations: { count: number };
} {
	const messages: unknown[] = [];
	const events: unknown[] = [];
	const continuations = { count: 0 };
	const verifyTools = options.activeTools ?? ["todo", "bash", "eval", "lsp"];
	const sessionCwd = options.cwd ?? "/repo";
	const built: TodoTrackerHost = {
		agent: { appendMessage: (message: unknown) => messages.push(message) } as unknown as Agent,
		sessionManager: {
			appendMessage: (message: unknown) => messages.push(message),
			getBranch: () => [],
		} as unknown as TodoTrackerHost["sessionManager"],
		settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 3 }),
		model: (): Model | undefined => undefined,
		agentKind: () => "main",
		cwd: () => sessionCwd,
		repoRoot: options.repoRoot !== undefined ? () => options.repoRoot : undefined,
		emitSessionEvent: async event => {
			events.push(event);
		},
		scheduleAgentContinue: () => {
			continuations.count++;
		},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		getActiveToolNames: () => verifyTools,
		getEnabledToolNames: () => verifyTools,
		toolRegistry: () => new Map<string, AgentTool>(),
		planModeEnabled: () => false,
		consumeLastServedToolChoiceLabel: () => undefined,
		hasUnverifiedMerge: () => latch.latched,
		unverifiedMergeGeneration: () => latch.generation,
		clearUnverifiedMergeIfGeneration: (generationAtStart: number) => latch.clearIfGeneration(generationAtStart),
	};
	return { host: built, messages, events, continuations };
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
		const reminder = ctx.events.find(
			(event): event is { type: string; unverifiedMerge?: boolean; todos: unknown[] } =>
				typeof event === "object" && event !== null && (event as { type?: string }).type === "todo_reminder",
		);
		expect(reminder?.unverifiedMerge).toBe(true);
		expect(reminder?.todos).toEqual([]);
	});

	it("settles when latched but no parent verify tools are active", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { activeTools: ["todo"] });
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
		expect(latch.latched).toBe(true);
	});

	it("settles after a successful parent bash that started after the latch", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);
		tracker.onToolExecutionStart("bash", "call-1", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-1");

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

	it("does not clear the latch when bash cwd is outside the merged tree", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-out", {
			command: "bun test test/foo.test.ts",
			cwd: "/tmp",
		});
		tracker.onToolResult("bash", false, { cwd: "/tmp" }, "call-out");
		expect(latch.latched).toBe(true);
	});

	it("does not clear when leading cd uses semicolon to escape the merged tree", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		// `cd /tmp; bun test` must resolve cwd to /tmp (not treat missing && as in-tree).
		tracker.onToolExecutionStart("bash", "call-semi", {
			command: "cd /tmp; bun test test/foo.test.ts",
		});
		tracker.onToolResult("bash", false, undefined, "call-semi");
		expect(latch.latched).toBe(true);

		tracker.onToolExecutionStart("bash", "call-semi-in", {
			command: "cd packages/coding-agent; bun test test/foo.test.ts",
		});
		tracker.onToolResult("bash", false, undefined, "call-semi-in");
		expect(latch.latched).toBe(false);
	});

	it("does not clear the latch on bare or trivial eval success", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);

		// Unrelated arithmetic with no cwd — not parent verification.
		tracker.onToolExecutionStart("eval", "call-arith", { language: "js", code: "1+1" });
		tracker.onToolResult("eval", false, { cells: [{ code: "1+1", status: "complete" }] }, "call-arith");
		expect(latch.latched).toBe(true);

		// Trivial expression even with in-tree cwd is non-evidence.
		tracker.onToolExecutionStart("eval", "call-trivial-cwd", {
			language: "js",
			code: "1+1",
			cwd: "/repo",
		});
		tracker.onToolResult("eval", false, { cwd: "/repo", code: "1+1" }, "call-trivial-cwd");
		expect(latch.latched).toBe(true);

		// Outside-tree cwd with project-looking code still must not clear.
		tracker.onToolExecutionStart("eval", "call-out", {
			language: "js",
			code: "await read('package.json')",
			cwd: "/tmp",
		});
		tracker.onToolResult("eval", false, { cwd: "/tmp", code: "await read('package.json')" }, "call-out");
		expect(latch.latched).toBe(true);

		// Non-trivial code without an explicit cwd runs in the session tree — clears.
		tracker.onToolExecutionStart("eval", "call-session", {
			language: "js",
			code: "await read('package.json')",
		});
		tracker.onToolResult(
			"eval",
			false,
			{ cells: [{ code: "await read('package.json')", status: "complete" }] },
			"call-session",
		);
		expect(latch.latched).toBe(false);
	});

	it("does not clear background eval without in-tree cwd or non-trivial code", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("eval", "call-bg", { language: "js", code: "1+1" });
		tracker.onToolResult("eval", false, { async: { state: "running", jobId: "job-eval" } }, "call-bg");
		tracker.onAsyncJobTerminal("job-eval", "eval", "completed");
		expect(latch.latched).toBe(true);

		tracker.onToolExecutionStart("eval", "call-bg-ok", {
			language: "js",
			code: "await read('package.json')",
			cwd: "/repo",
		});
		tracker.onToolResult(
			"eval",
			false,
			{ async: { state: "running", jobId: "job-eval-ok" }, cwd: "/repo" },
			"call-bg-ok",
		);
		tracker.onAsyncJobTerminal("job-eval-ok", "eval", "completed");
		expect(latch.latched).toBe(false);
	});

	it("does not clear when bash cwd escapes via relative path or leading cd", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);

		tracker.onToolExecutionStart("bash", "call-rel", {
			command: "npm test",
			cwd: "../other-repo",
		});
		tracker.onToolResult("bash", false, undefined, "call-rel");
		expect(latch.latched).toBe(true);

		tracker.onToolExecutionStart("bash", "call-cd", {
			command: "cd ../other-repo && npm test",
		});
		// No details.cwd — start snap must retain the leading-cd target.
		tracker.onToolResult("bash", false, undefined, "call-cd");
		expect(latch.latched).toBe(true);

		tracker.onToolExecutionStart("bash", "call-in", {
			command: "bun test test/foo.test.ts",
			cwd: "packages/coding-agent",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo/packages/coding-agent" }, "call-in");
		expect(latch.latched).toBe(false);
	});

	it("does not clear on lsp diagnostics that report success:false (no server coverage)", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-none");
		tracker.onToolResult(
			"lsp",
			false,
			{
				action: "diagnostics",
				success: false,
				diagnosticErrorCount: 0,
				failedServerCount: 1,
			},
			"call-none",
		);
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
		tracker.onToolExecutionStart("bash", "call-bg", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "job-bg" }, cwd: "/repo" }, "call-bg");
		expect(latch.latched).toBe(true);

		tracker.onAsyncJobTerminal("job-bg", "bash", "completed");
		expect(latch.latched).toBe(false);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("clears when async terminal arrives before the toolResult re-key", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-race", { command: "bun test test/foo.test.ts" });
		// Terminal before running ack re-keys under job id.
		tracker.onAsyncJobTerminal("job-race", "bash", "completed");
		expect(latch.latched).toBe(true);
		tracker.onToolResult(
			"bash",
			false,
			{ async: { state: "running", jobId: "job-race" }, cwd: "/repo" },
			"call-race",
		);
		expect(latch.latched).toBe(false);
	});

	it("ignores early async terminals from non-verify job types", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		// A task terminal must not consume the bash verify snap on re-key.
		tracker.onAsyncJobTerminal("job-shared", "task", "completed");
		tracker.onToolExecutionStart("bash", "call-bash", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult(
			"bash",
			false,
			{ async: { state: "running", jobId: "job-shared" }, cwd: "/repo" },
			"call-bash",
		);
		expect(latch.latched).toBe(true);
		tracker.onAsyncJobTerminal("job-shared", "bash", "completed");
		expect(latch.latched).toBe(false);
	});

	it("does not stash a finished job terminal while another verifier awaits re-key", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-a", { command: "bun test test/a.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_1" }, cwd: "/repo" }, "call-a");
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		expect(latch.latched).toBe(false);

		latch.mark();
		// Second verifier still awaiting running-ack; hub redelivers the finished job.
		tracker.onToolExecutionStart("bash", "call-b", { command: "bun test test/b.test.ts" });
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_2" }, cwd: "/repo" }, "call-b");
		expect(latch.latched).toBe(true);

		// Reused bg_1 for a new job must not consume the stale redelivery.
		tracker.onToolExecutionStart("bash", "call-c", { command: "bun test test/c.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_1" }, cwd: "/repo" }, "call-c");
		expect(latch.latched).toBe(true);
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		expect(latch.latched).toBe(false);
	});

	it("does not clear the latch on truncated-glob diagnostics details", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-trunc", { action: "diagnostics", file: "**/*.ts" });
		tracker.onToolResult(
			"lsp",
			false,
			{
				action: "diagnostics",
				success: false,
				diagnosticErrorCount: 0,
				failedServerCount: 1,
				file: "**/*.ts",
			},
			"call-trunc",
		);
		expect(latch.latched).toBe(true);
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
		tracker.onToolExecutionStart("lsp", "call-lsp", { action: "diagnostics", file: "src/foo.ts" });
		tracker.onToolResult(
			"lsp",
			false,
			{ action: "diagnostics", success: true, diagnosticErrorCount: 0, failedServerCount: 0 },
			"call-lsp",
		);
		expect(latch.latched).toBe(false);
	});

	it("does not clear the latch on lsp diagnostics outside the merged tree", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-out", { action: "diagnostics", file: "/tmp/clean.ts" });
		tracker.onToolResult(
			"lsp",
			false,
			{
				action: "diagnostics",
				success: true,
				diagnosticErrorCount: 0,
				failedServerCount: 0,
				request: { action: "diagnostics", file: "/tmp/clean.ts" },
			},
			"call-out",
		);
		expect(latch.latched).toBe(true);
	});

	it("does not clear from details.file alone when the target is outside the merged tree", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		// No start snap — only details.file (as emitted by the lsp tool).
		tracker.onToolResult(
			"lsp",
			false,
			{
				action: "diagnostics",
				success: true,
				file: "/tmp/clean.ts",
				diagnosticErrorCount: 0,
				failedServerCount: 0,
			},
			undefined,
		);
		expect(latch.latched).toBe(true);
	});

	it("clears the latch on workspace-wide lsp diagnostics", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-ws", { action: "diagnostics", file: "*" });
		tracker.onToolResult(
			"lsp",
			false,
			{ action: "diagnostics", success: true, diagnosticErrorCount: 0, failedServerCount: 0 },
			"call-ws",
		);
		expect(latch.latched).toBe(false);
	});

	it("does not clear on partial lsp server failures or missing error count", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("lsp", "call-partial");
		tracker.onToolResult(
			"lsp",
			false,
			{ action: "diagnostics", success: true, diagnosticErrorCount: 0, failedServerCount: 1 },
			"call-partial",
		);
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("lsp", "call-missing");
		tracker.onToolResult("lsp", false, { action: "diagnostics", success: true }, "call-missing");
		expect(latch.latched).toBe(true);
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
			{ action: "diagnostics", success: true, diagnosticErrorCount: 2, failedServerCount: 0 },
			"call-diag",
		);
		expect(latch.latched).toBe(true);
	});

	it("does not clear the latch on tautological bash including env-prefixed forms", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-pwd", { command: "pwd" });
		tracker.onToolResult("bash", false, undefined, "call-pwd");
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("bash", "call-ci-pwd", { command: "CI=1 pwd" });
		tracker.onToolResult("bash", false, undefined, "call-ci-pwd");
		expect(latch.latched).toBe(true);
		tracker.onToolExecutionStart("bash", "call-test", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, undefined, "call-test");
		expect(latch.latched).toBe(false);
	});

	it("does not clear when structured cwd hides a leading out-of-tree cd", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-hide", {
			cwd: "/repo",
			command: "cd /tmp && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-hide");
		expect(latch.latched).toBe(true);
	});

	it("preserves start-resolved cwd across async bash re-key", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-async", {
			cwd: "/repo",
			command: "cd /tmp && bun test",
		});
		tracker.onToolResult(
			"bash",
			false,
			{ cwd: "/repo", async: { state: "running", jobId: "bg_out" } },
			"call-async",
		);
		expect(latch.latched).toBe(true);
		tracker.onAsyncJobTerminal("bg_out", "bash", "completed");
		expect(latch.latched).toBe(true);
	});

	it("does not clear when leading cd has redirects that cannot be resolved", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-redir", {
			cwd: "/repo",
			command: "cd /tmp 2>/dev/null && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-redir");
		expect(latch.latched).toBe(true);
	});

	it("does not clear when env-prefixed or chained out-of-tree cd hides structured cwd", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-env", {
			cwd: "/repo",
			command: "FOO=1 cd /tmp && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-env");
		expect(latch.latched).toBe(true);

		tracker.onToolExecutionStart("bash", "call-chain", {
			cwd: "/repo",
			command: "cd /repo && cd /tmp && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-chain");
		expect(latch.latched).toBe(true);
	});

	it("does not clear when a relative cd chain lands outside the merged tree", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-rel", {
			cwd: "/repo",
			command: "cd /tmp && cd project && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-rel");
		expect(latch.latched).toBe(true);
	});

	it("resolves a relative leading cd against the structured cwd", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch, { cwd: "/repo", repoRoot: "/repo" });
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-rel-cwd", {
			cwd: "/tmp",
			command: "cd project && bun test",
		});
		tracker.onToolResult("bash", false, { cwd: "/tmp" }, "call-rel-cwd");
		expect(latch.latched).toBe(true);
	});

	it("does not clear on status-masking shell chains", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		for (const [id, command] of [
			["call-or", "bun test || true"],
			["call-semi", "bun test; true"],
			["call-pipe", "bun test | cat"],
		] as const) {
			tracker.onToolExecutionStart("bash", id, { command });
			tracker.onToolResult("bash", false, { cwd: "/repo" }, id);
			expect(latch.latched).toBe(true);
		}
	});

	it("does not clear on shell-backgrounded verification", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-bg-amp", {
			command: "bun test test/foo.test.ts & true",
		});
		tracker.onToolResult("bash", false, { cwd: "/repo" }, "call-bg-amp");
		expect(latch.latched).toBe(true);
	});

	it("does not stash duplicate async terminals after the verify snap cleared", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-1", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_1" } }, "call-1");
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		expect(latch.latched).toBe(false);
		latch.mark();
		// Duplicate terminal for the consumed job must not stash for a later reuse.
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		expect(latch.latched).toBe(true);
		// Fresh verifier with reused id still works when a pending snap exists.
		tracker.onToolExecutionStart("bash", "call-2", { command: "bun test test/bar.test.ts" });
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_1" } }, "call-2");
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

	it("keeps the merge gate armed when the assistant ends with a user-facing question", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([]);

		expect(await tracker.checkCompletion(textOnlyStop("Should I run the tests?"))).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain(MERGED_UNVERIFIED_MARKER);
		expect(latch.latched).toBe(true);
	});

	it("skips ordinary todo reminders when the assistant ends with a user-facing question", async () => {
		const latch = new UnverifiedMergeLatch();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "Ship feature", status: "pending" }] }]);

		expect(await tracker.checkCompletion(textOnlyStop("Should I run the tests?"))).toBe(false);
		expect(ctx.continuations.count).toBe(0);
	});

	it("session-boundary clear drops the latch and pending verify snapshots", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-1", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_1" } }, "call-1");
		expect(latch.latched).toBe(true);

		// Mirrors AgentSession.#clearSessionScopedToolState on switch/new.
		latch.clear();
		tracker.resetVerifyState();
		expect(latch.latched).toBe(false);

		// Recycled job id from a later session must not clear a fresh latch.
		latch.mark();
		tracker.onAsyncJobTerminal("bg_1", "bash", "completed");
		expect(latch.latched).toBe(true);
	});

	it("clears the latch when hub observes a consumed successful bash job", async () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.onToolExecutionStart("bash", "call-hub", { command: "bun test test/foo.test.ts" });
		tracker.onToolResult("bash", false, { async: { state: "running", jobId: "bg_hub" } }, "call-hub");
		expect(latch.latched).toBe(true);
		// Hub buildJobResult calls observeAsyncJobTerminal after consumeJobResults.
		tracker.onAsyncJobTerminal("bg_hub", "bash", "completed");
		expect(latch.latched).toBe(false);
	});

	it("keeps model-abandoned todos incomplete alongside the merge latch", async () => {
		const latch = new UnverifiedMergeLatch();
		const ctx = host(latch);
		const tracker = new TodoTracker(ctx.host);
		tracker.setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Ship feature", status: "abandoned" },
					{ content: "Cancelled by user", status: "abandoned", droppedBy: "user" },
				],
			},
		]);
		expect(await tracker.checkCompletion(textOnlyStop())).toBe(true);
		expect(ctx.continuations.count).toBe(1);
		expect(JSON.stringify(ctx.messages)).toContain("Ship feature");
		expect(JSON.stringify(ctx.messages)).toContain("(dropped)");
		expect(JSON.stringify(ctx.messages)).not.toContain("Cancelled by user");
		// Clone must preserve user provenance.
		expect(tracker.phases[0]?.tasks.find(t => t.content === "Cancelled by user")).toEqual({
			content: "Cancelled by user",
			status: "abandoned",
			droppedBy: "user",
		});
	});
});
