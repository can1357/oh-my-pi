import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

function makeModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const CONTEXT: Context = {
	systemPrompt: ["Keep this system prefix."],
	messages: [{ role: "user", content: "Keep this user prefix.", timestamp: 1 }],
};

function prewarmFetch(requests: Record<string, unknown>[]): typeof fetch {
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push(JSON.parse(requestBodyText(init) ?? "{}") as Record<string, unknown>);
			return new Response(
				JSON.stringify({
					id: "msg_prewarm",
					type: "message",
					role: "assistant",
					content: [],
					stop_reason: "max_tokens",
					usage: {
						input_tokens: 3,
						output_tokens: 0,
						cache_read_input_tokens: 90_000,
						cache_creation_input_tokens: 0,
						cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
		{ preconnect: fetch.preconnect },
	);
}

withOfficialAnthropicEndpoint();

describe("Anthropic prompt-cache pre-warm", () => {
	it("sends the hooked request body non-streaming with max_tokens 0 and reports its usage", async () => {
		const requests: Record<string, unknown>[] = [];
		const hooked: unknown[] = [];
		const stream = streamAnthropic(makeModel("claude-sonnet-5"), CONTEXT, {
			apiKey: "sk-ant-test",
			maxTokens: 4_096,
			prewarm: true,
			fetch: prewarmFetch(requests),
			onPayload: payload => {
				hooked.push(structuredClone(payload));
			},
		});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const message = await stream.result();

		expect(events).toEqual(["start", "done"]);
		expect(hooked).toHaveLength(1);
		expect(requests).toHaveLength(1);
		const {
			max_tokens: hookedMaxTokens,
			stream: _hookedStream,
			...hookedBody
		} = hooked[0] as Record<string, unknown>;
		const { max_tokens: sentMaxTokens, stream: sentStream, ...sentBody } = requests[0];
		expect(hookedMaxTokens).toBe(4_096);
		expect(sentMaxTokens).toBe(0);
		expect(sentStream).toBe(false);
		expect(sentBody).toEqual(hookedBody);
		expect(message.content).toEqual([]);
		expect(message.stopReason).toBe("length");
		expect(message.usage).toMatchObject({ input: 3, output: 0, cacheRead: 90_000, cacheWrite: 0 });
		expect(message.usage.cost.total).toBeGreaterThan(0);
	});

	it("refuses budget thinking and forced tool choice before sending", async () => {
		const context: Context = {
			...CONTEXT,
			tools: [{ name: "lookup", description: "Look something up", parameters: { type: "object", properties: {} } }],
		};
		for (const options of [{ thinkingEnabled: true, thinkingBudgetTokens: 2_048 }, { toolChoice: "any" as const }]) {
			const requests: Record<string, unknown>[] = [];
			const message = await streamAnthropic(makeModel("claude-3-7-sonnet-20250219"), context, {
				apiKey: "sk-ant-test",
				prewarm: true,
				fetch: prewarmFetch(requests),
				...options,
			}).result();
			expect(requests).toHaveLength(0);
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("max_tokens: 0");
		}
	});
});
