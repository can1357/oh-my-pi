import { describe, expect, it } from "bun:test";
import type { GatewayErrorDisposition } from "../src/error/gateway";
import { actionForDisposition, type FailureAction } from "../src/error/gateway-action";

const TERMINAL_DISPOSITIONS: readonly GatewayErrorDisposition[] = [
	"cancelled",
	"request_terminal",
	"policy_terminal",
	"gateway_terminal",
	"credential_permanent",
];

const SIBLING_DISPOSITIONS: readonly GatewayErrorDisposition[] = ["credential_quota", "credential_transient"];

const FALLBACK_ONLY_DISPOSITIONS: readonly GatewayErrorDisposition[] = [
	"provider_unavailable",
	"model_unavailable",
	"context_overflow",
];

function expectAbsentOrFalse(action: FailureAction, key: keyof FailureAction): void {
	expect(action[key] ?? false).toBe(false);
}

describe("actionForDisposition", () => {
	it("maps terminal dispositions to an empty action", () => {
		for (const disposition of TERMINAL_DISPOSITIONS) {
			const action = actionForDisposition(disposition);
			expect(action).toEqual({});
			expectAbsentOrFalse(action, "refreshCredential");
			expectAbsentOrFalse(action, "trySiblingCredential");
			expectAbsentOrFalse(action, "retryTarget");
			expectAbsentOrFalse(action, "fallbackTarget");
			expectAbsentOrFalse(action, "cooldownCredential");
			expectAbsentOrFalse(action, "penalizeTargetHealth");
		}
	});

	it("maps credential_quota and credential_transient to sibling cooldown", () => {
		for (const disposition of SIBLING_DISPOSITIONS) {
			const action = actionForDisposition(disposition);
			expect(action.trySiblingCredential).toBe(true);
			expect(action.cooldownCredential).toBe(true);
			expectAbsentOrFalse(action, "refreshCredential");
			expectAbsentOrFalse(action, "retryTarget");
			expectAbsentOrFalse(action, "fallbackTarget");
			expectAbsentOrFalse(action, "penalizeTargetHealth");
		}
	});

	it("maps provider/model/overflow unavailability to fallback plus health penalty", () => {
		for (const disposition of FALLBACK_ONLY_DISPOSITIONS) {
			const action = actionForDisposition(disposition);
			expect(action.fallbackTarget).toBe(true);
			expect(action.penalizeTargetHealth).toBe(true);
			expectAbsentOrFalse(action, "refreshCredential");
			expectAbsentOrFalse(action, "trySiblingCredential");
			expectAbsentOrFalse(action, "retryTarget");
			expectAbsentOrFalse(action, "cooldownCredential");
		}
	});

	it("maps provider_transient to retry, fallback, and health penalty", () => {
		const action = actionForDisposition("provider_transient");
		expect(action.retryTarget).toBe(true);
		expect(action.fallbackTarget).toBe(true);
		expect(action.penalizeTargetHealth).toBe(true);
		expectAbsentOrFalse(action, "refreshCredential");
		expectAbsentOrFalse(action, "trySiblingCredential");
		expectAbsentOrFalse(action, "cooldownCredential");
	});

	it("does not set fallbackTarget or trySiblingCredential for credential_permanent (negative)", () => {
		const action = actionForDisposition("credential_permanent");
		expect(action.fallbackTarget).not.toBe(true);
		expect(action.trySiblingCredential).not.toBe(true);
		expectAbsentOrFalse(action, "fallbackTarget");
		expectAbsentOrFalse(action, "trySiblingCredential");
	});

	it("does not treat provider_unavailable as a same-target retry (negative)", () => {
		const action = actionForDisposition("provider_unavailable");
		expect(action.retryTarget).not.toBe(true);
		expectAbsentOrFalse(action, "retryTarget");
	});
});
