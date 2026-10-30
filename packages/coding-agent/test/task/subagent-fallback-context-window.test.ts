/**
 * The subagent usage gauge divides context tokens by the window of the model
 * the run is attributed to. A retry fallback moves attribution to a model with
 * a different window, and the executor's progress record has to move with it —
 * the Agent Hub renders `progress.contextWindow` (`agent-hub-projection.ts`
 * `progressMetrics`), so a stale value shows the wrong percentage for the rest
 * of the run.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { createSessionDefaults } from "../helpers/session-defaults";

function model(provider: string, id: string, contextWindow: number): Model {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	});
}

const SERVED_TURN = {
	role: "assistant",
	content: [{ type: "text", text: "answered after the swap" }],
	stopReason: "stop",
} as AssistantMessage;

describe("subagent context window after a model swap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("follows the serving model's window", async () => {
		const primary = model("sub-omp", "k3-256k", 256_000);
		const fallback = model("openai-codex", "gpt-6-sol", 500_000);
		const snapshots: AgentProgress[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			let activeModel = primary;
			const recovery = new TurnRecovery({
				model: () => activeModel,
				thinkingLevel: () => undefined,
				sessionManager: { getSessionId: () => "context-window-swap" },
				settings: Settings.isolated({}),
				modelRegistry: {},
				configWarnings: [],
			} as unknown as TurnRecoveryHost);
			const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
			const session = {
				...createSessionDefaults(),
				agent: { state: { systemPrompt: ["test"] } },
				state: { messages: [] },
				model: primary,
				extensionRunner: undefined,
				sessionManager: { appendSessionInit: () => {} },
				getActiveToolNames: () => ["yield"],
				getEnabledToolNames: () => ["yield"],
				subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async () => {
					const emit = (event: { type: string; [key: string]: unknown }): void => {
						for (const listener of listeners) listener(event);
					};
					activeModel = fallback;
					session.model = fallback;
					await recovery.onAssistantSettledSuccessfully(SERVED_TURN);
					emit({
						type: "retry_fallback_succeeded",
						model: "openai-codex/gpt-6-sol",
						role: "subagent:context-window-swap",
					});
					emit({
						type: "tool_execution_end",
						toolCallId: "tool-yield",
						toolName: "yield",
						result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
						isError: false,
					});
				},
			};
			Object.defineProperty(session, "servingModel", { get: () => recovery.servingModel });
			return {
				session: session as unknown as AgentSession,
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		const settings = Settings.isolated({});
		settings.setModelRole("default", "sub-omp/k3-256k");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "context-window-swap",
			modelOverride: ["sub-omp/k3-256k", "openai-codex/gpt-6-sol"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			onProgress: progress => {
				snapshots.push({ ...progress });
			},
		});

		expect(result.resolvedModelIdentity).toBe("openai-codex/gpt-6-sol");
		expect(result.contextWindow).toBe(500_000);
		// The hub polls streamed progress, not just the settled result.
		expect(
			snapshots.findLast(snapshot => snapshot.resolvedModelIdentity === "openai-codex/gpt-6-sol")?.contextWindow,
		).toBe(500_000);
	});
});
