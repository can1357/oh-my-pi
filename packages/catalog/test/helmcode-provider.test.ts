import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { helmcodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

/** helmcode.com/docs/models "Controlling reasoning"; host class ladders would send `xhigh`. */
const DEEPSEEK_LADDER = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max];
/** Qwen3.6 and Gemma 4 treat `minimal` like `none` (reasoning skipped), so it is not a tier. */
const BUDGETED_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
const GLM_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
/** Helmcode documents no effort values for resold models; vendor ladders would send minimal/xhigh/max. */
const FRONTIER_LADDER = [Effort.Low, Effort.Medium, Effort.High];

function rosterFetch(ids: readonly string[]): FetchImpl {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ data: ids.map(id => ({ id, owned_by: "helmcode" })) }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as FetchImpl;
}

async function resolveRoster(fetch: FetchImpl): Promise<Map<string, Model<"openai-completions">>> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-helmcode-"));
	try {
		const result = await resolveProviderModels(
			{
				...helmcodeModelManagerOptions({ apiKey: "sk-helmcode", fetch }),
				staticModels: getBundledModels("helmcode"),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);
		return new Map(result.models.map(model => [model.id, model as Model<"openai-completions">]));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function vendorRow(provider: "anthropic" | "openai" | "google", id: string): Model {
	const row = getBundledModels(provider).find(candidate => candidate.id === id);
	if (!row) throw new Error(`missing bundled ${provider}/${id}`);
	return row as Model;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Helmcode provider support", () => {
	test("live roster drops non-chat SKUs, prunes absent seed rows, and keeps Helmcode's effort ladders", async () => {
		// gemma4 is absent from this roster, so its seed row is pruned; glm5.3-flash has no bundled row.
		const fetchMock = rosterFetch([
			"deepseek-v4-flash",
			"qwen3.6",
			"glm5.3",
			"glm5.3-flash",
			"qwen3-embedding",
			"rerank",
			"kokoro",
			"whisper",
		]);
		const byId = await resolveRoster(fetchMock);

		expect([...byId.keys()].sort()).toEqual(["deepseek-v4-flash", "glm5.3", "glm5.3-flash", "qwen3.6"]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.helmcode.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer sk-helmcode" }),
			}),
		);
		expect(byId.get("deepseek-v4-flash")?.thinking?.efforts).toEqual(DEEPSEEK_LADDER);
		expect(byId.get("qwen3.6")?.thinking?.efforts).toEqual(BUDGETED_LADDER);
		expect(byId.get("glm5.3")?.thinking?.efforts).toEqual(GLM_LADDER);
		expect(byId.get("glm5.3-flash")?.thinking?.efforts).toEqual(GLM_LADDER);
	});

	test("thinking-off sends `none` where Helmcode documents it as the only way to skip reasoning", async () => {
		const byId = await resolveRoster(rosterFetch(["deepseek-v4-flash", "qwen3.6", "gemma4", "glm5.3"]));

		expect(byId.get("deepseek-v4-flash")?.compat.reasoningDisableMode).toBe("none-effort");
		expect(byId.get("qwen3.6")?.compat.reasoningDisableMode).toBe("none-effort");
		expect(byId.get("gemma4")?.compat.reasoningDisableMode).toBe("none-effort");
		// GLM documents no `none`; the lowest tier stays the off fallback.
		expect(byId.get("glm5.3")?.compat.reasoningDisableMode).toBe("lowest-effort");
	});

	test("resold frontier ids inherit first-party vendor capabilities but keep Helmcode's wire shape", async () => {
		const vendors = {
			"claude-sonnet-5": "anthropic",
			// A gateway (aimlapi) ties Anthropic on limits and carries a zero price for this id.
			"claude-opus-4-7": "anthropic",
			"gpt-5.6-luna": "openai",
			"gemini-3.6-flash": "google",
		} as const;
		const byId = await resolveRoster(rosterFetch(Object.keys(vendors)));

		for (const [id, vendorProvider] of Object.entries(vendors)) {
			const vendor = vendorRow(vendorProvider, id);
			const model = byId.get(id);
			expect(model).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://api.helmcode.com/v1",
				reasoning: true,
				input: vendor.input,
				contextWindow: vendor.contextWindow,
				maxTokens: vendor.maxTokens,
			});
			expect(model?.cost.input).toBe(vendor.cost.input);
			expect(model?.cost.output).toBe(vendor.cost.output);
			expect(model?.cost.cacheRead).toBe(vendor.cost.cacheRead);
			expect(model?.thinking).toMatchObject({ mode: "effort", efforts: FRONTIER_LADDER });
			expect(model?.webSearch).toBeUndefined();
		}
		expect(byId.get("claude-opus-4-7")?.cost.input).toBeGreaterThan(0);
		// Helmcode bills cache writes only for Anthropic models.
		expect(byId.get("claude-sonnet-5")?.cost.cacheWrite).toBe(
			vendorRow("anthropic", "claude-sonnet-5").cost.cacheWrite,
		);
		expect(vendorRow("openai", "gpt-5.6-luna").cost.cacheWrite).toBeGreaterThan(0);
		expect(byId.get("gpt-5.6-luna")?.cost.cacheWrite).toBe(0);
	});

	test("unknown open-weight ids inherit no other gateway's price, limits, or ladder", async () => {
		// Bundled on fireworks, deepseek, and others with per-token prices and non-Helmcode ladders.
		const byId = await resolveRoster(rosterFetch(["deepseek-v4-pro"]));
		const model = byId.get("deepseek-v4-pro");

		expect(model).toBeDefined();
		expect(model?.cost).toMatchObject({ input: 0, output: 0 });
		expect(model?.contextWindow ?? null).toBeNull();
		expect(model?.thinking?.efforts ?? []).not.toContain(Effort.XHigh);
	});
});
