import { afterEach, describe, expect, it, vi } from "bun:test";
import { type SettingPath, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createSettingsWithOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		...overrides,
	});
}

function createActiveGoalState() {
	return {
		enabled: true,
		mode: "active" as const,
		goal: {
			id: "goal-1",
			objective: "Ship the release",
			status: "active" as const,
			tokenBudget: 25,
			tokensUsed: 5,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

function createDiscoverySessionHooks(): Partial<ToolSession> {
	const selected: string[] = [];
	return {
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableTools: () => [],
		getSelectedMCPToolNames: () => [...selected],
		activateDiscoveredMCPTools: async toolNames => {
			const activated: string[] = [];
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
					activated.push(name);
				}
			}
			return activated;
		},
	};
}

describe("createTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates all builtin tools by default", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		// Core tools should always be present
		expect(names).toContain("eval");
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("grep");
		expect(names).toContain("glob");
		expect(names).toContain("lsp");
		expect(names).toContain("task");
		expect(names).toContain("todo");
		expect(names).toContain("web_search");
		expect(names).toContain("resolve");
		expect(names).not.toContain("fetch");
		expect(names).not.toContain("vim");
	});

	it("normalizes legacy explicit tool names", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "astGrep.enabled": false }),
		});
		const tools = await createTools(session, ["search", "find", "grep"]);
		const names = tools.map(t => t.name);

		expect(names.filter(name => name === "grep")).toHaveLength(1);
		expect(names).toContain("glob");
		expect(names).toContain("resolve");
		expect(names).not.toContain("search");
		expect(names).not.toContain("find");
	});

	it("includes bash and eval when both eval backends are allowed", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"eval.py": true,
				"eval.js": true,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("eval");
		expect(names).toContain("bash");
	});

	it("still exposes eval when only the js backend is allowed", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"eval.py": false,
				"eval.js": true,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("bash");
		expect(names).toContain("eval");
	});

	it("still exposes eval when python kernel is unavailable (dispatches to js)", async () => {
		const session = createTestSession();
		vi.spyOn(
			await import("@pk-nerdsaver-ai/pi-coding-agent/eval/py/kernel"),
			"checkPythonKernelAvailability",
		).mockResolvedValue({
			ok: false,
			reason: "missing python",
		});
		const tools = await createTools(session, ["eval"]);
		const names = tools.map(t => t.name);

		expect(names).toContain("eval");
		expect(names).toContain("resolve");
	});

	it("excludes lsp tool when session disables LSP", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session, ["read", "lsp", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "resolve"]);
	});

	it("excludes lsp tool when disabled", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("lsp");
	});

	it("respects requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "resolve"]);
	});

	it("lowercases requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["Read", "Write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write", "resolve"]);
	});

	it("includes hidden tools when explicitly requested", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["report_finding"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["report_finding", "resolve"]);
	});

	it("includes yield tool when required", async () => {
		const session = createTestSession({ requireYieldTool: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("yield");
	});

	it("excludes ask tool when hasUI is false", async () => {
		const session = createTestSession({ hasUI: false });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("ask");
	});

	it("includes ask tool when hasUI is true", async () => {
		const session = createTestSession({ hasUI: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("ask");
	});

	it("filters disabled builtin tools by settings", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"glob.enabled": false,
				"grep.enabled": false,
				"astGrep.enabled": false,
				"astEdit.enabled": false,
				"bash.enabled": false,
				"web_search.enabled": false,
				"browser.enabled": false,
				"inspect_image.enabled": false,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("bash");
		expect(names).not.toContain("glob");
		expect(names).not.toContain("grep");
		expect(names).not.toContain("ast_grep");
		expect(names).not.toContain("ast_edit");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("browser");
		expect(names).not.toContain("inspect_image");

		const requestedTools = await createTools(session, ["bash", "read"]);
		expect(requestedTools.map(t => t.name)).toEqual(["read", "resolve"]);
	});

	it("always includes resolve regardless of plan-mode setting", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"plan.enabled": false,
			}),
		});

		const defaultTools = await createTools(session);
		expect(defaultTools.map(t => t.name)).toContain("resolve");
		expect(defaultTools.map(t => t.name)).not.toContain("exit_plan_mode");

		const requestedTools = await createTools(session, ["read"]);
		expect(requestedTools.map(t => t.name)).toEqual(["read", "resolve"]);
	});
	it("auto-includes goal when goal mode is active", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"goal.enabled": true,
			}),
			getGoalModeState: () => createActiveGoalState(),
		});
		const tools = await createTools(session, ["read"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "goal", "resolve"]);
	});

	it("includes search_tool_bm25 when MCP tool discovery is enabled and executable", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"mcp.discoveryMode": true,
			}),
			...createDiscoverySessionHooks(),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("search_tool_bm25");
	});

	it("HIDDEN_TOOLS contains review tools and goal", () => {
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual([
			"goal",
			"report_finding",
			"report_tool_issue",
			"resolve",
			"yield",
		]);
	});
});
