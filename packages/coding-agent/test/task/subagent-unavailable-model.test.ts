import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const agent: AgentDefinition = { name: "astra-api", description: "test", systemPrompt: "test", source: "bundled" };

/**
 * Fake session that yields once per prompt. `runtimeHop` moves the session's
 * serving model during the turn, as a served runtime fallback does.
 */
function createYieldingSession(servingModel: ServingModel, runtimeHop?: ServingModel): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "declared-model"),
		servingModel,
		extensionRunner: undefined,
		isStreaming: false,
		setWorkPoolYieldItems: async () => {},
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			if (runtimeHop) session.servingModel = runtimeHop;
			// A listener may unsubscribe while it handles the event.
			for (const listener of listeners.slice()) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent whose declared model cannot serve", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records the model a deferred spawn settled on in session_init", async () => {
		const declared = model("primary", "declared-model");
		const parent = model("parent", "session-model");
		const session = createYieldingSession({ selector: "parent/session-model", isFallback: true });
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session, extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "no-credentials",
			modelOverride: ["primary/declared-model"],
			modelRole: "smol",
			parentActiveModelPattern: "parent/session-model",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [declared, parent],
				getApiKey: async (requested: Model) => (requested.provider === "primary" ? undefined : "parent-key"),
			} as never,
			enableLsp: false,
		});

		expect(appendSessionInit.mock.calls[0]?.[0]).toMatchObject({ resolvedModel: "parent/session-model" });
	});

	const parentFallback: ServingModel = {
		selector: "parent/session-model",
		modelIdentity: "parent/session-model",
		isFallback: false,
	};
	const startupModelFallback = {
		model: "parent/session-model",
		reason:
			"Fallback: primary/declared-model -> parent/session-model\nprimary/declared-model has no working credentials",
	};
	const unauthenticatedRegistry = {
		refresh: async () => {},
		getAvailable: () => [model("primary", "declared-model")],
		getApiKey: async () => undefined,
	};

	it("reports the startup fallback on a follow-up turn of the same live session", async () => {
		const session = createYieldingSession(parentFallback);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session, startupModelFallback, extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "startup-follow-up",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: unauthenticatedRegistry as never,
			enableLsp: false,
		});
		AgentRegistry.global().unregister("startup-follow-up");
		AgentRegistry.global().register({
			id: "startup-follow-up",
			displayName: "startup-follow-up",
			kind: "sub",
			status: "idle",
			session,
		});

		try {
			const followUp = await runSubagentFollowUpTurn({
				cwd: "/tmp",
				agent,
				index: 0,
				id: "startup-follow-up",
				message: "continue",
				settings: Settings.isolated(),
				enableLsp: false,
			} as never);

			expect(followUp.resolvedModel).toBe("parent/session-model");
			expect(followUp.resolvedModelIsFallback).toBe(true);
			expect(followUp.resolvedModelFallbackReason).toBe(startupModelFallback.reason);
		} finally {
			AgentRegistry.global().unregister("startup-follow-up");
		}
	});

	it("stops giving the startup reason once a runtime hop moves the run to another model", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					session: createYieldingSession(parentFallback, {
						selector: "fallback/working-model",
						modelIdentity: "fallback/working-model",
						isFallback: true,
					}),
					startupModelFallback,
					extensionsResult: {},
					setToolUIContext: () => {},
				}) as never,
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "runtime-hop",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: unauthenticatedRegistry as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("fallback/working-model");
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(result.resolvedModelFallbackReason).toBeUndefined();
	});
});
