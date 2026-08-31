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
	"vllm",
	"openai-codex-device",
]);

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
		behavior.apiRoutes,
		behavior.modelLimits,
		behavior.excludeModels,
		behavior.planRequirements,
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

	test("every rules/**/*.kdl file was compiled", async () => {
		const rulesDir = path.join(import.meta.dir, "../src/compat/rules");
		const onDisk: string[] = [];
		for (const group of ["taxonomy", "classes", "providers", "runtime"]) {
			for (const name of await fs.readdir(path.join(rulesDir, group))) {
				if (name.endsWith(".kdl")) onDisk.push(`${group}/${name}`);
			}
		}
		expect([...rules.files].sort()).toEqual(onDisk.sort());
	});
});
