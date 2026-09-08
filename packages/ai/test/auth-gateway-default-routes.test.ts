import { describe, expect, it } from "bun:test";
import { parseRouteDefinition } from "@oh-my-pi/pi-ai/auth-gateway";
import { defaultVirtualRoutes } from "@oh-my-pi/pi-ai/auth-gateway/default-routes";
import { RouteRegistry } from "@oh-my-pi/pi-ai/auth-gateway/route-graph";
import type { FallbackNode, RouteNode, TargetNode } from "@oh-my-pi/pi-ai/auth-gateway/route-graph";

function asFallback(node: RouteNode): FallbackNode {
	if (node.type !== "fallback") {
		throw new Error(`expected fallback node, got ${node.type}`);
	}
	return node;
}

function asTarget(node: RouteNode): TargetNode {
	if (node.type !== "target") {
		throw new Error(`expected target node, got ${node.type}`);
	}
	return node;
}

describe("defaultVirtualRoutes", () => {
	it("registers and resolves each default route for dispatch", () => {
		const registry = new RouteRegistry(id => {
			const slash = id.indexOf("/");
			const provider = slash >= 0 ? id.slice(0, slash) : "test";
			const model = slash >= 0 ? id.slice(slash + 1) : id;
			return {
				id: model,
				provider,
				api: "openai-completions",
				baseUrl: "https://example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			} as never;
		});
		for (const route of defaultVirtualRoutes()) {
			registry.register(route);
			const compiled = registry.resolve(route.id);
			expect(compiled?.id).toBe(route.id);
			expect(compiled?.targets.length).toBeGreaterThan(0);
			for (const target of compiled!.targets) {
				const leaf = registry.resolve(target);
				expect(leaf?.targets).toContain(target);
			}
		}
	});

	it("keeps the three ids unique", () => {
		const ids = defaultVirtualRoutes().map(route => route.id);
		expect(ids).toEqual(["implementer", "verifier", "researcher"]);
		expect(new Set(ids).size).toBe(3);
	});

	it("does not emit catalog colon-delimited model ids (negative)", () => {
		for (const route of defaultVirtualRoutes()) {
			const children = asFallback(route.root).children;
			expect(children).toHaveLength(2);
			for (const child of children) {
				const model = asTarget(child).model;
				expect(model.includes(":")).toBe(false);
				expect(model.includes("/")).toBe(true);
			}
		}
	});

	it("does not share a mutable singleton across calls (negative)", () => {
		const first = defaultVirtualRoutes();
		const second = defaultVirtualRoutes();
		expect(first).not.toBe(second);
		first.pop();
		expect(second).toHaveLength(3);
		expect(second.map(route => route.id)).toEqual(["implementer", "verifier", "researcher"]);
	});

	it("rejects a fallback that is not keyed on provider_unavailable (negative)", () => {
		for (const route of defaultVirtualRoutes()) {
			expect(asFallback(route.root).on).toEqual(["provider_unavailable"]);
		}
	});

	it("parses as route definitions", () => {
		for (const route of defaultVirtualRoutes()) {
			expect(parseRouteDefinition(route)).toEqual(route);
		}
	});
});
