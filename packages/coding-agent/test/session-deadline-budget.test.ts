import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hasEligibleRetryFallbackHop } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { capDurationToSessionDeadline, remainingSessionDeadlineMs } from "../src/session/session-deadline.ts";

describe("session deadline budget", () => {
	it("reports remaining --max-time as a non-negative millisecond budget", () => {
		expect(remainingSessionDeadlineMs(undefined, 1_000)).toBeUndefined();
		expect(remainingSessionDeadlineMs(5_000, 1_000)).toBe(4_000);
		expect(remainingSessionDeadlineMs(500, 1_000)).toBe(0);
	});

	it("reserves a bounded fixed slice for a fallback hop", () => {
		// 90s budget: primary keeps 75s, not 45s — a slow-but-viable primary is
		// only preempted inside the last 15s.
		expect(capDurationToSessionDeadline(300_000, 90_000, true)).toBe(75_000);
		expect(capDurationToSessionDeadline(undefined, 90_000, true)).toBe(75_000);
		expect(capDurationToSessionDeadline(10_000, 90_000, true)).toBe(10_000);
	});

	it("never withholds more than half the remaining budget", () => {
		// Below 2x the reserve the fixed slice would starve the primary.
		expect(capDurationToSessionDeadline(undefined, 20_000, true)).toBe(10_000);
		expect(capDurationToSessionDeadline(undefined, 4_000, true)).toBe(2_000);
	});

	it("withholds only 1s when no eligible fallback hop exists", () => {
		expect(capDurationToSessionDeadline(8_000, 60_000, false)).toBe(8_000);
		expect(capDurationToSessionDeadline(8_000, 2_000, false)).toBe(1_000);
		expect(capDurationToSessionDeadline(undefined, 90_000, false)).toBe(89_000);
	});

	it("replaces an explicit disabled duration when a deadline exists", () => {
		expect(capDurationToSessionDeadline(0, 90_000, false)).toBe(89_000);
		expect(capDurationToSessionDeadline(0, undefined, false)).toBe(0);
	});
});

describe("hasEligibleRetryFallbackHop", () => {
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("openai", "gpt-4o-mini");
	if (!primary || !fallback) {
		throw new Error("Expected bundled test models to exist");
	}

	it("is false when modelFallback is on but fallbackChains is empty", () => {
		const settings = Settings.isolated({ "retry.modelFallback": true });
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		expect(hasEligibleRetryFallbackHop(settings, primary)).toBe(false);
	});

	it("is false when modelFallback is off even if a chain is configured", () => {
		const settings = Settings.isolated({
			"retry.modelFallback": false,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		expect(hasEligibleRetryFallbackHop(settings, primary)).toBe(false);
	});

	it("is true when the current model has a later chain candidate", () => {
		const settings = Settings.isolated({
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		expect(hasEligibleRetryFallbackHop(settings, primary)).toBe(true);
	});

	it("is false when the current model is the last chain entry", () => {
		const settings = Settings.isolated({
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		expect(hasEligibleRetryFallbackHop(settings, fallback)).toBe(false);
	});
});
