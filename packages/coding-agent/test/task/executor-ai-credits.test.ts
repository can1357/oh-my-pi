/**
 * A subagent's Copilot AI credits reach its parent through the task result. The result must carry every
 * source of spend the child's own `/session` shows: its turns, its nested task calls, and its journaled
 * side requests, with the turns that sent no billing frame counted apart (unknown, not zero).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(aiuNano?: number, totalTokens = 2) {
	return {
		input: totalTokens === 0 ? 0 : 1,
		output: totalTokens === 0 ? 0 : 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: ZERO_COST,
		...(aiuNano === undefined ? {} : { aiu: { nano: aiuNano } }),
	};
}

function copilotModel() {
	const model = getBundledModel("github-copilot", "gpt-5.4");
	if (!model) throw new Error("Expected bundled Copilot model");
	return model;
}

function copilotTurn(aiuNano?: number, stopReason: "stop" | "error" = "stop", totalTokens = 2): AgentSessionEvent {
	const model = copilotModel();
	return {
		type: "message_end",
		message: {
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			stopReason,
			content: [],
			usage: usage(aiuNano, totalTokens),
		},
	} as unknown as AgentSessionEvent;
}

function createSession(journal: unknown[], onPrompt: (emit: (event: AgentSessionEvent) => void) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getEntries: () => journal },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			onPrompt(emit);
			return true;
		},
	} as unknown as AgentSession;
}

function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

async function run(session: AgentSession) {
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));
	return runSubprocess({
		cwd: "/tmp",
		agent,
		task: "do work",
		index: 0,
		id: "subagent-ai-credits",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	});
}

function emitYield(emit: (event: AgentSessionEvent) => void): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "tool-yield",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	});
}

describe("subagent AI credit roll-up", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds nested task calls and current-turn side requests without old journal charges", async () => {
		const model = copilotModel();
		const journal: unknown[] = [
			{
				type: "model_usage",
				provider: model.provider,
				api: model.api,
				model: model.id,
				stopReason: "stop",
				usage: usage(900),
			},
			{
				type: "model_usage",
				provider: model.provider,
				api: model.api,
				model: model.id,
				stopReason: "stop",
				usage: usage(),
			},
		];
		const result = await run(
			createSession(journal, emit => {
				journal.push(
					{
						type: "model_usage",
						provider: model.provider,
						api: model.api,
						model: model.id,
						stopReason: "stop",
						usage: usage(25),
					},
					{
						type: "model_usage",
						provider: model.provider,
						api: model.api,
						model: model.id,
						stopReason: "stop",
						usage: usage(),
					},
					{
						type: "model_usage",
						provider: "openai",
						api: model.api,
						model: model.id,
						stopReason: "stop",
						usage: usage(),
					},
				);
				emit(copilotTurn(100));
				emit(copilotTurn());
				emit({
					type: "message_end",
					message: {
						role: "toolResult",
						toolName: "task",
						content: [],
						details: { usage: usage(50), results: [{ aiuUnreportedTurns: 2 }] },
					},
				} as unknown as AgentSessionEvent);
				emitYield(emit);
			}),
		);

		// 100 (own turn) + 50 (nested task) + 25 (this turn's side request); preexisting charges are excluded.
		expect(result.usage?.aiu).toEqual({ nano: 175 });
		// 1 own turn + 2 in the nested task + 1 current side request; the non-Copilot request is not counted.
		expect(result.aiuUnreportedTurns).toBe(4);
	});

	it("adds the credits of background jobs the subagent consumed through wait, cancel or an async-result delivery", async () => {
		const job = (nano: number, aiuUnreportedTurns?: number) => ({
			jobId: `job-${nano}`,
			type: "task",
			status: "completed",
			usage: usage(nano),
			...(aiuUnreportedTurns ? { aiuUnreportedTurns } : {}),
		});
		const result = await run(
			createSession([], emit => {
				emit(copilotTurn(100));
				// A snapshot that took one job over, beside a running row that carries nothing.
				emit({
					type: "message_end",
					message: {
						role: "toolResult",
						toolName: "wait",
						content: [],
						details: { op: "wait", jobs: [job(40, 1), { jobId: "running", type: "task", status: "running" }] },
					},
				} as unknown as AgentSessionEvent);
				emit({
					type: "message_end",
					message: {
						role: "toolResult",
						toolName: "write",
						content: [],
						details: { op: "cancel", jobs: [job(5)] },
					},
				} as unknown as AgentSessionEvent);
				// A job delivered as a follow-up instead.
				emit({
					type: "message_end",
					message: { role: "custom", customType: "async-result", content: "done", details: { jobs: [job(7, 2)] } },
				} as unknown as AgentSessionEvent);
				// Not billing carriers: a listing-style result with usage-shaped rows never counts.
				emit({
					type: "message_end",
					message: { role: "toolResult", toolName: "read", content: [], details: { jobs: [job(1000)] } },
				} as unknown as AgentSessionEvent);
				emitYield(emit);
			}),
		);

		// 100 (own turn) + 40 (wait) + 5 (cancel) + 7 (delivery); the `read` result is no billing carrier.
		expect(result.usage?.aiu).toEqual({ nano: 152 });
		expect(result.aiuUnreportedTurns).toBe(3);
	});

	it("does not count zero-token errors as missing billing frames", async () => {
		const result = await run(
			createSession([], emit => {
				emit(copilotTurn(undefined, "error", 0));
				emitYield(emit);
			}),
		);

		expect(result.aiuUnreportedTurns).toBeUndefined();
	});

	it("reports unknown, not zero, when no source carried a billing frame", async () => {
		const journal: unknown[] = [];
		const model = copilotModel();
		const result = await run(
			createSession(journal, emit => {
				journal.push({
					type: "model_usage",
					provider: model.provider,
					api: model.api,
					model: model.id,
					stopReason: "stop",
					usage: usage(),
				});
				emit(copilotTurn());
				emitYield(emit);
			}),
		);

		expect(result.usage?.aiu).toBeUndefined();
		expect(result.aiuUnreportedTurns).toBe(2);
	});
});
