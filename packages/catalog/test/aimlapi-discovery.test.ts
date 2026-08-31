import { describe, expect, test } from "bun:test";
import { aimlApiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** Minimal `/v1/models?include=pricing,modalities` entry, chat-completions by default. */
function modelEntry(
	id: string,
	overrides: {
		type?: string;
		name?: string;
		isHottest?: boolean;
		contextLength?: number;
		outputMax?: number;
		input?: string[];
		output?: string[];
		pricing?: Array<{ origin: string; price: number; per?: number }>;
	} = {},
) {
	return {
		id,
		type: overrides.type ?? "openai/chat-completions",
		info: {
			name: overrides.name,
			contextLength: overrides.contextLength,
			outputMax: overrides.outputMax,
			isHottest: overrides.isHottest,
		},
		modalities: { input: overrides.input ?? ["text"], output: overrides.output ?? ["text"] },
		pricing: overrides.pricing
			? {
					units: overrides.pricing.map(unit => ({
						name: "token",
						content: "text",
						origin: unit.origin,
						price: unit.price,
						per: unit.per ?? 1_000_000,
					})),
				}
			: undefined,
	};
}

function respondWith(data: unknown[]): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("aimlApiModelManagerOptions discovery", () => {
	test("requests pricing+modalities and maps them onto the model shape", async () => {
		const calls: Array<{ url: string; authorization: string | null; source: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: input.toString(),
				authorization: headers.get("authorization"),
				source: headers.get("x-aimlapi-source"),
			});
			return new Response(
				JSON.stringify({
					data: [
						modelEntry("openai/gpt-5", {
							name: "GPT-5",
							contextLength: 400_000,
							outputMax: 128_000,
							input: ["text", "image"],
							pricing: [
								{ origin: "provided", price: 1.25 },
								{ origin: "generated", price: 10 },
							],
						}),
						modelEntry("anthropic/claude-sonnet-5", {
							name: "Claude Sonnet 5",
							isHottest: true,
							contextLength: 200_000,
							outputMax: 64_000,
							pricing: [
								{ origin: "provided", price: 3 },
								{ origin: "generated", price: 15 },
								{ origin: "cached", price: 0.3 },
								{ origin: "cache_write", price: 3.75 },
							],
						}),
						// Dropped: audio-output chat model.
						modelEntry("openai/gpt-audio", { output: ["audio", "text"] }),
						// Dropped: image-on-chat model (id clause).
						modelEntry("openai/gpt-5-image"),
						// Dropped: not a chat-completions endpoint.
						modelEntry("openai/dall-e-3", { type: "openai/image-generations" }),
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const options = aimlApiModelManagerOptions({ apiKey: "aiml-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("aimlapi");
		// Discovery hits /models with the include query + attribution headers.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.aimlapi.com/v1/models?include=pricing%2Cmodalities");
		expect(calls[0]?.authorization).toBe("Bearer aiml-test-key");
		expect(calls[0]?.source).toBe("agent/oh-my-pi");

		// LLM-only: audio-output, image-on-chat, and non-chat endpoints are filtered out.
		// Order: hottest first, then the rest — each group alphabetical.
		expect(models?.map(model => model.id)).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-5"]);

		expect(models?.[0]).toMatchObject({
			id: "anthropic/claude-sonnet-5",
			name: "Claude Sonnet 5",
			provider: "aimlapi",
			contextWindow: 200_000,
			maxTokens: 64_000,
			priority: 0,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		expect(models?.find(model => model.id === "openai/gpt-5")).toMatchObject({
			priority: 1,
			cost: { input: 1.25, output: 10 },
			input: ["text", "image"],
		});
	});

	test("normalizes token pricing to $/million when `per` differs", async () => {
		const options = aimlApiModelManagerOptions({
			apiKey: "k",
			fetch: respondWith([
				modelEntry("x/model", {
					pricing: [
						{ origin: "provided", price: 2, per: 1_000 },
						{ origin: "generated", price: 6, per: 1_000 },
					],
				}),
			]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.cost).toMatchObject({ input: 2000, output: 6000 });
	});

	test("orders hottest models first, then the rest, alphabetically within each group", async () => {
		const options = aimlApiModelManagerOptions({
			apiKey: "k",
			fetch: respondWith([
				modelEntry("z/cool", { isHottest: true }),
				modelEntry("a/plain"),
				modelEntry("a/hot", { isHottest: true }),
				modelEntry("b/plain"),
			]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["a/hot", "z/cool", "a/plain", "b/plain"]);
	});
});
