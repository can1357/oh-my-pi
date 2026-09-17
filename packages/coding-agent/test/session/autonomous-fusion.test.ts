import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import type { BeforeToolCallContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockContent } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import {
	DeleteArgsSchema,
	DiagnosticsArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
	WriteArgsSchema,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/cursor-gen/agent_pb";
import { logger, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { CreateAgentSessionOptions } from "../../src/sdk";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { BUILTIN_SLASH_COMMANDS } from "../../src/slash-commands/builtin-registry";
import { buildFusionStatusText, handleFusionCommand } from "../../src/slash-commands/helpers/fusion";
import { TaskTool } from "../../src/task";
import { BashTool, EditTool, EvalTool, WriteTool } from "../../src/tools";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

async function createPolicySession(
	overrides: Record<string, unknown> = {},
	options: Partial<CreateAgentSessionOptions> = {},
) {
	const directory = TempDir.createSync("@omp-autonomous-policy-");
	const authStorage = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory.path(), "models.yml"));
	const model = modelRegistry.getAll()[0];
	if (!model) throw new Error("Missing bundled model");
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const settings = Settings.isolated({
		"fusion.enabled": true,
		"fusion.mode": "autonomous",
		"async.enabled": false,
		"task.batch": false,
		"task.prefetch.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"tools.approvalMode": "yolo",
		"tools.discoveryMode": "off",
		...overrides,
	});
	const created = await createAgentSession({
		cwd: directory.path(),
		agentDir: directory.path(),
		authStorage,
		modelRegistry,
		settings,
		sessionManager: SessionManager.inMemory(directory.path()),
		disableExtensionDiscovery: true,
		skipPythonPreflight: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		model,
		skills: [],
		rules: [],
		preloadedCustomToolPaths: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		...options,
	});
	cleanups.push(async () => {
		await created.session.dispose();
		authStorage.close();
		directory.removeSync();
	});
	return { session: created.session, settings, directory };
}

function makeToolCallContext(name: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		assistantMessage: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "runtime-provider",
			model: "runtime-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
		toolCall: {
			type: "toolCall",
			id: "call-1",
			name,
			arguments: args,
		},
		args,
		context: { messages: [], systemPrompt: [] },
	};
}

describe("Autonomous Fusion Workflow", () => {
	it("sets autonomous mode via /fusion mode autonomous and reflects it in status", async () => {
		const store = new Map<string, unknown>([
			["fusion.enabled", true],
			["fusion.mode", "escalate"],
		]);
		const outputs: string[] = [];
		const settings = {
			get: (key: string) => store.get(key),
			set: (key: string, value: unknown) => {
				store.set(key, value);
			},
		} as unknown as Settings;
		const runtime = {
			settings,
			session: {
				getFusionSidekickId: () => undefined,
				getFusionUsageSplit: () => ({
					total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			},
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as Parameters<typeof handleFusionCommand>[1];

		await handleFusionCommand({ name: "fusion", args: "mode autonomous", text: "/fusion mode autonomous" }, runtime);
		expect(settings.get("fusion.mode")).toBe("autonomous");
		expect(outputs).toContain('fusion.mode set to "autonomous".');

		const statusText = buildFusionStatusText(runtime);
		expect(statusText).toContain("Mode:            autonomous (planning-only root)");
		expect(statusText).toContain("I/O delegation: on");
		expect(statusText).toContain("I/O threshold:");
		expect(statusText).not.toContain("isolated durable workers");
	});

	it("automatically enables fusion when setting a mode from disabled state", async () => {
		const store = new Map<string, unknown>([
			["fusion.enabled", false],
			["fusion.mode", "off"],
		]);
		const outputs: string[] = [];
		const settings = {
			get: (key: string) => store.get(key),
			set: (key: string, value: unknown) => {
				store.set(key, value);
			},
		} as unknown as Settings;
		const runtime = {
			settings,
			session: {
				getFusionSidekickId: () => undefined,
				getFusionUsageSplit: () => ({
					total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			},
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as Parameters<typeof handleFusionCommand>[1];

		await handleFusionCommand(
			{ name: "fusion", args: "mode token-savings", text: "/fusion mode token-savings" },
			runtime,
		);
		expect(settings.get("fusion.mode")).toBe("token-savings");
		expect(settings.get("fusion.enabled")).toBe(true);
		expect(outputs).toContain('fusion.mode set to "token-savings" and Fusion enabled.');
	});

	it("exposes autonomous completion directly in /fusion argument menu", async () => {
		const fusion = BUILTIN_SLASH_COMMANDS.find(c => c.name === "fusion");
		expect(fusion).toBeDefined();
		const items = await fusion?.getArgumentCompletions?.("");
		expect(items).not.toBeNull();
		const labels = items?.map(item => item.label) ?? [];
		expect(labels).toContain("autonomous");
		expect(labels).toContain("token-savings");

		const autonomousItem = items?.find(item => item.label === "autonomous");
		expect(autonomousItem?.value).toBe("mode autonomous ");
		expect(autonomousItem?.description).toContain("planning-only root");
	});

	it("validates fusion.mode setting schema enum accepts autonomous", () => {
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "autonomous",
		});
		expect(settings.get("fusion.mode")).toBe("autonomous");
	});

	it("fails closed at the SDK root hook with bounded diagnostics", async () => {
		const { session } = await createPolicySession();
		const hook = session.agent.beforeToolCall;
		expect(hook).toBeDefined();
		for (const name of [
			"bash",
			"eval",
			"edit",
			"write",
			"ast_edit",
			"memory_edit",
			"retain",
			"rewind",
			"mcp_execute",
			"new_capability",
			"constructor",
			"Read",
		]) {
			const result = await hook?.(makeToolCallContext(name, { command: "SECRET-COMMAND" }));
			expect(result?.block).toBe(true);
			expect(result?.reason).toStartWith("[Autonomous Fusion Mode]");
			expect(result?.reason).toEndWith("Delegate execution through task.");
			expect(result?.reason).not.toContain("SECRET-COMMAND");
		}
		for (const name of [
			"read",
			"search",
			"find",
			"grep",
			"glob",
			"ast_grep",
			"web_search",
			"inspect_image",
			"recall",
			"reflect",
			"ask",
			"task",
			"todo",
			"irc",
			"job",
			"yield",
			"report_finding",
			"report_tool_issue",
			"search_tool_bm25",
		]) {
			expect(await hook?.(makeToolCallContext(name, {}))).toBeUndefined();
		}
		expect(await hook?.(makeToolCallContext("resolve", { action: "discard" }))).toBeUndefined();
		expect((await hook?.(makeToolCallContext("resolve", { action: "apply" })))?.block).toBe(true);
	});

	it("executes native task/read but never invokes denied implementations in an SDK model loop", async () => {
		const unknownExecute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "unexpected execution" }],
		}));
		// SDK output wrappers capture execute during construction; spy before that capture.
		const bash = vi.spyOn(BashTool.prototype, "execute");
		const edit = vi.spyOn(EditTool.prototype, "execute");
		const write = vi.spyOn(WriteTool.prototype, "execute");
		const evaluate = vi.spyOn(EvalTool.prototype, "execute");
		const task = vi.spyOn(TaskTool.prototype, "execute");
		const { session, directory } = await createPolicySession(
			{},
			{
				toolNames: ["read", "task", "bash", "eval", "edit", "write", "new_capability"],
				customTools: [
					{
						name: "new_capability",
						label: "Unknown",
						description: "Unclassified execution",
						parameters: type({}),
						execute: unknownExecute,
					},
				],
			},
		);
		await Bun.write(path.join(directory.path(), "fixture.txt"), "REAL-READ-SENTINEL\n");
		const calls = [
			["read", { path: "fixture.txt" }],
			[
				"task",
				{ agent: "DefinitelyMissingAgent", assignment: "Inspect the fixture; report verified findings only." },
			],
			["bash", { command: "git reset --hard" }],
			["bash", { command: "mv fixture.txt moved.txt" }],
			["bash", { command: "git status" }],
			["eval", { language: "js", code: "await Bun.write('escape.txt', 'bad')" }],
			["edit", { input: "ignored because execution must be blocked" }],
			["write", { path: "escape.txt", content: "bad" }],
			["new_capability", {}],
		] as const;
		const scripted = createMockModel({
			responses: [
				{
					content: calls.map(
						([name, args], index): MockContent => ({
							type: "toolCall",
							id: `call-${index}`,
							name,
							arguments: args,
						}),
					),
				},
				{ content: ["Finished capability checks."] },
			],
		});
		session.agent.streamFn = scripted.stream;
		await session.agent.prompt("Execute the capability checks.");
		const results = session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(calls.length);
		expect(JSON.stringify(results.find(result => result.toolCallId === "call-0"))).toContain("REAL-READ-SENTINEL");
		expect(task).toHaveBeenCalledTimes(1);
		for (const result of results.filter(result => result.toolName !== "read" && result.toolName !== "task")) {
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain("[Autonomous Fusion Mode]");
		}
		for (const spy of [bash, edit, write, evaluate, unknownExecute]) expect(spy).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(directory.path(), "escape.txt")).exists()).toBe(false);
	});
	it.each(["autonomous", "token-savings"])(
		"fences Cursor provider callbacks with live root policy (initial=%s)",
		async initialMode => {
			const bash = vi.spyOn(BashTool.prototype, "execute");
			const write = vi.spyOn(WriteTool.prototype, "execute");
			const edit = vi.spyOn(EditTool.prototype, "execute");
			const evaluate = vi.spyOn(EvalTool.prototype, "execute");
			const task = vi.spyOn(TaskTool.prototype, "execute");
			const unknownExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unclassified ran" }] }));
			const { session, settings, directory } = await createPolicySession(
				{ "fusion.mode": initialMode },
				{
					toolNames: ["read", "task", "bash", "write", "edit", "eval", "new_capability", "mcp__unsafe"],
					customTools: ["new_capability", "mcp__unsafe"].map(name => ({
						name,
						label: name,
						description: "Unclassified test capability",
						parameters: type({}),
						execute: unknownExecute,
					})),
				},
			);
			const fixture = path.join(directory.path(), "cursor-fixture.txt");
			await Bun.write(fixture, "CURSOR-READ-SENTINEL\n");
			const results = new Map<string, unknown>();
			const onStdout = vi.fn();
			const onStderr = vi.fn();
			const scripted = createMockModel({
				handler: async (_context, options) => {
					const bridge = options?.cursorExecHandlers;
					if (
						!bridge?.read ||
						!bridge.write ||
						!bridge.delete ||
						!bridge.shell ||
						!bridge.shellStream ||
						!bridge.mcp ||
						!bridge.diagnostics
					) {
						throw new Error("SDK Cursor execution handlers unavailable");
					}
					// Retain the exact provider callback object while the mode changes.
					settings.override("fusion.mode", "autonomous");
					results.set(
						"read",
						await bridge.read(create(ReadArgsSchema, { path: fixture, toolCallId: "cursor-read" })),
					);
					results.set(
						"task",
						await bridge.mcp({
							name: "task",
							toolName: "task",
							providerIdentifier: "test",
							toolCallId: "cursor-task",
							rawArgs: {},
							args: {
								agent: "DefinitelyMissingAgent",
								assignment: "Inspect the fixture and cite verified findings only.",
							},
						}),
					);
					results.set(
						"write",
						await bridge.write(
							create(WriteArgsSchema, {
								path: "cursor-escape.txt",
								fileText: "PRIVATE-SOURCE",
								toolCallId: "cursor-write",
							}),
						),
					);
					results.set(
						"delete",
						await bridge.delete(create(DeleteArgsSchema, { path: fixture, toolCallId: "cursor-delete" })),
					);
					const shell = create(ShellArgsSchema, {
						command: "echo PRIVATE-COMMAND",
						workingDirectory: directory.path(),
						toolCallId: "cursor-shell",
					});
					results.set("shell", await bridge.shell(shell));
					results.set("shellStream", await bridge.shellStream(shell, { onStdout, onStderr }));
					results.set(
						"diagnostics",
						await bridge.diagnostics(
							create(DiagnosticsArgsSchema, { path: fixture, toolCallId: "cursor-diagnostics" }),
						),
					);
					for (const name of [
						"new_capability",
						"mcp__unsafe",
						"newly_discovered",
						"write",
						"edit",
						"eval",
						"resolve",
					]) {
						results.set(
							`mcp:${name}`,
							await bridge.mcp({
								name,
								toolName: name,
								providerIdentifier: "test",
								toolCallId: `cursor-${name}`,
								args: {},
								rawArgs: { action: new TextEncoder().encode(JSON.stringify("apply")) },
							}),
						);
					}
					return { content: ["Cursor capability checks complete."] };
				},
			});
			session.agent.streamFn = scripted.stream;
			await session.agent.prompt("Run scripted Cursor provider callbacks.");
			expect(results.size).toBe(14);
			expect(results.get("read")).toMatchObject({ role: "toolResult", isError: false });
			expect(JSON.stringify(results.get("read"))).toContain("CURSOR-READ-SENTINEL");
			expect(task).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(results.get("task"))).not.toContain("[Autonomous Fusion Mode]");
			for (const [name, result] of results) {
				if (name === "read" || name === "task") continue;
				expect(result).toMatchObject({
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("[Autonomous Fusion Mode]") }],
				});
				expect(JSON.stringify(result)).not.toContain("PRIVATE-SOURCE");
				expect(JSON.stringify(result)).not.toContain("PRIVATE-COMMAND");
			}
			for (const spy of [bash, write, edit, evaluate, unknownExecute, onStdout, onStderr])
				expect(spy).not.toHaveBeenCalled();
			expect(await Bun.file(fixture).text()).toBe("CURSOR-READ-SENTINEL\n");
			expect(await Bun.file(path.join(directory.path(), "cursor-escape.txt")).exists()).toBe(false);
		},
	);

	it.each([
		{ enabled: false, mode: "autonomous", child: false },
		{ enabled: true, mode: "token-savings", child: false },
		{ enabled: true, mode: "autonomous", child: true },
	])("preserves Cursor execution outside the autonomous root (%j)", async ({ enabled, mode, child }) => {
		const unknownExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "allowed unknown" }] }));
		const { session, settings, directory } = await createPolicySession(
			{ "fusion.enabled": enabled, "fusion.mode": mode },
			{
				...(child ? { taskDepth: 1, agentId: "CursorPolicyChild" } : {}),
				toolNames: ["read", "write", "bash", "new_capability"],
				customTools: [
					{
						name: "new_capability",
						label: "Unknown",
						description: "Unclassified test capability",
						parameters: type({}),
						execute: unknownExecute,
					},
				],
			},
		);
		const results = new Map<string, unknown>();
		const onStdout = vi.fn();
		const scripted = createMockModel({
			handler: async (_context, options) => {
				const bridge = options?.cursorExecHandlers;
				if (!bridge?.write || !bridge.delete || !bridge.shell || !bridge.shellStream || !bridge.mcp)
					throw new Error("SDK Cursor execution handlers unavailable");
				// A handler first used while denied must also honor the switch back to savings.
				if (enabled && !child) {
					settings.override("fusion.mode", "autonomous");
					results.set(
						"blocked",
						await bridge.write(create(WriteArgsSchema, { path: "denied.txt", fileText: "denied" })),
					);
					settings.override("fusion.mode", mode);
				}
				results.set(
					"write",
					await bridge.write(create(WriteArgsSchema, { path: "allowed-cursor.txt", fileText: "allowed" })),
				);
				await Bun.write(path.join(directory.path(), "delete-cursor.txt"), "delete fixture");
				results.set("delete", await bridge.delete(create(DeleteArgsSchema, { path: "delete-cursor.txt" })));
				const shell = create(ShellArgsSchema, {
					command: "echo CURSOR-SHELL-ALLOWED",
					workingDirectory: directory.path(),
				});
				results.set("shell", await bridge.shell(shell));
				results.set("shellStream", await bridge.shellStream(shell, { onStdout, onStderr: () => {} }));
				results.set(
					"unknown",
					await bridge.mcp({
						name: "new_capability",
						toolName: "new_capability",
						providerIdentifier: "test",
						toolCallId: "cursor-unknown",
						args: {},
						rawArgs: {},
					}),
				);
				return { content: ["Cursor compatibility checks complete."] };
			},
		});
		session.agent.streamFn = scripted.stream;
		await session.agent.prompt("Run scripted Cursor compatibility callbacks.");
		expect(results.size).toBe(enabled && !child ? 6 : 5);
		for (const name of ["write", "delete", "shell", "shellStream", "unknown"])
			expect(results.get(name)).toMatchObject({ role: "toolResult", isError: false });
		if (results.has("blocked")) expect(results.get("blocked")).toMatchObject({ isError: true });
		expect(await Bun.file(path.join(directory.path(), "allowed-cursor.txt")).text()).toBe("allowed");
		expect(await Bun.file(path.join(directory.path(), "delete-cursor.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(directory.path(), "denied.txt")).exists()).toBe(false);
		expect(unknownExecute).toHaveBeenCalledTimes(1);
		expect(onStdout.mock.calls.map(([text]) => text).join("")).toContain("CURSOR-SHELL-ALLOWED");
	});

	it.each([
		{ "fusion.enabled": false, "fusion.mode": "autonomous" },
		{ "fusion.enabled": true, "fusion.mode": "token-savings" },
	])("retains native write execution outside autonomous mode (%j)", async overrides => {
		const { session, directory } = await createPolicySession(overrides);
		const writer = session.getToolByName("write");
		expect(writer).toBeDefined();
		await writer?.execute("allowed-write", { path: "allowed.txt", content: "allowed" });
		expect(await Bun.file(path.join(directory.path(), "allowed.txt")).text()).toBe("allowed");
		expect(await session.agent.beforeToolCall?.(makeToolCallContext("eval", {}))).toBeUndefined();
	});

	it("fences handles acquired before mode changes and xd execution", async () => {
		const write = vi.spyOn(WriteTool.prototype, "execute");
		const { session, settings, directory } = await createPolicySession({ "fusion.mode": "token-savings" });
		const writer = session.getToolByName("write");
		if (!writer) throw new Error("Missing write tool");
		settings.override("fusion.mode", "autonomous");
		await expect(writer.execute("old-handle", { path: "escape.txt", content: "bad" })).rejects.toThrow(
			"[Autonomous Fusion Mode]",
		);
		await expect(session.executeXdevTool("write", { path: "escape.txt", content: "bad" })).rejects.toThrow(
			"[Autonomous Fusion Mode]",
		);
		expect(() => session.assertEvalExecutionAllowed()).toThrow("[Autonomous Fusion Mode]");
		expect(write).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(directory.path(), "escape.txt")).exists()).toBe(false);
	});

	it("blocks nested tool.write in an already-running eval when the root becomes autonomous", async () => {
		const write = vi.spyOn(WriteTool.prototype, "execute");
		let activeSettings: Settings | undefined;
		const { session, settings, directory } = await createPolicySession(
			{ "fusion.mode": "token-savings" },
			{
				toolNames: ["eval", "write", "arm_autonomous"],
				customTools: [
					{
						name: "arm_autonomous",
						label: "Arm policy",
						description: "Test mode transition",
						parameters: type({}),
						execute: async () => {
							if (!activeSettings) throw new Error("Missing test settings");
							activeSettings.override("fusion.mode", "autonomous");
							return { content: [{ type: "text" as const, text: "armed" }] };
						},
					},
				],
			},
		);
		activeSettings = settings;
		const evaluate = session.getToolByName("eval");
		if (!evaluate) throw new Error("Missing eval tool");
		const result = await evaluate.execute("nested", {
			language: "js",
			code: 'await tool.arm_autonomous({}); await tool.write({path: "escape.txt", content: "bad"});',
		});
		expect(settings.get("fusion.mode")).toBe("autonomous");
		expect(JSON.stringify(result.content)).toContain("[Autonomous Fusion Mode]");
		expect(write).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(directory.path(), "escape.txt")).exists()).toBe(false);
	});

	it("does not impose the root allowlist on child SDK sessions", async () => {
		const { session, directory } = await createPolicySession({}, { taskDepth: 1, agentId: "PolicyChild" });
		expect(await session.agent.beforeToolCall?.(makeToolCallContext("write", {}))).toBeUndefined();
		await session.getToolByName("write")?.execute("child-write", { path: "child.txt", content: "child" });
		expect(await Bun.file(path.join(directory.path(), "child.txt")).text()).toBe("child");
		expect(session.systemPrompt.join("\n")).not.toContain("<fusion-autonomous>");
	});

	it("warns once per session for invalid thresholds and reports the effective value", async () => {
		const original = Bun.env.SHUNT_MIN_LINES;
		const warnings = vi.spyOn(logger, "warn");
		try {
			Bun.env.SHUNT_MIN_LINES = "not-an-integer";
			const { session, settings } = await createPolicySession({ "fusion.ioDelegation.minLines": -2 });
			for (let call = 0; call < 3; call++) expect(session.getFusionIoMinLines()).toBe(350);
			expect(warnings.mock.calls.filter(([message]) => String(message).startsWith("[Fusion I/O]"))).toHaveLength(1);
			expect(session.systemPrompt.join("\n")).toContain("beyond 350 lines");
			settings.override("fusion.ioDelegation.minLines", 125);
			expect(session.getFusionIoMinLines()).toBe(125);
			expect(warnings.mock.calls.filter(([message]) => String(message).startsWith("[Fusion I/O]"))).toHaveLength(1);
		} finally {
			if (original === undefined) delete Bun.env.SHUNT_MIN_LINES;
			else Bun.env.SHUNT_MIN_LINES = original;
		}
	});

	it("captures the valid environment override at the SDK boundary", async () => {
		const original = Bun.env.SHUNT_MIN_LINES;
		try {
			Bun.env.SHUNT_MIN_LINES = "99";
			const { session } = await createPolicySession({ "fusion.ioDelegation.minLines": 125 });
			Bun.env.SHUNT_MIN_LINES = "180";
			expect(session.getFusionIoMinLines()).toBe(99);
			expect(session.systemPrompt.join("\n")).toContain("beyond 99 lines");
		} finally {
			if (original === undefined) delete Bun.env.SHUNT_MIN_LINES;
			else Bun.env.SHUNT_MIN_LINES = original;
		}
	});
});
