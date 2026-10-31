import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	cfgCompactionMethodOrder,
	cfgCompactionShakeThresholdPercent,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const THRESHOLD_TOKENS = 400_000;
const TIER_TOKENS = THRESHOLD_TOKENS / 2;
/** Just above the tier, where the savings floor is about 10% of the threshold. */
const NEAR_TIER_TOKENS = TIER_TOKENS + 1_000;

function usage(input = 0): AssistantMessage["usage"] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textOfResult(message: ToolResultMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("automatic shake below the compaction threshold", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let events: AgentSessionEvent[];
	let timestamp: number;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-tier-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model");
		// Room below the trigger for three phases, each pushing older results out of the protect window.
		const model = { ...bundled, contextWindow: 1_000_000 };
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			"compaction.asyncEnabled": false,
			"compaction.thresholdTokens": THRESHOLD_TOKENS,
			"compaction.supersedeReads": false,
			"compaction.dropUseless": false,
			"contextPromotion.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry,
		});
		events = [];
		session.subscribe(event => events.push(event));
		timestamp = Date.now() - 10_000;
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
	});

	function enableTier(): void {
		cfgCompactionShakeThresholdPercent.override(settings, 50);
	}

	function textOfTokens(target: number, seed: string): string {
		const unit = `${seed} `;
		const sampleTokens = session.agent.tokenizer.countTokens(unit.repeat(100));
		const text = unit.repeat(Math.ceil((target * 100) / sampleTokens));
		const tokens = session.agent.tokenizer.countTokens(text);
		expect(tokens).toBeGreaterThanOrEqual(target * 0.97);
		expect(tokens).toBeLessThanOrEqual(target * 1.03);
		return text;
	}

	function assistant(content: AssistantMessage["content"], billedInput = 0): AssistantMessage {
		const model = session.model;
		if (!model) throw new Error("Expected an active model");
		return {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
			usage: usage(billedInput),
			timestamp: ++timestamp,
		};
	}

	function seedToolTurn(id: string, text: string): void {
		sessionManager.appendMessage(assistant([{ type: "toolCall", id, name: "bash", arguments: { command: "pwd" } }]));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: ++timestamp,
		});
	}

	function seedTail(seed: string): UserMessage {
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: textOfTokens(40_500, seed) }],
			timestamp: ++timestamp,
		};
		sessionManager.appendMessage(message);
		return message;
	}

	function adoptSeededMessages(): void {
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	function seedFirstPhase(): { old1: string; old2: string; tail: UserMessage } {
		sessionManager.appendMessage({ role: "user", content: "Inspect the workspace.", timestamp: ++timestamp });
		const old1 = textOfTokens(22_000, "first");
		const old2 = textOfTokens(22_000, "second");
		seedToolTurn("old-1", old1);
		seedToolTurn("old-2", old2);
		const tail = seedTail("tail-one");
		adoptSeededMessages();
		return { old1, old2, tail };
	}

	function result(id: string): ToolResultMessage {
		const entry = sessionManager
			.getBranch()
			.find(
				entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id,
			);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error(`Expected tool result ${id}`);
		}
		return entry.message;
	}

	function expectShaken(id: string): string {
		const message = result(id);
		const text = textOfResult(message);
		expect(text).toMatch(/\[shaken ~\d+ tokens — recover: artifact:\/\/\S+ \(region \d+\)\]/);
		expect(message.prunedAt).toBeGreaterThan(0);
		const artifactId = /artifact:\/\/(\S+)/.exec(text)?.[1];
		if (!artifactId) throw new Error("Expected recovery artifact id");
		return artifactId;
	}

	function starts(): AgentSessionEvent[] {
		return events.filter(event => event.type === "auto_compaction_start");
	}

	function ends(): AgentSessionEvent[] {
		return events.filter(event => event.type === "auto_compaction_end");
	}

	async function trigger(billedInput: number): Promise<void> {
		const finalAssistant = assistant([{ type: "text", text: "ok" }], billedInput);
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	it("elides once, waits for enough new eligible content, then elides again without summarizing", async () => {
		enableTier();
		const compact = vi.spyOn(compactionModule, "compact");
		const { old1, old2, tail } = seedFirstPhase();
		const tailBefore = structuredClone(tail.content);

		await trigger(NEAR_TIER_TOKENS);

		const artifactId = expectShaken("old-1");
		expect(expectShaken("old-2")).toBe(artifactId);
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("Expected persisted shake artifact");
		const artifact = await Bun.file(artifactPath).text();
		expect(artifact).toContain(old1);
		expect(artifact).toContain(old2);
		expect(tail.content).toEqual(tailBefore);
		expect(starts()).toEqual([{ type: "auto_compaction_start", reason: "threshold", action: "shake" }]);
		expect(ends()).toEqual([
			{
				type: "auto_compaction_end",
				action: "shake",
				result: undefined,
				aborted: false,
				willRetry: false,
				skipped: false,
			},
		]);
		expect(compact).not.toHaveBeenCalled();
		expect(session.getContextUsage()?.tokens).toBeLessThan(NEAR_TIER_TOKENS);

		const mid = textOfTokens(6_000, "middle");
		seedToolTurn("mid-1", mid);
		seedTail("tail-two");
		adoptSeededMessages();

		await trigger(NEAR_TIER_TOKENS);

		expect(textOfResult(result("mid-1"))).toBe(mid);
		expect(result("mid-1").prunedAt).toBeUndefined();
		expect(starts()).toHaveLength(1);
		expect(ends()).toHaveLength(1);

		seedToolTurn("new-1", textOfTokens(38_000, "newest"));
		seedTail("tail-three");
		adoptSeededMessages();
		expect(session.agent.tokenizer.countMessages(session.agent.state.messages)).toBeLessThan(THRESHOLD_TOKENS);

		await trigger(NEAR_TIER_TOKENS);

		expectShaken("mid-1");
		expectShaken("new-1");
		expect(starts()).toHaveLength(2);
		expect(ends()).toHaveLength(2);
		for (const event of [...starts(), ...ends()]) expect(event).toHaveProperty("action", "shake");
		expect(compact).not.toHaveBeenCalled();
	});

	it("requires a larger saving the closer context is to the compaction threshold", async () => {
		enableTier();
		const compact = vi.spyOn(compactionModule, "compact");
		const { old1, old2 } = seedFirstPhase();

		// About 44K tokens are eligible. 10K below the threshold the floor is
		// 10% of it scaled by (threshold - tier) / headroom: 40K × 200K / 10K.
		await trigger(THRESHOLD_TOKENS - 10_000);

		expect(textOfResult(result("old-1"))).toBe(old1);
		expect(textOfResult(result("old-2"))).toBe(old2);
		expect(starts()).toHaveLength(0);
		expect(ends()).toHaveLength(0);

		await trigger(NEAR_TIER_TOKENS);

		expectShaken("old-1");
		expectShaken("old-2");
		expect(starts()).toHaveLength(1);
		expect(compact).not.toHaveBeenCalled();
	});

	it("leaves old results unchanged below the compaction threshold by default", async () => {
		const compact = vi.spyOn(compactionModule, "compact");
		const { old1, old2 } = seedFirstPhase();

		await trigger(NEAR_TIER_TOKENS);

		expect(textOfResult(result("old-1"))).toBe(old1);
		expect(textOfResult(result("old-2"))).toBe(old2);
		expect(starts()).toHaveLength(0);
		expect(ends()).toHaveLength(0);
		expect(compact).not.toHaveBeenCalled();
	});

	it("does not elide below threshold when shake is absent from the method order", async () => {
		enableTier();
		cfgCompactionMethodOrder.override(settings, ["soft"]);
		const compact = vi.spyOn(compactionModule, "compact");
		const { old1, old2 } = seedFirstPhase();

		await trigger(NEAR_TIER_TOKENS);

		expect(textOfResult(result("old-1"))).toBe(old1);
		expect(textOfResult(result("old-2"))).toBe(old2);
		expect(starts()).toHaveLength(0);
		expect(ends()).toHaveLength(0);
		expect(compact).not.toHaveBeenCalled();
	});

	it("elides at a continuing tool boundary and sends the rebuilt context on the next request", async () => {
		enableTier();
		const compact = vi.spyOn(compactionModule, "compact");
		seedFirstPhase();
		// Pre-prompt and final-turn local estimates remain below the tier. Only
		// the first response's billed usage can trigger the mid-turn pass.
		expect(session.agent.tokenizer.countMessages(session.agent.state.messages)).toBeLessThan(TIER_TOKENS);
		session.agent.setTools([
			{
				name: "noop",
				label: "No-op",
				description: "Return without changing the workspace",
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text", text: "unchanged" }] };
				},
			},
		]);
		const model = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call-noop", name: "noop", arguments: {} }],
					stopReason: "toolUse",
					usage: { cacheRead: NEAR_TIER_TOKENS },
				},
				{ content: ["done"], stopReason: "stop", usage: { cacheRead: 1_000 } },
			],
		});
		session.agent.streamFn = model.stream;

		await session.prompt("continue");
		await session.waitForIdle();

		expectShaken("old-1");
		expectShaken("old-2");
		expect(starts()).toEqual([{ type: "auto_compaction_start", reason: "threshold", action: "shake" }]);
		const shakeIndex = events.findIndex(event => event.type === "auto_compaction_start");
		const finalIndex = events.findIndex(
			event =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some(block => block.type === "text" && block.text === "done"),
		);
		expect(shakeIndex).toBeGreaterThanOrEqual(0);
		expect(finalIndex).toBeGreaterThan(shakeIndex);
		expect(model.calls).toHaveLength(2);
		const nextRequest = model.calls[1].context.messages;
		for (const id of ["old-1", "old-2"]) {
			const message = nextRequest.find(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
			);
			if (!message) throw new Error(`Expected ${id} in the second request`);
			expect(textOfResult(message)).toContain("artifact://");
		}
		expect(nextRequest).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "call-noop" }));
		expect(compact).not.toHaveBeenCalled();
	});
});
