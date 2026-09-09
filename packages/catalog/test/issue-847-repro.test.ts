import { afterEach, describe, expect, test, vi } from "bun:test";
import { ollamaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ollama provider context window discovery (issue #847)", () => {
	test("uses /api/show context_length for unbundled cloud models like deepseek-v4-flash:cloud", async () => {
		const showCalls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "deepseek-v4-flash:cloud", object: "model" },
							{ id: "llama3.2:3b", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				showCalls.push(body.model ?? "");
				if (body.model === "deepseek-v4-flash:cloud") {
					return new Response(
						JSON.stringify({
							model_info: { "deepseek4.context_length": 1048576 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (body.model === "llama3.2:3b") {
					return new Response(
						JSON.stringify({
							model_info: { "llama.context_length": 131072 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const deepseek = models?.find(m => m.id === "deepseek-v4-flash:cloud");
		const llama = models?.find(m => m.id === "llama3.2:3b");
		expect(deepseek?.contextWindow).toBe(1048576);
		expect(llama?.contextWindow).toBe(131072);
		expect(showCalls.sort()).toEqual(["deepseek-v4-flash:cloud", "llama3.2:3b"]);
	});

	test("caches /api/show results across repeated fetchDynamicModels calls", async () => {
		const showCalls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "deepseek-v4-flash:cloud", object: "model" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				showCalls.push(body.model ?? "");
				return new Response(JSON.stringify({ model_info: { "deepseek4.context_length": 1048576 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaModelManagerOptions({ fetch: fetchMock });
		await options.fetchDynamicModels?.();
		await options.fetchDynamicModels?.();
		expect(showCalls).toEqual(["deepseek-v4-flash:cloud"]);
	});

	test("falls back to 128k when /api/show is unavailable", async () => {
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(JSON.stringify({ object: "list", data: [{ id: "mystery:1b", object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				return new Response(null, { status: 500 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const mystery = models?.find(m => m.id === "mystery:1b");
		expect(mystery?.contextWindow).toBe(128000);
	});
});
