import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	CORALBRICKS_BASE_URL,
	coralbricksModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const DISCOVERY_URL = `${CORALBRICKS_BASE_URL}/models`;

/**
 * A Coral `/v1/models` row shaped as the gateway returns it (2026-10-02):
 * OpenAI list fields plus Coral's own per-million pricing block and the
 * capability flags its docs declare authoritative.
 */
function coralRow(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		id: "glm-5.3-fp4",
		object: "model",
		owned_by: "coralbricks",
		context_length: 1048576,
		created: 1789000000,
		pricing: {
			cache_write_multiple: 0.3,
			cache_write_per_m: 1.68,
			cached_input_per_m: 0,
			input_per_m: 1.12,
			output_per_m: 4.4,
		},
		supports_chat: true,
		supports_image_input: false,
		supports_tools: true,
		...overrides,
	};
}

function catalogFixture(): Response {
	return Response.json({
		object: "list",
		data: [
			coralRow({}),
			coralRow({
				id: "glm-5.3-flash-fp4",
				pricing: { cached_input_per_m: 0, cache_write_per_m: 0.23, input_per_m: 0.15, output_per_m: 0.5 },
				supports_image_input: true,
			}),
			// A row the bundled catalog has never seen: neutral defaults, no
			// capabilities invented from the live response.
			coralRow({
				id: "glm-5.2-fp4",
				pricing: { input_per_m: 0.75, output_per_m: 2.4 },
				supports_tools: false,
			}),
			// Non-chat surfaces and id-less rows are dropped.
			coralRow({ id: "coral-embed", supports_chat: false }),
			{ object: "model", context_length: 8192 },
		],
	});
}

describe("CoralBricks built-in provider", () => {
	test("maps live rows with Coral's pricing and capability fields and drops non-chat rows", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({ url: input.toString(), authorization: headers.get("Authorization") });
			return catalogFixture();
		};

		const options = coralbricksModelManagerOptions({ apiKey: "cb-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		// `/v1/models` is key-protected, so discovery must authenticate.
		expect(requests).toEqual([{ url: DISCOVERY_URL, authorization: "Bearer cb-test-key" }]);
		expect(models?.map(item => item.id)).toEqual(["glm-5.2-fp4", "glm-5.3-flash-fp4", "glm-5.3-fp4"]);

		// The endpoint publishes no output cap or reasoning flag; the bundled
		// reference's values apply.
		const glm = models?.find(item => item.id === "glm-5.3-fp4");
		expect(glm?.maxTokens).toBe(131072);
		expect(glm?.reasoning).toBe(true);

		// Unknown ids stay neutral: no invented reasoning or output cap, and
		// the live tools flag maps through.
		const unknown = models?.find(item => item.id === "glm-5.2-fp4");
		expect(unknown?.reasoning).toBe(false);
		expect(unknown?.maxTokens).toBeNull();
		expect(unknown?.cost).toEqual({ input: 0.75, output: 2.4, cacheRead: 0, cacheWrite: 0 });
		expect(unknown?.supportsTools).toBe(false);
	});

	test("gates discovery on credentials because /v1/models is key-protected", () => {
		expect(coralbricksModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
		expect(coralbricksModelManagerOptions({ apiKey: "cb-test-key" }).fetchDynamicModels).toBeDefined();
	});

	test("keeps a live modality removal authoritative through the production manager merge", async () => {
		// Coral documents `supports_image_input` as authoritative and answers
		// unsupported content with `400 unsupported_content_type`, so a live
		// text-only row must strip the bundled row's image support instead of
		// OR-merging it back.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-coralbricks-refresh-"));
		const dbPath = path.join(tempDir, "models.db");
		const bundledVisionModel: ModelSpec<"openai-completions"> = {
			id: "glm-5.3-flash-fp4",
			name: "GLM 5.3 Flash",
			api: "openai-completions",
			provider: "coralbricks",
			baseUrl: CORALBRICKS_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0.23 },
			contextWindow: 1048576,
			maxTokens: 131072,
		};
		const fetchMock = async (): Promise<Response> =>
			Response.json({
				object: "list",
				data: [
					coralRow({
						id: "glm-5.3-flash-fp4",
						pricing: { cached_input_per_m: 0, cache_write_per_m: 0.23, input_per_m: 0.15, output_per_m: 0.5 },
						supports_image_input: false,
					}),
				],
			});

		try {
			const { models } = await resolveProviderModels<"openai-completions">(
				{
					...coralbricksModelManagerOptions({ apiKey: "cb-test-key", fetch: fetchMock }),
					staticModels: [bundledVisionModel],
					cacheDbPath: dbPath,
				},
				"online",
			);

			const model = models.find(item => item.id === "glm-5.3-flash-fp4");
			expect(model?.input).toEqual(["text"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
