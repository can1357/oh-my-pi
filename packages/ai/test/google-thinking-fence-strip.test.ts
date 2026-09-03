import { describe, expect, it } from "bun:test";
import { ThinkingFenceStripper } from "@oh-my-pi/pi-ai/dialect/thinking-fence-strip";
import { consumeGoogleStream } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { GenerateContentResponse, Part } from "@oh-my-pi/pi-ai/providers/google-types";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Regression for #8719: Gemini thought summaries occasionally emit a bare
// ```thinking / ``````thinking opener line as a between-summary delimiter.
// It must never reach the persisted thinking text or the streamed thinking_delta.

const feed = (stripper: ThinkingFenceStripper, chunks: string[]): string =>
	chunks.map(chunk => stripper.push(chunk)).join("") + stripper.flush();

describe("ThinkingFenceStripper", () => {
	it("drops a standalone reasoning-fence opener line (any backtick run ≥3)", () => {
		expect(feed(new ThinkingFenceStripper(), ["a\n```thinking\nb\n"])).toBe("a\nb\n");
		expect(feed(new ThinkingFenceStripper(), ["a\n``````thinking\nb\n"])).toBe("a\nb\n");
		expect(feed(new ThinkingFenceStripper(), ["```reasoning\nx"])).toBe("x");
	});

	it("strips an opener even when the delimiter is split across deltas", () => {
		expect(feed(new ThinkingFenceStripper(), ["intro\n``", "````thin", "king\nrest"])).toBe("intro\nrest");
	});

	it("drops a trailing opener that never gets its newline (flush path)", () => {
		expect(feed(new ThinkingFenceStripper(), ["done\n``````thinking"])).toBe("done\n");
	});

	it("preserves language-tagged code fences and bare closers inside reasoning", () => {
		const body = "look:\n```rs\nlet x = 1;\n```\ndone\n";
		expect(feed(new ThinkingFenceStripper(), [body])).toBe(body);
	});

	it("keeps inline mentions of the idiom (prose on the fence line)", () => {
		const line = "I should emit a ```thinking block here.\n";
		expect(feed(new ThinkingFenceStripper(), [line])).toBe(line);
	});

	it("keeps indented content that only resembles a fence", () => {
		// 4-space indent is a code line, not a fence; must survive verbatim.
		expect(feed(new ThinkingFenceStripper(), ["    ```thinking\n"])).toBe("    ```thinking\n");
	});
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-vertex",
		provider: "google-vertex",
		model: vertexModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/**
 * Drive `consumeGoogleStream` over fabricated chunks (each an array of parts)
 * and return the persisted thinking text plus the concatenated thinking deltas.
 */
async function runThinking(chunks: Part[][]): Promise<{ thinking: string; streamed: string }> {
	const output = emptyAssistant();
	const stream = new AssistantMessageEventStream();
	const streamed: string[] = [];
	const collecting = (async () => {
		for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
			if (event.type === "thinking_delta") streamed.push(event.delta);
		}
	})();

	async function* googleStream(): AsyncGenerator<GenerateContentResponse> {
		for (const parts of chunks) {
			yield { candidates: [{ content: { parts } }] } as unknown as GenerateContentResponse;
		}
		yield { candidates: [{ finishReason: "STOP" }] } as unknown as GenerateContentResponse;
	}

	await consumeGoogleStream({ googleStream: googleStream(), output, stream, model: vertexModel, options: undefined });
	stream.end(output);
	await collecting;

	const block = output.content.find(b => b.type === "thinking");
	return { thinking: block?.thinking ?? "", streamed: streamed.join("") };
}

describe("consumeGoogleStream leaked thinking-fence delimiter (#8719)", () => {
	it("heals a leaked ```thinking delimiter out of persistence and streaming", async () => {
		const { thinking, streamed } = await runThinking([
			[{ text: "Investigating the return type.\n", thought: true }],
			[{ text: "``````thinking\n**Investigating Adapter Host Logic**\n", thought: true }],
			[{ text: "The host owns the loop.", thought: true }],
		]);
		const expected = "Investigating the return type.\n**Investigating Adapter Host Logic**\nThe host owns the loop.";
		expect(thinking).toBe(expected);
		expect(thinking).not.toContain("```thinking");
		expect(streamed).toBe(expected);
	});

	it("leaves normal thought summaries untouched", async () => {
		const clean = "Considered options A and B; picked B for latency.";
		const { thinking, streamed } = await runThinking([[{ text: clean, thought: true }]]);
		expect(thinking).toBe(clean);
		expect(streamed).toBe(clean);
	});

	it("does not strip the same idiom from visible (non-thought) text", async () => {
		const { thinking } = await runThinking([[{ text: "here:\n```thinking\nx\n", thought: false }]]);
		// No thinking block at all — the text branch is untouched by the stripper.
		expect(thinking).toBe("");
	});
});
