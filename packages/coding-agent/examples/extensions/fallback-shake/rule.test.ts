import { expect, test } from "bun:test";
import { shouldShakeFallback } from "./rule";

const primary = { provider: "provider-a", id: "model" };
const replacement = { provider: "provider-b", id: "model" };

test("provider-only changes count as fallback, unchanged identity does not", () => {
	expect(shouldShakeFallback({ agentKind: "main", from: primary, to: replacement, current: replacement })).toBe(true);
	expect(shouldShakeFallback({ agentKind: "main", from: primary, to: { ...primary }, current: primary })).toBe(false);
});

test("helper, advisor and stale-target notifications cannot shake the main history", () => {
	expect(shouldShakeFallback({ agentKind: "sub", from: primary, to: replacement, current: replacement })).toBe(false);
	expect(
		shouldShakeFallback({
			agentKind: "main",
			target: "advisor",
			from: primary,
			to: replacement,
			current: replacement,
		}),
	).toBe(false);
	expect(shouldShakeFallback({ agentKind: "main", from: primary, to: replacement, current: primary })).toBe(false);
});
