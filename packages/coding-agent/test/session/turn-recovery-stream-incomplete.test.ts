import { describe, expect, it } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const STREAM_INCOMPLETE_MESSAGE =
	"stream_incomplete: Upstream websocket closed before response.completed: Upstream websocket receive failed";
const STREAM_INCOMPLETE_CLOSE_CODE_MESSAGE =
	"stream_incomplete: Upstream websocket closed before response.completed (close_code=1000)";
// Production persists Transient (0x20000) | Class (0x1000) for these drops.
const STREAM_INCOMPLETE_ERROR_ID = 135168;

const ACTIVE_MODEL = {
	api: "openai-responses",
	provider: "codex-lb",
	id: "gpt-6-sol",
	contextWindow: 200_000,
} as Model;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "partial reasoning" }],
		api: "openai-responses",
		provider: "codex-lb",
		model: "gpt-6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorId: 0,
		errorStatus: null as unknown as undefined,
		errorMessage: STREAM_INCOMPLETE_MESSAGE,
		timestamp: Date.now(),
		...overrides,
	};
}

function failUnexpected(name: string): never {
	throw new Error(`Unexpected TurnRecoveryHost call: ${name}`);
}

interface RecoveryCalls {
	appended: unknown[];
	continued: { source: string }[];
}

function recovery(options: { textOutputCommitted?: boolean; calls?: RecoveryCalls } = {}): TurnRecovery {
	const calls = options.calls;
	const host: TurnRecoveryHost = {
		agent: {
			appendMessage: (message: unknown) => {
				if (!calls) failUnexpected("agent.appendMessage");
				calls.appended.push(message);
			},
		} as unknown as Agent,
		sessionManager: {} as SessionManager,
		settings: Settings.isolated({
			"retry.modelFallback": false,
			"retry.fallbackChains": {},
		}),
		modelRegistry: {
			isProviderDiscoveryPending: () => false,
		} as unknown as ModelRegistry,
		configWarnings: [],
		model: () => ACTIVE_MODEL,
		contextFitsModel: () => true,
		textOutputCommitted: () => options.textOutputCommitted === true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 1,
		promptSequence: () => 1,
		sessionId: () => "stream-incomplete-test",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: (request: { source: string }) => {
			calls?.continued.push(request);
		},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		persistedAssistantEntryId: () => undefined,
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: () => failUnexpected("setModelWithProviderSessionReset"),
		resolveActiveEditMode: () => failUnexpected("resolveActiveEditMode"),
		syncAfterModelChange: () => failUnexpected("syncAfterModelChange"),
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: () => failUnexpected("runAutoCompaction"),
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: operation => operation(),
	};
	return new TurnRecovery(host);
}

describe("TurnRecovery stream_incomplete retry gate", () => {
	it("retries a thinking-only OpenAI Responses stream_incomplete failure", () => {
		expect(recovery().isRetryableError(assistant())).toBe(true);
	});

	it("does not retry the same failure after committed assistant text", () => {
		expect(
			recovery({ textOutputCommitted: true }).isRetryableError(
				assistant({
					content: [
						{ type: "thinking", thinking: "partial reasoning" },
						{ type: "text", text: "committed answer" },
					],
				}),
			),
		).toBe(false);
	});
});

describe("TurnRecovery stream_incomplete after committed text", () => {
	const textOnly: AssistantMessage["content"] = [{ type: "text", text: "committed answer" }];
	const thinkingAndText: AssistantMessage["content"] = [
		{ type: "thinking", thinking: "partial reasoning" },
		{ type: "text", text: "committed answer" },
	];

	it("persists the live errorId as a retriable transient", () => {
		expect(AIError.create(AIError.Flag.Transient)).toBe(STREAM_INCOMPLETE_ERROR_ID);
		expect(AIError.retriable(STREAM_INCOMPLETE_ERROR_ID)).toBe(true);
	});

	for (const errorMessage of [STREAM_INCOMPLETE_MESSAGE, STREAM_INCOMPLETE_CLOSE_CODE_MESSAGE]) {
		for (const [label, content] of [
			["text", textOnly],
			["thinking+text", thinkingAndText],
		] as const) {
			it(`continues a ${label} turn that failed with ${JSON.stringify(errorMessage)}`, () => {
				const calls: RecoveryCalls = { appended: [], continued: [] };
				const subject = recovery({ textOutputCommitted: true, calls });
				const message = assistant({ content: [...content], errorId: STREAM_INCOMPLETE_ERROR_ID, errorMessage });
				expect(subject.isRetryableError(message)).toBe(false);
				expect(subject.handleCommittedTextStreamStall(message)).toBe(true);
				expect(calls.continued).toEqual([expect.objectContaining({ source: "stream-stall-continue" })]);
				expect(calls.appended).toEqual([expect.objectContaining({ role: "developer" })]);
			});
		}
	}

	it("does not continue a turn that carries a tool call", () => {
		const subject = recovery({ textOutputCommitted: true, calls: { appended: [], continued: [] } });
		const message = assistant({
			content: [...textOnly, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }],
			errorId: STREAM_INCOMPLETE_ERROR_ID,
		});
		expect(subject.handleCommittedTextStreamStall(message)).toBe(false);
	});

	it("does not treat a terminal stream_incomplete-free error as a transport drop", () => {
		const subject = recovery({ textOutputCommitted: true, calls: { appended: [], continued: [] } });
		const message = assistant({
			content: [...textOnly],
			errorId: STREAM_INCOMPLETE_ERROR_ID,
			errorMessage: "server_error: upstream returned an internal error",
		});
		expect(subject.handleCommittedTextStreamStall(message)).toBe(false);
	});

	it("continues when the stream-drop diagnostic is only in errorClassificationMessage", () => {
		const calls: RecoveryCalls = { appended: [], continued: [] };
		const subject = recovery({ textOutputCommitted: true, calls });
		const message = assistant({
			content: [...textOnly],
			errorId: STREAM_INCOMPLETE_ERROR_ID,
			errorMessage: "Request failed",
			errorClassificationMessage: STREAM_INCOMPLETE_MESSAGE,
		});
		expect(subject.handleCommittedTextStreamStall(message)).toBe(true);
		expect(calls.continued).toEqual([expect.objectContaining({ source: "stream-stall-continue" })]);
	});
});
