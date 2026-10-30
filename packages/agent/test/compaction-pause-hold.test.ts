import { describe, expect, test } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/** A caller's hold that stays closed until the test opens it, counting how often it was awaited. */
function gate() {
	const opened = Promise.withResolvers<void>();
	const state = { awaited: 0 };
	return {
		state,
		hold: () => {
			state.awaited++;
			return opened.promise;
		},
		open: () => opened.resolve(),
	};
}

/** Lets every queued continuation run, so a request that is not held reaches the fetch. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const openAiModel = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	remoteCompaction: {
		enabled: true,
		v2StreamingEnabled: true,
		v2Endpoint: "https://compact.example/v1/responses",
		model: "gpt-5-compact",
	},
}) as Model<"openai-responses">;

const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };

// The remote-compaction requests fetch on their own and never reach a
// completion wrapper, so a host that gates its requests (`/pause`) could not
// hold them: each one went out while the caller's `beforeDispatch` was still
// pending. Every remote transport now awaits the hold before its fetch.
describe("remote compaction holds every request at the caller's beforeDispatch", () => {
	test("compact() holds a remoteEndpoint summary until the hold opens", async () => {
		const { state, hold, open } = gate();
		const sent: string[] = [];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent turn", timestamp: 1 }],
			isSplitTurn: false,
			tokensBefore: 20_000,
			previousSummary: "earlier summary",
			fileOps: createFileOps(),
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				reserveTokens: 10_000,
				remoteEnabled: true,
				remoteEndpoint: "https://compaction.example.test/summarize",
			},
		};
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");

		const pending = compact(preparation, model, "test-key", undefined, undefined, {
			beforeDispatch: hold,
			fetch: async input => {
				sent.push(String(input));
				return Response.json({ summary: "summary" });
			},
		});
		await settle();
		expect({ sent, awaited: state.awaited }).toEqual({ sent: [], awaited: 1 });

		open();
		await pending;
		expect(sent).toEqual(["https://compaction.example.test/summarize"]);
	});

	test("requestRemoteCompaction holds before its fetch", async () => {
		const { state, hold, open } = gate();
		let sent = 0;
		const pending = requestRemoteCompaction(
			"https://compaction.example.test/summarize",
			{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>", maxTokens: 1024 },
			undefined,
			{
				beforeDispatch: hold,
				fetch: async () => {
					sent++;
					return Response.json({ summary: "summary" });
				},
			},
		);
		await settle();
		expect({ sent, awaited: state.awaited }).toEqual({ sent: 0, awaited: 1 });

		open();
		expect(await pending).toEqual({ summary: "summary" });
		expect(sent).toBe(1);
	});

	test("requestOpenAiRemoteCompaction (V1) holds before its fetch", async () => {
		const { state, hold, open } = gate();
		let sent = 0;
		const fetch: FetchImpl = async () => {
			sent++;
			return Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] });
		};
		const pending = requestOpenAiRemoteCompaction(openAiModel, "test-key", [userItem], "compact", undefined, {
			fetch,
			beforeDispatch: hold,
		});
		await settle();
		expect({ sent, awaited: state.awaited }).toEqual({ sent: 0, awaited: 1 });

		open();
		await pending;
		expect(sent).toBe(1);
	});

	test("requestCompactionV2Streaming holds each attempt before its fetch", async () => {
		const { state, hold, open } = gate();
		let sent = 0;
		const request = buildCompactionV2Request(openAiModel, [userItem], "instructions", { sessionId: "session-1" });
		const fetch: FetchImpl = async () => {
			sent++;
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc_123" },
				},
				{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			]);
		};
		const pending = requestCompactionV2Streaming(openAiModel, "test-key", request, undefined, {
			fetch,
			beforeDispatch: hold,
		});
		await settle();
		expect({ sent, awaited: state.awaited }).toEqual({ sent: 0, awaited: 1 });

		open();
		await pending;
		expect(sent).toBe(1);
	});

	// The remote requests bound the provider with a timeout. Armed before the
	// hold, a pause longer than it would fail the compaction instead of sending
	// it on resume; the hold therefore runs on the caller's signal alone.
	test("a held remote request is not failed by its own timeout", async () => {
		const { state, hold, open } = gate();
		let sent = 0;
		let sentWhileHeld = 0;
		let opened = false;
		const pending = requestRemoteCompaction(
			"https://compaction.example.test/summarize",
			{ systemPrompt: "summarize", prompt: "hello", maxTokens: 1024 },
			undefined,
			{
				timeoutMs: 20,
				beforeDispatch: hold,
				fetch: async (_input, init) => {
					sent++;
					if (state.awaited === 0 || !opened) sentWhileHeld++;
					expect(init?.signal?.aborted).toBe(false);
					return Response.json({ summary: "summary" });
				},
			},
		);
		// `AbortSignal.timeout` runs on the platform clock, which fake timers do
		// not drive, so the hold has to outlast a real (short) timeout.
		await Bun.sleep(60);
		opened = true;
		open();
		expect(await pending).toEqual({ summary: "summary" });
		expect({ sent, sentWhileHeld }).toEqual({ sent: 1, sentWhileHeld: 0 });
	});

	test("an abort on the caller's signal ends the hold without sending", async () => {
		const { hold } = gate();
		let sent = 0;
		const abort = new AbortController();
		const pending = requestRemoteCompaction(
			"https://compaction.example.test/summarize",
			{ systemPrompt: "summarize", prompt: "hello", maxTokens: 1024 },
			abort.signal,
			{
				beforeDispatch: hold,
				fetch: async () => {
					sent++;
					return Response.json({ summary: "summary" });
				},
			},
		);
		await settle();
		abort.abort(new Error("cancelled while held"));
		await expect(pending).rejects.toThrow("cancelled while held");
		expect(sent).toBe(0);
	});
});
