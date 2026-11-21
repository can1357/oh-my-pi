import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { scalewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/** One Scaleway card ladder: [id, on-tiers, default level]. */
const SCALEWAY_LADDERS: Array<[string, Effort[], Effort | undefined]> = [
	// GLM 5.3/5.2 accept `none` as a wire off value (verified live:
	// reasoning_tokens 0), diverging from the lineage glob's cannot-disable
	// contract in classes/glm.kdl; the priority=20 residue must outrank it.
	["glm-5.3", [Effort.Low, Effort.High, Effort.Max], Effort.Max],
	["glm-5.2", [Effort.High, Effort.Max], Effort.Max],
	["deepseek-v4.1-flash", [Effort.Low, Effort.High, Effort.Max], undefined],
	["deepseek-v4-flash-0731", [Effort.Low, Effort.High, Effort.Max], undefined],
	// Qwen 3.8 keeps its native xhigh tier; 3.6/3.5 stop at high.
	["qwen3.8-27b", [Effort.Low, Effort.Medium, Effort.XHigh], undefined],
	["qwen3.6-35b-a3b", [Effort.Low, Effort.Medium, Effort.High], undefined],
	["qwen3.5-397b-a17b", [Effort.Low, Effort.Medium, Effort.High], undefined],
	["gemma-4-26b-a4b-it", [Effort.Low, Effort.Medium, Effort.High], undefined],
	// Mistral Medium 3.5 documents none/high only; medium (the server default)
	// is not a valid tier, so the omp default pins high.
	["mistral-medium-3.5-128b", [Effort.High], Effort.High],
];

// No card ladder and no upgrade-neutral promotion: these ids must stay
// dial-free even though the Qwen and Mistral classes serve reasoning lineages
// on other hosts.
const NON_REASONING_IDS = [
	"qwen3-235b-a22b-instruct-2507",
	"mistral-small-3.2-24b-instruct-2506",
	"llama-3.3-70b-instruct",
];

/**
 * A row as Scaleway's `/v1/models` reports it with no bundled reference: bare
 * OpenAI fields, no capability metadata, no limits, and no prices.
 */
function bareSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("Scaleway provider support", () => {
	test("resolves each card's documented effort ladder with `none` as the off value", () => {
		for (const [id, efforts, defaultLevel] of SCALEWAY_LADDERS) {
			// The wire row claims no reasoning, so each ladder must arrive
			// through `thinking-upgrade-neutral` promotion of the reviewed card.
			const model = buildModel(bareSpec(id));
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.mode).toBe("effort");
			expect(model.thinking?.efforts).toEqual(efforts);
			expect(model.thinking?.defaultLevel).toBe(defaultLevel);
			// The lineage glob marks glm-5.3 thinking as mandatory; Scaleway's
			// `none` tier must keep these disableable.
			expect(model.thinking?.requiresEffort).not.toBe(true);
			// Thinking-off must send reasoning_effort `none`: omitting the field
			// falls back to the server default (medium) and leaves reasoning on.
			expect(model.compat?.reasoningDisableMode).toBe("none-effort");
		}

		for (const id of NON_REASONING_IDS) {
			const model = buildModel(bareSpec(id));
			expect(model.reasoning).toBe(false);
			expect(model.thinking).toBeUndefined();
		}
	});

	test("live discovery is the complete roster: retired rows drop, non-chat and tool-less SKUs stay out", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scaleway-"));
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						// glm-5.2 is absent: Scaleway routes it to glm-5.3 after EOL.
						{ id: "glm-5.3", object: "model", owned_by: "zai" },
						{ id: "whisper-large-v3", object: "model", owned_by: "openai" },
						{ id: "qwen3-embedding-8b", object: "model", owned_by: "qwen" },
						{ id: "bge-multilingual-gemma2", object: "model", owned_by: "baai" },
						{ id: "lightonocr-3-0.8b", object: "model", owned_by: "" },
						{ id: "gpt-oss-120b", object: "model", owned_by: "openai" },
						{ id: "llama-3.3-70b-instruct", object: "model", owned_by: "meta" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as FetchImpl;

		const { models } = await resolveProviderModels(
			{
				...scalewayModelManagerOptions({ apiKey: "scw-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);

		expect(requests).toEqual([{ url: "https://api.scaleway.ai/v1/models", authorization: "Bearer scw-key" }]);
		expect(models.map(model => model.id).sort()).toEqual(["glm-5.3", "llama-3.3-70b-instruct"]);

		// The bare live row keeps the bundled row's documented contract and the
		// Scaleway ladder instead of degrading to a generic text-only default.
		const bundled = getBundledModels("scaleway").find(model => model.id === "glm-5.3");
		const glm = models.find(model => model.id === "glm-5.3");
		expect(glm?.name).toBe(bundled?.name);
		expect(glm?.cost).toEqual(bundled?.cost);
		expect(glm?.contextWindow).toBe(bundled?.contextWindow);
		expect(glm?.maxTokens).toBe(bundled?.maxTokens);
		expect(glm?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});
});
