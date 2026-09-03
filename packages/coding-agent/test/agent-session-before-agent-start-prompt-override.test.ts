import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Contract: a per-turn system prompt returned by `before_agent_start`
// ("Replace the system prompt for this turn") must reach the provider for the
// turn. A base-prompt rebuild that fires in the prompt window — context-overflow
// compaction/promotion, memory promotion, MCP/RPC tool refresh, or the
// fire-and-forget hindsight MM-TTL refresh — re-sets the agent prompt to the
// rebuilt base. It must not clobber an active override. Regression for #7755.

const OVERRIDE = "OVERRIDE-SYSTEM-PROMPT-LIFEOS_ROUTE";
const REBUILT_BASE = "REBUILT-BASE-WITH-TOOL-CATALOG";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession before_agent_start system prompt override", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	/**
	 * Builds a session whose `before_agent_start` replaces the prompt with
	 * {@link OVERRIDE} and whose base rebuild renders {@link REBUILT_BASE}.
	 *
	 * When `rebuildInWindow` is set, a base rebuild is fired from a
	 * `beforeModelCall` hook — which the agent loop runs immediately before it
	 * re-reads `state.systemPrompt` for the request — reproducing a rebuild that
	 * lands in the window between the hook and the provider request.
	 */
	function createSession(
		responses: MockResponseSource,
		options: { rebuildInWindow?: boolean } = {},
	): { session: AgentSession; systemPrompts: string[][] } {
		const mock = createMockModel({ responses });
		const systemPrompts: string[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(model, context, streamOptions);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => ({ systemPrompt: [OVERRIDE] }),
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: [REBUILT_BASE] }),
		});
		const activeSession = session;

		if (options.rebuildInWindow) {
			let fired = false;
			agent.addBeforeModelCallHook(async () => {
				if (fired) return;
				fired = true;
				await activeSession.refreshBaseSystemPrompt();
			});
		}

		return { session, systemPrompts };
	}

	it("keeps the override when a base rebuild fires in the prompt window", async () => {
		const { session, systemPrompts } = createSession([{ content: ["Done"] }], { rebuildInWindow: true });

		await session.prompt("hello");
		await session.waitForIdle();

		// The rebuild ran right before the request re-read the agent prompt; the
		// override must still reach the provider instead of the rebuilt base.
		expect(systemPrompts).toHaveLength(1);
		expect(systemPrompts[0]).toEqual([OVERRIDE]);
	});

	it("falls back to the rebuilt base once the turn ends", async () => {
		const { session } = createSession([{ content: ["Done"] }]);

		await session.prompt("hello");
		await session.waitForIdle();

		// The per-turn override is cleared when the turn completes, so a later
		// rebuild applies the base prompt rather than leaking the stale override.
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual([REBUILT_BASE]);
	});
});
