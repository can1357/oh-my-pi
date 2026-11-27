import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchOpenAICompatibleModels } from "@oh-my-pi/pi-catalog/discovery/openai-compatible";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { clampThinkingLevelForModel, withoutUnverifiedThinking } from "@oh-my-pi/pi-catalog/model-thinking";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import {
	applyThinkingCapability,
	readThinkingCapability,
	type ThinkingCapability,
	withThinkingCapability,
	writeThinkingCapability,
} from "@oh-my-pi/pi-catalog/thinking-capability";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "undocumented-chat-model",
		name: "Undocumented Chat Model",
		provider: "capability-test",
		api: "openai-completions",
		baseUrl: "https://gateway.example/v1",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 4096,
		...overrides,
	};
}

function capability(overrides: Partial<ThinkingCapability> = {}): ThinkingCapability {
	return {
		checkedAt: Date.now(),
		format: "openai",
		efforts: [Effort.Low, Effort.High],
		observed: false,
		attempts: [
			{ format: "openai", effort: Effort.Low, accepted: true, observed: false },
			{ format: "openai", effort: Effort.Medium, accepted: false, observed: false },
			{ format: "openai", effort: Effort.High, accepted: true, observed: false },
		],
		...overrides,
	};
}

describe("unknown reasoning capability", () => {
	it("offers all six provisional efforts only for unknown supported chat APIs", () => {
		const supported: Api[] = [
			"openai-completions",
			"openrouter",
			"openai-responses",
			"azure-openai-responses",
			"anthropic-messages",
			"google-generative-ai",
			"google-vertex",
		];
		for (const api of supported) {
			const model = buildModel({ ...spec(), api, compat: undefined });
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.unverified).toBe(true);
			expect(model.thinking?.efforts).toEqual(THINKING_EFFORTS);
		}
		expect(buildModel(spec({ reasoning: false })).thinking).toBeUndefined();
		expect(buildModel(spec({ reasoning: false })).reasoning).toBe(false);
		expect(buildModel(spec({ kind: "image" })).thinking).toBeUndefined();
		expect(buildModel({ ...spec(), api: "openai-embeddings", compat: undefined }).thinking).toBeUndefined();
	});

	it("preserves reviewed unverified rules for capability-less false seeds", () => {
		for (const provider of ["meta", "muse-code"]) {
			const model = buildModel({
				...spec({ provider, reasoning: false }),
				api: "openai-responses",
				compat: undefined,
			});
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.unverified).toBe(true);
			expect(model.thinking?.efforts).toEqual(THINKING_EFFORTS);
		}
	});

	it("preserves unknown provenance across rebuilds but gives effortless requests a safe view", () => {
		const model = buildModel(spec());
		const projected = toModelSpec(model);
		expect(projected.reasoning).toBeUndefined();
		expect(projected.thinking).toBeUndefined();
		expect(buildModel(projected).thinking?.unverified).toBe(true);
		const safe = withoutUnverifiedThinking(model);
		expect(safe.reasoning).toBe(false);
		expect(safe.thinking).toBeUndefined();
		expect(model.thinking?.unverified).toBe(true);
	});

	it("keeps explicit false separate from absent discovery metadata", async () => {
		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "capability-test",
			baseUrl: "https://gateway.example/v1",
			fetch: async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "unknown" },
							{ id: "negative", supports_reasoning: false },
							{ id: "positive", reasoning: true },
						],
					}),
				),
		});
		expect(models?.find(model => model.id === "unknown")?.reasoning).toBeUndefined();
		expect(models?.find(model => model.id === "negative")?.reasoning).toBe(false);
		expect(models?.find(model => model.id === "positive")?.reasoning).toBe(true);
	});
});

describe("persisted thinking controls", () => {
	let directory = "";
	let dbPath = "";
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-thinking-capability-"));
		dbPath = join(directory, "models.db");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("materializes discovery specs with absent or explicitly undefined reasoning and restores their cache", async () => {
		const authored = spec({ id: "missing-evidence" });
		const projected = toModelSpec(buildModel(spec({ id: "projected-evidence" })));
		const negative = spec({ id: "negative-evidence", reasoning: false });
		const options = {
			providerId: "capability-test",
			staticModels: [],
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => [authored, projected, negative],
		};
		const online = await resolveProviderModels(options, "online");
		expect(online.models).toHaveLength(3);
		expect(online.models.find(model => model.id === authored.id)?.thinking?.unverified).toBe(true);
		expect(online.models.find(model => model.id === projected.id)?.thinking?.unverified).toBe(true);
		expect(online.models.find(model => model.id === negative.id)?.reasoning).toBe(false);
		const offline = await resolveProviderModels(options, "offline");
		expect(offline.models).toEqual(online.models);
	});

	it("survives a new database access and isolates endpoint, API, provider and wire id", () => {
		const model = buildModel(spec({ requestModelId: "wire-id" }));
		const learned = capability();
		writeThinkingCapability(model, learned, dbPath);
		expect(readThinkingCapability(model, dbPath)).toEqual(learned);
		expect(readThinkingCapability({ ...model, baseUrl: "https://gateway.example/v1/" }, dbPath)).toEqual(learned);
		expect(readThinkingCapability({ ...model, id: "another-alias" }, dbPath)).toEqual(learned);
		expect(readThinkingCapability({ ...model, baseUrl: "https://gateway.example/other" }, dbPath)).toBeUndefined();
		expect(readThinkingCapability({ ...model, api: "openai-responses" }, dbPath)).toBeUndefined();
		expect(readThinkingCapability({ ...model, provider: "other-provider" }, dbPath)).toBeUndefined();
		expect(readThinkingCapability({ ...model, requestModelId: "other-wire-id" }, dbPath)).toBeUndefined();
	});

	it("persists accepted effort support without visible reasoning, clamps and preserves sparse config", () => {
		const model = buildModel(spec({ compat: { supportsDeveloperRole: false }, headers: { "X-Local": "secret" } }));
		writeThinkingCapability(model, capability(), dbPath);
		const learned = withThinkingCapability(model, dbPath);
		expect(learned.thinking?.unverified).toBeUndefined();
		expect(learned.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(clampThinkingLevelForModel(learned, Effort.Medium)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(learned, Effort.Max)).toBe(Effort.High);
		expect(learned.compat.thinkingFormat).toBe("openai");
		expect(learned.compat.supportsReasoningEffort).toBe(true);
		expect(learned.compat.omitReasoningEffort).toBe(false);
		expect(learned.compat.reasoningEffortMap).toEqual({ low: "low", high: "high" });
		expect(learned.compat.supportsDeveloperRole).toBe(false);
		expect(learned.headers).toBe(model.headers);
		expect(learned.cost).toEqual(model.cost);
		expect(withThinkingCapability(learned, dbPath)).toBe(learned);
		const explicitFalse = buildModel(spec({ reasoning: false }));
		expect(withThinkingCapability(explicitFalse, dbPath)).toBe(explicitFalse);
		const configured = buildModel(spec({ reasoning: true, thinking: { mode: "effort", efforts: [Effort.Medium] } }));
		expect(applyThinkingCapability(configured, capability())).toBe(configured);
	});

	it("learns binary toggles without inventing effort parameters and maps native modes", () => {
		const model = buildModel(spec());
		const binaryFormats: readonly ("zai" | "qwen")[] = ["zai", "qwen"];
		for (const format of binaryFormats) {
			const learned = applyThinkingCapability(
				model,
				capability({ format, efforts: THINKING_EFFORTS, attempts: [{ format, accepted: true, observed: false }] }),
			);
			expect(learned.compat.thinkingFormat).toBe(format);
			expect(learned.compat.supportsReasoningEffort).toBe(false);
			expect(learned.compat.omitReasoningEffort).toBe(true);
			expect(learned.thinking?.efforts).toEqual(THINKING_EFFORTS);
		}
		const responseModel = buildModel({ ...spec(), api: "openai-responses", compat: undefined });
		const responses = applyThinkingCapability(responseModel, capability({ format: "responses" }));
		expect(responses.compat.supportsReasoningEffort).toBe(true);
		expect(responses.compat.omitReasoningEffort).toBe(false);
		const anthropic = buildModel({ ...spec(), api: "anthropic-messages", compat: undefined });
		expect(applyThinkingCapability(anthropic, capability({ format: "anthropic-adaptive" })).thinking?.mode).toBe(
			"anthropic-adaptive",
		);
		expect(applyThinkingCapability(anthropic, capability({ format: "anthropic-budget" })).thinking?.mode).toBe(
			"budget",
		);
		const google = buildModel({ ...spec(), api: "google-generative-ai", compat: undefined });
		expect(applyThinkingCapability(google, capability({ format: "google-level" })).thinking?.mode).toBe(
			"google-level",
		);
		expect(applyThinkingCapability(google, capability({ format: "google-budget" })).thinking?.mode).toBe("budget");
	});

	it("distinguishes native reasoning without a dial from verified nonreasoning", () => {
		const model = buildModel(spec());
		for (const observed of [false, true]) {
			const learned = capability({
				format: "none",
				efforts: [],
				observed,
				attempts: [{ format: "none", accepted: true, observed }],
			});
			writeThinkingCapability(model, learned, dbPath);
			const resolved = withThinkingCapability(model, dbPath);
			expect(resolved.reasoning).toBe(observed);
			expect(resolved.thinking).toBeUndefined();
		}
	});

	it("expires successful controls after 30 days and no-dial results after one day", () => {
		const model = buildModel(spec());
		const day = 24 * 60 * 60 * 1000;
		writeThinkingCapability(model, capability({ checkedAt: Date.now() - 29 * day }), dbPath);
		expect(readThinkingCapability(model, dbPath)).toBeDefined();
		writeThinkingCapability(model, capability({ checkedAt: Date.now() - 31 * day }), dbPath);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		writeThinkingCapability(
			model,
			capability({ format: "none", efforts: [], checkedAt: Date.now() - 2 * day }),
			dbPath,
		);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		writeThinkingCapability(model, capability({ checkedAt: Date.now() + day }), dbPath);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
	});

	it("ignores malformed stored metadata and recovers a corrupt database through the model-cache opener", async () => {
		await writeFile(dbPath, "not a sqlite database");
		const model = buildModel(spec());
		const learned = capability();
		writeThinkingCapability(model, learned, dbPath);
		expect(readThinkingCapability(model, dbPath)).toEqual(learned);
		const db = new Database(dbPath);
		try {
			for (const payload of [
				"{",
				JSON.stringify({ ...learned, efforts: ["bogus"] }),
				JSON.stringify({ ...learned, attempts: [{ format: "openai", accepted: "yes", observed: false }] }),
			]) {
				db.run("UPDATE thinking_capability SET capability = ?", [payload]);
				expect(readThinkingCapability(model, dbPath)).toBeUndefined();
			}
		} finally {
			db.close();
		}
	});
});
