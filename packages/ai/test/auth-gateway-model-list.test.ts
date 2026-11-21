import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

async function withGateway(models: Model<Api>[], run: (url: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-model-list-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		listModels: () => models,
		version: "test",
	});
	try {
		await run(handle.url);
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

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
					context_window: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
				{
					id: "devin/shared-model",
					object: "model",
					owned_by: "devin",
					api: "mock",
					display_name: "shared-model",
					context_length: 200_000,
					context_window: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
			],
		});
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("pi-native Codex discovery through the gateway keeps reasoning and the window for ids missing from the bundled openai-codex catalog", async () => {
	const ladder = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
	const openaiSol = getBundledModel("openai", "gpt-6.2-sol");
	const bundledCodex = getBundledModel("openai-codex", "gpt-6.1-sol");
	// Preconditions: the unknown id exists only under `openai`, and the known id
	// is a bundled openai-codex reasoning model with its own ladder.
	expect(getBundledModel("openai-codex", "gpt-6.2-sol")).toBeUndefined();
	expect(openaiSol).toBeDefined();
	expect(bundledCodex?.thinking?.efforts?.length).toBeGreaterThan(0);

	const unknownCodex: Model<Api> = {
		...openaiSol,
		provider: "openai-codex",
		api: "openai-codex-responses",
		reasoning: true,
		thinking: { mode: "effort", efforts: ladder },
		contextWindow: 1_050_000,
	};
	const otherProvider = createMockModel({ provider: "anthropic", id: "gpt-6.2-sol" });

	await withGateway([unknownCodex, { ...bundledCodex }, otherProvider], async url => {
		const listing = (await (await fetch(`${url}/v1/models`)).json()) as {
			data: Array<Record<string, unknown> & { id: string; owned_by: string }>;
		};
		const rawBundled = listing.data.find(row => row.id === "openai-codex/gpt-6.1-sol");
		expect(rawBundled).toBeDefined();
		// A bundled id must keep the client's bundled thinking reference; an
		// advertised ladder would replace it wholesale during discovery.
		expect(rawBundled).not.toHaveProperty("supported_reasoning_levels");
		expect(rawBundled).not.toHaveProperty("default_reasoning_level");

		// Mirror a `/p/openai-codex` shim: keep this provider's rows, strip the prefix.
		const codexRows = listing.data
			.filter(row => row.owned_by === "openai-codex")
			.map(row => ({ ...row, id: row.id.slice("openai-codex/".length) }));
		const baseUrl = "https://gw.example/p/openai-codex";
		const discovered = await fetchCodexModels({
			accessToken: "x",
			baseUrl,
			paths: ["/models"],
			fetchFn: Object.assign(async () => Response.json({ object: "list", data: codexRows }), {
				preconnect() {},
			}),
		});
		const byId = new Map(discovered?.models.map(spec => [spec.id, buildModel(spec)]));
		expect([...byId.keys()].sort()).toEqual(["gpt-6.1-sol", "gpt-6.2-sol"]);

		const sol = byId.get("gpt-6.2-sol");
		expect(sol?.reasoning).toBe(true);
		expect(sol?.thinking?.efforts).toEqual(ladder);
		expect(sol?.contextWindow).toBe(1_050_000);
	});
});
