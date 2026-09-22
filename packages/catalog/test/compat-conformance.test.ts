import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import rules from "../src/compat/rules.json";
import models from "../src/models.json";

/**
 * Providers referenced by rules that have no bundled models.json rows:
 * local runtimes, hosted-search facades, and routing-variant device peers.
 * Additions require a comment naming the runtime path that resolves them.
 */
const RUNTIME_ONLY_PROVIDERS = new Set([
	"kimi-search",
	"ollama",
	"siliconflow",
	"zai-search",
	"synthetic-search",
	"llama.cpp",
	"lm-studio",
	"litellm",
	"vllm",
	"openai-codex-device",
	// Public gateway discovery via charmHyperModelManagerOptions: every row,
	// including its tariff and effort ladder, comes from the live /v1/models
	// snapshot, so no bundled rows are frozen into models.json.
	"charm-hyper",
	// Both SingularityAPI rosters are live and credential-scoped (one key sees
	// only its own product's models — the pay-as-you-go catalog or the reserved
	// lanes), so no rows are frozen into models.json.
	"singularityapi-dev",
	"singularityapi-tech",
	// User-configured LiteLLM proxy (models.yml provider or litellm auth flow;
	// PROXY_OPENAI_COMPAT_PROVIDERS) that forwards upstream chat templates.
	"litellm",
	// User-configured models.yml provider pointing at
	// https://inference-api.nousresearch.com/v1 (NousResearch inference API).
	"nous",
]);

// Hosted image-generation defaults (`<backend>-image`) are referenced from
// behavior.hostedDefaults and resolved at runtime via hostedDefaultModel
// (packages/coding-agent/src/tools/image-gen.ts), so they are derived from
// the KDL policy instead of being hard-coded: a new backend needs no test
// edit, and this allowlist cannot bless a backend that lacks its default.
for (const entry of rules.behavior.hostedDefaults) {
	if (entry.provider.endsWith("-image")) RUNTIME_ONLY_PROVIDERS.add(entry.provider);
}

function collectReferencedProviders(): Map<string, string> {
	const referenced = new Map<string, string>();
	for (const rule of rules.cascade.rules) {
		for (const provider of rule.providers ?? []) referenced.set(provider, rule.source);
	}
	const taxonomy = rules.taxonomy;
	for (const cls of taxonomy.classes) {
		for (const override of cls.overrides) {
			if (override.provider) referenced.set(override.provider, `override ${override.id}`);
		}
	}
	for (const lane of taxonomy.collapse.lanes) {
		for (const provider of lane.providers) referenced.set(provider, `effort-lane ${lane.suffix}`);
	}
	for (const variant of taxonomy.collapse.routingVariants) {
		for (const provider of variant.providers) referenced.set(provider, `routing-variant ${variant.suffix}`);
	}
	for (const family of taxonomy.collapse.effortFamilies)
		referenced.set(family.provider, `effort-family ${family.logical}`);
	for (const provider of taxonomy.discovery.canonicalRecovery) referenced.set(provider, "recover-canonical-params");
	for (const group of taxonomy.discovery.responsesHintGroups) {
		for (const provider of group) referenced.set(provider, "borrow-responses-route");
	}
	for (const provider in taxonomy.discovery.responsesRouteModels) referenced.set(provider, "responses-route-models");
	const behavior = rules.behavior;
	const lists = [
		behavior.modelOperations,
		behavior.quotaTiers,
		behavior.hostedDefaults,
		behavior.imageProviders,
		behavior.apiRoutes,
		behavior.modelLimits,
		behavior.excludeDiscoveryModes,
		behavior.excludeModels,
		behavior.planRequirements,
		behavior.retryResetTimezones,
		behavior.pricingPeers,
	];
	for (const list of lists) {
		for (const entry of list) referenced.set(entry.provider, "behavior");
	}
	return referenced;
}

describe("compat rules conformance", () => {
	test("every referenced provider id is bundled or runtime-only", () => {
		const known = new Set(Object.keys(models));
		const offenders: string[] = [];
		for (const [provider, source] of collectReferencedProviders()) {
			if (!known.has(provider) && !RUNTIME_ONLY_PROVIDERS.has(provider)) {
				offenders.push(`${provider} (${source})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every cascade class/family reference exists in the taxonomy", () => {
		const classes = new Map(rules.taxonomy.classes.map(cls => [cls.id, new Set(cls.families.map(f => f.id))]));
		const offenders: string[] = [];
		for (const rule of rules.cascade.rules) {
			if (rule.class !== undefined) {
				const families = classes.get(rule.class);
				if (!families) {
					offenders.push(`class ${rule.class} (${rule.source})`);
					continue;
				}
				if (rule.family !== undefined && !families.has(rule.family)) {
					offenders.push(`family ${rule.class}/${rule.family} (${rule.source})`);
				}
			} else if (rule.family !== undefined) {
				// Provider-scoped family selectors must name a family of SOME class.
				const known = rules.taxonomy.classes.some(cls => cls.families.some(f => f.id === rule.family));
				if (!known) offenders.push(`family ${rule.family} (${rule.source})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every image-provider backend has a hosted default or credential model", () => {
		// generate_image resolves credential-listed backends from the active
		// credential and every other backend via hostedDefaultModel(`${backend}-image`),
		// which throws without one. Both halves come from the KDL policy, so a
		// new backend cannot be blessed without declaring its model source.
		const credential = new Set(rules.behavior.credentialImageModels);
		const defaults = new Set(rules.behavior.hostedDefaults.map(entry => entry.provider));
		const offenders: string[] = [];
		for (const entry of rules.behavior.imageProviders) {
			if (!credential.has(entry.backend) && !defaults.has(`${entry.backend}-image`)) {
				offenders.push(entry.backend);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every rules/**/*.kdl file was compiled", async () => {
		const rulesDir = path.join(import.meta.dir, "../src/compat/rules");
		const onDisk: string[] = [];
		for (const group of ["taxonomy", "classes", "providers", "runtime", "auth"]) {
			for (const name of await fs.readdir(path.join(rulesDir, group))) {
				if (name.endsWith(".kdl")) onDisk.push(`${group}/${name}`);
			}
		}
		expect([...rules.files].sort()).toEqual(onDisk.sort());
	});
});
