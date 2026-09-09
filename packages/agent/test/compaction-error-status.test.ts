import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
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
// `createSummarizationError` helper backs all four summarizer throw
// sites in `packages/agent/src/compaction/compaction.ts`, so verifying
// one site is sufficient to lock the contract.

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
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

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
		expect(e.message).toMatch(/Summarization failed|Short summary failed|Turn prefix summarization failed/);
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
