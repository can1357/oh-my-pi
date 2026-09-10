import { describe, expect, it } from "bun:test";
import { RouteRegistry } from "@oh-my-pi/pi-ai/auth-gateway";
import type { CompiledRoute } from "@oh-my-pi/pi-ai/auth-gateway";
import { decideAttempt, type ExecutionState } from "@oh-my-pi/pi-ai/auth-gateway/route-conductor";
import type { GatewayErrorClassification } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function compiledRoute(): CompiledRoute {
	const targetModel = buildModel({
		api: "openai-responses",
		name: "primary",
		id: "primary",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	const route = new RouteRegistry(id => (id === "primary" ? targetModel : undefined)).resolve("primary");
	if (!route) throw new Error("Expected RouteRegistry to compile the primary target");
	return { ...route, targets: ["primary"], fallbacks: { credential_permanent: ["backup"] } } as CompiledRoute;
}

function state(
	overrides: Partial<Omit<ExecutionState, "attemptedCredentials">> & {
		attemptedCredentials?: ReadonlySet<number>;
	} = {},
): ExecutionState {
	const { attemptedCredentials, ...rest } = overrides;
	return {
		routeId: "primary",
		generation: 1,
		attemptedTargets: new Set(["primary"]),
		attemptedCredentials: attemptedCredentials ?? new Set(),
		retryCount: 0,
		fallbackCount: 0,
		committed: false,
		currentTarget: "primary",
		siblingsExhausted: false,
		...rest,
	};
}

const permanent = (): GatewayErrorClassification => ({
	status: 401,
	type: "authentication_error",
	message: "credential permanently rejected",
	owner: "credential",
	disposition: "credential_permanent",
});

describe("permanent credential conductor repair", () => {
	it("tries a sibling credential before a compiled fallback", () => {
		expect(
			decideAttempt({ route: compiledRoute(), state: state(), classification: permanent(), commitState: "probing" }),
		).toEqual({ type: "sibling_credential" });
	});

	it("uses the compiled permanent fallback after siblings are exhausted", () => {
		expect(
			decideAttempt({
				route: compiledRoute(),
				state: state({ siblingsExhausted: true }),
				classification: permanent(),
				commitState: "probing",
			}),
		).toEqual({ type: "fallback_target", targetModelId: "backup" });
	});

	it("terminates when permanent fallback targets are exhausted or committed", () => {
		const route = compiledRoute();
		expect(
			decideAttempt({
				route,
				state: state({ siblingsExhausted: true, attemptedTargets: new Set(["primary", "backup"]) }),
				classification: permanent(),
				commitState: "probing",
			}),
		).toEqual({ type: "terminal" });
		expect(
			decideAttempt({
				route,
				state: state({ siblingsExhausted: true }),
				classification: permanent(),
				commitState: "committed",
			}),
		).toEqual({ type: "terminal" });
	});
});
