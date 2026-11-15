import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "../src/models";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

test("partial gateway refresh serves successful models without destroying cached source results", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-partial-"));
	try {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		);
		if (!reference) throw new Error("Expected a bundled Workers AI gateway model");
		let workersFail = true;
		let anthropicFail = false;
		const fetchMock = (async (input: string | URL | Request) => {
			if (new URL(String(input)).hostname === "api.cloudflare.com") {
				return workersFail
					? new Response("", { status: 403 })
					: Response.json({ success: true, result: [{ name: reference.id.slice("workers-ai/".length) }] });
			}
			return anthropicFail
				? new Response("", { status: 500 })
				: Response.json({ data: [{ id: "claude-custom", display_name: "Claude Custom" }] });
		}) as typeof fetch;
		const manager = createModelManager({
			...cloudflareAiGatewayModelManagerOptions({
				apiKey: serializeCloudflareCredential({ token: "token", accountId: "account", gatewayId: "gateway" }),
				baseUrl: "https://gateway.example/anthropic",
				fetch: fetchMock,
			}),
			cacheDbPath: path.join(dir, "cache.db"),
		});
		const cold = await manager.refresh("online");
		expect(cold.models.some(model => model.id === "claude-custom")).toBe(true);
		expect(cold.stale).toBe(true);
		expect(cold.fetchError).toContain("Workers AI read permission");
		workersFail = false;
		const full = await manager.refresh("online");
		expect(full.models.some(model => model.id === reference.id)).toBe(true);
		expect(full.stale).toBe(false);
		anthropicFail = true;
		const partial = await manager.refresh("online");
		expect(partial.models.some(model => model.id === "claude-custom")).toBe(true);
		expect(partial.models.some(model => model.id === reference.id)).toBe(true);
		expect(partial.stale).toBe(true);
		const offline = await manager.refresh("offline");
		expect(offline.models.some(model => model.id === "claude-custom")).toBe(true);
		expect(offline.models.some(model => model.id === reference.id)).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
