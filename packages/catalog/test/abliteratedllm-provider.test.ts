import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { abliteratedllmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Entries mirror live `https://api.abliteratedllm.dev/v1/models` payloads:
 * `pricing` as decimal strings in USD per million tokens, `context_length`,
 * `max_output_tokens`, `input_modalities`, and `capabilities`. Ids under
 * `abliteratedllm-test/` are never bundled, so they exercise the
 * no-reference path.
 */
function abliteratedllmModelsFetch(data: Record<string, unknown>[]): {
	calls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

async function discover(data: Record<string, unknown>[], options: { apiKey?: string } = { apiKey: "sk-test" }) {
	const { calls, authorizations, fetch } = abliteratedllmModelsFetch(data);
	const models = await abliteratedllmModelManagerOptions({ ...options, fetch }).fetchDynamicModels?.();
	return { calls, authorizations, models: models ?? [] };
}

const FULL_ROW = {
	id: "abliteratedllm-test/full-model",
	object: "model",
	created: 1793664000,
	owned_by: "AbliteratedLLM",
	name: "Full Model",
	context_length: 1048576,
	max_output_tokens: 131072,
	pricing: { input: "0.0977", output: "0.3421", cached_input: "0.0098", priority: null },
	provider_label: null,
	variant: "abliterated",
	input_modalities: ["text", "image"],
	capabilities: { reasoning: true, vision: true, priority_tier: false },
	precision: "FP8",
};

describe("AbliteratedLLM provider discovery", () => {
	test("a live row drops bundled reasoning and vision, fresh and from cache", async () => {
		const bundled = getBundledModels("abliteratedllm").find(
			model => model.reasoning && model.input.includes("image"),
		);
		expect(bundled?.thinking).toBeDefined();
		const { fetch } = abliteratedllmModelsFetch([
			{
				...FULL_ROW,
				id: bundled!.id,
				input_modalities: ["text"],
				capabilities: { reasoning: false, vision: false, priority_tier: false },
			},
		]);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-abliteratedllm-authority-"));
		try {
			const options = {
				...abliteratedllmModelManagerOptions({ apiKey: "sk-test", fetch }),
				cacheDbPath: path.join(tempDir, "models.db"),
			};
			for (const strategy of ["online", "offline"] as const) {
				const { models } = await createModelManager(options).refresh(strategy);
				const model = models.find(entry => entry.id === bundled!.id);
				expect(model).toMatchObject({ reasoning: false, input: ["text"] });
				expect(model?.thinking).toBeUndefined();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("maps AbliteratedLLM catalog metadata", async () => {
		const { calls, authorizations, models } = await discover([FULL_ROW]);

		expect(calls[0]).toBe("https://api.abliteratedllm.dev/v1/models");
		expect(authorizations[0]).toBe("Bearer sk-test");
		expect(models.find(model => model.id === FULL_ROW.id)).toMatchObject({
			provider: "abliteratedllm",
			api: "openai-completions",
			baseUrl: "https://api.abliteratedllm.dev/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 131072,
			cost: { input: 0.0977, output: 0.3421, cacheRead: 0.0098, cacheWrite: 0 },
		});
	});

	test("discovers the public catalog without a key", async () => {
		const { calls, authorizations, models } = await discover([FULL_ROW], {});

		expect(calls[0]).toBe("https://api.abliteratedllm.dev/v1/models");
		expect(authorizations[0]).toBeNull();
		expect(models.map(model => model.id)).toContain(FULL_ROW.id);
	});

	test("a row without reasoning carries no effort ladder", async () => {
		const { models } = await discover([
			{
				...FULL_ROW,
				id: "abliteratedllm-test/no-reasoning",
				input_modalities: ["text"],
				capabilities: { reasoning: false, vision: false, priority_tier: false },
			},
		]);
		const model = models.find(entry => entry.id === "abliteratedllm-test/no-reasoning");
		expect(model?.reasoning).toBe(false);
		expect(model?.thinking).toBeUndefined();
		expect(model?.input).toEqual(["text"]);
	});

	test("a missing capabilities object keeps the row's other live metadata", async () => {
		const { capabilities: _capabilities, ...row } = FULL_ROW;
		const { models } = await discover([{ ...row, id: "abliteratedllm-test/no-capabilities" }]);
		expect(models.find(model => model.id === "abliteratedllm-test/no-capabilities")).toMatchObject({
			input: ["text", "image"],
			maxTokens: 131072,
			cost: { input: 0.0977, output: 0.3421, cacheRead: 0.0098, cacheWrite: 0 },
		});
	});

	test("a metadata-less row that is not bundled invents no capabilities", async () => {
		const { models } = await discover([
			{
				id: "abliteratedllm-test/bare-model",
				object: "model",
				owned_by: "AbliteratedLLM",
			},
		]);
		const bare = models.find(model => model.id === "abliteratedllm-test/bare-model");
		expect(bare).toMatchObject({ provider: "abliteratedllm", reasoning: false, input: ["text"] });
		expect(bare?.thinking).toBeUndefined();
		expect(bare?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

/** The Chat Completions request body omp sends for the bundled AbliteratedLLM model `id` at `effort`. */
async function chatRequestBody(id: string, effort: Effort): Promise<Record<string, unknown>> {
	const model = getBundledModel<"openai-completions">("abliteratedllm", id);
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
		const chunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: id,
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
	await streamSimple(model, context, { apiKey: "sk-test", fetch, reasoning: effort }).result();
	expect(requests.map(request => request.url)).toEqual(["https://api.abliteratedllm.dev/v1/chat/completions"]);
	return requests[0]!.body;
}

// Checked against api.abliteratedllm.dev on 2026-11-14: glm-5.3 and kimi-k3
// accept `reasoning_effort: "max"`, and glm-5.3-flash-abliterated rejects
// `minimal`, which the provider rule sends as `low`.
describe("AbliteratedLLM chat completions requests", () => {
	test("Qwen 3.8 sends the selected effort as reasoning_effort, not enable_thinking", async () => {
		for (const effort of [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]) {
			const body = await chatRequestBody("qwen3.8-max", effort);
			expect(body.reasoning_effort).toBe(effort);
			expect(body.enable_thinking).toBeUndefined();
			expect(body.chat_template_kwargs).toBeUndefined();
			expect(body.store).toBeUndefined();
		}
	});

	test("minimal is sent as low", async () => {
		for (const id of ["qwen3.8-max", "glm-5.3-flash-abliterated"]) {
			expect((await chatRequestBody(id, Effort.Minimal)).reasoning_effort).toBe("low");
		}
	});

	test("max passes through on GLM-5.3 and Kimi K3", async () => {
		for (const id of ["glm-5.3", "kimi-k3"]) {
			expect((await chatRequestBody(id, Effort.Max)).reasoning_effort).toBe("max");
		}
	});
});
