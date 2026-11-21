import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { toolCommandNames } from "@oh-my-pi/pi-coding-agent/exec/tool-command-host";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "dev.autoqa": false }),
		...overrides,
	};
}

function createSettingsWithOverrides(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"dev.autoqa": false,
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

describe("createTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates all builtin tools by default", async () => {
		// tool-command mounting (default-on) would unmount discoverables like lsp and
		// web_search into bash commands; disable it to assert the full builtin set.
		const session = createTestSession({ settings: createSettingsWithOverrides({ "tools.commands": false }) });
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
		expect(names).not.toContain("fetch");
		expect(names).not.toContain("vim");
	});

	it("normalizes legacy explicit tool names", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({ "astGrep.enabled": false }),
		});
		const tools = await createTools(session, ["search", "glob", "grep"]);
		const names = tools.map(t => t.name);

		expect(names.filter(name => name === "grep")).toHaveLength(1);
		expect(names).toContain("glob");
		expect(names).not.toContain("search");
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
			await import("@oh-my-pi/pi-coding-agent/eval/py/kernel"),
			"checkPythonKernelAvailability",
		).mockResolvedValue({
			ok: false,
			reason: "missing python",
		});
		const tools = await createTools(session, ["eval"]);
		const names = tools.map(t => t.name);

		expect(names).toContain("eval");
	});

	it("excludes lsp tool when session disables LSP", async () => {
		const session = createTestSession({ enableLsp: false });
		const tools = await createTools(session, ["read", "lsp", "write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write"]);
	});

	it("keeps an explicit tool list top-level when it omits bash", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "lsp", "write"]);

		expect(session.toolCommands).toBeUndefined();
		expect(tools.map(tool => tool.name)).toEqual(["read", "lsp", "write"]);
	});

	it("lowercases requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["Read", "Write"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["read", "write"]);
	});

	it("includes hidden tools when explicitly requested", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["yield"]);
		const names = tools.map(t => t.name);

		expect(names).toEqual(["yield"]);
	});

	it("includes yield tool when required", async () => {
		const session = createTestSession({ requireYieldTool: true });
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).toContain("yield");
	});

	it("updates an already-created yield tool to the active workpool key schema", async () => {
		let items: Array<{ id: string; index: number }> = [];
		const session = createTestSession({
			requireYieldTool: true,
			getWorkPoolYieldItems: () => items,
		});
		const tools = await createTools(session);
		const yieldTool = tools.find(tool => tool.name === "yield");
		if (!yieldTool) throw new Error("Missing yield tool");
		expect(Reflect.get(yieldTool.parameters, "properties")).toHaveProperty("type");
		expect(Reflect.get(yieldTool.parameters, "properties")).not.toHaveProperty("key");

		items = [{ id: "pool#1", index: 1 }];
		expect(Reflect.get(yieldTool.parameters, "required")).toEqual(["key"]);
		const properties = Reflect.get(yieldTool.parameters, "properties");
		expect(properties).toHaveProperty("key");
		expect(properties).not.toHaveProperty("type");
	});
	it("excludes todo from yield sessions unless prewalk is armed", async () => {
		// Subagents (requireYieldTool) never get todo — except when the spawn is
		// prewalk-armed: the prewalk plan nudge + todo gate need the child to
		// commit its own todo list before the model hand-off.
		const subagent = await createTools(createTestSession({ requireYieldTool: true }));
		expect(subagent.map(t => t.name)).not.toContain("todo");

		const prewalkSubagent = await createTools(createTestSession({ requireYieldTool: true, prewalkArmed: true }));
		expect(prewalkSubagent.map(t => t.name)).toContain("todo");
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

	it("excludes ask tool when ask.enabled is false", async () => {
		const session = createTestSession({
			hasUI: true,
			settings: createSettingsWithOverrides({ "ask.enabled": false }),
		});
		const tools = await createTools(session);
		expect(tools.map(t => t.name)).not.toContain("ask");

		const requested = await createTools(
			createTestSession({
				hasUI: true,
				settings: createSettingsWithOverrides({ "ask.enabled": false }),
			}),
			["ask", "read"],
		);
		expect(requested.map(t => t.name)).toEqual(["read"]);
	});

	it("filters disabled builtin tools by settings", async () => {
		const session = createTestSession({
			settings: createSettingsWithOverrides({
				"glob.enabled": false,
				"grep.enabled": false,
				"astGrep.enabled": false,
				"astEdit.enabled": false,
				"bash.enabled": false,
				"launch.enabled": false,
				"web_search.enabled": false,
				"browser.enabled": false,
			}),
		});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);

		expect(names).not.toContain("bash");
		expect(names).not.toContain("launch");
		expect(names).not.toContain("glob");
		expect(names).not.toContain("grep");
		expect(names).not.toContain("ast_grep");
		expect(names).not.toContain("ast_edit");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("browser");

		const requestedTools = await createTools(createTestSession({ settings: session.settings }), ["bash", "read"]);
		expect(requestedTools.map(t => t.name)).toEqual(["read"]);
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

		expect(names).toEqual(["read", "goal"]);
	});

	it("presents report_issue top-level when Auto-QA is on and bash is not requested", async () => {
		const session = createTestSession({ settings: Settings.isolated({ "dev.autoqa": true }) });
		const tools = await createTools(session, ["read"]);

		expect(tools.map(tool => tool.name)).toEqual(["read", "report_issue"]);
		expect(session.toolCommands).toBeUndefined();
	});

	it("runs report_issue as a command when Auto-QA is on and bash is active", async () => {
		const session = createTestSession({ settings: Settings.isolated({ "dev.autoqa": true }) });
		const tools = await createTools(session, ["bash", "read"]);

		expect(tools.map(tool => tool.name)).not.toContain("report_issue");
		expect(toolCommandNames(session)).toContain("report_issue");
	});

	it("does not widen a restricted explicit tool list for an active goal", async () => {
		const session = createTestSession({
			restrictToolNames: true,
			settings: createSettingsWithOverrides({
				"goal.enabled": true,
			}),
			getGoalModeState: () => createActiveGoalState(),
		});

		const tools = await createTools(session, ["read", "write"]);

		expect(tools.map(tool => tool.name)).toEqual(["read", "write"]);
	});

	it("records active tools on the original session object", async () => {
		const session = createTestSession();

		await createTools(session, ["bash"]);

		expect(session.isToolActive?.("bash")).toBe(true);
		expect(session.isToolActive?.("read")).toBe(false);
	});

	it("allows checkpoint/rewind in subagent when explicitly requested and enabled", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["checkpoint", "rewind"],
			)
		).map(t => t.name);
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("grants wait to subagents when explicitly requested", async () => {
		const settings = createSettingsWithOverrides({ "async.enabled": true });
		const main = (await createTools(createTestSession({ settings }), ["read", "wait"])).map(t => t.name);
		const sub = (await createTools(createTestSession({ taskDepth: 1, settings }), ["read", "wait"])).map(t => t.name);
		expect(main).toContain("wait");
		expect(sub).toContain("wait");
	});

	it("excludes checkpoint/rewind from subagent when not explicitly requested", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
			)
		).map(t => t.name);
		expect(names).not.toContain("checkpoint");
		expect(names).not.toContain("rewind");
	});

	it("excludes checkpoint/rewind from subagent when disabled even if explicitly requested", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": false }),
				}),
				["checkpoint", "rewind"],
			)
		).map(t => t.name);
		expect(names).not.toContain("checkpoint");
		expect(names).not.toContain("rewind");
	});

	it("allows checkpoint/rewind at top level when enabled and explicitly requested", async () => {
		const names = (
			await createTools(
				createTestSession({
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["checkpoint", "rewind"],
			)
		).map(t => t.name);
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("auto-includes rewind when only checkpoint is in the explicit list", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["checkpoint"],
			)
		).map(t => t.name);
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("auto-includes checkpoint when only rewind is in the explicit list", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["rewind"],
			)
		).map(t => t.name);
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("does not auto-include checkpoint/rewind when neither is requested", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["read"],
			)
		).map(t => t.name);
		expect(names).not.toContain("checkpoint");
		expect(names).not.toContain("rewind");
	});

	it("auto-pairs checkpoint/rewind in a restricted subagent with one-sided list", async () => {
		const names = (
			await createTools(
				createTestSession({
					taskDepth: 1,
					restrictToolNames: true,
					settings: createSettingsWithOverrides({ "checkpoint.enabled": true }),
				}),
				["checkpoint"],
			)
		).map(t => t.name);
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});
});
