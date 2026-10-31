import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, StopReason } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// The short summary is a display-only field. These tests pin that its failure
// modes no longer discard a completed full summary, while cancellation still
// cancels the whole compaction.

const FULL_SUMMARY = "HISTORY SUMMARY TEXT";

function reply(stopReason: StopReason, content: AssistantMessage["content"], errorMessage?: string): AssistantMessage {
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
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

function makePreparation(settings: Partial<CompactionPreparation["settings"]> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "history msg", timestamp: Date.now() } satisfies AgentMessage,
			reply("stop", [{ type: "text", text: "history reply" }]),
		],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false, ...settings },
	};
}

/** `compact()` requests the full summary first, then the short summary; only the second call gets `shortReply`. */
function completeWith(shortReply: () => AssistantMessage) {
	let calls = 0;
	return async () => (++calls === 1 ? reply("stop", [{ type: "text", text: FULL_SUMMARY }]) : shortReply());
}

describe("compaction short summary isolation", () => {
	test("a successful short summary is kept alongside the full summary", async () => {
		const result = await compact(makePreparation(), getModel(), "key", undefined, undefined, {
			completeImpl: completeWith(() => reply("stop", [{ type: "text", text: "I fixed the thing." }])),
			oneshotRetry: false,
		});

		expect(result.summary.startsWith(FULL_SUMMARY)).toBe(true);
		expect(result.shortSummary).toBe("I fixed the thing.");
	});

	test("a failed short summary keeps the full summary and omits shortSummary", async () => {
		const result = await compact(makePreparation(), getModel(), "key", undefined, undefined, {
			completeImpl: completeWith(() =>
				reply("error", [], "Cloud Code Assist API returned a thought-only response without final output"),
			),
			oneshotRetry: false,
		});

		expect(result.summary.startsWith(FULL_SUMMARY)).toBe(true);
		expect("shortSummary" in result).toBe(false);
	});

	test("a short summary with no answer text omits shortSummary instead of storing an empty string", async () => {
		const result = await compact(makePreparation(), getModel(), "key", undefined, undefined, {
			completeImpl: completeWith(() => reply("length", [{ type: "thinking", thinking: "..." }])),
			oneshotRetry: false,
		});

		expect(result.summary.startsWith(FULL_SUMMARY)).toBe(true);
		expect("shortSummary" in result).toBe(false);
	});

	test("an aborted short-summary response cancels the compaction", async () => {
		const error = await compact(makePreparation(), getModel(), "key", undefined, undefined, {
			completeImpl: completeWith(() => reply("aborted", [], "Request was aborted")),
			oneshotRetry: false,
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});

	test("caller cancellation during the short summary cancels the compaction", async () => {
		const controller = new AbortController();
		const error = await compact(makePreparation(), getModel(), "key", undefined, controller.signal, {
			completeImpl: completeWith(() => {
				controller.abort();
				return reply("stop", [{ type: "text", text: "I fixed the thing." }]);
			}),
			oneshotRetry: false,
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});
});

describe("compaction short summary isolation on a remote summarization endpoint", () => {
	const remote = { remoteEnabled: true, remoteEndpoint: "https://remote.invalid/compact" };
	const remoteModel = getBundledModel("google", "gemini-2.5-flash");

	/** The remote endpoint serves the full summary first, then the short summary via `shortResponse`. */
	function remoteFetch(shortResponse: () => Response) {
		let calls = 0;
		return async () => (++calls === 1 ? Response.json({ summary: FULL_SUMMARY }) : shortResponse());
	}

	test("a failed remote short summary keeps the full summary and omits shortSummary", async () => {
		const result = await compact(makePreparation(remote), remoteModel, "key", undefined, undefined, {
			fetch: remoteFetch(() => new Response("upstream down", { status: 503 })),
			oneshotRetry: false,
		});

		expect(result.summary.startsWith(FULL_SUMMARY)).toBe(true);
		expect("shortSummary" in result).toBe(false);
	});

	test("caller cancellation during a remote short summary cancels the compaction", async () => {
		const controller = new AbortController();
		const error = await compact(makePreparation(remote), remoteModel, "key", undefined, controller.signal, {
			fetch: remoteFetch(() => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			}),
			oneshotRetry: false,
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});
});
