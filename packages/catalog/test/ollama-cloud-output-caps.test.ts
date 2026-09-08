import { expect, test, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { ollamaCloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/ollama";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const cloudModel: Model<"ollama-chat"> = {
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	identity: { class: "deepseek" },
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
	compat: undefined,
};

function createNdjsonResponse(lines: unknown[]): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

test("ollama-cloud discovery does not inherit unsafe cross-provider maxTokens", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			return new Response(JSON.stringify({ models: [{ name: "kimi-k2.5" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://ollama.com/api/show") {
			return new Response(JSON.stringify({ capabilities: ["completion"] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "kimi-k2.5");

	expect(model?.contextWindow).toBe(128000);
	expect(model?.maxTokens).toBe(8192);
});

test("ollama-cloud discovery caps discovered max-output at the enforced ceiling (#7266)", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			return new Response(JSON.stringify({ models: [{ name: "deepseek-v4-flash:0731" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://ollama.com/api/show") {
			return new Response(
				JSON.stringify({ capabilities: ["completion"], model_info: { "deepseek.context_length": 1048576 } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "deepseek-v4-flash:0731");

	expect(model?.contextWindow).toBe(1048576);
	// Ollama Cloud rejects output budgets above 65536, so the 1M context window
	// must not surface as the max-output figure.
	expect(model?.maxTokens).toBe(65536);
});

test("ollama-cloud discovery caps a capped model by its context window when below the ceiling", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			return new Response(JSON.stringify({ models: [{ name: "deepseek-v4-flash:mini" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://ollama.com/api/show") {
			return new Response(
				JSON.stringify({ capabilities: ["completion"], model_info: { "deepseek.context_length": 32768 } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "deepseek-v4-flash:mini");

	expect(model?.contextWindow).toBe(32768);
	expect(model?.maxTokens).toBe(32768);
});

test("ollama-cloud discovery always omits max output tokens", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			return new Response(JSON.stringify({ models: [{ name: "deepseek-v4-flash" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://ollama.com/api/show") {
			return new Response(
				JSON.stringify({
					capabilities: ["completion", "thinking"],
					model_info: { "deepseek4.context_length": 1048576 },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "deepseek-v4-flash");

	expect(model?.provider).toBe("ollama-cloud");
	expect(model?.contextWindow).toBe(1048576);
	expect(model?.maxTokens).toBe(65536);
	expect(model?.omitMaxOutputTokens).toBe(true);
});

test("ollama-chat omits num_predict when model opts out of max output tokens", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-v4-flash", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-v4-flash", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	const model: Model<"ollama-chat"> = { ...cloudModel, omitMaxOutputTokens: true };
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock, maxTokens: 384000 },
	).result();

	expect(requestBody).not.toHaveProperty("options");
});

test("ollama-chat clamps num_predict at the Ollama Cloud 65536 output-token cap (#3392)", async () => {
	// Stale cached models.db row: maxTokens carried forward from a pre-fix
	// catalog (or a user modelOverride re-enabling output caps), no
	// `omitMaxOutputTokens` policy applied — so the model spec arrives at the
	// wire with `maxTokens: 1048576`. Ollama Cloud rejects anything above
	// 65536 with HTTP 400; the wire layer must clamp before sending.
	const staleCachedSpec: Model<"ollama-chat"> = {
		id: "deepseek-v4-pro",
		name: "deepseek-v4-pro",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		identity: { class: "deepseek" },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 524288,
		maxTokens: 1_048_576,
		compat: undefined,
	};

	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-v4-pro", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-v4-pro", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	await streamSimple(
		staleCachedSpec,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock },
	).result();

	const options = requestBody?.options as { num_predict?: number } | undefined;
	expect(options?.num_predict).toBe(65_536);
});

test("ollama-chat does not clamp num_predict for self-hosted ollama (#3392)", async () => {
	// Sanity: the clamp is provider-scoped to `ollama-cloud`. A local Ollama
	// host carries its own output-token semantics — the wire layer must not
	// rewrite `num_predict` for non-cloud `ollama-chat` traffic.
	const localSpec: Model<"ollama-chat"> = {
		id: "deepseek-r1:70b",
		name: "deepseek-r1:70b",
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		identity: { class: "deepseek" },
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: undefined,
	};

	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-r1:70b", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-r1:70b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	await streamSimple(
		localSpec,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "local-key", fetch: fetchMock },
	).result();

	const options = requestBody?.options as { num_predict?: number } | undefined;
	expect(options?.num_predict).toBe(131_072);
});

test("ollama-chat sends think false when reasoning is disabled", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-v4-flash", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-v4-flash", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	await streamSimple(
		cloudModel,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock, disableReasoning: true },
	).result();

	expect(requestBody?.think).toBe(false);
});

test("ollama-chat surfaces HTTP 400 response bodies", async () => {
	const fetchMock: FetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ error: { message: "num_predict exceeds model cap", type: "invalid_request" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			),
	);

	const response = await streamSimple(
		cloudModel,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock },
	).result();

	expect(response.stopReason).toBe("error");
	expect(response.errorStatus).toBe(400);
	expect(response.errorMessage).toContain("HTTP 400 from https://ollama.com/api/chat");
	expect(response.errorMessage).toContain("num_predict exceeds model cap");
});
