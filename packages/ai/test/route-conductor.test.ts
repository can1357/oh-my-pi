import { describe, expect, it } from "bun:test";
import type { CompiledRoute } from "@oh-my-pi/pi-ai/auth-gateway";
import { decideAttempt, type ExecutionState } from "@oh-my-pi/pi-ai/auth-gateway/route-conductor";
import type { GatewayErrorClassification, GatewayErrorDisposition } from "@oh-my-pi/pi-ai/error";

function route(
	overrides: {
		targets?: readonly string[];
		fallbacks?: Partial<Record<GatewayErrorDisposition, readonly string[]>>;
	} = {},
): CompiledRoute {
	return {
		generation: 1,
		id: "virtual/primary",
		root: { type: "target", model: "primary" },
		targets: overrides.targets ?? ["primary", "backup"],
		fallbacks: overrides.fallbacks ?? { provider_unavailable: ["backup", "tertiary"] },
	} as CompiledRoute;
}

function state(overrides: Partial<ExecutionState> = {}): ExecutionState {
	return {
		routeId: "virtual/primary",
		generation: 1,
		attemptedTargets: new Set(),
		retryCount: 0,
		fallbackCount: 0,
		committed: false,
		currentTarget: "primary",
		...overrides,
	};
}

function classification(disposition: GatewayErrorDisposition): GatewayErrorClassification {
	return {
		status: 503,
		type: "error",
		message: disposition,
		owner: "provider",
		disposition,
	};
}

describe("decideAttempt", () => {
	it("dispatches the first unused target when classification is absent", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "dispatch", targetModelId: "backup" });
	});

	it("returns terminal after commit even when fallbacks remain (negative)", () => {
		const fallbacks = { provider_unavailable: ["backup"] as const };
		const probingCommitted = decideAttempt({
			route: route({ fallbacks }),
			state: state({ committed: true }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		const streamCommitted = decideAttempt({
			route: route({ fallbacks }),
			state: state(),
			classification: classification("provider_unavailable"),
			commitState: "committed",
		});
		const streamTerminated = decideAttempt({
			route: route({ fallbacks }),
			state: state(),
			classification: classification("provider_unavailable"),
			commitState: "terminated",
		});
		expect(probingCommitted).toEqual({ type: "terminal" });
		expect(streamCommitted).toEqual({ type: "terminal" });
		expect(streamTerminated).toEqual({ type: "terminal" });
	});

	it("returns sibling_credential on credential_transient", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			classification: classification("credential_transient"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "sibling_credential" });
	});

	it("honors credential_quota compiled fallbacks after siblings are exhausted", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["backup"] } }),
			state: state({ attemptedTargets: new Set(["primary"]), siblingsExhausted: true }),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "backup" });
	});

	it("falls back to the first unused fallbacks-map id on provider_unavailable", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { provider_unavailable: ["backup", "tertiary"] } }),
			state: state({ attemptedTargets: new Set(["primary", "backup"]) }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "tertiary" });
	});

	it("returns terminal on request_terminal", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			classification: classification("request_terminal"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "terminal" });
	});

	it("returns terminal when fallbacks are exhausted (negative)", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { provider_unavailable: ["backup"] } }),
			state: state({ attemptedTargets: new Set(["primary", "backup"]) }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "terminal" });
	});
});
