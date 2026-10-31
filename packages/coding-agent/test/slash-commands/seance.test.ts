import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import * as seanceResolver from "@oh-my-pi/pi-coding-agent/task/seance";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const command = BUILTIN_LIFECYCLE_SLASH_COMMANDS.find(candidate => candidate.name === "seance");

async function runSeanceCommand(ctx: InteractiveModeContext, args: string): Promise<void> {
	if (!command?.handleTui) throw new Error("/seance TUI handler is not registered");
	await command.handleTui({ name: "seance", args, text: `/seance ${args}` }, { ctx });
}

function sourceSession(path: string): SessionInfo {
	return {
		path,
		id: "source-session",
		cwd: "/repo",
		created: new Date(1),
		modified: new Date(2),
		messageCount: 1,
		size: 16,
		firstMessage: "Continue the previous investigation",
		allMessagesText: "Continue the previous investigation",
	};
}

async function registerTaskTool(ctx: InteractiveModeContext, execute: AgentTool["execute"]): Promise<void> {
	const tool = await TaskTool.create({
		cwd: ctx.sessionManager.getCwd(),
		hasUI: true,
		settings: ctx.settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession);
	vi.spyOn(tool, "execute").mockImplementation(execute);
	ctx.session.agent.state.tools = [tool as unknown as AgentTool];
}

function taskResult(details: Partial<TaskToolDetails>, text = ""): AgentToolResult<TaskToolDetails> {
	return {
		content: text ? [{ type: "text", text }] : [],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			...details,
		} as TaskToolDetails,
	};
}

async function hostSeanceFixture(root: string, settingsOverrides: Record<string, unknown> = {}) {
	const model = createMockModel({ id: "operator-unapproved-seance-model" });
	const modelSelector = `mock/${model.id}`;
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "credentialed-but-not-approved");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue([model]);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : undefined,
	);
	const sourceFile = path.join(root, "source.jsonl");
	await Bun.write(
		sourceFile,
		`${[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp: "2026-10-01T00:00:00.000Z",
				cwd: root,
			},
			{
				type: "model_change",
				id: "saved-model",
				parentId: null,
				timestamp: "2026-10-01T00:00:01.000Z",
				model: modelSelector,
				role: "default",
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.perCallModel": "off",
		modelRoles: { review: "mock/another-model" },
		...settingsOverrides,
	});
	const tool = await TaskTool.create({
		cwd: root,
		hasUI: true,
		settings,
		authStorage,
		modelRegistry,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession);
	const ctx = createInteractiveModeContext({
		settings,
		sessionManager: { getCwd: () => root },
		session: { modelRegistry, model },
	});
	ctx.session.agent.state.tools = [tool as unknown as AgentTool];
	const completed = Promise.withResolvers<void>();
	ctx.showStatus = vi.fn(() => completed.resolve());
	ctx.showError = vi.fn(() => completed.resolve());
	const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
		index: options.index,
		id: options.id ?? "HostSeance",
		agent: "seance",
		agentSource: "bundled",
		task: options.task,
		exitCode: 0,
		output: "Historical consultation completed.",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		resolvedModel: modelSelector,
	}));
	return {
		ctx,
		tool,
		run,
		authStorage,
		modelRegistry,
		model,
		modelSelector,
		sourceFile,
		completed: completed.promise,
	};
}

beforeEach(() => {
	const seanceAgent = getBundledAgent("seance");
	if (!seanceAgent) throw new Error("Expected the bundled seance agent");
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [seanceAgent], projectAgentsDir: null });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/seance", () => {
	it("opens the model picker directly for a picked session with no saved model", async () => {
		const picked = sourceSession("/elsewhere/.omp/sessions/no-model.jsonl");
		const resolve = vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: picked.path,
			id: picked.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		let onSelected: ((session: SessionInfo) => Promise<void> | void) | undefined;
		ctx.showSessionSelector = vi.fn((_title, onSelect) => {
			onSelected = onSelect as (session: SessionInfo) => Promise<void>;
		}) as InteractiveModeContext["showSessionSelector"];
		ctx.showHookSelector = vi.fn();
		ctx.showModelSelector = vi.fn();

		await runSeanceCommand(ctx, "");
		await onSelected?.(picked);

		expect(resolve).toHaveBeenCalledWith(picked.path, expect.objectContaining({ includeGlobal: true }));
		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		expect(ctx.showModelSelector).toHaveBeenCalledWith(expect.objectContaining({ selectOnly: expect.anything() }));
	});
	it("offers the saved model when the picked session recorded one", async () => {
		const picked = sourceSession("/repo/.omp/sessions/with-model.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: picked.path,
			id: picked.id,
			modelSelectors: ["openai/saved-model"],
		});
		const ctx = createInteractiveModeContext();
		let onSelected: ((session: SessionInfo) => Promise<void> | void) | undefined;
		ctx.showSessionSelector = vi.fn((_title, onSelect) => {
			onSelected = onSelect as (session: SessionInfo) => Promise<void>;
		}) as InteractiveModeContext["showSessionSelector"];
		ctx.showHookSelector = vi.fn(async () => undefined);
		ctx.showModelSelector = vi.fn();

		await runSeanceCommand(ctx, "");
		await onSelected?.(picked);

		expect(ctx.showHookSelector).toHaveBeenCalled();
		expect(ctx.showModelSelector).not.toHaveBeenCalled();
	});
	it("bypasses model pickers for an override and reports completed IDs with the actual model", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/old.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const execute = vi.fn(
			async (
				_callId: string,
				_params: TaskParams,
				_signal?: AbortSignal,
				onUpdate?: (partial: AgentToolResult<TaskToolDetails>) => void,
			) => {
				onUpdate?.(
					taskResult({
						progress: [{ id: "progress-id", resolvedModel: "openai/actual-model" } as never],
					}),
				);
				return taskResult({
					results: [{ id: "fast-result-id", exitCode: 0, resolvedModel: "openai/actual-model" } as never],
				});
			},
		);
		await registerTaskTool(ctx, execute as AgentTool["execute"]);
		ctx.showSessionSelector = vi.fn();
		ctx.showHookSelector = vi.fn();
		ctx.showModelSelector = vi.fn();

		await runSeanceCommand(ctx, `${resolved.path} --model openai/requested-model`);

		expect(ctx.showSessionSelector).not.toHaveBeenCalled();
		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		expect(ctx.showModelSelector).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("fast-result-id"));
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("progress-id"));
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("openai/actual-model"));
	});
	it("surfaces live async progress IDs and resolved model", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/async.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const snapshot = taskResult({
			async: { state: "running", jobId: "seance-job", type: "task" },
			progress: [{ id: "live-seance-id", resolvedModel: "anthropic/actual-model" } as never],
		});
		const execute = vi.fn(
			async (
				_callId: string,
				_params: TaskParams,
				_signal?: AbortSignal,
				onUpdate?: (partial: AgentToolResult<TaskToolDetails>) => void,
			) => {
				onUpdate?.(snapshot);
				return snapshot;
			},
		);
		await registerTaskTool(ctx, execute as AgentTool["execute"]);

		await runSeanceCommand(ctx, `${resolved.path} --model openai/requested-model`);

		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Seance running"));
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("live-seance-id"));
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("anthropic/actual-model"));
	});
	it("keeps the latest defined streamed model when the settled result omits one", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/streamed-model.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const execute = vi.fn(
			async (
				_callId: string,
				_params: TaskParams,
				_signal?: AbortSignal,
				onUpdate?: (partial: AgentToolResult<TaskToolDetails>) => void,
			) => {
				onUpdate?.(
					taskResult({
						progress: [{ id: "streamed-id", resolvedModel: "anthropic/primary-model" } as never],
					}),
				);
				onUpdate?.(
					taskResult({
						progress: [{ id: "streamed-id", resolvedModel: "openai/latest-streamed-model" } as never],
					}),
				);
				onUpdate?.(taskResult({ progress: [{ id: "streamed-id" } as never] }));
				return taskResult({ results: [{ id: "settled-id", exitCode: 0 } as never] });
			},
		);
		await registerTaskTool(ctx, execute as AgentTool["execute"]);

		await runSeanceCommand(ctx, `${resolved.path} --model openai/requested-model`);

		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("openai/latest-streamed-model"));
		expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("anthropic/primary-model"));
	});

	it("prefers the settled fallback model over the streamed primary model", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/fallback-model.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const execute = vi.fn(
			async (
				_callId: string,
				_params: TaskParams,
				_signal?: AbortSignal,
				onUpdate?: (partial: AgentToolResult<TaskToolDetails>) => void,
			) => {
				onUpdate?.(
					taskResult({
						progress: [{ id: "fallback-id", resolvedModel: "anthropic/primary-model" } as never],
					}),
				);
				return taskResult({
					results: [
						{
							id: "fallback-id",
							exitCode: 0,
							resolvedModel: "openai/settled-fallback",
							resolvedModelIsFallback: true,
						} as never,
					],
				});
			},
		);
		await registerTaskTool(ctx, execute as AgentTool["execute"]);

		await runSeanceCommand(ctx, `${resolved.path} --model openai/requested-model`);

		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("openai/settled-fallback"));
		expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("anthropic/primary-model"));
	});

	it("reports zero-exit aborted results as failures with their abort reason", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/aborted.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const abortReason = "Consultation stopped because the source is unavailable";
		const abortedResult: SingleResult = {
			index: 0,
			id: "aborted-id",
			agent: "seance",
			agentSource: "bundled",
			task: "Historical consultation",
			exitCode: 0,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 1,
			aborted: true,
			abortReason,
		};
		const renderedResult = formatTaskResultSummary(abortedResult, { totalDurationMs: 0 });
		await registerTaskTool(
			ctx,
			vi.fn(async () => taskResult({ results: [abortedResult] }, renderedResult)) as AgentTool["execute"],
		);

		await runSeanceCommand(ctx, `${resolved.path} --model openai/requested-model`);

		expect(ctx.showError).toHaveBeenCalledWith(sanitizeErrorLine(abortReason));
		expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Seance completed"));
	});

	it("shows real preflight content and sanitizes thrown executor errors", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/failure.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		ctx.showHookSelector = vi.fn(async () => "Use saved model");
		const preflight = "Source session is missing\n\u001b[31m";
		await registerTaskTool(ctx, vi.fn(async () => taskResult({}, preflight)) as AgentTool["execute"]);
		await runSeanceCommand(ctx, `${resolved.path} --model openai/model`);
		expect(ctx.showError).toHaveBeenCalledWith(sanitizeErrorLine(preflight));

		const thrown = new Error("Session fork failed\n\u001b[31m");
		await registerTaskTool(
			ctx,
			vi.fn(async () => {
				throw thrown;
			}) as AgentTool["execute"],
		);
		await runSeanceCommand(ctx, `${resolved.path} --model openai/model`);
		expect(ctx.showError).toHaveBeenCalledWith(sanitizeErrorLine(thrown));
	});
});

describe("/seance host model selection", () => {
	it("runs --model with unapproved credentials while task.perCallModel is off", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-explicit-");
		const fixture = await hostSeanceFixture(tempDir.path());
		fixture.ctx.showHookSelector = vi.fn();
		fixture.ctx.showModelSelector = vi.fn();
		try {
			expect(fixture.modelRegistry.hasConfiguredAuth(fixture.model)).toBe(true);
			await runSeanceCommand(fixture.ctx, `${fixture.sourceFile} --model ${fixture.modelSelector}`);
			await fixture.completed;
			expect(fixture.ctx.showError).not.toHaveBeenCalled();
			expect(fixture.ctx.showHookSelector).not.toHaveBeenCalled();
			expect(fixture.ctx.showModelSelector).not.toHaveBeenCalled();
			expect(fixture.run).toHaveBeenCalledTimes(1);
			expect(fixture.run.mock.calls[0]?.[0].modelOverride).toEqual([fixture.modelSelector]);
			expect(fixture.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(fixture.modelSelector));
		} finally {
			fixture.authStorage.close();
		}
	});

	it("runs an unapproved saved model from the session picker while task.perCallModel is off", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-saved-");
		const fixture = await hostSeanceFixture(tempDir.path());
		let onSelected: ((session: SessionInfo) => Promise<void> | void) | undefined;
		fixture.ctx.showSessionSelector = vi.fn((_title, onSelect) => {
			onSelected = onSelect as (session: SessionInfo) => Promise<void>;
		}) as InteractiveModeContext["showSessionSelector"];
		fixture.ctx.showHookSelector = vi.fn(async () => "Use saved model");
		fixture.ctx.showModelSelector = vi.fn();
		try {
			await runSeanceCommand(fixture.ctx, "");
			if (!onSelected) throw new Error("Expected the session picker");
			await onSelected(sourceSession(fixture.sourceFile));
			await fixture.completed;
			expect(fixture.ctx.showError).not.toHaveBeenCalled();
			expect(fixture.ctx.showHookSelector).toHaveBeenCalled();
			expect(fixture.ctx.showModelSelector).not.toHaveBeenCalled();
			expect(fixture.run).toHaveBeenCalledTimes(1);
			expect(fixture.run.mock.calls[0]?.[0].modelOverride).toEqual([fixture.modelSelector]);
			expect(fixture.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(fixture.modelSelector));
		} finally {
			fixture.authStorage.close();
		}
	});

	it("runs an unapproved choose-another model without changing session defaults or consulting the gate", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-picked-model-");
		const fixture = await hostSeanceFixture(tempDir.path());
		fixture.ctx.showHookSelector = vi.fn(async () => "Choose another model");
		let selectModel: ((selector: string) => void | Promise<void>) | undefined;
		fixture.ctx.showModelSelector = vi.fn(options => {
			selectModel = options?.selectOnly?.onSelect;
		});
		const rolesBefore = fixture.ctx.settings.getModelRoles();
		try {
			await runSeanceCommand(fixture.ctx, fixture.sourceFile);
			if (!selectModel) throw new Error("Expected the one-off model picker");
			await selectModel(fixture.modelSelector);
			await fixture.completed;
			expect(fixture.ctx.showError).not.toHaveBeenCalled();
			expect(fixture.run).toHaveBeenCalledTimes(1);
			expect(fixture.run.mock.calls[0]?.[0].modelOverride).toEqual([fixture.modelSelector]);
			expect(fixture.ctx.settings.getModelRoles()).toEqual(rolesBefore);
			expect(fixture.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(fixture.modelSelector));
		} finally {
			fixture.authStorage.close();
		}
	});

	it("preserves task deny policy when /seance executes an extension-wrapped task tool", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-denied-");
		const fixture = await hostSeanceFixture(tempDir.path(), {
			"tools.approvalMode": "yolo",
			"tools.approval": { task: "deny" },
		});
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			fixture.ctx.sessionManager,
			fixture.modelRegistry,
			undefined,
			Settings.isolated({ "tools.approvalMode": "always-ask" }),
		);
		const select = vi.fn(async () => "Deny");
		vi.spyOn(runner, "hasUI").mockReturnValue(true);
		vi.spyOn(runner, "getUIContext").mockReturnValue({ ...runner.getUIContext(), select });
		fixture.ctx.session.agent.state.tools = [new ExtensionToolWrapper(fixture.tool as unknown as AgentTool, runner)];
		try {
			await runSeanceCommand(fixture.ctx, `${fixture.sourceFile} --model ${fixture.modelSelector}`);
			await fixture.completed;
			expect(fixture.ctx.showError).toHaveBeenCalledWith(expect.stringMatching(/task.*blocked by user policy/i));
			expect(fixture.run).not.toHaveBeenCalled();
			expect(select).not.toHaveBeenCalled();
			expect(fixture.ctx.showStatus).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});

	it.each([
		["an explicit task allow policy", { "tools.approvalMode": "always-ask", "tools.approval": { task: "allow" } }],
		["yolo mode", { "tools.approvalMode": "yolo" }],
	] as const)("preserves %s without a new approval prompt for wrapped /seance", async (_label, settings) => {
		using tempDir = TempDir.createSync("@omp-seance-command-approved-");
		const fixture = await hostSeanceFixture(tempDir.path(), settings);
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			fixture.ctx.sessionManager,
			fixture.modelRegistry,
			undefined,
			Settings.isolated({ "tools.approvalMode": "always-ask" }),
		);
		const select = vi.fn(async () => "Deny");
		vi.spyOn(runner, "hasUI").mockReturnValue(true);
		vi.spyOn(runner, "getUIContext").mockReturnValue({ ...runner.getUIContext(), select });
		fixture.ctx.session.agent.state.tools = [new ExtensionToolWrapper(fixture.tool as unknown as AgentTool, runner)];
		try {
			await runSeanceCommand(fixture.ctx, `${fixture.sourceFile} --model ${fixture.modelSelector}`);
			await fixture.completed;
			expect(fixture.ctx.showError).not.toHaveBeenCalled();
			expect(select).not.toHaveBeenCalled();
			expect(fixture.run).toHaveBeenCalledTimes(1);
			expect(fixture.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(fixture.modelSelector));
		} finally {
			fixture.authStorage.close();
		}
	});

	it("shows the /seance --model selection to tool_call handlers and runs their revision", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-tool-call-");
		const fixture = await hostSeanceFixture(tempDir.path(), { "tools.approvalMode": "yolo" });
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			fixture.ctx.sessionManager,
			fixture.modelRegistry,
			undefined,
			Settings.isolated({ "tools.approvalMode": "yolo" }),
		);
		const seen: unknown[] = [];
		const revised = `${fixture.modelSelector}:low`;
		vi.spyOn(runner, "hasHandlers").mockImplementation(event => event === "tool_call");
		vi.spyOn(runner, "emitToolCall").mockImplementation(async event => {
			const input = event.input as Record<string, unknown>;
			seen.push(input.model);
			return { input: { ...input, model: revised } };
		});
		fixture.ctx.session.agent.state.tools = [new ExtensionToolWrapper(fixture.tool as unknown as AgentTool, runner)];
		try {
			await runSeanceCommand(fixture.ctx, `${fixture.sourceFile} --model ${fixture.modelSelector}`);
			await fixture.completed;
			// The handler saw the host selection, and the revision it returned is what ran.
			expect(seen).toEqual([fixture.modelSelector]);
			expect(fixture.ctx.showError).not.toHaveBeenCalled();
			expect(fixture.run).toHaveBeenCalledTimes(1);
			expect(fixture.run.mock.calls[0]?.[0].modelOverride).toEqual([revised]);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("lets a tool_call handler block a /seance --model selection", async () => {
		using tempDir = TempDir.createSync("@omp-seance-command-tool-call-block-");
		const fixture = await hostSeanceFixture(tempDir.path(), { "tools.approvalMode": "yolo" });
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			fixture.ctx.sessionManager,
			fixture.modelRegistry,
			undefined,
			Settings.isolated({ "tools.approvalMode": "yolo" }),
		);
		vi.spyOn(runner, "hasHandlers").mockImplementation(event => event === "tool_call");
		vi.spyOn(runner, "emitToolCall").mockImplementation(async event => {
			const input = event.input as Record<string, unknown>;
			return input.model === fixture.modelSelector ? { block: true, reason: "model not allowed" } : undefined;
		});
		fixture.ctx.session.agent.state.tools = [new ExtensionToolWrapper(fixture.tool as unknown as AgentTool, runner)];
		try {
			await runSeanceCommand(fixture.ctx, `${fixture.sourceFile} --model ${fixture.modelSelector}`);
			await fixture.completed;
			expect(fixture.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("model not allowed"));
			expect(fixture.run).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});
});
