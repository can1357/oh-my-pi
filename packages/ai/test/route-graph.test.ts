import { describe, expect, it } from "bun:test";
import { RouteRegistry } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function fakeModel(id: string) {
	return buildModel({
		api: "openai-responses",
		name: id,
		id,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

describe("RouteRegistry", () => {
	it("returns undefined for an unknown model id", () => {
		const registry = new RouteRegistry(id => (id === "gpt-5" ? fakeModel("gpt-5") : undefined));
		expect(registry.resolve("no-such-model")).toBeUndefined();
	});

	it("wraps a known id as a single TargetNode", () => {
		const registry = new RouteRegistry(id => (id === "gpt-5" ? fakeModel("gpt-5") : undefined));
		const route = registry.resolve("gpt-5");
		expect(route).toEqual({
			generation: 1,
			id: "gpt-5",
			root: { type: "target", model: "gpt-5" },
		});
	});

	it("keeps generation stable across resolves", () => {
		const registry = new RouteRegistry(id => (id === "a" || id === "b" ? fakeModel(id) : undefined));
		const first = registry.resolve("a");
		const second = registry.resolve("b");
		expect(first?.generation).toBe(1);
		expect(second?.generation).toBe(1);
		expect(first?.generation).toBe(second?.generation);
	});

	it("preserves provider-qualified model ids as the compiled target", () => {
		const registry = new RouteRegistry(id => {
			const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
			return bare === "gpt-5" ? fakeModel("gpt-5") : undefined;
		});
		const compiled = registry.resolve("openai/gpt-5");
		expect(compiled?.root).toEqual({ type: "target", model: "openai/gpt-5" });
		expect(compiled?.id).toBe("openai/gpt-5");
	});

});
