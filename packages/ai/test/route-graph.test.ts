import { describe, expect, it } from "bun:test";
import { pickInitialRouteTarget, RouteRegistry } from "@oh-my-pi/pi-ai/auth-gateway";
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
			fallbackByTarget: {},
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
			fallbackByTarget: { "gpt-5": { credential_quota: ["gpt-4o"] } },
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

	it("rejects ambiguous cross-branch reuse of the same model id", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
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
			}),
		).toThrow(/ambiguous cross-branch reuse/i);
		expect(registry.generation).toBe(1);
	});

	it("rejects domain sibling reuse that would merge distinct fallback contexts", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "domain-reuse",
				root: {
					type: "domain",
					name: "outer",
					children: [
						{
							type: "fallback",
							on: ["context_overflow"],
							children: [
								{ type: "target", model: "A" },
								{ type: "target", model: "B" },
							],
						},
						{
							type: "fallback",
							on: ["provider_unavailable"],
							children: [
								{ type: "target", model: "A" },
								{ type: "target", model: "C" },
							],
						},
					],
				},
			}),
		).toThrow(/ambiguous cross-branch reuse/i);
		expect(registry.generation).toBe(1);
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
			fallbackByTarget: {},
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

	it("keeps nested fallback edges scoped away from sibling branches", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "scoped",
			root: {
				type: "domain",
				name: "outer",
				children: [
					{ type: "target", model: "A" },
					{
						type: "fallback",
						on: ["credential_quota"],
						children: [
							{ type: "target", model: "B" },
							{ type: "target", model: "C" },
						],
					},
				],
			},
		});
		const route = registry.resolve("scoped");
		expect(route?.targets).toEqual(["A", "B", "C"]);
		expect(route?.fallbacks.credential_quota).toEqual(["C"]);
		expect(route?.fallbackByTarget?.A?.credential_quota).toBeUndefined();
		expect(route?.fallbackByTarget?.B?.credential_quota).toEqual(["C"]);
	});

	it("get returns registered virtual routes and ignores catalog models (negative)", () => {
		const registry = new RouteRegistry(id => (id === "gpt-5" ? fakeModel("gpt-5") : undefined));
		registry.register({
			id: "virtual-impl",
			root: { type: "target", model: "other" },
		});
		const virtual = registry.get("virtual-impl");
		expect(virtual?.id).toBe("virtual-impl");
		expect(virtual?.targets).toEqual(["other"]);
		expect(registry.get("gpt-5")).toBeUndefined();
		expect(registry.get("missing")).toBeUndefined();
		expect(registry.resolve("gpt-5")?.id).toBe("gpt-5");
	});

	it("flattens balance children in visit order for rr and weighted", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "rr",
			root: {
				type: "balance",
				strategy: "rr",
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		registry.register({
			id: "weighted",
			root: {
				type: "balance",
				strategy: "weighted",
				children: [
					{ type: "target", model: "c" },
					{ type: "target", model: "d" },
				],
			},
		});
		expect(registry.resolve("rr")?.targets).toEqual(["a", "b"]);
		expect(registry.resolve("weighted")?.targets).toEqual(["c", "d"]);
		expect(registry.resolve("rr")?.root).toEqual({
			type: "balance",
			strategy: "rr",
			children: [
				{ type: "target", model: "a" },
				{ type: "target", model: "b" },
			],
		});
	});

	it("flattens all conditional children at compile time", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "vision",
			root: {
				type: "conditional",
				when: { vision: true },
				children: [
					{ type: "target", model: "vision-model" },
					{ type: "target", model: "text-model" },
				],
			},
		});
		expect(registry.resolve("vision")?.targets).toEqual(["vision-model", "text-model"]);
	});

	it("treats domain as compile-time grouping", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "coding",
			root: {
				type: "domain",
				name: "coding",
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		expect(registry.resolve("coding")?.targets).toEqual(["a", "b"]);
		expect(registry.resolve("coding")?.root).toEqual({
			type: "domain",
			name: "coding",
			children: [
				{ type: "target", model: "a" },
				{ type: "target", model: "b" },
			],
		});
	});

	it("rejects a cycle through a balance node", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "cyclic-balance",
				root: {
					type: "balance",
					strategy: "rr",
					children: [
						{ type: "target", model: "a" },
						{ type: "target", model: "a" },
					],
				},
			}),
		).toThrow(/cycle/i);
		expect(registry.generation).toBe(1);
		expect(registry.resolve("cyclic-balance")).toBeUndefined();
	});

	it("rejects an unknown route-ref (negative)", () => {
		const registry = new RouteRegistry(() => undefined);
		expect(() =>
			registry.register({
				id: "alias",
				root: { type: "route-ref", route: "missing" },
			}),
		).toThrow(/Unresolved route-ref/);
		expect(registry.generation).toBe(1);
		expect(registry.get("alias")).toBeUndefined();
	});

	it("inlines a route-ref against an already-registered id", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({ id: "base", root: { type: "target", model: "a" } });
		registry.register({ id: "alias", root: { type: "route-ref", route: "base" } });
		const alias = registry.get("alias");
		expect(alias?.targets).toEqual(["a"]);
		expect(alias?.root).toEqual({ type: "target", model: "a" });
	});

	it("replaceAll compiles every definition then swaps once", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.replaceAll([
			{ id: "one", root: { type: "target", model: "a" } },
			{
				id: "two",
				root: {
					type: "balance",
					strategy: "weighted",
					children: [
						{ type: "target", model: "b" },
						{ type: "target", model: "c" },
					],
				},
			},
		]);
		expect(registry.generation).toBe(2);
		expect(registry.get("one")?.generation).toBe(2);
		expect(registry.get("two")?.generation).toBe(2);
		expect(registry.get("two")?.targets).toEqual(["b", "c"]);
		expect(registry.list().map(route => route.id)).toEqual(["one", "two"]);
	});

	it("replaceAll rolls back when a later definition is invalid (negative)", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({ id: "keep", root: { type: "target", model: "a" } });
		const generation = registry.generation;
		expect(() =>
			registry.replaceAll([
				{ id: "ok", root: { type: "target", model: "b" } },
				{
					id: "bad",
					root: {
						type: "fallback",
						on: ["credential_quota"],
						children: [
							{ type: "target", model: "x" },
							{ type: "target", model: "x" },
						],
					},
				},
			]),
		).toThrow(/cycle/i);
		expect(registry.generation).toBe(generation);
		expect(registry.get("keep")?.targets).toEqual(["a"]);
		expect(registry.get("ok")).toBeUndefined();
		expect(registry.get("bad")).toBeUndefined();
	});

	it("replaceAll resolves alias-before-base against the complete incoming set", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({ id: "base", root: { type: "target", model: "stale" } });
		registry.replaceAll([
			{ id: "alias", root: { type: "route-ref", route: "base" } },
			{ id: "base", root: { type: "target", model: "fresh" } },
		]);
		expect(registry.get("alias")?.targets).toEqual(["fresh"]);
		expect(registry.get("alias")?.root).toEqual({ type: "target", model: "fresh" });
		expect(registry.get("base")?.targets).toEqual(["fresh"]);
	});

	it("pickInitialRouteTarget rotates rr and prefers weighted children", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "rr",
			root: {
				type: "balance",
				strategy: "rr",
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		registry.register({
			id: "weighted",
			root: {
				type: "balance",
				strategy: "weighted",
				children: [
					{ type: "target", model: "low", weight: 1 },
					{ type: "target", model: "high", weight: 5 },
				],
			},
		});
		const rr = registry.resolve("rr");
		const weighted = registry.resolve("weighted");
		expect(rr).toBeDefined();
		expect(weighted).toBeDefined();
		expect(pickInitialRouteTarget(rr!, 0)).toBe("a");
		expect(pickInitialRouteTarget(rr!, 1)).toBe("b");
		expect(pickInitialRouteTarget(weighted!)).toBe("high");
	});
});
