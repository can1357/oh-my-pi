/**
 * Tests for per-project budget profiles and the selection rule.
 */

import { describe, expect, it } from "bun:test";
import type {
	BudgetBenchmarkResult,
	ProjectBudgetProfile,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/budget-profiles";
import {
	DEFAULT_BUDGET_PROFILE_CONFIG,
	ProjectBudgetProfileStore,
	selectBestConfiguration,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/budget-profiles";

const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

function store(): ProjectBudgetProfileStore {
	return new ProjectBudgetProfileStore(undefined, () => FIXED_NOW);
}

function benchmark(overrides?: Partial<BudgetBenchmarkResult>): BudgetBenchmarkResult {
	return {
		budgetTokens: 4000,
		taskSuccessRate: 0.9,
		precisionAt5: 0.8,
		hasCrossProjectLeakage: false,
		hasSecretLeakage: false,
		hasFalseVerifiedPromotion: false,
		p95LatencyMs: 1200,
		harmfulMemoryInfluenceRate: 0,
		...overrides,
	};
}

describe("ProjectBudgetProfileStore", () => {
	it("creates default profiles with a deterministic clock", () => {
		const profile = store().getProfile("proj-a", "debugging");
		expect(profile.recommendedInitialTokens).toBe(DEFAULT_BUDGET_PROFILE_CONFIG.defaultInitialTokens);
		expect(profile.recommendedMaximumTokens).toBe(DEFAULT_BUDGET_PROFILE_CONFIG.defaultMaximumTokens);
		expect(profile.sampleCount).toBe(0);
		expect(profile.lastUpdatedAt).toBe("2026-01-15T12:00:00.000Z");
	});

	it("keeps projects and task categories separate", () => {
		const profiles = store();
		profiles.updateProfile("proj-a", "normal", 8000, true);
		expect(profiles.getProfile("proj-a", "debugging").sampleCount).toBe(0);
		expect(profiles.getProfile("proj-b", "normal").sampleCount).toBe(0);
		expect(profiles.size()).toBe(3);
	});

	it("tracks a running mean and max under honest names", () => {
		const profiles = store();
		profiles.updateProfile("proj-a", "normal", 1000, true);
		profiles.updateProfile("proj-a", "normal", 3000, false);
		const profile = profiles.getProfile("proj-a", "normal");
		expect(profile.meanUsefulTokens).toBe(2000);
		expect(profile.maxUsefulTokens).toBe(3000);
		expect(profile.sampleCount).toBe(2);
		expect(profile.successfulRuns).toBe(1);
	});

	it("moves the recommendation at most ten percent per run", () => {
		const profiles = store();
		const updated = profiles.updateProfile("proj-a", "normal", 32000, true);
		expect(updated.recommendedInitialTokens).toBe(2750);
		expect(updated.recommendedMaximumTokens).toBe(11000);
	});

	it("never recommends below the minimum even for tiny observations", () => {
		const profiles = store();
		let profile = profiles.getProfile("proj-a", "normal");
		for (let i = 0; i < 200; i++) {
			profile = profiles.updateProfile("proj-a", "normal", 0, true);
		}
		expect(profile.recommendedInitialTokens).toBeGreaterThanOrEqual(500);
	});

	it("caps the maximum at four times the initial and the absolute limit", () => {
		const profiles = store();
		let profile = profiles.getProfile("proj-a", "recovery");
		for (let i = 0; i < 200; i++) {
			profile = profiles.updateProfile("proj-a", "recovery", 32000, true);
		}
		expect(profile.recommendedInitialTokens).toBeLessThanOrEqual(32000);
		expect(profile.recommendedMaximumTokens).toBeLessThanOrEqual(32000);
	});

	it("round-trips through exportAll and loadProfiles", () => {
		const source = store();
		source.updateProfile("proj-a", "debugging", 6000, true);
		const restored = store();
		const accepted = restored.loadProfiles(JSON.parse(JSON.stringify(source.exportAll())));
		expect(accepted).toBe(1);
		expect(restored.getProfile("proj-a", "debugging").maxUsefulTokens).toBe(6000);
	});

	it("rejects invalid entries during load", () => {
		const restored = store();
		const bogus = [
			{ projectId: "", taskCategory: "normal" },
			{ projectId: "proj-a", taskCategory: "not-a-category" },
			{ projectId: "proj-a", taskCategory: "normal", sampleCount: -1 },
		] as unknown as ProjectBudgetProfile[];
		expect(restored.loadProfiles(bogus)).toBe(0);
		expect(restored.size()).toBe(0);
	});

	it("exports copies, not live references", () => {
		const profiles = store();
		profiles.updateProfile("proj-a", "normal", 1000, true);
		const exported = profiles.exportAll();
		exported[0].meanUsefulTokens = 999999;
		expect(profiles.getProfile("proj-a", "normal").meanUsefulTokens).toBe(1000);
	});
});

describe("selectBestConfiguration", () => {
	it("returns null for an empty result set", () => {
		expect(selectBestConfiguration([])).toBeNull();
	});

	it("picks the smallest budget among near-best safe configurations", () => {
		const chosen = selectBestConfiguration([
			benchmark({ budgetTokens: 16000, taskSuccessRate: 0.9 }),
			benchmark({ budgetTokens: 4000, taskSuccessRate: 0.89 }),
			benchmark({ budgetTokens: 8000, taskSuccessRate: 0.895 }),
		]);
		expect(chosen).toBe(4000);
	});

	it("excludes configurations outside the success margin", () => {
		const chosen = selectBestConfiguration([
			benchmark({ budgetTokens: 16000, taskSuccessRate: 0.9 }),
			benchmark({ budgetTokens: 2000, taskSuccessRate: 0.5 }),
		]);
		expect(chosen).toBe(16000);
	});

	it("rejects any configuration with leakage or false promotion", () => {
		const chosen = selectBestConfiguration([
			benchmark({ budgetTokens: 2000, hasCrossProjectLeakage: true }),
			benchmark({ budgetTokens: 3000, hasSecretLeakage: true }),
			benchmark({ budgetTokens: 4000, hasFalseVerifiedPromotion: true }),
			benchmark({ budgetTokens: 8000 }),
		]);
		expect(chosen).toBe(8000);
	});

	it("rejects slow or harmful configurations and can return null", () => {
		const chosen = selectBestConfiguration([
			benchmark({ budgetTokens: 2000, p95LatencyMs: 60000 }),
			benchmark({ budgetTokens: 3000, harmfulMemoryInfluenceRate: 0.5 }),
		]);
		expect(chosen).toBeNull();
	});

	it("honors custom thresholds", () => {
		const chosen = selectBestConfiguration([benchmark({ budgetTokens: 2000, p95LatencyMs: 5000 })], {
			maxLatencyMs: 4000,
		});
		expect(chosen).toBeNull();
	});
});
