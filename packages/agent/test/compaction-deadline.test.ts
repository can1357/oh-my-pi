import { describe, expect, test } from "bun:test";
import {
	compact,
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";

const model = {
	id: "summary-model",
	provider: "test",
	api: "openai-completions",
	contextWindow: 200_000,
	maxTokens: 8192,
} as Model;

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: "Keep the deployment on hold", timestamp: 1 }],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
	};
}

function response(stopReason: "stop" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "deployment remains on hold" }],
		provider: model.provider,
		model: model.id,
		api: model.api,
		stopReason,
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("soft compaction deadlines", () => {
	test("a silent completion releases maintenance instead of hanging indefinitely", async () => {
		let requestSignal: AbortSignal | undefined;
		await expect(
			compact(preparation(), model, "fixture-key", undefined, undefined, {
				timeoutMs: 20,
				oneshotRetry: false,
				completeImpl: async (_model, _context, options) => {
					requestSignal = options.signal;
					return Promise.withResolvers<AssistantMessage>().promise;
				},
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(requestSignal?.aborted).toBe(true);
	});

	test("a stalled short summary cannot hold a completed history summary forever", async () => {
		let calls = 0;
		await expect(
			compact(preparation(), model, "fixture-key", undefined, undefined, {
				timeoutMs: 20,
				oneshotRetry: false,
				completeImpl: async () => {
					if (++calls === 1) return response("stop");
					return Promise.withResolvers<AssistantMessage>().promise;
				},
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(calls).toBe(2);
	});

	test("operator cancellation never commits a partially returned summary", async () => {
		const controller = new AbortController();
		const reason = new Error("operator cancelled maintenance");
		await expect(
			compact(preparation(), model, "fixture-key", undefined, controller.signal, {
				timeoutMs: 0,
				completeImpl: async () => {
					controller.abort(reason);
					return response("aborted");
				},
			}),
		).rejects.toBe(reason);
	});
});
