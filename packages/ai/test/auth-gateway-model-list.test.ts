import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

test("model listing exposes one provider-qualified route per upstream model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-model-list-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const anthropic = createMockModel({ provider: "anthropic", id: "shared-model" });
	const devin = createMockModel({ provider: "devin", id: "shared-model" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		listModels: () => [anthropic, anthropic, devin, devin],
		version: "test",
	});

	try {
		const response = await fetch(`${handle.url}/v1/models`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{
					id: "anthropic/shared-model",
					object: "model",
					owned_by: "anthropic",
					api: "mock",
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
					reasoning: false,
				},
				{
					id: "devin/shared-model",
					object: "model",
					owned_by: "devin",
					api: "mock",
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
					reasoning: false,
				},
			],
		});
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("model listing advertises only a reasoning ladder the catalog has verified", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-model-list-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const verified = {
		...createMockModel({ provider: "acme", id: "verified", reasoning: true }),
		thinking: {
			mode: "effort" as const,
			efforts: [Effort.Low, Effort.High],
			defaultLevel: Effort.High,
			requiresEffort: false,
		},
	};
	const provisional = {
		...createMockModel({ provider: "acme", id: "provisional", reasoning: true }),
		thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High], unverified: true },
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		listModels: () => [verified, provisional],
		version: "test",
	});

	try {
		const response = await fetch(`${handle.url}/v1/models`);
		const { data } = (await response.json()) as { data: Record<string, unknown>[] };
		expect(data[0]).toMatchObject({
			id: "acme/verified",
			reasoning: true,
			supported_reasoning_levels: ["low", "high"],
			default_reasoning_level: "high",
			reasoning_required: false,
		});
		// A provisional ladder is a guess; advertising it would make clients
		// trust tiers the upstream may reject.
		expect(data[1]?.id).toBe("acme/provisional");
		for (const field of [
			"reasoning",
			"supported_reasoning_levels",
			"default_reasoning_level",
			"reasoning_required",
		]) {
			expect(data[1]).not.toHaveProperty(field);
		}
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
