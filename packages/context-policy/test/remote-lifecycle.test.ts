import { describe, expect, it } from "bun:test";
import { DEFAULT_CONTEXT_POLICY } from "../src/default-policy";
import { remoteLifecycleCategories, staticallyExpiringCategories } from "../src/remote-lifecycle";
import { CONTEXT_CATEGORIES } from "../src/types";

interface LifecycleRule {
	ID: string;
	Status: string;
	Filter: {
		Prefix?: string;
		And?: { Prefix: string; Tags: { Key: string; Value: string }[] };
	};
	Expiration?: { Days?: number; Date?: string; ExpiredObjectDeleteMarker?: boolean };
	NoncurrentVersionExpiration?: { NoncurrentDays: number };
	Transitions?: unknown;
}

const lifecycleUrl = new URL("../../../infra/context-storage/lifecycle.s3.json", import.meta.url);

async function loadRules(): Promise<LifecycleRule[]> {
	const parsed = (await Bun.file(lifecycleUrl).json()) as { Rules: LifecycleRule[] };
	return parsed.Rules;
}

describe("remote lifecycle template", () => {
	it("defines every ContextCategory in the canonical remote lifecycle mapping", () => {
		const policyCategories = Object.keys(DEFAULT_CONTEXT_POLICY.categories).sort();
		expect(policyCategories).toEqual([...CONTEXT_CATEGORIES].sort());
		const lifecycleCategories = remoteLifecycleCategories()
			.map<string>(entry => entry.category)
			.sort();
		expect(lifecycleCategories).toEqual(policyCategories);
		expect(DEFAULT_CONTEXT_POLICY.categories.preference.ttlDays).toBe(365);
		expect(DEFAULT_CONTEXT_POLICY.categories.quarantine.ttlDays).toBe(14);
	});

	it("matches every static expiry rule exactly to the canonical policy", async () => {
		const rules = await loadRules();
		const dataRules = rules
			.filter(rule => rule.Expiration?.ExpiredObjectDeleteMarker !== true)
			.sort((left, right) => left.ID.localeCompare(right.ID));
		const expected = staticallyExpiringCategories()
			.map(({ prefix, ttlDays, noncurrentDays }) => ({
				ID: `${prefix.slice(0, -1)}-expire`,
				Status: "Enabled",
				Filter: { And: { Prefix: prefix, Tags: [{ Key: "legal_hold", Value: "false" }] } },
				Expiration: { Days: ttlDays },
				NoncurrentVersionExpiration: { NoncurrentDays: noncurrentDays },
			}))
			.sort((left, right) => left.ID.localeCompare(right.ID));

		expect(dataRules).toEqual(expected);
	});

	it("cleans up expired delete markers with one action-only enabled rule", async () => {
		const rules = await loadRules();
		const cleanup = rules.filter(rule => rule.Expiration?.ExpiredObjectDeleteMarker === true);
		expect(cleanup).toEqual([
			{
				ID: "expired-delete-marker-cleanup",
				Status: "Enabled",
				Filter: { Prefix: "" },
				Expiration: { ExpiredObjectDeleteMarker: true },
			},
		]);
	});
});
