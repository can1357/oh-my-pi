/**
 * Type-level contract for `UsageScope.modelFamily`.
 *
 * The field is optional and distinct from `modelId`. There is no clone/copy
 * helper for `UsageScope`; this file constructs a scope with `modelFamily`
 * and reads it so the type is exercised at compile time and at runtime.
 */
import { describe, expect, it } from "bun:test";
import type { UsageScope } from "@oh-my-pi/pi-ai";

describe("UsageScope modelFamily", () => {
	it("accepts optional modelFamily distinct from modelId", () => {
		const scope: UsageScope = {
			provider: "anthropic",
			modelId: "claude-opus-4-5",
			modelFamily: "claude",
		};
		expect(scope.modelFamily).toBe("claude");
		expect(scope.modelId).toBe("claude-opus-4-5");
		expect(scope.modelFamily).not.toBe(scope.modelId);
	});

	it("allows omitting modelFamily", () => {
		const scope: UsageScope = { provider: "anthropic", modelId: "claude-opus-4-5" };
		expect(scope.modelFamily).toBeUndefined();
	});
});
