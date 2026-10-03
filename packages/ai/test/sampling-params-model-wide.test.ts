import { afterEach, describe, expect, test } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Whether a model accepts `temperature`/`top_p` is a property of the model
// lineage, not of the provider serving it: GPT-5+/GPT-6 and adaptive Claude
// reject them with a 400 on Bedrock, OpenRouter, and every other host. Class
// rules assign `supportsSamplingParams` on every compat record, and the
// stream entry points drop sampling options when it resolves `false`.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function bundled<TApi extends Api>(provider: GeneratedProvider, id: string): Model<TApi> {
	const model = getBundledModel<TApi>(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model;
}

const emptyResponse = async () => new Response(new Uint8Array(), { status: 200 });

/** The body as sent: providers may build `temperature: undefined`, which serialization drops. */
const wire = (payload: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(payload));

function simplePayload(model: Model<Api>): Promise<Record<string, unknown>> {
	setBedrockProviderModule({ streamBedrock });
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		providerOptions: { bearerToken: "test-token" },
		maxTokens: 16,
		temperature: 0,
		topP: 0.9,
		frequencyPenalty: 1,
		fetch: emptyResponse,
		onPayload: payload => resolve(wire(payload)),
	});
	return promise;
}

function bedrockInference(payload: Record<string, unknown>): Record<string, unknown> {
	const inference = payload.inferenceConfig;
	return typeof inference === "object" && inference !== null ? { ...inference } : {};
}

afterEach(() => {
	clearCustomApis();
});

describe("sampling params are gated by model, on every provider", () => {
	test.each([["global.openai.gpt-6-luna"], ["global.anthropic.claude-opus-5-5"]])(
		"Bedrock %s omits temperature and topP",
		async id => {
			const inference = bedrockInference(await simplePayload(bundled("amazon-bedrock", id)));
			expect(inference).not.toHaveProperty("temperature");
			expect(inference).not.toHaveProperty("topP");
			expect(inference.maxTokens).toBe(16);
		},
	);

	test("Bedrock Claude Sonnet 4.5 still sends temperature and topP", async () => {
		const inference = bedrockInference(
			await simplePayload(bundled("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")),
		);
		expect(inference.temperature).toBe(0);
		expect(inference.topP).toBe(0.9);
	});

	test("OpenRouter Claude Opus 5.5 omits temperature and top_p", async () => {
		const payload = await simplePayload(bundled("openrouter", "anthropic/claude-opus-5.5"));
		expect(payload).not.toHaveProperty("temperature");
		expect(payload).not.toHaveProperty("top_p");
	});

	test("OpenRouter Claude Sonnet 4.5 still sends temperature", async () => {
		const payload = await simplePayload(bundled("openrouter", "anthropic/claude-sonnet-4.5"));
		expect(payload.temperature).toBe(0);
	});

	test("a custom API adapter receives no sampling options, including frequencyPenalty", () => {
		let received: SimpleStreamOptions | undefined;
		registerCustomApi("sampling-gate-test", (_model, _context, options) => {
			received = options;
			return new AssistantMessageEventStream();
		});
		const model = bundled("amazon-bedrock", "global.openai.gpt-6-luna");
		void streamSimple({ ...model, api: "sampling-gate-test" }, context, {
			temperature: 0,
			topP: 0.9,
			frequencyPenalty: 1,
			presencePenalty: 1,
		});
		expect(received).toBeDefined();
		expect(received).not.toHaveProperty("temperature");
		expect(received).not.toHaveProperty("topP");
		expect(received).not.toHaveProperty("frequencyPenalty");
		expect(received).not.toHaveProperty("presencePenalty");
	});

	test("an explicit compat override re-enables sampling for a custom endpoint", async () => {
		const model = buildModel({
			id: "gpt-5",
			name: "gpt-5",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: { supportsSamplingParams: true },
		});
		const payload = await simplePayload(model);
		expect(payload.temperature).toBe(0);
	});

	test("the non-simple stream() entry applies the same gate", async () => {
		setBedrockProviderModule({ streamBedrock });
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		void stream(bundled<"bedrock-converse-stream">("amazon-bedrock", "global.openai.gpt-6-luna"), context, {
			bearerToken: "test-token",
			maxTokens: 16,
			temperature: 0,
			fetch: emptyResponse,
			onPayload: payload => resolve(wire(payload)),
		});
		expect(bedrockInference(await promise)).not.toHaveProperty("temperature");
	});
});
