import { expect, it } from "bun:test";
import { RouteRegistry } from "../src/auth-gateway/route-graph";
import { decideAttempt, type ExecutionState } from "../src/auth-gateway/route-conductor";
import type { GatewayErrorClassification, GatewayErrorDisposition } from "../src/error/gateway";

it("uses only the failing subtree's edges and retains its parent fallback", () => {
	const registry = new RouteRegistry(() => undefined);
	registry.register({
		id: "scoped",
		root: {
			type: "fallback",
			on: ["credential_quota"],
			children: [
				{
					type: "fallback",
					on: ["context_overflow"],
					children: [
						{ type: "target", model: "a" },
						{ type: "target", model: "a-large" },
					],
				},
				{
					type: "fallback",
					on: ["context_overflow"],
					children: [
						{ type: "target", model: "b" },
						{ type: "target", model: "b-large" },
					],
				},
			],
		},
	});
	const route = registry.resolve("scoped")!;
	const next = (currentTarget: string, attempted: string[], disposition: GatewayErrorDisposition) => {
		const state: ExecutionState = {
			routeId: route.id,
			generation: route.generation,
			attemptedCredentials: new Set<number>(),
			attemptedTargets: new Set(attempted),
			retryCount: 0,
			fallbackCount: 0,
			committed: false,
			currentTarget,
			siblingsExhausted: true,
		};
		const classification: GatewayErrorClassification = {
			status: 400,
			type: "error",
			message: "fixture",
			owner: "request",
			disposition,
		};
		return decideAttempt({ route, state, classification, commitState: "probing" });
	};
	expect(next("b", ["b"], "context_overflow")).toEqual({ type: "fallback_target", targetModelId: "b-large" });
	expect(next("b-large", ["b", "b-large"], "context_overflow")).toEqual({ type: "terminal" });
	expect(next("a-large", ["a", "a-large"], "credential_quota")).toEqual({
		type: "fallback_target",
		targetModelId: "b",
	});
});
