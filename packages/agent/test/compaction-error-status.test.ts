import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@oh-my-pi/pi-agent-core/compaction";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Pins the fix for the "raw 401 surfaced as Compaction failed:" bug.
//
// When a real provider returns HTTP 401/403 from a summarization call,
// `instrumentedCompleteSimple` resolves with `stopReason: "error"` and
// `errorStatus` populated by the provider's catch block (e.g.
// `packages/ai/src/providers/anthropic.ts`). The compaction layer must
// surface that status on the thrown Error so
// `AgentSession.#isCompactionAuthFailure` can route to the authenticated
// fallback model instead of dumping the raw `<status> <body>` string
// into the UI.
//
// `generateHandoff` is the cheapest vehicle (one LLM call). The same
// `createSummarizationError` helper backs every provider-error throw site
// in `packages/agent/src/compaction/compaction.ts`, so verifying one
// site is sufficient to lock that contract.

function makeAssistantStop(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makeAssistantError(errorStatus: number | undefined, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		...(errorStatus !== undefined ? { errorStatus } : {}),
	};
}

function makeAssistantLength(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...makeAssistantStop(content),
		stopReason: "length",
		errorStatus: 401,
		errorId: AIError.create(AIError.Flag.AuthFailed),
		errorMessage: "auth_unavailable",
	};
}

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const handoffMessages: AgentMessage[] = [
	{ role: "user", content: "begin", timestamp: 1 },
	makeAssistantStop([{ type: "text", text: "ok" }]),
];

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			makeUserMessage("history msg"),
			makeAssistantStop([{ type: "text", text: "history reply" }]),
		],
		turnPrefixMessages: [makeUserMessage("turn prefix msg")],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: snapcompact.createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

/** A length stop is local: the error carries no stale provider status, so it never reads as an auth failure. */
function expectIncompleteSummaryError(error: unknown, prefix: string): void {
	expect(error).toBeInstanceOf(Error);
	const e = error as Error & { status?: number };
	expect(e.message).toBe(`${prefix}: model output ended incomplete (stopReason: length)`);
	expect(e.status).toBeUndefined();
	expect(AIError.is(AIError.classify(e.message), AIError.Flag.AuthFailed)).toBe(false);
}

/** Only the turn-prefix summary request carries this prompt line; the history summary request does not. */
const TURN_PREFIX_PROMPT = "MUST summarize prefix for retained suffix:";

function isTurnPrefixRequest(ctx: Context): boolean {
	return JSON.stringify(ctx.messages).includes(TURN_PREFIX_PROMPT);
}

/**
 * Resolves on the next macrotask, after every promise job queued before it has
 * run. On the local split-summary path `compact()` starts, fails and cancels its
 * requests through promise jobs alone (the requests run on `completeImpl`; no
 * timer, no I/O), so this boundary orders those steps. It measures no time.
 */
function afterQueuedJobs(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

type RequestState = "idle" | "running" | "stopped";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction error-status propagation", () => {
	test("generateHandoff throws Error with .status === 401 when provider returns 401", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(
				401,
				'401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
			),
		);

		const error = await generateHandoff(handoffMessages, getAnthropicModel(), "stale-key", {
			systemPrompt: ["sp"],
			tools: [],
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		expect(e.status).toBe(401);
		// Message still carries the upstream body so logs and telemetry
		// retain the raw provider envelope.
		expect(e.message).toContain("Handoff generation failed");
		expect(e.message).toContain("authentication_error");
	});

	test("compact() fan-out throws Error with .status === 403 when provider returns 403", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(403, '403 {"error":{"type":"forbidden","message":"Access denied"}}'),
		);

		const error = await compact(makePreparation(), getAnthropicModel(), "stale-key").catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		expect(e.status).toBe(403);
		expect(e.message).toMatch(/Summarization failed|Turn prefix summarization failed/);
	});

	test("missing errorStatus does not attach .status (preserves auth_unavailable regex path)", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(undefined, "503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)"),
		);

		const error = await generateHandoff(handoffMessages, getAnthropicModel(), "stale-key", {
			systemPrompt: ["sp"],
			tools: [],
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		// Synthetic pi-native gateway errors don't carry HTTP status; the
		// upstream regex on `auth_unavailable` is the load-bearing detector.
		expect(e.status).toBeUndefined();
		expect(e.message).toContain("auth_unavailable");
	});
});

describe("incomplete local summaries", () => {
	test("compact rejects a full summary that hit the output limit without another call", async () => {
		const completeImpl = vi.fn(async () => makeAssistantLength([{ type: "text", text: "The remaining work is to" }]));
		const error = await compact(
			makePreparation({ isSplitTurn: false, turnPrefixMessages: [] }),
			getAnthropicModel(),
			"key",
			undefined,
			undefined,
			{ completeImpl },
		).catch((caught: unknown) => caught);

		expectIncompleteSummaryError(error, "Summarization failed");
		expect(completeImpl).toHaveBeenCalledTimes(1);
	});

	test("compact rejects a split-turn prefix summary that hit the output limit", async () => {
		const error = await compact(makePreparation(), getAnthropicModel(), "key", undefined, undefined, {
			completeImpl: async (_model, ctx) =>
				isTurnPrefixRequest(ctx)
					? makeAssistantLength([{ type: "thinking", thinking: "Preparing the summary" }])
					: makeAssistantStop([{ type: "text", text: "Complete history summary." }]),
		}).catch((caught: unknown) => caught);

		expectIncompleteSummaryError(error, "Turn prefix summarization failed");
	});
});

describe("split-turn summary fan-out", () => {
	test("waits for a split summary to stop before returning the first failure", async () => {
		const failure = new Error("turn prefix summary failed");
		const historyStopped = new Error("history summary stopped");
		const prefixFails = Promise.withResolvers<void>();
		// The held abort cleanup gate: an aborted history request keeps running
		// until the test opens it, so a cancellation compact() does not wait for
		// is still running when compact() returns.
		const historyStops = Promise.withResolvers<void>();
		const started = { history: 0, prefix: 0 };
		const history: { state: RequestState } = { state: "idle" };
		const observed: {
			aborted?: { reason: unknown; history: RequestState };
			returned?: { error: unknown; history: RequestState };
		} = {};
		const requests: Promise<AssistantMessage>[] = [];

		const failPrefix = async (): Promise<AssistantMessage> => {
			started.prefix++;
			await prefixFails.promise;
			throw failure;
		};
		const holdHistory = async (signal: AbortSignal | undefined): Promise<AssistantMessage> => {
			started.history++;
			history.state = "running";
			signal?.addEventListener(
				"abort",
				() => {
					observed.aborted = { reason: signal?.reason, history: history.state };
				},
				{ once: true },
			);
			try {
				await historyStops.promise;
				throw historyStopped;
			} finally {
				history.state = "stopped";
			}
		};

		const run = compact(makePreparation(), getAnthropicModel(), "key", undefined, undefined, {
			completeImpl: (_model, ctx, options) => {
				const request = isTurnPrefixRequest(ctx) ? failPrefix() : holdHistory(options.signal);
				requests.push(request);
				return request;
			},
			oneshotRetry: false,
		});
		// Read the history request's state in the job where compact() settles, not later.
		const settled = run.then(
			() => {
				observed.returned = { error: undefined, history: history.state };
			},
			(error: unknown) => {
				observed.returned = { error, history: history.state };
			},
		);

		try {
			// 1. Both summary requests are in flight, and neither has answered.
			await afterQueuedJobs();
			expect(started).toEqual({ history: 1, prefix: 1 });
			expect(observed.returned).toBeUndefined();

			// 2. The turn-prefix request fails first. compact() must cancel the held
			// history request now; if it does not wait for that request, it returns
			// here, while the request still runs.
			prefixFails.resolve();
			await afterQueuedJobs();

			// 3. Only now does the history request stop.
			historyStops.resolve();
			await settled;

			expect(observed.returned?.error).toBe(failure);
			expect(observed.returned?.history).toBe("stopped");
			expect(observed.aborted?.history).toBe("running");
			expect(observed.aborted?.reason).toBe(failure);
			expect(started).toEqual({ history: 1, prefix: 1 });
		} finally {
			prefixFails.resolve();
			historyStops.resolve();
			await Promise.allSettled([settled, ...requests]);
		}
	});

	test("runs both split summaries concurrently when both succeed", async () => {
		const prefixAnswers = Promise.withResolvers<void>();
		const historyAnswers = Promise.withResolvers<void>();
		const started = { history: 0, prefix: 0, short: 0 };
		const observed: { historyAbortedAtAnswer?: boolean } = {};
		const requests: Promise<AssistantMessage>[] = [];

		const answerPrefix = async (): Promise<AssistantMessage> => {
			started.prefix++;
			await prefixAnswers.promise;
			return makeAssistantStop([{ type: "text", text: "Turn prefix summary." }]);
		};
		const answerHistory = async (signal: AbortSignal | undefined): Promise<AssistantMessage> => {
			started.history++;
			await historyAnswers.promise;
			observed.historyAbortedAtAnswer = signal?.aborted === true;
			return makeAssistantStop([{ type: "text", text: "History summary." }]);
		};
		const answerShort = async (): Promise<AssistantMessage> => {
			started.short++;
			return makeAssistantStop([{ type: "text", text: "Short summary." }]);
		};

		const run = compact(makePreparation(), getAnthropicModel(), "key", undefined, undefined, {
			// The history request is the first without the turn-prefix prompt; the short summary follows both.
			completeImpl: (_model, ctx, options) => {
				const request = isTurnPrefixRequest(ctx)
					? answerPrefix()
					: started.history === 0
						? answerHistory(options.signal)
						: answerShort();
				requests.push(request);
				return request;
			},
			oneshotRetry: false,
		});
		const settled = run.then(
			() => undefined,
			() => undefined,
		);

		try {
			// 1. Both summary requests are in flight, and neither has answered.
			await afterQueuedJobs();
			expect(started).toEqual({ history: 1, prefix: 1, short: 0 });

			// 2. The turn-prefix request answers first; its success cancels nothing.
			prefixAnswers.resolve();
			await afterQueuedJobs();
			historyAnswers.resolve();
			const result = await run;

			expect(observed.historyAbortedAtAnswer).toBe(false);
			expect(result.summary).toContain("History summary.");
			expect(result.summary).toContain("Turn prefix summary.");
			expect(started).toEqual({ history: 1, prefix: 1, short: 1 });
		} finally {
			prefixAnswers.resolve();
			historyAnswers.resolve();
			await Promise.allSettled([settled, ...requests]);
		}
	});
});
