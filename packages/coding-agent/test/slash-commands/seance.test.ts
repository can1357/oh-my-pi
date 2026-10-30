import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
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

function registerTaskTool(ctx: InteractiveModeContext, execute: AgentTool["execute"]): void {
	ctx.session.agent.state.tools = [{ name: "task", execute } as unknown as AgentTool];
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
		registerTaskTool(ctx, execute as AgentTool["execute"]);
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
		registerTaskTool(ctx, execute as AgentTool["execute"]);

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
		registerTaskTool(ctx, execute as AgentTool["execute"]);

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
		registerTaskTool(ctx, execute as AgentTool["execute"]);

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
		registerTaskTool(
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
		registerTaskTool(ctx, vi.fn(async () => taskResult({}, preflight)) as AgentTool["execute"]);
		await runSeanceCommand(ctx, `${resolved.path} --model openai/model`);
		expect(ctx.showError).toHaveBeenCalledWith(sanitizeErrorLine(preflight));

		const thrown = new Error("Session fork failed\n\u001b[31m");
		registerTaskTool(
			ctx,
			vi.fn(async () => {
				throw thrown;
			}) as AgentTool["execute"],
		);
		await runSeanceCommand(ctx, `${resolved.path} --model openai/model`);
		expect(ctx.showError).toHaveBeenCalledWith(sanitizeErrorLine(thrown));
	});
});
