import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentToolCall } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

const BIG_RESULT = "DROP-ME:" + "discardable output ".repeat(18_000);
const SECOND_RESULT = "SHORTEN-ME:" + "secondary details ".repeat(7_000);
const PROTECTED_RECENT_RESULT = "protected recent output ".repeat(16_000);
const RETAINED_CONSTRAINT = "RETAINED-CONSTRAINT: never remove the database migration safety check.";
const TAIL_TEXT = "recent retained dialogue ".repeat(100);
const LIVE_TAIL = "LIVE-TAIL: preserve this pending user constraint.";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type JevAction = "keep" | "truncate_result" | "drop_pair";
type JevReplyMode =
	| { kind: "answers"; action: (candidateId: string) => JevAction }
	| { kind: "missing" }
	| { kind: "out-of-range" }
	| { kind: "http-error" }
	| { kind: "held"; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
	| { kind: "abort-only"; entered: PromiseWithResolvers<void> };

interface SeededPair {
	callId: string;
	callEntry: SessionMessageEntry;
	resultEntry: SessionMessageEntry;
	originalResult: string;
}

interface BoosterHarness {
	tempDir: TempDir;
	authStorage: AuthStorage;
	sessionManager: SessionManager;
	settings: Settings;
	session: AgentSession;
	primary: MockModel;
	model: Model;
	preparations: CompactionPreparation[];
	events: AgentSessionEvent[];
	pairs: SeededPair[];
	cleanup(): Promise<void>;
}

interface HarnessOptions {
	boosterEnabled?: boolean;
	typeSafeAuth?: boolean;
	methodOrder?: Array<"shake" | "soft" | "handoff">;
	candidateSizes?: number[];
	retainedPressureChars?: number;
	thresholdPercent?: number;
	primaryResponses?: MockResponse[];
	sharedAncestorPair?: boolean;
	shortCircuitCompaction?: boolean;
	secretFixture?: {
		secret: string;
		obfuscator: SecretObfuscator;
		assistant?: boolean;
		candidateArguments?: boolean;
		protectedArguments?: boolean;
	};
}

const activeHarnesses: BoosterHarness[] = [];

function assistant(model: Model, text: string, input = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: { ...ZERO_USAGE, input, totalTokens: input },
		timestamp: Date.now(),
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return JSON.stringify(block.arguments);
			return "";
		})
		.join("\n");
}

function entry(manager: SessionManager, id: string): SessionMessageEntry {
	const found = manager.getEntry(id);
	if (found?.type !== "message") throw new Error(`Expected message entry ${id}`);
	return found;
}

function appendPair(
	manager: SessionManager,
	model: Model,
	callId: string,
	resultText: string,
	secretSuffixes: { assistant?: string; arguments?: string } = {},
): SeededPair {
	const callEntryId = manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: `Running ${callId}.${secretSuffixes.assistant ?? ""}` },
			{
				type: "toolCall",
				id: callId,
				name: "bash",
				arguments: { command: `inspect ${callId}${secretSuffixes.arguments ?? ""}` },
			},
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		usage: ZERO_USAGE,
		timestamp: Date.now(),
	});
	const resultEntryId = manager.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: resultText }],
		isError: false,
		timestamp: Date.now(),
	});
	return {
		callId,
		callEntry: entry(manager, callEntryId),
		resultEntry: entry(manager, resultEntryId),
		originalResult: resultText,
	};
}

function appendRecentTail(manager: SessionManager, model: Model): void {
	for (let index = 0; index < 8; index++) {
		if (index % 2 === 0) {
			manager.appendMessage({
				role: "user",
				content: `${TAIL_TEXT}${index}`,
				timestamp: Date.now(),
			});
		} else {
			manager.appendMessage(assistant(model, `${TAIL_TEXT}${index}`, index === 7 ? 100_000 : 0));
		}
	}
}

async function createHarness(options: HarnessOptions = {}): Promise<BoosterHarness> {
	const tempDir = TempDir.createSync("@omp-jev-booster-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	if (options.typeSafeAuth !== false) authStorage.setRuntimeApiKey("typesafe", "typesafe-test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic model");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

	const secret = options.secretFixture?.secret;
	sessionManager.appendMessage({
		role: "user",
		content: secret === undefined ? RETAINED_CONSTRAINT : `${RETAINED_CONSTRAINT} User secret: ${secret}`,
		timestamp: Date.now(),
	});
	const pairs: SeededPair[] = [];
	const sizes = options.candidateSizes ?? [BIG_RESULT.length];
	for (let index = 0; index < sizes.length; index++) {
		const source = index === 0 ? BIG_RESULT : SECOND_RESULT;
		const size = sizes[index] ?? source.length;
		const assistantSuffix =
			index === 0 && options.secretFixture && options.secretFixture.assistant !== false
				? ` Assistant secret: ${options.secretFixture.obfuscator.obfuscate(options.secretFixture.secret)}`
				: undefined;
		pairs.push(
			appendPair(sessionManager, model, `jev-call-${index + 1}`, source.slice(0, size), {
				assistant: assistantSuffix,
				arguments:
					index === 0 && options.secretFixture?.candidateArguments === true
						? ` --token=${options.secretFixture.secret}`
						: undefined,
			}),
		);
	}
	// Recent-output protection counts tool-result tokens, not intervening dialogue.
	// This oversized newest result is deliberately pinned while moving the older
	// fixture pairs outside the 40k protection window.
	appendPair(sessionManager, model, "recent-protected-call", PROTECTED_RECENT_RESULT, {
		arguments:
			options.secretFixture && options.secretFixture.protectedArguments !== false
				? ` --token=${options.secretFixture.obfuscator.obfuscate(options.secretFixture.secret)}`
				: undefined,
	});

	if (options.sharedAncestorPair) {
		const shared = pairs[0];
		if (!shared) throw new Error("Shared-ancestor fixture needs a pair");
		sessionManager.appendMessageToBranch(
			{ role: "user", content: "sibling branch conversation", timestamp: Date.now() },
			shared.resultEntry.id,
		);
	}

	const retainedPressureChars = options.retainedPressureChars ?? 0;
	if (retainedPressureChars > 0) {
		sessionManager.appendMessage({
			role: "user",
			content: `NON-PRUNABLE-PRESSURE:${"P".repeat(retainedPressureChars)}`,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistant(model, "Pressure acknowledged."));
	}
	appendRecentTail(sessionManager, model);
	sessionManager.appendMessage({ role: "user", content: LIVE_TAIL, timestamp: Date.now() });

	const primary = createMockModel({
		handler: () => ({ content: ["primary response"], usage: { input: 1_000, output: 10 } }),
		responses: options.primaryResponses,
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: primary.stream,
	});
	const settings = Settings.isolated({
		"compaction.enabled": true,
		"compaction.boosterEnabled": options.boosterEnabled ?? true,
		"compaction.asyncEnabled": false,
		"compaction.autoContinue": false,
		"compaction.keepRecentTokens": 1,
		"compaction.thresholdPercent": options.thresholdPercent ?? 1,
		"compaction.methodOrder": options.methodOrder ?? ["soft"],
		"contextPromotion.enabled": false,
		"providers.judgmentProvider": "typesafe",
	});
	const preparations: CompactionPreparation[] = [];
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("session_before_compact", event => {
				preparations.push(event.preparation);
				if (options.shortCircuitCompaction === false) return undefined;
				return {
					compaction: {
						summary: "fallback compactor summary",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"jev-booster-test-compactor",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner,
		obfuscator: options.secretFixture?.obfuscator,
	});
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => events.push(event));

	let cleaned = false;
	const harness: BoosterHarness = {
		tempDir,
		authStorage,
		sessionManager,
		settings,
		session,
		primary,
		model,
		preparations,
		events,
		pairs,
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
	activeHarnesses.push(harness);
	return harness;
}

function answersFor(
	questions: Record<string, unknown>,
	action: (candidateId: string) => JevAction,
): Record<string, { type: "noul"; noul: number }> {
	return Object.fromEntries(
		Object.keys(questions).map(questionId => {
			const candidateId = questionId.replace(/^(call|result)_/, "");
			const decision = action(candidateId);
			const noul = questionId.startsWith("result_")
				? decision === "keep"
					? 0.9
					: 0.1
				: decision === "drop_pair"
					? 0.1
					: 0.9;
			return [questionId, { type: "noul" as const, noul }];
		}),
	);
}

function installTypeSafe(mode: JevReplyMode): {
	requests: Array<{ state: unknown; questions: Record<string, unknown> }>;
} {
	const requests: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { state: unknown; questions: Record<string, unknown> };
			requests.push(body);
			if (mode.kind === "http-error") return new Response("invalid scorer request", { status: 422 });
			if (mode.kind === "held") {
				mode.entered.resolve();
				await mode.release.promise;
			}
			if (mode.kind === "abort-only") {
				mode.entered.resolve();
				const aborted = Promise.withResolvers<Response>();
				const signal = init?.signal;
				if (signal?.aborted) aborted.reject(signal.reason);
				else signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
				return await aborted.promise;
			}
			const answerAction = mode.kind === "answers" ? mode.action : () => "drop_pair" as const;
			const answers = answersFor(body.questions, answerAction);
			if (mode.kind === "missing") delete answers[Object.keys(answers)[0] ?? ""];
			if (mode.kind === "out-of-range") {
				const first = Object.keys(answers)[0];
				if (first) answers[first] = { type: "noul", noul: 1.5 };
			}
			return Response.json({
				model: "jev-test",
				answers,
				usage: { input_tokens: 20, output_tokens: 2 },
			});
		}),
	);
	return { requests };
}

function preparationMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages, ...preparation.recentMessages];
}

function rawResult(pair: SeededPair): ToolResultMessage {
	if (pair.resultEntry.message.role !== "toolResult") throw new Error("Expected native tool result");
	return pair.resultEntry.message;
}

function hasText(messages: readonly AgentMessage[], text: string): boolean {
	return messages.some(message => messageText(message).includes(text));
}

function expectBalancedPruneLifecycle(events: readonly AgentSessionEvent[]): void {
	const starts = events.filter(event => event.type === "auto_compaction_start" && event.action === "prune");
	const ends = events.filter(event => event.type === "auto_compaction_end" && event.action === "prune");
	expect(ends).toHaveLength(starts.length);
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(activeHarnesses.splice(0).map(harness => harness.cleanup()));
});

describe("optional Jev compaction booster", () => {
	it("keeps the disabled route byte-for-byte and runs the configured compactor without scoring", async () => {
		const harness = await createHarness({ boosterEnabled: false });
		const typeSafe = installTypeSafe({ kind: "answers", action: () => "drop_pair" });

		await harness.session.runIdleCompaction();

		expect(typeSafe.requests).toHaveLength(0);
		expect(harness.preparations).toHaveLength(1);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expect(messageText(rawResult(harness.pairs[0]!))).toBe(harness.pairs[0]!.originalResult);
	});

	it("does not invoke the booster for explicit manual compaction", async () => {
		const harness = await createHarness();
		const typeSafe = installTypeSafe({ kind: "answers", action: () => "drop_pair" });

		await harness.session.compact();

		expect(typeSafe.requests).toHaveLength(0);
		expect(harness.preparations).toHaveLength(1);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(harness.events);
	});

	it("commits drop and truncate decisions with real token savings, skips the heavy compactor, and sends valid retained context", async () => {
		const harness = await createHarness({ candidateSizes: [BIG_RESULT.length, SECOND_RESULT.length] });
		const typeSafe = installTypeSafe({
			kind: "answers",
			action: candidateId => (candidateId === "t1" ? "drop_pair" : "truncate_result"),
		});

		await harness.session.runIdleCompaction();

		expect(typeSafe.requests).toHaveLength(1);
		expect(harness.preparations).toHaveLength(0);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBe(true);
		expect(messageText(rawResult(harness.pairs[0]!))).toBe(BIG_RESULT);
		const shortened = messageText(rawResult(harness.pairs[1]!));
		expect(shortened).toStartWith(SECOND_RESULT.slice(0, 300));
		expect(shortened).toContain("artifact://");
		expectBalancedPruneLifecycle(harness.events);
		harness.session.setAutoCompactionEnabled(false);

		await harness.session.prompt("continue with the retained constraint");
		const request = harness.primary.calls.at(-1)?.context.messages;
		if (!request) throw new Error("Expected a provider request after pruning");
		expect(hasText(request, RETAINED_CONSTRAINT)).toBe(true);
		expect(hasText(request, "DROP-ME:")).toBe(false);
		expect(hasText(request, "SHORTEN-ME:")).toBe(true);
	});

	it("obfuscates every secret-bearing Jev state field without losing the selected pair", async () => {
		const secret = "JEV_BOUNDARY_SECRET_123456789";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], "jev-boundary-test-key");
		const placeholder = obfuscator.obfuscate(secret);
		const harness = await createHarness({ secretFixture: { secret, obfuscator } });
		const typeSafe = installTypeSafe({
			kind: "answers",
			action: candidateId => (candidateId === "t1" ? "drop_pair" : "keep"),
		});

		await harness.session.runIdleCompaction();

		expect(typeSafe.requests).toHaveLength(1);
		const outboundState = JSON.stringify(typeSafe.requests[0]!.state);
		expect(outboundState).toContain(placeholder);
		expect(outboundState).not.toContain(secret);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBe(true);
	});

	it.each([
		[
			"JSON-escaped",
			'JEV_"QUOTED"_SECRET\nWITH\\SLASH_123456789',
			JSON.stringify('JEV_"QUOTED"_SECRET\nWITH\\SLASH_123456789').slice(1, -1),
		],
		["over input cap", `JEV_LONG_TOOL_SECRET_${"L".repeat(1_500)}`, "JEV_LONG_TOOL_SECRET_" + "L".repeat(40)],
	] as const)(
		"obfuscates %s secrets before Jev serializes or truncates tool inputs",
		async (name, secret, distinctive) => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], `jev-${name}-key`);
			const placeholder = obfuscator.obfuscate(secret);
			const harness = await createHarness({
				secretFixture: {
					secret,
					obfuscator,
					assistant: false,
					candidateArguments: true,
					protectedArguments: false,
				},
			});
			const originalCall = structuredClone(harness.pairs[0]!.callEntry.message);
			const typeSafe = installTypeSafe({ kind: "answers", action: () => "keep" });

			await harness.session.runIdleCompaction();

			expect(typeSafe.requests).toHaveLength(1);
			const state = typeSafe.requests[0]!.state as {
				history?: Array<{ tool_calls?: Array<{ id?: string; input?: string }> }>;
			};
			const toolInput = state.history
				?.flatMap(history => history.tool_calls ?? [])
				.find(call => call.id === "t1")?.input;
			expect(toolInput).toContain(placeholder);
			expect(toolInput).not.toContain(distinctive);
			expect(harness.pairs[0]!.callEntry.message).toEqual(originalCall);
		},
	);

	it("measures Jev savings from the active placeholder context and falls through when actual pruning is insufficient", async () => {
		const secret = `JEV_LONG_SECRET_${"S".repeat(500_000)}`;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], "jev-counting-test-key");
		const harness = await createHarness({
			secretFixture: { secret, obfuscator },
			candidateSizes: [12_000],
			retainedPressureChars: 420_000,
			methodOrder: ["soft"],
		});
		installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		const pair = harness.pairs[0]!;
		const beforePairTokens =
			harness.session.agent.tokenizer.countMessage(pair.callEntry.message) +
			harness.session.agent.tokenizer.countMessage(pair.resultEntry.message);

		await harness.session.prompt("trigger pressure maintenance");

		expect(harness.preparations).toHaveLength(1);
		const afterPairTokens =
			harness.session.agent.tokenizer.countMessage(pair.callEntry.message) +
			harness.session.agent.tokenizer.countMessage(pair.resultEntry.message);
		const actualTokensSaved = Math.max(0, beforePairTokens - afterPairTokens);
		const notice = harness.events.find(
			event =>
				event.type === "notice" && event.source === "compaction" && event.message.startsWith("Jev pruning omitted"),
		);
		if (notice?.type !== "notice") throw new Error("Expected the Jev savings notice");
		expect(notice.message).toContain(`saved ~${actualTokensSaved.toLocaleString("en-US")} tokens.`);
	});

	it("falls through once on insufficient savings after shake and does not score again on the soft fallback", async () => {
		const harness = await createHarness({
			candidateSizes: [12_000],
			retainedPressureChars: 420_000,
			methodOrder: ["shake", "soft"],
		});
		const typeSafe = installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		const shake = vi.spyOn(harness.session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});

		await harness.session.prompt("trigger pressure maintenance");

		expect(typeSafe.requests).toHaveLength(1);
		expect(shake).toHaveBeenCalledTimes(1);
		expect(harness.preparations).toHaveLength(1);
		const fallbackMessages = preparationMessages(harness.preparations[0]!);
		expect(hasText(fallbackMessages, "DROP-ME:")).toBe(false);
		expectBalancedPruneLifecycle(harness.events);
	});

	it("scores only once before a threshold handoff is deferred and completed", async () => {
		const harness = await createHarness({
			candidateSizes: [12_000],
			methodOrder: ["handoff", "soft"],
			thresholdPercent: 90,
			shortCircuitCompaction: false,
			primaryResponses: [
				{
					content: ["threshold trigger"],
					usage: { input: 190_000, output: 1_000 },
				},
			],
		});
		const typeSafe = installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		const handoff = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue after Jev pruning");

		await harness.session.prompt("trigger deferred handoff");

		expect(typeSafe.requests).toHaveLength(1);
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getEntries().filter(item => item.type === "compaction")).toHaveLength(1);
		expectBalancedPruneLifecycle(harness.events);
	});

	it("uses ordinary compaction for unavailable or invalid scoring without any partial history rewrite", async () => {
		const cases: Array<{ name: string; auth: boolean; mode: JevReplyMode; expectedRequests: number }> = [
			{
				name: "missing auth",
				auth: false,
				mode: { kind: "answers", action: () => "drop_pair" },
				expectedRequests: 0,
			},
			{ name: "missing probability", auth: true, mode: { kind: "missing" }, expectedRequests: 1 },
			{ name: "out-of-range probability", auth: true, mode: { kind: "out-of-range" }, expectedRequests: 1 },
			{ name: "HTTP failure", auth: true, mode: { kind: "http-error" }, expectedRequests: 1 },
		];

		for (const item of cases) {
			const harness = await createHarness({
				typeSafeAuth: item.auth,
				candidateSizes: [BIG_RESULT.length, SECOND_RESULT.length],
			});
			const typeSafe = installTypeSafe(item.mode);
			await harness.session.runIdleCompaction();
			expect(typeSafe.requests, item.name).toHaveLength(item.expectedRequests);
			expect(harness.preparations, item.name).toHaveLength(1);
			expect(rawResult(harness.pairs[0]!).contextOmitted, item.name).toBeUndefined();
			expect(rawResult(harness.pairs[1]!).contextOmitted, item.name).toBeUndefined();
			expectBalancedPruneLifecycle(harness.events);
			vi.restoreAllMocks();
		}
	});

	it("falls back after the whole-pass deadline, while caller cancellation neither falls back nor mutates", async () => {
		const deadlineHarness = await createHarness();
		const deadlineController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadlineController.signal);
		const deadlineEntered = Promise.withResolvers<void>();
		installTypeSafe({ kind: "abort-only", entered: deadlineEntered });
		const deadlineRun = deadlineHarness.session.runIdleCompaction();
		await deadlineEntered.promise;
		deadlineController.abort(new DOMException("deadline", "TimeoutError"));
		await deadlineRun;
		expect(deadlineHarness.preparations).toHaveLength(1);
		expect(rawResult(deadlineHarness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(deadlineHarness.events);

		vi.restoreAllMocks();
		const cancelHarness = await createHarness();
		const cancelEntered = Promise.withResolvers<void>();
		installTypeSafe({ kind: "abort-only", entered: cancelEntered });
		const cancelRun = cancelHarness.session.runIdleCompaction();
		await cancelEntered.promise;
		cancelHarness.session.abortCompaction(new Error("caller cancelled"));
		await cancelRun;
		expect(cancelHarness.preparations).toHaveLength(0);
		expect(rawResult(cancelHarness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(cancelHarness.events);
	});

	it("discards a held score when the active branch leaf changes and never falls back on the successor", async () => {
		const harness = await createHarness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		installTypeSafe({ kind: "held", entered, release });
		const run = harness.session.runIdleCompaction();
		await entered.promise;

		harness.sessionManager.appendMessage({
			role: "user",
			content: "successor branch owns this leaf",
			timestamp: Date.now(),
		});
		release.resolve();
		await run;

		expect(harness.preparations).toHaveLength(0);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(harness.events);
	});

	it("discards a held score when prompt generation changes", async () => {
		const harness = await createHarness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		installTypeSafe({ kind: "held", entered, release });
		const run = harness.session.runIdleCompaction();
		await entered.promise;

		await harness.session.resetSessionContext();
		release.resolve();
		await run;

		expect(harness.preparations).toHaveLength(0);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(harness.events);
	});

	it("discards a held score when the model changes", async () => {
		const harness = await createHarness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		installTypeSafe({ kind: "held", entered, release });
		const run = harness.session.runIdleCompaction();
		await entered.promise;
		const replacement = { ...harness.model, id: `${harness.model.id}-replacement` };
		harness.session.agent.setModel(replacement);
		release.resolve();
		await run;

		expect(harness.preparations).toHaveLength(0);
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expectBalancedPruneLifecycle(harness.events);
	});

	it("rolls a held rewrite out of a successor generation without replacing or continuing its leaf", async () => {
		const harness = await createHarness();
		installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		const rewriteStarted = Promise.withResolvers<void>();
		const releaseRewrite = Promise.withResolvers<void>();
		const originalRewrite = harness.sessionManager.rewriteEntries.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "rewriteEntries").mockImplementation(async () => {
			rewriteStarted.resolve();
			await releaseRewrite.promise;
			await originalRewrite();
		});

		const run = harness.session.runIdleCompaction();
		await rewriteStarted.promise;
		await harness.session.resetSessionContext();
		const successorId = harness.sessionManager.appendMessage({
			role: "user",
			content: "SUCCESSOR-CONTEXT-MUST-SURVIVE",
			timestamp: Date.now(),
		});
		const successor: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "SUCCESSOR-CONTEXT-MUST-SURVIVE" }],
			timestamp: Date.now(),
		};
		harness.session.agent.replaceMessages([successor]);
		harness.session.agent.setModel({ ...harness.model, id: `${harness.model.id}-successor` });
		releaseRewrite.resolve();
		await run;

		expect(harness.session.agent.state.messages).toEqual([successor]);
		expect(harness.sessionManager.getEntry(successorId)).toBeDefined();
		const rawCall = harness.sessionManager.getEntry(harness.pairs[0]!.callEntry.id);
		if (rawCall?.type !== "message" || rawCall.message.role !== "assistant") {
			throw new Error("Expected the candidate tool-call entry");
		}
		const rawCallBlock = rawCall.message.content.find(
			(block): block is AgentToolCall => block.type === "toolCall" && block.id === harness.pairs[0]!.callId,
		);
		if (!rawCallBlock) throw new Error("Expected the candidate tool call");
		expect(rawCallBlock.contextOmitted).toBeUndefined();
		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expect(rawResult(harness.pairs[0]!).prunedAt).toBeUndefined();
		expect(harness.preparations).toHaveLength(0);
		expect(harness.primary.calls).toHaveLength(0);

		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected file-backed session");
		const reopened = await SessionManager.open(sessionFile, harness.tempDir.path());
		try {
			expect(reopened.getEntry(successorId)).toBeDefined();
			const reopenedCall = reopened.getEntry(harness.pairs[0]!.callEntry.id);
			if (reopenedCall?.type !== "message" || reopenedCall.message.role !== "assistant") {
				throw new Error("Expected the reopened candidate tool-call entry");
			}
			const reopenedCallBlock = reopenedCall.message.content.find(
				(block): block is AgentToolCall => block.type === "toolCall" && block.id === harness.pairs[0]!.callId,
			);
			if (!reopenedCallBlock) throw new Error("Expected the reopened candidate tool call");
			const reopenedResult = reopened.getEntry(harness.pairs[0]!.resultEntry.id);
			expect(reopenedCallBlock.contextOmitted).toBeUndefined();
			expect(
				reopenedResult?.type === "message" && reopenedResult.message.role === "toolResult"
					? reopenedResult.message.contextOmitted
					: undefined,
			).toBeUndefined();
			expect(
				reopenedResult?.type === "message" && reopenedResult.message.role === "toolResult"
					? reopenedResult.message.prunedAt
					: undefined,
			).toBeUndefined();
		} finally {
			await reopened.close();
		}
		expectBalancedPruneLifecycle(harness.events);
	});

	it("rolls live and persisted history back when the transactional rewrite fails", async () => {
		const harness = await createHarness();
		await harness.sessionManager.rewriteEntries();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected file-backed session");
		installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		vi.spyOn(harness.sessionManager, "rewriteEntries").mockRejectedValueOnce(new Error("injected rewrite failure"));

		await harness.session.runIdleCompaction();

		expect(rawResult(harness.pairs[0]!).contextOmitted).toBeUndefined();
		expect(harness.preparations).toHaveLength(1);
		expect(hasText(preparationMessages(harness.preparations[0]!), "DROP-ME:")).toBe(true);
		const reopened = await SessionManager.open(sessionFile, harness.tempDir.path());
		try {
			const diskResult = reopened
				.getEntries()
				.find(
					item =>
						item.type === "message" &&
						item.message.role === "toolResult" &&
						item.message.toolCallId === harness.pairs[0]!.callId,
				);
			expect(
				diskResult?.type === "message" && diskResult.message.role === "toolResult"
					? diskResult.message.contextOmitted
					: undefined,
			).toBeUndefined();
			expect(
				diskResult?.type === "message" && diskResult.message.role === "toolResult"
					? messageText(diskResult.message)
					: undefined,
			).toBe(BIG_RESULT);
		} finally {
			await reopened.close();
		}
		expectBalancedPruneLifecycle(harness.events);
	});

	it("persists omission across resume and fork, retains raw transcript bodies and resolvable cutoffs, and pins shared ancestors", async () => {
		const harness = await createHarness({
			candidateSizes: [BIG_RESULT.length, SECOND_RESULT.length],
			sharedAncestorPair: true,
		});
		const typeSafe = installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		await harness.session.runIdleCompaction();

		const shared = harness.pairs[0]!;
		const activeOnly = harness.pairs[1]!;
		expect(typeSafe.requests).toHaveLength(1);
		expect(rawResult(shared).contextOmitted).toBeUndefined();
		expect(rawResult(activeOnly).contextOmitted).toBe(true);
		expect(messageText(rawResult(activeOnly))).toBe(SECOND_RESULT);

		harness.settings.override("compaction.boosterEnabled", false);
		await harness.session.runIdleCompaction();
		const compaction = harness.sessionManager.getEntries().findLast(item => item.type === "compaction");
		if (compaction?.type !== "compaction") throw new Error("Expected the ordinary compaction cutoff");
		const firstKeptEntryId = compaction.firstKeptEntryId;

		await harness.sessionManager.rewriteEntries();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted booster session");
		const resumed = await SessionManager.open(sessionFile, harness.tempDir.path());
		try {
			expect(hasText(resumed.buildSessionContext().messages, "SHORTEN-ME:")).toBe(false);
			const raw = resumed.getEntries().find(item => item.id === activeOnly.resultEntry.id);
			expect(
				raw?.type === "message" && raw.message.role === "toolResult" ? messageText(raw.message) : undefined,
			).toBe(SECOND_RESULT);
			expect(
				raw?.type === "message" && raw.message.role === "toolResult" ? raw.message.contextOmitted : undefined,
			).toBe(true);
			const rawCall = resumed.getEntry(activeOnly.callEntry.id);
			const callBlock =
				rawCall?.type === "message" && rawCall.message.role === "assistant"
					? rawCall.message.content.find(block => block.type === "toolCall" && block.id === activeOnly.callId)
					: undefined;
			expect(callBlock).toMatchObject({
				contextOmitted: true,
				arguments: { command: `inspect ${activeOnly.callId}` },
			});
			expect(resumed.getEntry(firstKeptEntryId)).toBeDefined();

			const forked = await SessionManager.forkFrom(
				sessionFile,
				harness.tempDir.path(),
				path.join(harness.tempDir.path(), "fork"),
				undefined,
				{ suppressBreadcrumb: true },
			);
			try {
				expect(hasText(forked.buildSessionContext().messages, "SHORTEN-ME:")).toBe(false);
				expect(forked.getEntry(firstKeptEntryId)).toBeDefined();
				const forkedRaw = forked.getEntry(activeOnly.resultEntry.id);
				expect(
					forkedRaw?.type === "message" && forkedRaw.message.role === "toolResult"
						? forkedRaw.message.contextOmitted
						: undefined,
				).toBe(true);
			} finally {
				await forked.close();
			}
		} finally {
			await resumed.close();
		}
	});

	it("a later normal compaction never reintroduces omitted pairs and the next provider answer becomes the fresh usage anchor", async () => {
		const harness = await createHarness();
		installTypeSafe({ kind: "answers", action: () => "drop_pair" });
		const before = harness.session.getContextUsage()?.tokens;
		await harness.session.runIdleCompaction();
		const afterPrune = harness.session.getContextUsage()?.tokens;
		expect(typeof before).toBe("number");
		expect(typeof afterPrune).toBe("number");
		expect(afterPrune as number).toBeLessThan(before as number);

		harness.settings.override("compaction.boosterEnabled", false);
		await harness.session.runIdleCompaction();
		expect(harness.preparations).toHaveLength(1);
		expect(hasText(preparationMessages(harness.preparations[0]!), "DROP-ME:")).toBe(false);
		expect(hasText(harness.session.agent.state.messages, "DROP-ME:")).toBe(false);
		harness.session.setAutoCompactionEnabled(false);

		await harness.session.prompt("establish a fresh provider usage anchor");
		const lastAssistant = harness.sessionManager
			.getBranch()
			.findLast(item => item.type === "message" && item.message.role === "assistant");
		expect(
			lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
				? lastAssistant.message.usage.input
				: undefined,
		).toBe(1_000);
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1_000);
		expect(hasText(harness.primary.calls.at(-1)?.context.messages ?? [], "DROP-ME:")).toBe(false);
		expect(hasText(harness.primary.calls.at(-1)?.context.messages ?? [], LIVE_TAIL)).toBe(true);
	});
});
