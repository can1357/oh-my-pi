import { expect, it } from "bun:test";
import { RouteRegistry } from "../src/auth-gateway/route-graph";
import { decideAttempt, type ExecutionState } from "../src/auth-gateway/route-conductor";
import type { GatewayErrorClassification } from "../src/error/gateway";

it("rotates permanent credential failures while retaining the post-commit boundary", () => {
	const registry = new RouteRegistry(() => undefined);
	registry.register({
		id: "route",
		root: {
			type: "fallback",
			on: ["credential_permanent"],
			children: [
				{ type: "target", model: "a" },
				{ type: "target", model: "b" },
			],
		},
	});
	const route = registry.resolve("route")!;
	const state: ExecutionState = {
		routeId: route.id,
		generation: route.generation,
		attemptedTargets: new Set(["a"]),
		retryCount: 0,
		fallbackCount: 0,
		committed: false,
		currentTarget: "a",
		siblingsExhausted: false,
	};
	const classification: GatewayErrorClassification = {
		status: 401,
		type: "authentication_error",
		message: "revoked",
		owner: "credential",
		disposition: "credential_permanent",
	};
	expect(decideAttempt({ route, state, classification, commitState: "probing" })).toEqual({
		type: "sibling_credential",
	});
	expect(
		decideAttempt({ route, state: { ...state, siblingsExhausted: true }, classification, commitState: "probing" }),
	).toEqual({ type: "fallback_target", targetModelId: "b" });
	expect(decideAttempt({ route, state, classification, commitState: "committed" })).toEqual({ type: "terminal" });
});
