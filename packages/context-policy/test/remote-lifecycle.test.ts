import { describe, expect, it } from "bun:test";
import { DEFAULT_CONTEXT_POLICY } from "../src/default-policy";
import { remotePrefixForCategory, staticallyExpiringCategories } from "../src/remote-lifecycle";
import type { ContextCategory } from "../src/types";

interface LifecycleRule {
	ID: string;
	Status: string;
	Filter: {
		Prefix?: string;
		And?: { Prefix: string; Tags: { Key: string; Value: string }[] };
	};
	Expiration?: { Days?: number; ExpiredObjectDeleteMarker?: boolean };
	NoncurrentVersionExpiration?: { NoncurrentDays: number };
	Transitions?: unknown;
}

const lifecycleUrl = new URL("../../../infra/context-storage/lifecycle.s3.json", import.meta.url);

async function loadRules(): Promise<LifecycleRule[]> {
	const parsed = (await Bun.file(lifecycleUrl).json()) as { Rules: LifecycleRule[] };
	return parsed.Rules;
}

describe("remote lifecycle template", () => {
	it("covers every statically expiring category with a hold-safe rule at the canonical prefix", async () => {
		const rules = await loadRules();
		const expiring = staticallyExpiringCategories();
		// Sanity: the policy fixture actually contains fixed-TTL categories,
		// including the governance-sensitive ones.
		expect(expiring.map(entry => entry.category)).toContain("preference");
		expect(expiring.map(entry => entry.category)).toContain("quarantine");

		for (const { prefix, ttlDays } of expiring) {
			const matching = rules.filter(rule => rule.Filter.And?.Prefix === prefix);
			expect(matching).toHaveLength(1);
			const rule = matching[0];
			expect(rule.Status).toBe("Enabled");
			expect(rule.Filter.And?.Tags).toEqual([{ Key: "legal_hold", Value: "false" }]);
			expect(rule.Expiration?.Days).toBe(ttlDays);
			// Versioned/Object Lock buckets: Expiration only writes a delete
			// marker; noncurrent expiration is what actually removes data.
			expect(rule.NoncurrentVersionExpiration?.NoncurrentDays).toBe(ttlDays);
			expect(rule.Transitions).toBeUndefined();
		}
	});

	it("never adds a static expiration for governed or case-closed categories", async () => {
		const rules = await loadRules();
		const governed = (Object.keys(DEFAULT_CONTEXT_POLICY.categories) as ContextCategory[]).filter(
			category => DEFAULT_CONTEXT_POLICY.categories[category].ttlDays === undefined,
		);
		expect(governed.length).toBeGreaterThan(0);
		for (const category of governed) {
			const prefix = remotePrefixForCategory(category);
			expect(rules.some(rule => rule.Filter.And?.Prefix === prefix || rule.Filter.Prefix === prefix)).toBe(false);
		}
	});

	it("cleans up expired delete markers without a tag filter", async () => {
		const rules = await loadRules();
		const cleanup = rules.filter(rule => rule.Expiration?.ExpiredObjectDeleteMarker === true);
		expect(cleanup).toHaveLength(1);
		// ExpiredObjectDeleteMarker is rejected by S3 when combined with tag
		// filters or Days; the rule must stay prefix-only and day-free.
		expect(cleanup[0].Filter).toEqual({ Prefix: "" });
		expect(cleanup[0].Expiration?.Days).toBeUndefined();
	});
});
