import { describe, expect, it } from "bun:test";
import { parseRouteDefinition } from "@oh-my-pi/pi-ai/auth-gateway";
import { defaultVirtualRoutes } from "@oh-my-pi/pi-ai/auth-gateway/default-routes";
import type { FallbackNode, RouteDefinition, RouteNode, TargetNode } from "@oh-my-pi/pi-ai/auth-gateway/route-graph";

const EXPECTED: RouteDefinition[] = [
	{
		id: "implementer",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "openai-codex/coding-model" },
				{ type: "target", model: "anthropic/coding-model" },
			],
		},
	},
	{
		id: "verifier",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "anthropic/reasoning-model" },
				{ type: "target", model: "openai-codex/reasoning-model" },
			],
		},
	},
	{
		id: "researcher",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "anthropic/reasoning-model" },
				{ type: "target", model: "openai-codex/reasoning-model" },
			],
		},
	},
];

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
	it("returns implementer, verifier, and researcher fallback templates", () => {
		expect(defaultVirtualRoutes()).toEqual(EXPECTED);
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
