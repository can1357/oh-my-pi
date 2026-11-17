import { describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { DEFAULT_TOOL_INTERCEPTOR_RULES, type ToolInterceptorRule } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { checkToolInterception } from "@oh-my-pi/pi-coding-agent/tools/tool-interceptor";

const ALL_DEDICATED_TOOLS = ["read", "write", "edit", "grep", "glob", "bash"];

function makeMockJudge(decide: (question: string, request: JudgmentRequest) => number) {
	const spy = vi.fn(async <Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> => {
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(request.questions)) {
			answers[id] = { type: "noul", noul: decide(q.instructions, request) };
		}
		return {
			api: "typesafe",
			provider: "typesafe",
			model: "jev-latest",
			answers: answers as JudgmentResult<Q>["answers"],
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	});
	const judge: Judge = {
		label: "mock-judge",
		judge: spy as Judge["judge"],
	};
	return { judge, spy };
}

describe("toolInterceptor target selection and pattern matching", () => {
	it("applies a rule only to the tools named in tools (including wildcards)", async () => {
		const rules: ToolInterceptorRule[] = [
			{
				tools: "eval",
				pattern: "\\bforbiddenInEval\\b",
				message: "Blocked in eval.",
			},
			{
				tools: ["mcp__*"],
				pattern: "drop_table",
				message: "Do not drop tables via MCP.",
			},
		];

		expect((await checkToolInterception("eval", { code: "forbiddenInEval()" }, { rules })).block).toBe(true);
		expect((await checkToolInterception("bash", { command: "forbiddenInEval" }, { rules })).block).toBe(false);
		expect((await checkToolInterception("mcp__db_query", { query: "drop_table users" }, { rules })).block).toBe(true);
		expect(
			(
				await checkToolInterception(
					"write",
					{ path: "xd://mcp__db_query", content: JSON.stringify({ query: "drop_table users" }) },
					{ rules, toolAliases: ["mcp__db_query"] },
				)
			).block,
		).toBe(true);
	});

	it("blocks synchronous pattern-only rules without invoking the judge", async () => {
		const { judge, spy } = makeMockJudge(() => 1.0);
		const rules: ToolInterceptorRule[] = [
			{
				tools: ["eval"],
				pattern: "\\bforbiddenSyncHelper\\s*\\(",
				message: "Do not call forbiddenSyncHelper in eval.",
			},
		];
		const result = await checkToolInterception(
			"eval",
			{ language: "js", code: "forbiddenSyncHelper()" },
			{ availableTools: ALL_DEDICATED_TOOLS, rules, judge },
		);

		expect(result.block).toBe(true);
		expect(result.message).toContain("Do not call forbiddenSyncHelper");
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("judge-backed question rules with optional pattern prefilter", () => {
	it("skips calling the judge when no rule's pattern prefilter matches (including in-memory JSON.parse, fetch, and title/intent strings)", async () => {
		const { judge, spy } = makeMockJudge(() => 1.0);
		for (const params of [
			{ language: "py", code: "print(sum(x * x for x in range(100)))" },
			{
				language: "js",
				code: 'const parsed = JSON.parse("{\\"ok\\":true}"); console.log(parsed.ok);',
				title: "Compare with open('data.json') and read('foo')",
				i: "Testing JSON.parse without reading files via open()",
			},
			{
				language: "js",
				code: 'const res = await fetch("http://127.0.0.1:8080/health", { method: "POST" }); console.log(res.status);',
			},
		]) {
			const result = await checkToolInterception("eval", params, {
				availableTools: ALL_DEDICATED_TOOLS,
				rules: DEFAULT_TOOL_INTERCEPTOR_RULES,
				judge,
			});
			expect(result.block).toBe(false);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("distinguishes single tool.<name> wrappers from @tool/loop orchestration via the judge", async () => {
		const { judge, spy } = makeMockJudge((_question, request) => {
			const state = request.state as { code?: string };
			return state.code?.includes("for (const target of targets)") ? 0.05 : 0.95;
		});

		const singleWrapper = await checkToolInterception(
			"eval",
			{ language: "js", code: 'return await tool.read({ path: "package.json" });' },
			{ availableTools: ALL_DEDICATED_TOOLS, rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);
		expect(singleWrapper.block).toBe(true);
		expect(singleWrapper.message).toContain("Do not call dedicated session tools");
		const loopOrchestration = await checkToolInterception(
			"eval",
			{
				language: "js",
				code: "for (const target of targets) {\n  results.push(await tool.grep({ pattern: target.symbol, path: target.dir }));\n}",
			},
			{ availableTools: ALL_DEDICATED_TOOLS, rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);
		expect(loopOrchestration.block).toBe(false);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("distinguishes trivial JSON filtering from statistical file aggregation via the judge", async () => {
		const { judge, spy } = makeMockJudge((_question, request) => {
			const state = request.state as { code?: string };
			return state.code?.includes("statistics.median") ? 0.1 : 0.95;
		});

		const trivialJsonCell = [
			"import json, re",
			'art = output("0")',
			"data = json.loads(art)",
			'print([s for s in data.get("data", []) if "addr" in s])',
		].join("\n");

		const blocked = await checkToolInterception(
			"eval",
			{ language: "py", code: trivialJsonCell },
			{ availableTools: ALL_DEDICATED_TOOLS, rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);
		expect(blocked.block).toBe(true);
		expect(blocked.suggestedTool).toBe("read");
		expect(blocked.message).toContain("jq query selector");
		expect(spy).toHaveBeenCalledTimes(1);

		const aggregationCell = [
			"import csv, json, statistics",
			"with open('meta.json') as f:",
			"    meta = json.load(f)",
			"with open('per_metal.csv') as f:",
			"    rps = [float(r['req_per_s']) for r in csv.DictReader(f)]",
			"print(statistics.median(rps), statistics.stdev(rps))",
		].join("\n");

		const allowed = await checkToolInterception(
			"eval",
			{ language: "py", code: aggregationCell },
			{ availableTools: ALL_DEDICATED_TOOLS, rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);
		expect(allowed.block).toBe(false);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("batches multiple matching question rules into a single judge request", async () => {
		const { judge, spy } = makeMockJudge(question => (question.includes("JSON") ? 0.9 : 0.2));
		const code = 'with open("data.json") as f:\n    print(json.loads(f.read())["items"])';

		const result = await checkToolInterception(
			"eval",
			{ language: "py", code },
			{ availableTools: ALL_DEDICATED_TOOLS, rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);

		expect(result.block).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		const firstCallQuestions = Object.keys(spy.mock.calls[0]![0].questions);
		expect(firstCallQuestions.length).toBeGreaterThanOrEqual(2);
	});

	it("does not block when the suggested replacement tool is unavailable in the session", async () => {
		const { judge, spy } = makeMockJudge(() => 1.0);
		const result = await checkToolInterception(
			"eval",
			{ language: "py", code: 'open("package.json").read()' },
			{ availableTools: ["eval"], rules: DEFAULT_TOOL_INTERCEPTOR_RULES, judge },
		);

		expect(result.block).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it("unwraps xd://eval JSON payloads (including hashline-wrapped paths) and skips xd:// help queries", async () => {
		const { judge, spy } = makeMockJudge((_question, request) => {
			const state = request.state as { tool?: string; language?: string; code?: string };
			return state.tool === "eval" && state.language === "py" && state.code?.includes("json.loads") ? 0.95 : 0.1;
		});

		const result = await checkToolInterception(
			"write",
			{
				path: " [xd://eval#1A2B] ",
				content: JSON.stringify({ language: "py", code: 'import json\nprint(json.loads(output("0")))' }),
			},
			{
				availableTools: ALL_DEDICATED_TOOLS,
				toolAliases: ["eval", "write_file"],
				rules: DEFAULT_TOOL_INTERCEPTOR_RULES,
				judge,
			},
		);

		expect(result.block).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);

		const helpQueryResult = await checkToolInterception(
			"write",
			{
				path: "xd://mcp__deploy_service",
				content: "?",
			},
			{
				toolAliases: ["mcp__deploy_service"],
				rules: [
					{
						tools: ["mcp__deploy_*"],
						question: "Does this deploy to production?",
						message: "Blocked deploy.",
					},
				],
				judge,
			},
		);
		expect(helpQueryResult.block).toBe(false);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("ExtensionToolWrapper pre-approval interception across tools", () => {
	it("rejects an intercepted tool call in always-ask mode without prompting the user", async () => {
		const select = vi.fn(async () => "Approve");
		const executeSpy = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "ran" }],
			details: undefined,
		}));
		const { judge, spy: judgeSpy } = makeMockJudge(() => 0.92);

		const settings = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"toolInterceptor.enabled": true,
			"toolInterceptor.rules": DEFAULT_TOOL_INTERCEPTOR_RULES,
			"eval.autoBackground.enabled": false,
		});
		const session = {
			cwd: process.cwd(),
			hasUI: true,
			getSessionFile: () => null,
			settings,
		} as unknown as ToolSession;
		const evalTool = new EvalTool(session, { proxyExecutor: executeSpy });
		const runner = {
			hasHandlers: () => false,
			consumeToolCallEmitted: () => false,
			hasUI: () => true,
			getUIContext: () => ({ select }),
			hasSessionApproval: () => false,
			getJudge: () => judge,
			sessionSettings: settings,
			sessionId: "tool-interceptor-test",
			cwd: process.cwd(),
			runScoped: <T>(fn: () => T): T => fn(),
		} as unknown as ExtensionRunner;
		const wrapper = new ExtensionToolWrapper(evalTool as unknown as Tool, runner);
		const ctx = {
			settings,
			toolNames: ALL_DEDICATED_TOOLS,
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute(
				"call-1",
				{ language: "py", code: 'import subprocess\nsubprocess.run(["go", "doc", "net/http"])' },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("Do not use `eval` to run standalone shell commands; use the `bash` tool directly.");

		expect(judgeSpy).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("intercepts arbitrary non-eval tools when configured in toolInterceptor.rules", async () => {
		const select = vi.fn(async () => "Approve");
		const executeSpy = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "deployed" }],
			details: undefined,
		}));
		const { judge } = makeMockJudge(() => 0.95);
		const rules: ToolInterceptorRule[] = [
			{
				tools: ["mcp__deploy_*"],
				question: "Does this request deploy to production without a change-request ticket?",
				message: "Include a CR ticket ID before calling mcp__deploy_service.",
			},
		];
		const settings = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"toolInterceptor.enabled": true,
			"toolInterceptor.rules": rules,
		});
		const customTool: AgentTool = {
			name: "mcp__deploy_service",
			label: "Deploy",
			description: "Deploy service",
			parameters: {} as never,
			approval: "exec",
			execute: executeSpy,
		};
		const runner = {
			hasHandlers: () => false,
			consumeToolCallEmitted: () => false,
			hasUI: () => true,
			getUIContext: () => ({ select }),
			hasSessionApproval: () => false,
			getJudge: () => judge,
			sessionSettings: settings,
			sessionId: "tool-interceptor-mcp-test",
			cwd: process.cwd(),
			runScoped: <T>(fn: () => T): T => fn(),
		} as unknown as ExtensionRunner;
		const wrapper = new ExtensionToolWrapper(customTool, runner);

		await expect(
			wrapper.execute("call-mcp", { environment: "production" } as never, undefined, undefined, {
				settings,
				toolNames: ["mcp__deploy_service"],
			} as unknown as AgentToolContext),
		).rejects.toThrow("Include a CR ticket ID before calling mcp__deploy_service.");

		expect(select).not.toHaveBeenCalled();
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("skips whenPolicy: 'prompt' rules when a bash call is already allowed by bash.patterns", async () => {
		const select = vi.fn(async () => "Approve");
		const executeSpy = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "clean" }],
			details: undefined,
		}));
		const { judge, spy: judgeSpy } = makeMockJudge(() => 0.95);
		const rules: ToolInterceptorRule[] = [
			{
				tools: ["bash"],
				whenPolicy: "prompt",
				question: "Is this unapproved bash command doing ad-hoc file parsing that belongs in read?",
				message: "Use the read tool instead of unapproved ad-hoc bash parsing.",
			},
		];
		const settings = Settings.isolated({
			"tools.approvalMode": "write",
			"tools.approval": { bash: "prompt" },
			"toolInterceptor.enabled": true,
			"toolInterceptor.rules": rules,
		});
		const bashLikeTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run bash",
			parameters: {} as never,
			approval: (args: unknown) => {
				const cmd = (args as { command?: string } | undefined)?.command ?? "";
				return cmd.startsWith("git status") ? { tier: "write", policy: "allow" } : "exec";
			},
			execute: executeSpy,
		};
		const runner = {
			hasHandlers: () => false,
			consumeToolCallEmitted: () => false,
			hasUI: () => true,
			getUIContext: () => ({ select }),
			hasSessionApproval: () => false,
			getJudge: () => judge,
			sessionSettings: settings,
			sessionId: "tool-interceptor-bash-policy-test",
			cwd: process.cwd(),
			runScoped: <T>(fn: () => T): T => fn(),
		} as unknown as ExtensionRunner;
		const wrapper = new ExtensionToolWrapper(bashLikeTool, runner);
		const ctx = {
			settings,
			toolNames: ALL_DEDICATED_TOOLS,
		} as unknown as AgentToolContext;

		const allowedResult = await wrapper.execute(
			"call-bash-allowed",
			{ command: "git status" } as never,
			undefined,
			undefined,
			ctx,
		);
		expect(allowedResult.content[0]).toEqual({ type: "text", text: "clean" });
		expect(judgeSpy).not.toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();

		await expect(
			wrapper.execute(
				"call-bash-prompting",
				{ command: "python3 -c 'print(1)'" } as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("Use the read tool instead of unapproved ad-hoc bash parsing.");
		expect(judgeSpy).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
	});
});
