import { describe, expect, test, vi } from "bun:test";
import { orcaRouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

interface EndpointTypesEntry {
	id: string;
	supported_endpoint_types?: string[];
}

function liveRoster(): { object: string; data: EndpointTypesEntry[] } {
	return {
		object: "list",
		data: [
			{ id: "anthropic/claude-opus-5", supported_endpoint_types: ["openai-response", "openai-completions"] },
			{ id: "deepseek/deepseek-v4-pro", supported_endpoint_types: ["openai-completions"] },
			{ id: "z-ai/glm-5.2", supported_endpoint_types: [] },
			{ id: "minimax/minimax-m3", supported_endpoint_types: undefined },
			{ id: "auto" },
		],
	};
}

function fakeFetch() {
	return vi.fn(async (url: string, init?: RequestInit) => {
		void url;
		void init;
		return new Response(JSON.stringify(liveRoster()), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
}

describe("OrcaRouter provider support", () => {
	test("unbundled rows map live capabilities, modalities and pricing before the neutral defaults", async () => {
		const fetchMock = vi.fn(async () => {
			const roster: { object: string; data: unknown[] } = {
				object: "list",
				data: [
					{
						id: "qwen/qwen-next-vision",
						object: "model",
						name: "Qwen: Qwen Next Vision",
						supported_endpoint_types: ["openai-response"],
						architecture: { input_modalities: ["text", "image"] },
						supported_parameters: ["reasoning", "tools", "max_tokens"],
						pricing: { prompt: "0.00000150", completion: "0.00000600", input_cache_read: "0.00000010" },
					},
				],
			};
			return new Response(JSON.stringify(roster), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fetchMock as FetchImpl });

		// A row that ships outside the bundle has no reference to inherit: without
		// the live mapper it would surface as text-only, non-reasoning and free.
		const [model] = (await options.fetchDynamicModels?.()) ?? [];

		expect(model).toBeDefined();
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.cost.input).toBeCloseTo(1.5);
		expect(model.cost.output).toBeCloseTo(6.0);
		expect(model.cost.cacheRead).toBeCloseTo(0.1);
	});

	test("discovery keeps only Responses-API-compatible ids and drops the roster-only auto entry", async () => {
		const fetchMock = fakeFetch();
		const options = orcaRouterModelManagerOptions({ apiKey: "orca_test", fetch: fetchMock as FetchImpl });
		const ids = ((await options.fetchDynamicModels?.()) ?? []).map(model => model.id);

		// Only Responses-capable ids reach the runtime roster: routing a model
		// that cannot speak the Responses wire, or the merged `auto` router
		// entry, would make every request error.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.orcarouter.ai/v1/models");
		expect(ids).toEqual(["anthropic/claude-opus-5"]);
	});

	test("discovery runs without credentials so the roster lists before /login", async () => {
		const fetchMock = fakeFetch();
		const options = orcaRouterModelManagerOptions({ fetch: fetchMock as FetchImpl });

		// `/v1/models` is public: keyless discovery still refreshes the roster,
		// so model selection works before `/login orcarouter`.
		const ids = ((await options.fetchDynamicModels?.()) ?? []).map(model => model.id);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers ?? {});
		expect(headers.get("Authorization")).toBeNull();
		expect(ids).toEqual(["anthropic/claude-opus-5"]);
	});
});
