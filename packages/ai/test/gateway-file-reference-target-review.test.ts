import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RouteRegistry, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import * as Stream from "@oh-my-pi/pi-ai/stream";
import type { Api, Model, AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
afterEach(() => vi.restoreAllMocks());
function model(id: string, api: Api): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider: "openai",
		api,
		baseUrl: "https://upstream.example/v1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}
function reply(m: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: m.api,
		provider: m.provider,
		model: m.id,
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
async function fixture(order: "compatible-first" | "compatible-last", run: (url: string) => Promise<void>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-file-target-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openai", "test-key");
	const good = model("good", "openai-responses"),
		bad = model("bad", "openai-completions");
	const resolveModel = (id: string) => (id === "good" ? good : id === "bad" ? bad : undefined);
	const registry = new RouteRegistry(resolveModel);
	registry.register({
		id: "route",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: (order === "compatible-first" ? ["good", "bad"] : ["bad", "good"]).map(id => ({
				type: "target",
				model: id,
			})),
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel,
		routeRegistry: registry,
		version: "test",
	});
	try {
		await run(gateway.url);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}
const post = (url: string, input: unknown) =>
	fetch(`${url}/v1/responses`, {
		method: "POST",
		headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
		body: JSON.stringify({ model: "route", input, stream: false, prompt_cache_key: "same" }),
	});
for (const nativeInput of [false, true]) {
	it(`blocks incompatible fallback for ${nativeInput ? "ordinary input" : "tool-output"} file references`, async () => {
		const dispatched: string[] = [];
		vi.spyOn(Stream, "completeSimple").mockImplementation(async m => {
			dispatched.push(m.id);
			if (m.id === "good") throw new Error("service unavailable");
			return reply(m);
		});
		await fixture("compatible-first", async url => {
			const input = nativeInput
				? [{ role: "user", content: [{ type: "input_image", file_id: "file_image" }] }]
				: [
						{
							type: "function_call_output",
							call_id: "call",
							output: [{ type: "input_image", file_id: "file_image" }],
						},
					];
			const response = await post(url, input);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("Responses-compatible");
			expect(dispatched).toEqual(["good"]);
		});
	});
}

it("validates a cached compatible target instead of the incompatible route primary", async () => {
	const dispatched: string[] = [];
	vi.spyOn(Stream, "completeSimple").mockImplementation(async m => {
		dispatched.push(m.id);
		if (m.id === "bad") throw new Error("service unavailable");
		return reply(m);
	});
	await fixture("compatible-last", async url => {
		const warm = await post(url, "warm");
		expect(warm.status).toBe(200);
		await warm.text();
		const response = await post(url, [
			{ type: "function_call_output", call_id: "call", output: [{ type: "input_image", file_id: "file_image" }] },
		]);
		expect(response.status).toBe(200);
		await response.text();
		expect(dispatched).toEqual(["bad", "good", "good"]);
	});
});
