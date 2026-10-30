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
import { TempDir } from "@oh-my-pi/pi-utils";

// Prepared extension policy lasts until the next preparation or conversation reset.
// Base rebuilds must preserve it across ordinary and autonomous continuations (#7755).

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
		options: { rebuildInWindow?: boolean; beforeAgentStart?: ExtensionRunner["emitBeforeAgentStart"] } = {},
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
				emitBeforeAgentStart: options.beforeAgentStart ?? (async () => ({ systemPrompt: [OVERRIDE] })),
				emit: async () => undefined,
				hasHandlers: () => false,
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

	it("keeps prepared policy until the next preparation returns no override", async () => {
		let enabled = true;
		let hookCalls = 0;
		const { session, systemPrompts } = createSession(
			Array.from({ length: 4 }, () => ({ content: ["Done"] })),
			{
				beforeAgentStart: async () => {
					hookCalls++;
					return enabled ? { systemPrompt: [OVERRIDE] } : undefined;
				},
			},
		);

		await session.prompt("enable extension policy");
		await session.refreshBaseSystemPrompt();
		await session.sendCustomMessage(
			{ customType: "peer", content: "continue", display: false },
			{ deliverAs: "aside" },
		);
		enabled = false;
		await session.prompt("extension mode is now off");
		await session.refreshBaseSystemPrompt();
		await session.sendCustomMessage(
			{ customType: "peer", content: "continue without policy", display: false },
			{ deliverAs: "aside" },
		);

		expect(hookCalls).toBe(2);
		expect(systemPrompts).toEqual([[OVERRIDE], [OVERRIDE], [REBUILT_BASE], [REBUILT_BASE]]);
	});

	for (const transition of ["new", "reset"] as const) {
		it(`drops prepared policy before autonomous requests after ${transition}`, async () => {
			const { session, systemPrompts } = createSession([{ content: ["Done"] }, { content: ["Done"] }]);
			await session.prompt("old conversation");
			if (transition === "new") expect(await session.newSession()).toBe(true);
			else expect(await session.resetSessionContext()).toBeDefined();
			await session.sendCustomMessage(
				{ customType: "peer", content: "new conversation", display: false },
				{ deliverAs: "aside" },
			);
			expect(systemPrompts).toEqual([[OVERRIDE], [REBUILT_BASE]]);
		});
	}

	it("drops prepared policy when switching to a different session", async () => {
		using tempDir = TempDir.createSync("@pi-prepared-policy-switch-");
		const { session, systemPrompts } = createSession([{ content: ["Done"] }, { content: ["Done"] }]);
		await session.prompt("old conversation");
		const target = SessionManager.create(session.sessionManager.getCwd(), tempDir.path());
		target.appendMessage({ role: "user", content: "target conversation", timestamp: Date.now() });
		await target.flush();
		const targetFile = target.getSessionFile()!;
		await target.close();
		try {
			expect(await session.switchSession(targetFile, { keepModel: true })).toBe(true);
			await session.sendCustomMessage(
				{ customType: "peer", content: "target aside", display: false },
				{ deliverAs: "aside" },
			);
			expect(systemPrompts).toEqual([[OVERRIDE], [REBUILT_BASE]]);
		} finally {
			await session.dispose();
		}
	});

	it("retains prepared policy when a session switch rolls back", async () => {
		using tempDir = TempDir.createSync("@pi-prepared-policy-rollback-");
		const { session, systemPrompts } = createSession([{ content: ["Done"] }, { content: ["Done"] }]);
		await session.prompt("original conversation");
		const failure = new Error("session switch failed");
		vi.spyOn(session.sessionManager, "setSessionFile").mockRejectedValueOnce(failure);
		await expect(session.switchSession(tempDir.join("target.jsonl"))).rejects.toBe(failure);
		await session.refreshBaseSystemPrompt();
		await session.sendCustomMessage(
			{ customType: "peer", content: "original aside", display: false },
			{ deliverAs: "aside" },
		);
		expect(systemPrompts).toEqual([[OVERRIDE], [OVERRIDE]]);
	});
});
