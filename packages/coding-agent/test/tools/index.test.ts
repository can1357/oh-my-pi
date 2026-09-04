import { afterEach, describe, expect, it, vi } from "bun:test";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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

describe("createTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates all builtin tools by default", async () => {
		// xdev mounting (default-on) would unmount discoverables like lsp and
		// web_search into xd://; disable it to assert the full builtin set.
		const session = createTestSession({ settings: createSettingsWithOverrides({ "tools.xdev": false }) });
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
		const tools = await createTools(session, ["search", "find", "grep"]);
		const names = tools.map(t => t.name);

		expect(names.filter(name => name === "grep")).toHaveLength(1);
		expect(names).toContain("glob");
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

		expect(names).toEqual(["read", "write"]);
	});

	it("creates xd:// presentation state without remounting explicitly requested built-ins", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "lsp", "write"]);

		expect(session.xdev).toBeDefined();
		expect(session.xdev?.mountedNames.size).toBe(0);
		expect(tools.map(tool => tool.name)).toEqual(["read", "lsp", "write"]);
	});

	it("grants a device-only xd:// transport write when an explicit list keeps read but omits write", async () => {
		// The xd:// transport rides `write xd://<tool>`; with no write at all the
		// session would allocate no xd:// state and later SDK assembly would
		// expose custom/MCP tools top-level. A device-only write restores
		// mounting while filesystem writes stay rejected (see WriteTool).
		const session = createTestSession();
		const tools = await createTools(session, ["read", "lsp"]);

		expect(session.deviceOnlyWrite).toBe(true);
		expect(session.xdev).toBeDefined();
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
		expect(Reflect.get(yieldTool.parameters, "required")).toEqual(["result"]);

		items = [{ id: "pool#1", index: 1 }];
		expect(Reflect.get(yieldTool.parameters, "required")).toEqual(["key"]);
		const properties = Reflect.get(yieldTool.parameters, "properties");
		expect(properties).toHaveProperty("key");
		expect(properties).not.toHaveProperty("result");
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
		// write joins as the device-only xd:// transport (read granted, ask disabled).
		expect(requested.map(t => t.name)).toEqual(["read", "write"]);
	});

	it("includes ask tool when ask.enabled is true and hasUI is true", async () => {
		const session = createTestSession({
			hasUI: true,
			settings: createSettingsWithOverrides({ "ask.enabled": true }),
		});
		const tools = await createTools(session);
		expect(tools.map(t => t.name)).toContain("ask");
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
		// `write` joins as the device-only xd:// transport: read was granted,
		// write omitted (see the "device-only xd:// transport write" test).
		expect(requestedTools.map(t => t.name)).toEqual(["read", "write"]);
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

		// `write` joins last as the device-only xd:// transport (see above).
		expect(names).toEqual(["read", "goal", "write"]);
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

	it("HIDDEN_TOOLS contains yield, goal, and think", () => {
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual(["goal", "think", "yield"]);
	});
});
