import { describe, expect, it } from "bun:test";

import type { SparsityInput } from "@oh-my-pi/pi-coding-agent/memory-fabric/activation-sparsity";
import {
	measureActivationSparsity,
	summarizeSparsity,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/activation-sparsity";

describe("activation-sparsity", () => {
	it("returns an inert report when disabled", () => {
		const report = measureActivationSparsity({ eligibleSubsystems: 4, activatedSubsystems: 4 });
		expect(report.enabled).toBe(false);
		expect(report.requiredNeedCoverage).toBe(1);
		expect(report.starved).toBe(false);
	});

	it("computes subsystem activation and sparsity", () => {
		const report = measureActivationSparsity({ eligibleSubsystems: 4, activatedSubsystems: 1 }, { enabled: true });
		expect(report.subsystemActivationRatio).toBe(0.25);
		expect(report.subsystemSparsity).toBe(0.75);
	});

	it("computes record activation from explicit counts", () => {
		const input: SparsityInput = { availableRecords: 10, injectedRecords: 2 };
		const report = measureActivationSparsity(input, { enabled: true });
		expect(report.recordActivationRatio).toBe(0.2);
		expect(report.recordSparsity).toBe(0.8);
	});

	it("guards zero and missing denominators", () => {
		const report = measureActivationSparsity({ activatedSubsystems: 3, injectedRecords: 5 }, { enabled: true });
		expect(report.subsystemActivationRatio).toBe(0);
		expect(report.recordActivationRatio).toBe(0);
	});

	it("clamps ratios into [0, 1] when numerator exceeds denominator", () => {
		const report = measureActivationSparsity({ eligibleSubsystems: 2, activatedSubsystems: 5 }, { enabled: true });
		expect(report.subsystemActivationRatio).toBe(1);
		expect(report.subsystemSparsity).toBe(0);
	});

	it("derives record and fidelity counts from a fidelity state", () => {
		const fidelity = { full: ["a", "b"], summarized: ["c"], evicted: ["d"] };
		const report = measureActivationSparsity({ fidelity }, { enabled: true });
		expect(report.fullFidelityRatio).toBeCloseTo(2 / 3, 5);
		expect(report.recordActivationRatio).toBe(0.75);
	});

	it("never clobbers an explicit zero with fidelity-derived values", () => {
		const fidelity = { full: ["a", "b"], summarized: ["c"], evicted: [] };
		const input: SparsityInput = { fidelity, injectedRecords: 0, admittedItems: 0 };
		const report = measureActivationSparsity(input, { enabled: true });
		expect(report.recordActivationRatio).toBe(0);
		expect(report.fullFidelityRatio).toBe(0);
	});

	it("treats no required needs as full coverage", () => {
		const report = measureActivationSparsity({}, { enabled: true });
		expect(report.requiredNeedCoverage).toBe(1);
		expect(report.starved).toBe(false);
	});

	it("flags starvation whenever a required need is missed", () => {
		const report = measureActivationSparsity({ requiredNeedsTotal: 3, requiredNeedsMet: 2 }, { enabled: true });
		expect(report.requiredNeedCoverage).toBeCloseTo(2 / 3, 5);
		expect(report.missedRequiredNeeds).toBe(1);
		expect(report.starved).toBe(true);
	});

	it("caps met needs at the total", () => {
		const report = measureActivationSparsity({ requiredNeedsTotal: 2, requiredNeedsMet: 9 }, { enabled: true });
		expect(report.requiredNeedCoverage).toBe(1);
		expect(report.missedRequiredNeeds).toBe(0);
	});

	it("ignores negative and non-finite inputs", () => {
		const input = { eligibleSubsystems: -4, activatedSubsystems: Number.NaN } as SparsityInput;
		const report = measureActivationSparsity(input, { enabled: true });
		expect(report.subsystemActivationRatio).toBe(0);
	});

	it("summarizes a disabled report", () => {
		expect(summarizeSparsity(measureActivationSparsity({}))).toBe("sparsity: disabled");
	});

	it("summarizes ratios and appends STARVED when needs are missed", () => {
		const input: SparsityInput = {
			eligibleSubsystems: 4,
			activatedSubsystems: 1,
			availableRecords: 10,
			injectedRecords: 2,
			admittedItems: 4,
			fullFidelityItems: 1,
			requiredNeedsTotal: 2,
			requiredNeedsMet: 1,
		};
		const line = summarizeSparsity(measureActivationSparsity(input, { enabled: true }));
		expect(line).toBe("sparsity: subsys=0.75 records=0.80 fullFidelity=0.25 coverage=0.50 STARVED(1)");
	});
});
