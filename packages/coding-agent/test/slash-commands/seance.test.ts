import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import * as seanceResolver from "@oh-my-pi/pi-coding-agent/task/seance";
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/seance", () => {
	it("bypasses model pickers for an override and reports completed IDs with the actual model", async () => {
		const resolved = sourceSession("/repo/.omp/sessions/old.jsonl");
		vi.spyOn(seanceResolver, "resolveSeanceSource").mockResolvedValue({
			file: resolved.path,
			id: resolved.id,
			modelSelectors: [],
		});
		const ctx = createInteractiveModeContext();
		const hostModel = ctx.session.model;
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
		expect(ctx.session.model).toBe(hostModel);
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
