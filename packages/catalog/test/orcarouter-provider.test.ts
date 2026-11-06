import { describe, expect, test, vi } from "bun:test";
import {
	allowsUnauthenticatedCatalogDiscovery,
	isCatalogDescriptor,
} from "@oh-my-pi/pi-catalog/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { orcaRouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

// Bundled snapshot row: exercises the mapper's reference path — live fields
// must overlay even though a bundled reference exists (P1: bundled rows were
// stuck on the neutral zero cost otherwise).
const BUNDLED_ID = "deepseek/deepseek-v4-flash";
// Live-only row: exercises the no-reference path against the neutral defaults.
const UNBUNDLED_ID = "qwen/qwen-next-vision";

function fakeFetch(...entries: unknown[]) {
	return vi.fn(
		async (_url: string, _init?: RequestInit) =>
			new Response(JSON.stringify({ object: "list", data: entries }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	);
}

describe("OrcaRouter provider support", () => {
	test("live capability fields overlay bundled reference rows too", async () => {
		// A bundled id must depend on the snapshot, not a fixture: assert the
		// reference map actually produced one before driving the overlay.
		const entries = [
			{
				id: BUNDLED_ID,
				supported_endpoint_types: ["openai-response"],
				name: "DeepSeek: DeepSeek V4 Flash",
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["reasoning", "tools"],
				pricing: { prompt: "0.00000200", completion: "0.00000800" },
				top_provider: { max_completion_tokens: 98688 },
			},
		];
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fakeFetch(...entries) as FetchImpl });

		// Without a bundled reference the driver below loses meaning: this test
		// pins the reference path, so fail loudly when the row leaves the bundle.
		expect(options.fetchDynamicModels).toBeDefined();
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		// Live-reported fields win for what the roster reports; the bundled
		// reference survives for what the roster leaves out.
		expect(model?.id).toBe(BUNDLED_ID);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
		expect(model?.cost.input).toBeCloseTo(2.0);
		expect(model?.cost.output).toBeCloseTo(8.0);
		expect(model?.maxTokens).toBe(98688);
	});

	test("unbundled rows map live capabilities, modalities and pricing before the neutral defaults", async () => {
		const entries = [
			{
				id: UNBUNDLED_ID,
				object: "model",
				name: "Qwen: Qwen Next Vision",
				supported_endpoint_types: ["openai-response"],
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["reasoning", "tools", "max_tokens"],
				pricing: { prompt: "0.00000150", completion: "0.00000600", input_cache_read: "0.00000010" },
				max_completion_tokens: 64000,
			},
		];
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fakeFetch(...entries) as FetchImpl });

		// With no bundled reference, the mapper must surface the reported
		// capabilities instead of text-only, non-reasoning, free defaults.
		const [model] = (await options.fetchDynamicModels?.()) ?? [];
		expect(model?.id).toBe(UNBUNDLED_ID);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
		expect(model?.cost.input).toBeCloseTo(1.5);
		expect(model?.cost.output).toBeCloseTo(6.0);
		expect(model?.cost.cacheRead).toBeCloseTo(0.1);
		expect(model?.maxTokens).toBe(64000);
	});

	test("nested top_provider.max_completion_tokens drives the output ceiling", async () => {
		const entries = [
			{
				id: UNBUNDLED_ID,
				supported_endpoint_types: ["openai-response"],
				name: "Fusion free pod",
				// No root ceiling: only the nested OpenRouter-shaped field reports it.
				top_provider: { max_completion_tokens: 32768 },
			},
		];
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fakeFetch(...entries) as FetchImpl });

		const [model] = (await options.fetchDynamicModels?.()) ?? [];
		expect(model?.maxTokens).toBe(32768);
	});

	test("a Responses-capable row whose supported_parameters omit tools maps supportsTools: false", async () => {
		const entries = [
			{
				id: UNBUNDLED_ID,
				supported_endpoint_types: ["openai-response"],
				supported_parameters: ["reasoning", "temperature"],
			},
		];
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fakeFetch(...entries) as FetchImpl });

		// `resolveDialect` treats an undefined supportsTools as native tool
		// support: a row the router says cannot run tools must not pass through
		// as undefined.
		const [model] = (await options.fetchDynamicModels?.()) ?? [];
		expect(model?.supportsTools).toBe(false);
	});

	test("discovery keeps only Responses-API-compatible ids and drops the roster-only auto entry", async () => {
		const entries = [
			{ id: BUNDLED_ID, supported_endpoint_types: ["openai-response", "openai-completions"] },
			{ id: "deepseek/deepseek-v4-pro", supported_endpoint_types: ["openai-completions"] },
			{ id: "z-ai/glm-5.2", supported_endpoint_types: [] },
			{ id: "minimax/minimax-m3", supported_endpoint_types: undefined },
			{ id: "auto" },
		];
		const fetchMock = fakeFetch(...entries);
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fetchMock as FetchImpl });
		const ids = ((await options.fetchDynamicModels?.()) ?? []).map(model => model.id);

		// Routing a model that cannot speak the Responses wire — or the merged
		// `auto` router entry — would make every request error.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.orcarouter.ai/v1/models");
		expect(ids).toEqual([BUNDLED_ID]);
	});

	test("compiled discovery runs pre-login and prunes the bundled snapshot from the public roster", () => {
		// Compiled from the KDL axes (same compile the generator consumes): the
		// pre-login manager decision reads the descriptor, not the factory.
		const descriptor = PROVIDER_DESCRIPTORS.find(d => d.providerId === "orcarouter");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(isCatalogDescriptor(descriptor!) && allowsUnauthenticatedCatalogDiscovery(descriptor!)).toBe(true);
	});

	test("discovery runs without credentials so the roster lists before /login", async () => {
		const fetchMock = fakeFetch({ id: BUNDLED_ID, supported_endpoint_types: ["openai-response"] });
		const options = orcaRouterModelManagerOptions({ fetch: fetchMock as FetchImpl });

		// `/v1/models` is public: keyless discovery still refreshes the roster.
		const ids = ((await options.fetchDynamicModels?.()) ?? []).map(model => model.id);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers ?? {});
		expect(headers.get("Authorization")).toBeNull();
		expect(ids).toEqual([BUNDLED_ID]);
	});
});
