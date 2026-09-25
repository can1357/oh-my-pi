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
			targets: ["gpt-5"],
			fallbacks: {},
		});
	});

	it("keeps generation stable across resolves", () => {
		const registry = new RouteRegistry(id => (id === "a" || id === "b" ? fakeModel(id) : undefined));
		const first = registry.resolve("a");
		const second = registry.resolve("b");
		expect(first?.generation).toBe(1);
		expect(second?.generation).toBe(1);
		expect(first?.generation).toBe(second?.generation);
		expect(registry.generation).toBe(1);
	});

	it("register compiles a quota fallback list", () => {
		const registry = new RouteRegistry(id => (id === "gpt-5" || id === "gpt-4o" ? fakeModel(id) : undefined));
		registry.register({
			id: "quota-route",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{ type: "target", model: "gpt-5" },
					{ type: "target", model: "gpt-4o" },
				],
			},
		});
		const route = registry.resolve("quota-route");
		expect(registry.generation).toBe(2);
		expect(route).toEqual({
			generation: 2,
			id: "quota-route",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{ type: "target", model: "gpt-5" },
					{ type: "target", model: "gpt-4o" },
				],
			},
			targets: ["gpt-5", "gpt-4o"],
			fallbacks: { credential_quota: ["gpt-4o"] },
		});
	});

	it("rejects a cycle on one root-to-leaf path", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "cyclic",
				root: {
					type: "fallback",
					on: ["provider_transient"],
					children: [
						{ type: "target", model: "a" },
						{ type: "target", model: "b" },
						{ type: "target", model: "a" },
					],
				},
			}),
		).toThrow(/cycle/i);
		expect(registry.generation).toBe(1);
		expect(registry.resolve("cyclic")).toBeUndefined();
	});

	it("allows sibling reuse of the same model id under a fallback", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "sibling-reuse",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{ type: "target", model: "a" },
					{
						type: "fallback",
						on: ["context_overflow"],
						children: [{ type: "target", model: "a" }],
					},
				],
			},
		});
		const route = registry.resolve("sibling-reuse");
		expect(route?.targets).toEqual(["a", "a"]);
		expect(registry.generation).toBe(2);
	});

	it("rejects a nested path that repeats a target model id", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "nested-cycle",
				root: {
					type: "fallback",
					on: ["provider_transient"],
					children: [
						{ type: "target", model: "a" },
						{
							type: "fallback",
							on: ["context_overflow"],
							children: [{ type: "target", model: "b" }],
						},
						{ type: "target", model: "a" },
					],
				},
			}),
		).toThrow(/cycle/i);
		expect(registry.generation).toBe(1);
		expect(registry.resolve("nested-cycle")).toBeUndefined();
	});

	it("rejects empty fallback children", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "empty-fallback",
				root: {
					type: "fallback",
					on: ["credential_quota"],
					children: [],
				},
			}),
		).toThrow(/empty/i);
		expect(registry.generation).toBe(1);
	});

	it("resolves an unregistered concrete model as a single target after register", () => {
		const registry = new RouteRegistry(id => (id === "gpt-5" ? fakeModel("gpt-5") : undefined));
		registry.register({
			id: "virtual",
			root: { type: "target", model: "other" },
		});
		const route = registry.resolve("gpt-5");
		expect(route).toEqual({
			generation: 2,
			id: "gpt-5",
			root: { type: "target", model: "gpt-5" },
			targets: ["gpt-5"],
			fallbacks: {},
		});
	});

	it("does not leak quota targets into context_overflow fallbacks", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "isolated",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{
						type: "fallback",
						on: ["context_overflow"],
						children: [
							{ type: "target", model: "primary" },
							{ type: "target", model: "overflow-backup" },
						],
					},
					{ type: "target", model: "quota-backup" },
				],
			},
		});
		const route = registry.resolve("isolated");
		expect(route?.targets).toEqual(["primary", "overflow-backup", "quota-backup"]);
		expect(route?.fallbacks.credential_quota).toEqual(["quota-backup"]);
		expect(route?.fallbacks.context_overflow).toEqual(["overflow-backup"]);
		expect(route?.fallbacks.context_overflow ?? []).not.toContain("quota-backup");
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
