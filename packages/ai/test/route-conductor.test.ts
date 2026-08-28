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
		attemptedCredentials: new Set<number>(),
		retryCount: 0,
		fallbackCount: 0,
		committed: false,
		currentTarget: "primary",
		siblingsExhausted: false,
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

	it("dispatches preferred unused target over list order", () => {
		const action = decideAttempt({
			route: route({ targets: ["primary", "backup"] }),
			state: state(),
			commitState: "probing",
			preferredTargetId: "backup",
		});
		expect(action).toEqual({ type: "dispatch", targetModelId: "backup" });
	});

	it("uses firstUnused when preferred was already attempted (negative)", () => {
		const action = decideAttempt({
			route: route({ targets: ["primary", "backup"] }),
			state: state({ attemptedTargets: new Set(["backup"]) }),
			commitState: "probing",
			preferredTargetId: "backup",
		});
		expect(action).toEqual({ type: "dispatch", targetModelId: "primary" });
		expect(action).not.toEqual({ type: "dispatch", targetModelId: "backup" });
	});

	it("ignores preferred that is not a route target (negative)", () => {
		const action = decideAttempt({
			route: route({ targets: ["primary", "backup"] }),
			state: state(),
			commitState: "probing",
			preferredTargetId: "other",
		});
		expect(action).toEqual({ type: "dispatch", targetModelId: "primary" });
		expect(action).not.toEqual({ type: "dispatch", targetModelId: "other" });
	});

	it("falls back to an unused earlier target after a preferred later target fails", () => {
		const action = decideAttempt({
			route: route({
				targets: ["primary", "backup"],
				fallbacks: { provider_unavailable: ["backup"] },
			}),
			state: state({ attemptedTargets: new Set(["backup"]), currentTarget: "backup" }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
			preferredTargetId: "backup",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "primary" });
		expect(action).not.toEqual({ type: "terminal" });
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

	it("returns sibling_credential on credential_quota while siblings remain even when quota fallbacks exist (negative)", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["claude"] } }),
			state: state({
				attemptedTargets: new Set(["primary"]),
				attemptedCredentials: new Set([0]),
				siblingsExhausted: false,
			}),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "sibling_credential" });
		expect(action).not.toEqual({ type: "fallback_target", targetModelId: "claude" });
	});

	it("falls back to the first unused credential_quota target once siblings are exhausted", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["claude", "gemini"] } }),
			state: state({
				attemptedTargets: new Set(["primary"]),
				siblingsExhausted: true,
			}),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "claude" });
	});

	it("skips already attempted credential_quota fallbacks once siblings are exhausted", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["claude", "gemini"] } }),
			state: state({
				attemptedTargets: new Set(["primary", "claude"]),
				siblingsExhausted: true,
			}),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "gemini" });
	});

	it("returns terminal when credential_quota fallbacks are exhausted after siblings (negative)", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["claude"] } }),
			state: state({
				attemptedTargets: new Set(["primary", "claude"]),
				siblingsExhausted: true,
			}),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "terminal" });
	});

	it("falls back on credential_transient once siblings are exhausted", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_transient: ["backup"] } }),
			state: state({ siblingsExhausted: true }),
			classification: classification("credential_transient"),
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
