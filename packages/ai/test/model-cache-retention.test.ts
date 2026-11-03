/**
 * A model's configured prompt-cache retention (`providers.<id>.cacheRetention`
 * in models.yml) reaches the wire through the shared stream entry: a request
 * that names no retention takes the model's, ahead of `PI_CACHE_RETENTION`; a
 * request that names one keeps it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildParams as buildResponsesParams, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import {
	type CapturedRequest,
	captureFetch,
	factoryModel,
	responsesChunks,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamSynthetic } from "@oh-my-pi/pi-ai/providers/synthetic";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

function anthropicModel(cacheRetention?: Model["cacheRetention"]): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...(cacheRetention !== undefined ? { cacheRetention } : {}),
	});
}

const CONTEXT: Context = {
	systemPrompt: ["You are a precise assistant."],
	messages: [{ role: "user", content: "Say hi", timestamp: 1 }],
};

function successResponse(): Response {
	const events: Array<Record<string, unknown>> = [
		{ type: "message_start", message: { id: "msg_ok", usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

interface Captured {
	ttls: Array<string | undefined>;
	betas: string[];
}

/** Every `cache_control` breakpoint's `ttl` in the body, and the advertised betas. */
async function captureRequest(
	model: Model<"anthropic-messages">,
	cacheRetention?: "short" | "long",
	entry: typeof stream | typeof streamAnthropic = stream,
): Promise<Captured> {
	let captured: Captured | undefined;
	const fetchImpl: FetchImpl = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as unknown;
		const ttls: Array<string | undefined> = [];
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (value === null || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			const cacheControl = record.cache_control as { ttl?: string } | undefined;
			if (cacheControl) ttls.push(cacheControl.ttl);
			for (const child of Object.values(record)) walk(child);
		};
		walk(body);
		const headers = new Headers(init?.headers);
		captured = { ttls, betas: (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean) };
		return successResponse();
	};
	await entry(model, CONTEXT, {
		apiKey: "sk-ant-api-test",
		fetch: fetchImpl,
		...(cacheRetention !== undefined ? { cacheRetention } : {}),
	}).result();
	if (!captured) throw new Error("no request reached the transport");
	return captured;
}

describe("model cacheRetention", () => {
	const savedEnv = process.env.PI_CACHE_RETENTION;
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = savedEnv;
	});

	it("keeps the API-key default of 5-minute entries when the model names no retention", async () => {
		const { ttls, betas } = await captureRequest(anthropicModel());
		expect(ttls.length).toBeGreaterThan(0);
		expect(ttls.every(ttl => ttl === undefined)).toBe(true);
		expect(betas).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("writes 1-hour entries for a request that names none when the model's retention is long", async () => {
		const { ttls, betas } = await captureRequest(anthropicModel("long"));
		expect(ttls.length).toBeGreaterThan(0);
		expect(ttls.every(ttl => ttl === "1h")).toBe(true);
		expect(betas).toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("outranks PI_CACHE_RETENTION", async () => {
		process.env.PI_CACHE_RETENTION = "short";
		const { ttls } = await captureRequest(anthropicModel("long"));
		expect(ttls.length).toBeGreaterThan(0);
		expect(ttls.every(ttl => ttl === "1h")).toBe(true);
	});

	it("yields to a retention the request names", async () => {
		const { ttls, betas } = await captureRequest(anthropicModel("long"), "short");
		expect(ttls.length).toBeGreaterThan(0);
		expect(ttls.every(ttl => ttl === undefined)).toBe(true);
		expect(betas).not.toContain(EXTENDED_CACHE_TTL_BETA);
	});
});

describe("model cacheRetention through a provider's exported stream function", () => {
	const savedEnv = process.env.PI_CACHE_RETENTION;
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = savedEnv;
	});

	it("streamAnthropic called directly writes the model's 1-hour entries", async () => {
		const { ttls, betas } = await captureRequest(anthropicModel("long"), undefined, streamAnthropic);
		expect(ttls.length).toBeGreaterThan(0);
		expect(ttls.every(ttl => ttl === "1h")).toBe(true);
		expect(betas).toContain(EXTENDED_CACHE_TTL_BETA);
	});

	it("streamOpenAIResponses called directly keeps a model's `none` over PI_CACHE_RETENTION=long", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const responsesModel = (cacheRetention?: Model["cacheRetention"]) =>
			buildModel({
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				...(cacheRetention !== undefined ? { cacheRetention } : {}),
			}) as Model<"openai-responses">;
		const sentBody = async (model: Model<"openai-responses">): Promise<Record<string, unknown>> => {
			let body: Record<string, unknown> | undefined;
			const fetchImpl: FetchImpl = async (_input, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400 });
			};
			await streamOpenAIResponses(model, CONTEXT, { apiKey: "sk-test", fetch: fetchImpl }).result();
			if (!body) throw new Error("no request reached the transport");
			return body;
		};
		// The environment alone asks for a long policy on this endpoint...
		expect((await sentBody(responsesModel())).prompt_cache_options).toBeDefined();
		// ...and the model's own `none` turns it off.
		expect((await sentBody(responsesModel("none"))).prompt_cache_options).toBeUndefined();
	});

	it("the Codex serializer (turns and V2 compaction) keeps a model's `none` over PI_CACHE_RETENTION=long", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const codexModel = (cacheRetention?: Model["cacheRetention"]) =>
			buildModel({
				id: "gpt-5.6-terra",
				name: "GPT-5.6 Terra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				...(cacheRetention !== undefined ? { cacheRetention } : {}),
			}) as Model<"openai-codex-responses">;
		const keyFor = async (model: Model<"openai-codex-responses">) =>
			(await buildTransformedCodexRequestBody(model, CONTEXT, { sessionId: "session-1" })).prompt_cache_key;
		expect(await keyFor(codexModel())).toBe("session-1");
		expect(await keyFor(codexModel("none"))).toBeUndefined();
	});

	it("streamSynthetic's Anthropic format keeps a model's `none` over PI_CACHE_RETENTION=long", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const model = buildModel({
			id: "hf:moonshotai/Kimi-K2",
			name: "Kimi K2",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
			cacheRetention: "none",
		}) as Model<"openai-completions">;
		let body: unknown;
		const fetchImpl: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return successResponse();
		};
		await streamSynthetic(model, CONTEXT, { apiKey: "k", format: "anthropic", fetch: fetchImpl }).result();
		expect(body).toBeDefined();
		expect(JSON.stringify(body)).not.toContain("cache_control");
	});
});

describe("model cacheRetention through streamSimple branches that skip the shared dispatch", () => {
	afterEach(() => clearCustomApis());

	it("reaches a custom API's streamSimple, and a request's own retention still wins", async () => {
		const seen: Array<SimpleStreamOptions["cacheRetention"]> = [];
		const bothSeen = Promise.withResolvers<void>();
		registerCustomApi("model-retention-custom", (_model, _context, options) => {
			seen.push(options?.cacheRetention);
			if (seen.length === 2) bothSeen.resolve();
			return new AssistantMessageEventStream();
		});
		const model = buildModel({
			id: "custom-claude",
			name: "Custom Claude",
			api: "model-retention-custom",
			provider: "custom-claude",
			baseUrl: "https://custom.example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
			cacheRetention: "long",
		} as Parameters<typeof buildModel>[0]);
		streamSimple(model, CONTEXT, { apiKey: "k" });
		streamSimple(model, CONTEXT, { apiKey: "k", cacheRetention: "short" });
		await bothSeen.promise;
		expect(seen).toEqual(["long", "short"]);
	});
});

describe("a retention of `none` is not put back downstream", () => {
	const savedEnv = process.env.PI_CACHE_RETENTION;
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = savedEnv;
	});

	it("the exported Responses serializer keeps a model's `none` over PI_CACHE_RETENTION=long", () => {
		process.env.PI_CACHE_RETENTION = "long";
		const responsesModel = (cacheRetention?: Model["cacheRetention"]) =>
			buildModel({
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				...(cacheRetention !== undefined ? { cacheRetention } : {}),
			}) as Model<"openai-responses">;
		const params = (model: Model<"openai-responses">) =>
			buildResponsesParams(model, CONTEXT, { sessionId: "session-1" }, undefined).params;
		expect(params(responsesModel()).prompt_cache_options).toBeDefined();
		expect(params(responsesModel("none")).prompt_cache_options).toBeUndefined();
		expect(params(responsesModel("none")).prompt_cache_key).toBeUndefined();
	});

	it("Factory Droid's Responses route keeps the native 24h default and honours a chosen `short` or `none`", async () => {
		const captured: CapturedRequest[] = [];
		const send = (cacheRetention?: "short" | "none") =>
			streamFactoryDroid(factoryModel("gpt-5.6-terra", ["openai"]), CONTEXT, {
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, responsesChunks("ok")),
				sessionId: "session-1",
				...(cacheRetention ? { cacheRetention } : {}),
			}).result();
		await send();
		await send("short");
		await send("none");
		const [unset, short, none] = captured.map(request => request.body);
		expect(unset?.prompt_cache_key).toBeDefined();
		expect(unset?.prompt_cache_retention).toBe("24h");
		expect(short?.prompt_cache_key).toBeDefined();
		expect(short?.prompt_cache_retention).toBeUndefined();
		expect(none?.prompt_cache_key).toBeUndefined();
		expect(none?.prompt_cache_retention).toBeUndefined();
	});

	it("an OAuth Anthropic request under `none` puts no breakpoint on the Claude Code identity block", async () => {
		let body: unknown;
		const fetchImpl: FetchImpl = async (_input, init) => {
			// The OAuth path signs the body, which then reaches fetch as bytes.
			body = JSON.parse(requestBodyText(init) ?? "{}");
			return successResponse();
		};
		const model = buildModel({
			...anthropicModel("none"),
			provider: "custom-anthropic",
			baseUrl: "https://oauth-proxy.example/anthropic",
		}) as Model<"anthropic-messages">;
		await streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			providerSessionState: new Map(),
			fetch: fetchImpl,
			maxHttpAttempts: 1,
		}).result();
		expect(body).toBeDefined();
		expect(JSON.stringify(body)).not.toContain("cache_control");
	});

	it("Chat Completions with an Anthropic cache format writes the retention's tier: none, 5m, or 1h", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const chatModel = (cacheRetention?: Model["cacheRetention"]) =>
			buildModel({
				id: "anthropic/claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				compat: { cacheControlFormat: "anthropic" },
				...(cacheRetention !== undefined ? { cacheRetention } : {}),
			}) as Model<"openai-completions">;
		const sentBody = async (model: Model<"openai-completions">): Promise<string> => {
			let body: string | undefined;
			const fetchImpl: FetchImpl = async (_input, init) => {
				body = requestBodyText(init);
				return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400 });
			};
			await streamOpenAICompletions(model, CONTEXT, { apiKey: "k", fetch: fetchImpl }).result();
			if (body === undefined) throw new Error("no request reached the transport");
			return body;
		};
		// PI_CACHE_RETENTION=long with no model value: the 1-hour marker.
		expect(await sentBody(chatModel())).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}');
		expect(await sentBody(chatModel("short"))).toContain('"cache_control":{"type":"ephemeral"}');
		expect(await sentBody(chatModel("none"))).not.toContain("cache_control");
	});
});
