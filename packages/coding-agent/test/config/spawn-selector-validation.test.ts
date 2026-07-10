import { describe, expect, test } from "bun:test";
import { canonicalizeRoleSelector } from "../../src/config/model-resolver";
import {
	validateSpawnSelectorsSemantic,
	validateSpawnSelectorsStructural,
} from "../../src/config/spawn-selector-validation";
import type { AgentPolicyFields } from "../../src/orchestration/agent-execution-profile";

describe("canonical role selectors", () => {
	test("smol and pi/smol converge", () => {
		expect(canonicalizeRoleSelector("smol")).toBe("pi/smol");
		expect(canonicalizeRoleSelector("pi/smol")).toBe("pi/smol");
		expect(canonicalizeRoleSelector("smol:high")).toBe("pi/smol:high");
		expect(canonicalizeRoleSelector("pi/smol:high")).toBe("pi/smol:high");
	});

	test("concrete selectors are unchanged", () => {
		expect(canonicalizeRoleSelector("openai/gpt-4o")).toBe("openai/gpt-4o");
		expect(canonicalizeRoleSelector("openai/gpt-4o:high")).toBe("openai/gpt-4o:high");
	});
});

describe("validateSpawnSelectorsStructural", () => {
	test("rejects normalized alias collisions deterministically", () => {
		const diagnostics = validateSpawnSelectorsStructural({
			aliases: {
				"mini-max": "provider/a",
				minimax: "provider/b",
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "normalized-collision")).toBe(true);
	});

	test("rejects aliases that shadow a role with a divergent target", () => {
		const diagnostics = validateSpawnSelectorsStructural({
			aliases: {
				smol: "openai/gpt-4o",
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "role-shadow-divergence")).toBe(true);
	});

	test("allows aliases that canonicalize to the shadowed role", () => {
		const diagnostics = validateSpawnSelectorsStructural({
			aliases: {
				smol: "pi/smol",
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "role-shadow-divergence")).toBe(false);
	});

	test("allows same-role targets that only differ by thinking suffix", () => {
		const diagnostics = validateSpawnSelectorsStructural({
			aliases: {
				smol: "pi/smol:high",
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "role-shadow-divergence")).toBe(false);
	});

	test("detects role-shadow divergence for thinking-suffixed alias keys", () => {
		const diagnostics = validateSpawnSelectorsStructural({
			aliases: {
				"smol:high": "openai/gpt-4o",
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "role-shadow-divergence")).toBe(true);
	});

	test("rejects malformed profiles and empty pool selectors", () => {
		const malformedPolicy = {
			tier: "ultra",
			modelPool: ["", "pi/smol"],
		} as unknown as AgentPolicyFields;
		const diagnostics = validateSpawnSelectorsStructural({
			agentPolicies: {
				explore: malformedPolicy,
			},
			modelPools: {
				light: ["pi/smol", ""],
			},
		});
		expect(diagnostics.some(diagnostic => diagnostic.code === "malformed-profile")).toBe(true);
		expect(diagnostics.some(diagnostic => diagnostic.code === "malformed-pool")).toBe(true);
	});
});

describe("validateSpawnSelectorsSemantic", () => {
	test("aggregates unresolved and unauthenticated selectors", () => {
		const diagnostics = validateSpawnSelectorsSemantic({
			selectors: ["pi/smol", "missing/model", "noauth/model", ""],
			resolveStatus: selector => {
				if (selector === "pi/smol") {
					return { selector, resolved: true, authenticated: true };
				}
				if (selector === "noauth/model") {
					return { selector, resolved: true, authenticated: false };
				}
				if (selector === "missing/model") {
					return { selector, resolved: false, authenticated: false };
				}
				return { selector, resolved: false, authenticated: false };
			},
		});

		const codes = diagnostics.map(diagnostic => diagnostic.code).sort();
		expect(codes).toEqual(["empty-selector", "unauthenticated-selector", "unresolved-selector"]);
	});
});
