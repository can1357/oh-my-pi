/**
 * A request the provider-request hold refused (its owner ended while it was held, or it was made in
 * shared work) is refused the same way on every retry. No retry loop may replay one: the Anthropic
 * client's own retries and the provider's backoff would otherwise keep a dead request alive for
 * seconds after its owner ended, asking the hold again each time.
 *
 * The case hands the stream a fetch that answers with the refusal itself, so it measures the retry
 * loops above the transport, with no endpoint and no timing: each attempt is one call of that fetch.
 */
import { describe, expect, it } from "bun:test";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AnthropicConnectionError, OwnerlessRequestError, RequestHeldError } from "../src/error";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] };

describe("a refusal of the provider-request hold", () => {
	it.each([
		["held, its owner ended", () => new RequestHeldError("Provider request held: its owner began disposing")],
		["made in shared work", () => new OwnerlessRequestError()],
	] as const)("%s, is not retried by the Anthropic client or the provider", async (_name, refusal) => {
		let attempts = 0;
		const refusing = (async () => {
			attempts++;
			throw refusal();
		}) as unknown as typeof fetch;

		const result = await streamAnthropic(model, context, { apiKey: "sk-ant-test", fetch: refusing }).result();

		expect({ attempts, stopReason: result.stopReason }).toEqual({ attempts: 1, stopReason: "error" });
	});

	it("is not retryable, also when a transport error wraps it", () => {
		const held = new RequestHeldError("Provider request held: its owner began disposing");
		expect({
			held: isProviderRetryableError(held),
			wrapped: isProviderRetryableError(new AnthropicConnectionError(held, "https://api.anthropic.com")),
			ownerless: isProviderRetryableError(new OwnerlessRequestError()),
		}).toEqual({ held: false, wrapped: false, ownerless: false });
	});
});
