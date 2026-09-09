import { describe, expect, test } from "bun:test";
import {
	resolveBuiltInDiscoveryBudgetMs,
	RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
} from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";

describe("resolveBuiltInDiscoveryBudgetMs", () => {
	test("keeps the runtime bound when no provider deadline is configured", () => {
		expect(resolveBuiltInDiscoveryBudgetMs(undefined)).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
	});

	test("never shrinks below the runtime bound for deadlines it already covers", () => {
		expect(resolveBuiltInDiscoveryBudgetMs(10_000)).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
	});

	test("grows past the runtime bound so a configured deadline is never silently capped", () => {
		// A manager given 30 s must not be cut off at 15 s by the outer race;
		// the margin leaves room for the /v1/models fallback after the walk.
		expect(resolveBuiltInDiscoveryBudgetMs(30_000)).toBeGreaterThan(30_000);
		expect(resolveBuiltInDiscoveryBudgetMs(30_000)).toBe(35_000);
	});

	test("treats non-positive or non-finite deadlines as unset", () => {
		expect(resolveBuiltInDiscoveryBudgetMs(0)).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
		expect(resolveBuiltInDiscoveryBudgetMs(Number.NaN)).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
	});
});
