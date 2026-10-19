import { describe, expect, test } from "bun:test";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { parseModelPattern, providerModelHint } from "../src/config/model-resolver";

describe("built-in role defaults", () => {
	// Provider-qualified selectors resolve exactly or not at all. A qualified
	// default missing from the bundled catalog may still arrive through account
	// discovery, but one that only near-matches a bundled sibling names a
	// renamed or retired id and would be skipped for every user.
	test("no provider-qualified default is a near miss of a bundled model", () => {
		// `getBundledProviders` lists exactly the generated providers' keys.
		const providers = new Set<string>(getBundledProviders());
		const models = getBundledProviders().flatMap(provider => getBundledModels(provider as GeneratedProvider));
		const nearMisses = Object.entries(roleDefaultModels()).flatMap(([role, patterns]) =>
			(patterns as readonly string[]).flatMap(pattern => {
				const slash = pattern.indexOf("/");
				const provider = pattern.slice(0, slash);
				if (slash === -1 || !providers.has(provider) || parseModelPattern(pattern, models).model) return [];
				const hint = providerModelHint(pattern, models);
				return hint ? [`${role}: ${pattern}${hint}`] : [];
			}),
		);
		expect(nearMisses).toEqual([]);
	});
});
