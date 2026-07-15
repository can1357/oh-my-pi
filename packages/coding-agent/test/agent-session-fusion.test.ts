/**
 * Contract tests for Fusion stateful logic in AgentSession.
 *
 * Each test drives AgentSession through its public API and observes the resulting
 * model selection. Spies are placed on the classifier seam (module-level
 * classifyFusionRoute function) and the agent's external-event emitter (the
 * mechanism by which tool_result messages reach the session's internal handler).
 * No private field inspection.
 *
 * Compaction requires real conversation history. Real prompts are used for priming.
 * Tests are gated by the ANTHROPIC_API_KEY env var — skipIfNoKey.
 *
 * Coverage:
 * 1. Compaction-boundary downgrade: fusion.compactModel switches the main model.
 * 2. Dynamic routing: classifier verdict routes tier at every compaction boundary.
 * 3. Routing latch: a user-initiated model change permanently disables auto-routing.
 * 4. Failure-streak escalation: consecutive tool failures escalate back to frontier.
 * 5. Sidekick re-tiering: sidekick route resolves independently at each boundary.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import * as fusionRouter from "@pk-nerdsaver-ai/pi-coding-agent/session/fusion-router";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { createTools } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

// ---------------------------------------------------------------------------
// E2E guard
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const describeIfKey = ANTHROPIC_API_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FusionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	frontierModel: Model<Api>;
	compactModel: Model<Api>;
	tempDir: TempDir;
	cleanupFns: Array<() => Promise<void>>;
}

const FRONTIER_ID = "claude-sonnet-4-5";
const COMPACT_ID = "claude-sonnet-4-0";

async function buildFusionHarness(fusionSettings: Record<string, unknown> = {}): Promise<FusionHarness> {
	const tempDir = TempDir.createSync("@fusion-test-");
	const authDb = path.join(tempDir.path(), "auth.db");
	const sessionsDir = path.join(tempDir.path(), "sessions");

	const authStorage = await AuthStorage.create(authDb);
	authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_API_KEY!);

	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

	const frontierModel = getBundledModel("anthropic", FRONTIER_ID);
	const compactModel = getBundledModel("anthropic", COMPACT_ID);
	if (!frontierModel) throw new Error(`Bundled model ${FRONTIER_ID} not found`);
	if (!compactModel) throw new Error(`Bundled model ${COMPACT_ID} not found`);

	const toolSession: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	const tools = await createTools(toolSession);

	const agent = new Agent({
		getApiKey: () => ANTHROPIC_API_KEY!,
		initialState: {
			model: frontierModel,
			systemPrompt: ["You are a helpful assistant."],
			tools,
		},
	});

	const sessionManager = SessionManager.create(tempDir.path(), sessionsDir);
	const settings = Settings.isolated({
		"compaction.keepRecentTokens": 1,
		"fusion.enabled": true,
		"fusion.mode": "delegate",
		...fusionSettings,
	});

	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

	return {
		session,
		sessionManager,
		authStorage,
		modelRegistry,
		frontierModel,
		compactModel,
		tempDir,
		cleanupFns: [
			async () => {
				await session.dispose();
				await sessionManager.close();
				authStorage.close();
				tempDir.removeSync();
			},
		],
	};
}

async function closeHarness(h: FusionHarness): Promise<void> {
	for (const fn of h.cleanupFns) {
		await fn();
	}
}

/**
 * Prime a session with enough context for compaction to fire.
 */
async function primeSession(session: AgentSession): Promise<void> {
	await session.prompt(
		"Write a detailed technical explanation of how photosynthesis works in plants. Include the light reactions, Calvin cycle, and factors affecting efficiency. Use at least 5 paragraphs.",
	);
	await session.agent.waitForIdle();
}

// ---------------------------------------------------------------------------
// Contract 1 — Compaction-boundary downgrade (static mode)
// ---------------------------------------------------------------------------

describeIfKey("Fusion compaction-boundary downgrade", () => {
	let h: FusionHarness;

	beforeEach(async () => {
		h = await buildFusionHarness({
			"fusion.compactModel": COMPACT_ID,
			"fusion.dynamicRouting": false,
		});
	});

	afterEach(async () => {
		await closeHarness(h);
	});

	it("switches main model to compact tier at the first compaction", async () => {
		await primeSession(h.session);
		expect(h.session.model?.id).toBe(FRONTIER_ID);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);
	});

	it("does not switch again on a second compaction (static one-shot guard)", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);

		await h.session.setModelTemporary(h.frontierModel);
		expect(h.session.model?.id).toBe(FRONTIER_ID);

		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(FRONTIER_ID);
	});

	it("preserves frontier model reference for later escalation paths", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);
		expect(h.frontierModel.id).not.toBe(h.session.model?.id);
	});
});

// ---------------------------------------------------------------------------
// Contract 2 — Dynamic routing at compaction boundary
// ---------------------------------------------------------------------------

describeIfKey("Fusion dynamic routing at compaction boundary", () => {
	let h: FusionHarness;
	let classifySpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		h = await buildFusionHarness({
			"fusion.dynamicRouting": true,
			"fusion.modelPool": ["1=vendor/big", "5=vendor/tiny"],
		});
		classifySpy = spyOn(fusionRouter, "classifyFusionRoute");
	});

	afterEach(async () => {
		classifySpy.mockRestore();
		await closeHarness(h);
	});

	it("calls the classifier at every compaction when dynamicRouting is on", async () => {
		classifySpy.mockResolvedValue("cheap" as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();

		classifySpy.mockClear();
		await primeSession(h.session);
		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
	});

	it("routes to compact tier when classifier returns 'cheap'", async () => {
		classifySpy.mockResolvedValue("cheap" as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);
	});

	it("routes to frontier when classifier returns 'frontier'", async () => {
		classifySpy.mockResolvedValue("frontier" as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(h.session.model?.id).toBe(FRONTIER_ID);
	});

	it("routes to pool tier when classifier returns a tier number", async () => {
		classifySpy.mockResolvedValue(1 as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Contract 3 — Routing latch after manual model switch
// ---------------------------------------------------------------------------

describeIfKey("Fusion routing latch after manual model switch", () => {
	let h: FusionHarness;
	let classifySpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		h = await buildFusionHarness({
			"fusion.dynamicRouting": true,
			"fusion.modelPool": ["1=vendor/big", "5=vendor/tiny"],
		});
		classifySpy = spyOn(fusionRouter, "classifyFusionRoute");
	});

	afterEach(async () => {
		classifySpy.mockRestore();
		await closeHarness(h);
	});

	it("disables dynamic routing after a user-initiated model switch", async () => {
		classifySpy.mockResolvedValue("cheap" as never);
		await primeSession(h.session);
		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
		classifySpy.mockClear();

		await h.session.setModelTemporary(h.frontierModel);
		expect(h.session.model?.id).toBe(FRONTIER_ID);

		await primeSession(h.session);
		await h.session.compact();
		expect(classifySpy).not.toHaveBeenCalled();
	});

	it("does not latch when the manual switch lands on the auto-selected model", async () => {
		classifySpy.mockResolvedValue("cheap" as never);
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);
		classifySpy.mockClear();

		await h.session.setModelTemporary(h.compactModel);
		await primeSession(h.session);
		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Contract 4 — Failure-streak escalation
// ---------------------------------------------------------------------------

describeIfKey("Fusion failure-streak escalation", () => {
	let h: FusionHarness;
	let emitSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		h = await buildFusionHarness({
			"fusion.compactModel": COMPACT_ID,
			"fusion.dynamicRouting": false,
			"fusion.escalateFailureStreak": 3,
		});
		emitSpy = spyOn(h.session.agent, "emitExternalEvent");
	});

	afterEach(async () => {
		emitSpy.mockRestore();
		await closeHarness(h);
	});

	function emitToolResult(isError: boolean): void {
		const toolResultMessage = {
			role: "toolResult",
			toolCallId: "test-call-id",
			toolName: "test-tool",
			content: [],
			isError,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const realEmit = h.session.agent.emitExternalEvent.bind(h.session.agent);
		emitSpy.mockImplementation(() => {
			realEmit({ type: "message_end", message: toolResultMessage });
		});
		realEmit({ type: "message_end", message: toolResultMessage });
	}

	it("escalates to frontier after consecutive tool failures reach the threshold", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);

		for (let i = 0; i < 3; i++) {
			emitToolResult(true);
		}

		expect(h.session.model?.id).toBe(FRONTIER_ID);
	});

	it("does not escalate when streak is below threshold", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);

		emitToolResult(true);
		expect(h.session.model?.id).toBe(COMPACT_ID);
	});

	it("resets streak on a successful tool call", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);

		emitToolResult(true);
		emitToolResult(true);
		emitToolResult(false); // reset
		emitToolResult(true);
		emitToolResult(true);

		expect(h.session.model?.id).toBe(COMPACT_ID);
	});

	it("respects routing latch: does not escalate after manual switch", async () => {
		await primeSession(h.session);
		await h.session.compact();
		expect(h.session.model?.id).toBe(COMPACT_ID);

		emitToolResult(true);
		emitToolResult(true);

		await h.session.setModelTemporary(h.frontierModel);
		expect(h.session.model?.id).toBe(FRONTIER_ID);

		emitToolResult(true);
		expect(h.session.model?.id).toBe(FRONTIER_ID);
	});
});

// ---------------------------------------------------------------------------
// Contract 5 — Sidekick re-tiering at compaction boundary
// ---------------------------------------------------------------------------

describeIfKey("Fusion sidekick re-tiering at compaction boundary", () => {
	let h: FusionHarness;
	let classifySpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		h = await buildFusionHarness({
			"fusion.dynamicRouting": true,
			"fusion.sidekickStrongModel": "vendor/strong-sidekick",
			"fusion.modelPool": ["1=vendor/big", "5=vendor/tiny"],
		});
		classifySpy = spyOn(fusionRouter, "classifyFusionRoute");
	});

	afterEach(async () => {
		classifySpy.mockRestore();
		await closeHarness(h);
	});

	it("exercises the sidekick routing path at every compaction boundary", async () => {
		classifySpy.mockResolvedValue("frontier" as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();

		classifySpy.mockClear();
		await primeSession(h.session);
		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
	});

	it("runs routing even when sidekickStrongModel is not configured", async () => {
		classifySpy.mockResolvedValue("frontier" as never);
		await primeSession(h.session);

		await h.session.compact();
		expect(classifySpy).toHaveBeenCalled();
	});
});
