import { describe, expect, it } from "bun:test";

import {
	type ActivationSignalInput,
	calculateActivationThreshold,
	gateActivations,
	summarizeGate,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/spiking-retrieval-gate";

describe("spiking-retrieval-gate", () => {
	it("is inert when disabled", () => {
		const result = gateActivations([{ id: "a", signal: 1 }]);
		expect(result.enabled).toBe(false);
		expect(result.decisions).toEqual([]);
		expect(result.activationRate).toBe(0);
	});

	it("uses the default base threshold of 0.5", () => {
		expect(calculateActivationThreshold({ id: "a", signal: 0 })).toBeCloseTo(0.5, 5);
	});

	it("lowers the threshold under risk and uncertainty", () => {
		const input: ActivationSignalInput = { id: "a", signal: 0, operationRisk: 1, uncertainty: 1 };
		expect(calculateActivationThreshold(input)).toBeCloseTo(0.25, 5);
	});

	it("raises the threshold under cost pressure and poor health", () => {
		const input: ActivationSignalInput = {
			id: "a",
			signal: 0,
			latencyPressure: 1,
			tokenPressure: 1,
			subsystemHealth: 0,
		};
		expect(calculateActivationThreshold(input)).toBeCloseTo(0.74, 5);
	});

	it("clamps the threshold to the [0.2, 0.9] band", () => {
		const low: ActivationSignalInput = {
			id: "a",
			signal: 0,
			operationRisk: 1,
			uncertainty: 1,
			contradictionLevel: 1,
			contextCoverageGap: 1,
			repeatedFailureCount: 5,
			historicalUtility: 1,
		};
		expect(calculateActivationThreshold(low)).toBe(0.2);
		expect(calculateActivationThreshold({ id: "a", signal: 0, baseThreshold: 2 })).toBe(0.9);
	});

	it("activates when the signal crosses the threshold", () => {
		const result = gateActivations([{ id: "a", signal: 0.6 }], { enabled: true });
		expect(result.activate).toEqual(["a"]);
		expect(result.decisions[0]?.override).toBe(false);
	});

	it("shadows within the margin band and suppresses below it", () => {
		const result = gateActivations(
			[
				{ id: "band", signal: 0.45 },
				{ id: "below", signal: 0.1 },
			],
			{ enabled: true },
		);
		expect(result.shadow).toEqual(["band"]);
		expect(result.suppress).toEqual(["below"]);
	});

	it("never auto-activates a blocked candidate, even at signal 1", () => {
		const result = gateActivations([{ id: "a", signal: 1, blocked: true }], { enabled: true });
		expect(result.suppress).toEqual(["a"]);
		expect(result.decisions[0]?.override).toBe(true);
	});

	it("shadows human-gated candidates instead of activating them", () => {
		const result = gateActivations([{ id: "a", signal: 1, needsUser: true }], { enabled: true });
		expect(result.shadow).toEqual(["a"]);
	});

	it("forceSuppress wins over forceActivate (deny-first)", () => {
		const result = gateActivations([{ id: "a", signal: 1, forceActivate: true, forceSuppress: true }], {
			enabled: true,
		});
		expect(result.suppress).toEqual(["a"]);
	});

	it("forceActivate rescues a zero-signal candidate", () => {
		const result = gateActivations([{ id: "a", signal: 0, forceActivate: true }], { enabled: true });
		expect(result.activate).toEqual(["a"]);
	});

	it("skips malformed entries and duplicate ids", () => {
		const inputs = [
			{ id: "a", signal: 0.9 },
			{ id: "a", signal: 0 },
			{ id: "", signal: 1 },
			null as unknown as ActivationSignalInput,
		];
		const result = gateActivations(inputs, { enabled: true });
		expect(result.decisions.length).toBe(1);
		expect(result.activate).toEqual(["a"]);
	});

	it("reports the activation rate and target overshoot", () => {
		const result = gateActivations(
			[
				{ id: "a", signal: 0.9 },
				{ id: "b", signal: 0.9 },
				{ id: "c", signal: 0 },
				{ id: "d", signal: 0 },
			],
			{ enabled: true, targetActivationRate: 0.25 },
		);
		expect(result.activationRate).toBeCloseTo(0.5, 5);
		expect(result.rateExceeded).toBe(true);
	});

	it("sorts decisions and id lists deterministically", () => {
		const result = gateActivations(
			[
				{ id: "z", signal: 0.9 },
				{ id: "a", signal: 0.9 },
			],
			{ enabled: true },
		);
		expect(result.decisions.map(d => d.id)).toEqual(["a", "z"]);
		expect(result.activate).toEqual(["a", "z"]);
	});

	it("summarizes results in one line", () => {
		expect(summarizeGate(gateActivations([], {}))).toBe("gate: disabled");
		const result = gateActivations([{ id: "a", signal: 0.9 }], { enabled: true, targetActivationRate: 0.1 });
		expect(summarizeGate(result)).toBe("gate: activate=1 shadow=0 suppress=0 rate=1.00 rate-exceeded");
	});
});
