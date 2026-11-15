import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { getBundledModels } from "../src/models";
import { toModelSpec } from "../src/provider-models/bundled-references";

const apiKey = serializeCloudflareCredential({ token: "token", accountId: "account", gatewayId: "gateway" });
const references = getBundledModels("cloudflare-ai-gateway").filter(
	model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
).slice(0, 2);
if (references.length < 2) throw new Error("Expected two bundled Workers AI gateway chat models");
const [seed, partial] = references;

function workersResult(name: string) {
	return Response.json({ success: true, result: [{ name, task: { name: "Text Generation" } }] });
}

describe("Workers AI discovery safety", () => {
	test("accepts a short filtered page without total_pages even when total_count is unfiltered", async () => {
		const requests: URL[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			requests.push(url);
			return Response.json({
				success: true,
				result_info: { count: 40, page: 1, per_page: 100, total_count: 334 },
				result: Array.from({ length: 40 }, (_, i) => ({
					name: i === 0 ? seed!.id.slice("workers-ai/".length) : `@cf/example/model-${i}`,
					task: { name: "Text Generation" },
				})),
			});
		}) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({ apiKey, fetch: fetchMock }).fetchDynamicModels?.();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.searchParams.get("task")).toBe("Text Generation");
		expect(requests[0]?.searchParams.get("per_page")).toBe("100");
		expect(models).toHaveLength(40);
		expect(models?.find(model => model.id === seed!.id)).toEqual({ ...toModelSpec(seed!), discoveryCostFields: [], discoveryMetadataFields: [] });
		for (let i = 1; i < 40; i++) {
			const model = models?.find(model => model.id === `workers-ai/@cf/example/model-${i}`);
			expect(model).toBeDefined();
			expect(model?.supportsTools).toBeUndefined();
		}
	});

	test("publishes unbundled text generation despite unverified protocol", async () => {
		const names = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "@cf/cloudflare/clef-omni", "@cf/example/new-decision"];
		const fetchMock = (async () => Response.json({
			success: true,
			result: names.map(name => ({
				name,
				task: { name: "Text Generation" },
				description: "A multimodal decision model for typed questions",
			})),
		})) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({ apiKey, fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "workers-ai/@cf/example/new-decision")).toBe(true);
	});

	test("does not infer capabilities or limits from untrusted search metadata", async () => {
		const fetchMock = (async () => Response.json({
			success: true,
			result: [{
				name: seed!.id.slice("workers-ai/".length),
				task: { name: "Text Generation" },
				context_window: 999999,
				max_tokens: 99999,
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				pricing: { input: 42, output: 43 },
			}],
		})) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({ apiKey, fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).toEqual([{ ...toModelSpec(seed!), discoveryCostFields: [], discoveryMetadataFields: [] }]);
	});

	test.each(["workers", "anthropic"])("retains cached models and saves partial results when %s discovery fails", async failed => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-catalog-"));
		try {
			let failing = false;
			const attempted = new Set<string>();
			const fetchMock = (async (input: string | URL | Request) => {
				const workers = new URL(String(input)).hostname === "api.cloudflare.com";
				const source = workers ? "workers" : "anthropic";
				attempted.add(source);
				if (failing && source === failed) return new Response("unavailable", { status: 500 });
				return workers
					? workersResult((failing ? partial! : seed!).id.slice("workers-ai/".length))
					: Response.json({ data: [{ id: failing ? "anthropic-partial" : "anthropic-seed", display_name: "Model" }] });
			}) as typeof fetch;
			const manager = createModelManager({
				...cloudflareAiGatewayModelManagerOptions({ apiKey, baseUrl: "https://gateway.example/anthropic", fetch: fetchMock }),
				staticModels: [],
				cacheDbPath: path.join(dir, "models.db"),
			});
			const seeded = await manager.refresh("online");
			expect(seeded.models.some(model => model.id === seed!.id)).toBe(true);
			expect(seeded.models.some(model => model.id === "anthropic-seed")).toBe(true);
			failing = true;
			attempted.clear();
			await manager.refresh("online");
			expect([...attempted].sort()).toEqual(["anthropic", "workers"]);
			const cached = await manager.refresh("offline");
			expect(cached.models.some(model => model.id === seed!.id)).toBe(true);
			expect(cached.models.some(model => model.id === "anthropic-seed")).toBe(true);
			expect(cached.models.some(model => model.id === partial!.id)).toBe(failed === "anthropic");
			expect(cached.models.some(model => model.id === "anthropic-partial")).toBe(failed === "workers");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
