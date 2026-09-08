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
		expect(route?.generation).toBe(1);
		expect(route?.id).toBe("gpt-5");
		expect(route?.root).toEqual({ type: "target", model: "gpt-5" });
		expect(route?.targets).toEqual(["gpt-5"]);
		expect(route?.fallbacks).toEqual({});
		expect(route?.fallbackByTarget).toEqual({});
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

	it("compiles suffix edges from each fallback sibling", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "abc",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "A" },
					{ type: "target", model: "B" },
					{ type: "target", model: "C" },
				],
			},
		});
		const route = registry.resolve("abc");
		expect(route?.fallbackByTarget?.A?.provider_unavailable).toEqual(["B", "C"]);
		expect(route?.fallbackByTarget?.B?.provider_unavailable).toEqual(["C"]);
		expect(route?.fallbackByTarget?.C?.provider_unavailable).toBeUndefined();
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
		expect(route?.generation).toBe(2);
		expect(route?.id).toBe("quota-route");
		expect(route?.targets).toEqual(["gpt-5", "gpt-4o"]);
		expect(route?.fallbacks).toEqual({ credential_quota: ["gpt-4o"] });
		expect(route?.fallbackByTarget).toEqual({ "gpt-5": { credential_quota: ["gpt-4o"] } });
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
							children: [
								{ type: "target", model: "a" },
								{ type: "target", model: "b" },
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
		expect(route?.fallbackByTarget).toEqual({});
		expect(route?.targets).toEqual(["gpt-5"]);
		expect(route?.fallbacks).toEqual({});
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

	it("scopes nested sibling fallbacks per source target", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "nested-siblings",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
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
						on: ["context_overflow"],
						children: [
							{ type: "target", model: "C" },
							{ type: "target", model: "D" },
						],
					},
				],
			},
		});
		const route = registry.resolve("nested-siblings");
		expect(route?.fallbacks.provider_unavailable).toEqual(["C"]);
		expect(route?.fallbackByTarget?.A?.provider_unavailable).toEqual(["C"]);
		expect(route?.fallbackByTarget?.B?.provider_unavailable).toEqual(["C"]);
		expect(route?.fallbackByTarget?.A?.context_overflow).toEqual(["B"]);
		expect(route?.fallbackByTarget?.C?.context_overflow).toEqual(["D"]);
		expect(route?.fallbackByTarget?.A?.context_overflow ?? []).not.toContain("D");
	});

	it("adds outer fallback edges from every nested child target to the later entry", () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "nested-overflow-then-c",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{
						type: "fallback",
						on: ["context_overflow"],
						children: [
							{ type: "target", model: "A" },
							{ type: "target", model: "B" },
						],
					},
					{ type: "target", model: "C" },
				],
			},
		});
		const route = registry.resolve("nested-overflow-then-c");
		expect(route?.fallbackByTarget?.A?.context_overflow).toEqual(["B"]);
		expect(route?.fallbackByTarget?.A?.provider_unavailable).toEqual(["C"]);
		expect(route?.fallbackByTarget?.B?.provider_unavailable).toEqual(["C"]);
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
