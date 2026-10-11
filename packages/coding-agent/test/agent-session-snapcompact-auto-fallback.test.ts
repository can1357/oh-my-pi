import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const UNRENDERABLE_SNAPCOMPACT_TEXT = "\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	notices: string[];
	failures: string[];
	awaitCompactionEnd: () => Promise<{ action: string; errorMessage?: string }>;
	triggerThreshold: () => void;
}

interface HarnessOptions {
	activeModel: { provider: GeneratedProvider; id: string };
	seedMessages?: Message[];
	/** Null leaves compaction.methodOrder at its schema default. */
	methodOrder?: readonly CompactionMethod[] | null;
	retryMaxDelayMs?: number;
}

async function createHarness(modelRegistry: ModelRegistry, options: HarnessOptions): Promise<Harness> {
	const activeModel = getBundledModel(options.activeModel.provider, options.activeModel.id);
	if (!activeModel) throw new Error(`Missing bundled model ${options.activeModel.provider}/${options.activeModel.id}`);
	const agent = new Agent({
		initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const sessionManager = SessionManager.inMemory();
	const seed = options.seedMessages ?? [{ role: "user", content: "hello", timestamp: Date.now() }];
	for (const message of seed) sessionManager.appendMessage(message);
	const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
	if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");

	const methodOrder = options.methodOrder ?? ["snapcompact", "soft"];
	const settings = Settings.isolated({
		...(options.retryMaxDelayMs === undefined ? {} : { "retry.maxDelayMs": options.retryMaxDelayMs }),
		// Assert the blocking threshold pass itself; keep the speculation grace
		// band from deferring it.
		"compaction.asyncEnabled": false,
		...(options.methodOrder === null ? {} : { "compaction.methodOrder": [...methodOrder] }),
		// Force a 1-token recent window so the post-turn cut always splits off the
		// last turn and summarizes the seeded unrenderable history. With the default
		// 20k window the cut keeps both tiny messages, leaving nothing for
		// snapcompact's renderability preflight to scan.
		"compaction.keepRecentTokens": 1,
		modelRoles: { vision: "aimlapi/claude-sonnet-4-5-20250929" },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});
	vi.spyOn(compactionModule, "compact").mockResolvedValue({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId,
		tokensBefore: 123,
		details: {},
	});
	const end = Promise.withResolvers<{ action: string; errorMessage?: string }>();
	const notices: string[] = [];
	const failures: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		if (event.type === "auto_compaction_end" && event.errorMessage) failures.push(event.errorMessage);
		if (
			event.type === "auto_compaction_end" &&
			!event.aborted &&
			(event.result !== undefined || event.skipped === true)
		) {
			end.resolve({ action: event.action, errorMessage: event.errorMessage });
		}
	});

	const triggerThreshold = () => {
		// Prompt tokens above the auto-compaction threshold but below the model's
		// context window: post-turn maintenance must run a threshold compaction,
		// NOT the overflow recovery path (which drops the just-ended turn before
		// snapcompact's renderability preflight can scan it, leaving nothing to
		// summarize). Derived from the live window so the fixture survives model
		// metadata changes (claude-sonnet-4-5's 200k window is narrower than the
		// vision-role qwen's, so a fixed count would overflow one of them).
		const contextWindow = activeModel.contextWindow ?? 0;
		const thresholdTokens = compactionModule.resolveThresholdTokens(contextWindow, cfgCompaction.get(settings));
		const promptTokens = contextWindow > 0 ? Math.floor((thresholdTokens + contextWindow) / 2) : 246_000;
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			stopReason: "stop" as const,
			usage: {
				input: promptTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
	};

	return { session, sessionManager, notices, failures, awaitCompactionEnd: () => end.promise, triggerThreshold };
}

describe("AgentSession auto-snapcompact local-blocker fallback", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("aimlapi", "test-key");
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
	});

	it("uses soft compaction when snapcompact is unavailable for the active model", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "aimlapi", id: "alibaba/qwen3-coder-480b-a35b-instruct" },
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});

	it("uses snapcompact for a non-OpenAI vision model under the default preference order", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "aimlapi", id: "claude-sonnet-4-5-20250929" },
			methodOrder: null,
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();

		expect(result).toEqual({ action: "snapcompact", errorMessage: undefined });
		expect(compactionModule.compact).not.toHaveBeenCalled();
		expect(harness.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("uses OpenAI server compaction before local fallback methods by default", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "openai", id: "gpt-5" },
			methodOrder: null,
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();

		expect(result).toEqual({ action: "remote", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalledTimes(1);
	});

	it("falls through from a failed OpenAI server compaction to snapcompact", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "openai", id: "gpt-5" },
			methodOrder: null,
		});
		session = harness.session;
		vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("server compaction unavailable"));
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();

		expect(result).toEqual({ action: "snapcompact", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalledTimes(1);
	});

	it("advances past a long Anthropic native retry-after instead of parking the turn", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
			methodOrder: ["remote", "soft"],
			retryMaxDelayMs: 100,
		});
		session = harness.session;
		const waitSpy = mockSchedulerWaitWithClock();
		let attempts = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			if (++attempts === 1) {
				throw new compactionModule.NativeCompactionError(new Error("429 rate_limit_error retry-after-ms=60144000"));
			}
			return {
				summary: "fallback summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		harness.triggerThreshold();
		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(harness.failures.some(message => message.includes("trying the next preferred compaction method"))).toBe(
			true,
		);
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(waitSpy).not.toHaveBeenCalled();
	});

	it("surfaces the Anthropic error when no preferred method remains", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
			methodOrder: ["remote"],
		});
		session = harness.session;
		const waitSpy = mockSchedulerWaitWithClock();
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(
				new compactionModule.NativeCompactionError(new Error("429 rate_limit_error retry-after-ms=60144000")),
			);
		const end = Promise.withResolvers<string | undefined>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") end.resolve(event.errorMessage);
		});
		harness.triggerThreshold();
		expect(await end.promise).toContain("429 rate_limit_error retry-after-ms=60144000");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).not.toHaveBeenCalled();
	});

	it("downgrades to context-full when unsupported glyphs make snapcompact unsafe", async () => {
		const harness = await createHarness(modelRegistry, {
			activeModel: { provider: "aimlapi", id: "claude-sonnet-4-5-20250929" },
			seedMessages: [
				{
					role: "user",
					content: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(10),
					timestamp: Date.now(),
				},
			],
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(result.errorMessage).toBeUndefined();
		expect(compactionModule.compact).toHaveBeenCalled();
		const unsupportedGlyphNotice = harness.notices.find(message =>
			message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
		);
		expect(unsupportedGlyphNotice).toContain("trying the next preferred compaction method.");
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});
});
