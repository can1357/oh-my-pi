/**
 * Compiles `rules/taxonomy/*.kdl` into {@link CompiledTaxonomy}.
 *
 * Faithful port of the o2 reference (`taxonomy.rs`): class membership
 * matchers, product families, revision extraction, reviewed identity
 * overrides, and the collapse/discovery vocabularies, with the same
 * validation rules (unique class names and override ids/pairs, exactly one
 * non-empty collapse, at most one discovery).
 */

import { isEffortTier, isThinkingMode } from "../../src/compat/axes";
import { formatRevision, parseRevision, parseRevisionConstraint } from "../../src/compat/revision";
import {
	type CompiledClass,
	type CompiledCollapse,
	type CompiledDiscovery,
	type CompiledFamily,
	type CompiledIdentityOverride,
	type CompiledMatcher,
	type CompiledTaxonomy,
	type CompiledVariantFamily,
	REVISION_PLACEHOLDER,
	type VariantTier,
} from "../../src/compat/types";
import type { Effort } from "../../src/effort";
import {
	CompatCompileError,
	type KdlNodeView,
	malformed,
	parseKdl,
	positionalStrings,
	propBool,
	propInt,
	propString,
	requiredProp,
	unexpected,
	validateProps,
} from "./kdl-reader";

const MATCHER_KINDS: Record<string, CompiledMatcher["kind"]> = {
	exact: "exact",
	bounded: "bounded",
	namespace: "namespace",
	prefix: "prefix",
	glob: "glob",
};

function parseEffort(node: KdlNodeView, value: string): Effort | "off" {
	if (!isEffortTier(value)) malformed(node);
	return value;
}

function parseMatcher(node: KdlNodeView): CompiledMatcher {
	validateProps(node, node.name === "namespace" ? ["bounded"] : []);
	const args = positionalStrings(node);
	if (args.length !== 1 || !args[0] || node.children) malformed(node);
	const kind = MATCHER_KINDS[node.name];
	if (kind === undefined) malformed(node);
	const matcher: CompiledMatcher = { kind, token: args[0].toLowerCase() };
	if (propBool(node, "bounded")) matcher.bounded = true;
	return matcher;
}

function parseFamily(node: KdlNodeView): CompiledFamily {
	validateProps(node, ["glob", "priority"]);
	const args = positionalStrings(node);
	const glob = propString(node, "glob");
	if (args.length !== 1 || !args[0] || !glob || node.children) malformed(node);
	return { id: args[0], glob: glob.toLowerCase(), priority: propInt(node, "priority") ?? 0 };
}

function parseRevisionRule(node: KdlNodeView, cls: CompiledClass): void {
	validateProps(node, ["prefix", "anywhere"]);
	if (node.children) malformed(node);
	const prefix = propString(node, "prefix");
	if (prefix !== undefined) {
		if (!prefix || node.args.length > 0) malformed(node);
		const rule: CompiledClass["revisionPrefixes"][number] = { prefix: prefix.toLowerCase() };
		if (propBool(node, "anywhere")) rule.anywhere = true;
		cls.revisionPrefixes.push(rule);
		return;
	}
	if (node.props.length > 0) malformed(node);
	const args = positionalStrings(node);
	if (args[0] !== "skip-bare" || args.length < 2) malformed(node);
	cls.skipBare.push(...args.slice(1).map(value => value.toLowerCase()));
}

const OVERRIDE_PROPS = [
	"id",
	"provider",
	"model",
	"logical",
	"class",
	"family",
	"revision",
	"effort",
	"thinking-variant",
	"rationale",
	"provenance",
	"expires-at-ms",
] as const;

function parseOverride(node: KdlNodeView): CompiledIdentityOverride {
	validateProps(node, OVERRIDE_PROPS);
	if (node.args.length > 0 || node.children) malformed(node);
	for (const name of ["class", "family"]) {
		const value = propString(node, name);
		if (value !== undefined && value === "") malformed(node);
	}
	const override: CompiledIdentityOverride = {
		id: requiredProp(node, "id"),
		model: requiredProp(node, "model"),
		rationale: requiredProp(node, "rationale"),
		provenance: requiredProp(node, "provenance"),
	};
	const provider = propString(node, "provider");
	if (provider !== undefined) override.provider = provider;
	const logical = propString(node, "logical");
	if (logical !== undefined) override.logical = logical;
	const cls = propString(node, "class");
	if (cls !== undefined) override.class = cls;
	const family = propString(node, "family");
	if (family !== undefined) override.family = family;
	const revision = propString(node, "revision");
	if (revision !== undefined) {
		const parsed = parseRevision(revision);
		if (!parsed) malformed(node);
		override.revision = formatRevision(parsed);
	}
	const effort = propString(node, "effort");
	if (effort !== undefined) override.effort = parseEffort(node, effort);
	const thinkingVariant = propBool(node, "thinking-variant");
	if (thinkingVariant !== undefined) override.thinkingVariant = thinkingVariant;
	const expiresAtMs = propInt(node, "expires-at-ms");
	if (expiresAtMs !== undefined) {
		if (expiresAtMs < 0) malformed(node);
		override.expiresAtMs = expiresAtMs;
	}
	return override;
}

function parseClass(node: KdlNodeView): CompiledClass {
	validateProps(node, []);
	const args = positionalStrings(node);
	if (args.length !== 1 || !args[0] || !node.children) malformed(node);
	const cls: CompiledClass = {
		id: args[0],
		matchers: [],
		families: [],
		revisionPrefixes: [],
		skipBare: [],
		overrides: [],
	};
	for (const child of node.children) {
		if (MATCHER_KINDS[child.name]) cls.matchers.push(parseMatcher(child));
		else if (child.name === "family") cls.families.push(parseFamily(child));
		else if (child.name === "revision") parseRevisionRule(child, cls);
		else if (child.name === "override") cls.overrides.push(parseOverride(child));
		else unexpected(child, "class");
	}
	return cls;
}

function parseCollapse(node: KdlNodeView): CompiledCollapse {
	validateProps(node, []);
	if (node.args.length > 0 || !node.children) malformed(node);
	const collapse: CompiledCollapse = {
		suffixes: [],
		pairTokens: [],
		lanes: [],
		routingVariants: [],
		effortFamilies: [],
		variantFamilies: [],
		providerAliases: {},
	};
	const suffixes = new Set<string>();
	const familyKeys = new Set<string>();
	const aliasKeys = new Set<string>();
	for (const child of node.children) {
		switch (child.name) {
			case "variant-family":
				collapse.variantFamilies.push(parseVariantFamily(child));
				break;
			case "provider-alias": {
				validateProps(child, []);
				const args = positionalStrings(child);
				if (args.length !== 3 || args.some(value => !value) || child.children) malformed(child);
				const [provider, alias, logical] = args;
				const key = provider.toLowerCase();
				collapse.providerAliases[key] ??= {};
				const aliases = collapse.providerAliases[key];
				if (alias in aliases) malformed(child);
				aliases[alias] = logical;
				break;
			}
			case "pair-token":
				validateProps(child, []);
				for (const token of positionalStrings(child).map(value => value.toLowerCase())) {
					if (!token || collapse.pairTokens.includes(token)) malformed(child);
					collapse.pairTokens.push(token);
				}
				if (child.children || collapse.pairTokens.length === 0) malformed(child);
				break;
			case "thinking-suffix":
			case "effort-suffix": {
				validateProps(child, child.name === "effort-suffix" ? ["tier", "except-bare-prefix"] : []);
				const args = positionalStrings(child);
				if (args.length !== 1 || !args[0] || child.children) malformed(child);
				const suffix = args[0].toLowerCase();
				if (suffixes.has(suffix)) malformed(child);
				suffixes.add(suffix);
				const rule: CompiledCollapse["suffixes"][number] = { suffix };
				if (child.name === "thinking-suffix") {
					rule.thinking = true;
				} else {
					rule.effort = parseEffort(child, requiredProp(child, "tier"));
					const except = propString(child, "except-bare-prefix");
					if (except !== undefined) {
						if (!except) malformed(child);
						rule.exceptBarePrefix = except.toLowerCase();
					}
				}
				collapse.suffixes.push(rule);
				break;
			}
			case "effort-lane-suffix": {
				validateProps(child, ["bare-prefix"]);
				const [suffix, ...providers] = positionalStrings(child);
				if (!suffix || providers.length === 0 || providers.some(value => !value) || child.children)
					malformed(child);
				const lower = suffix.toLowerCase();
				if (suffixes.has(lower)) malformed(child);
				suffixes.add(lower);
				const lane: CompiledCollapse["lanes"][number] = {
					suffix: lower,
					providers: providers.map(value => value.toLowerCase()),
				};
				const barePrefix = propString(child, "bare-prefix");
				if (barePrefix !== undefined) {
					if (!barePrefix) malformed(child);
					lane.barePrefix = barePrefix.toLowerCase();
				}
				collapse.lanes.push(lane);
				break;
			}
			case "routing-variant-suffix": {
				validateProps(child, []);
				const [suffix, ...providers] = positionalStrings(child);
				if (!suffix || providers.length === 0 || providers.some(value => !value) || child.children)
					malformed(child);
				const lower = suffix.toLowerCase();
				if (suffixes.has(lower)) malformed(child);
				suffixes.add(lower);
				collapse.routingVariants.push({ suffix: lower, providers: providers.map(value => value.toLowerCase()) });
				break;
			}
			case "effort-family": {
				validateProps(child, []);
				const args = positionalStrings(child).map(value => value.toLowerCase());
				const [provider, logical, ...aliases] = args;
				if (!provider || !logical || child.children) malformed(child);
				const key = `${provider}\0${logical}`;
				if (familyKeys.has(key) || aliasKeys.has(key)) malformed(child);
				for (const alias of aliases) {
					const aliasKey = `${provider}\0${alias}`;
					if (!alias || alias === logical || familyKeys.has(aliasKey) || aliasKeys.has(aliasKey)) malformed(child);
					aliasKeys.add(aliasKey);
				}
				familyKeys.add(key);
				collapse.effortFamilies.push({ provider, logical, aliases });
				break;
			}
			default:
				unexpected(child, "collapse");
		}
	}
	return collapse;
}

function parseVariantTier(node: KdlNodeView, value: string): VariantTier {
	if (!isEffortTier(value)) malformed(node);
	return value;
}

/**
 * `variant-family "<provider>" "<logical id>" name="…" [revision="…"] { … }`
 * — reviewed per-provider effort/thinking sibling routing (see
 * `rules/README.md`). A `{rev}` in the logical id makes the node a template:
 * every wire id in the body must carry the placeholder too, and `revision=`
 * bounds the generations it instantiates for.
 */
function parseVariantFamily(node: KdlNodeView): CompiledVariantFamily {
	validateProps(node, ["name", "revision"]);
	const args = positionalStrings(node);
	if (args.length !== 2 || args.some(value => !value) || !node.children) malformed(node);
	const family: CompiledVariantFamily = {
		provider: args[0].toLowerCase(),
		id: args[1],
		name: requiredProp(node, "name"),
		members: [],
		routing: {},
	};
	const templated = family.id.includes(REVISION_PLACEHOLDER);
	const revision = propString(node, "revision");
	if (revision !== undefined) {
		if (!templated || parseRevisionConstraint(revision) === undefined) malformed(node);
		family.revision = revision;
	}
	for (const child of node.children) {
		validateProps(child, []);
		if (child.children) malformed(child);
		if (
			child.name === "requires-effort" ||
			child.name === "suppress-when-off" ||
			child.name === "no-thinking" ||
			child.name === "preserve-absent-effort-routes"
		) {
			if (child.args.length !== 1 || typeof child.args[0] !== "boolean") malformed(child);
			const flag = child.args[0];
			if (child.name === "requires-effort") family.requiresEffort = flag;
			else if (child.name === "suppress-when-off") family.suppressWhenOff = flag;
			else if (child.name === "no-thinking") family.noThinking = flag;
			else family.preserveAbsentEffortRoutes = flag;
			continue;
		}
		const values = positionalStrings(child);
		switch (child.name) {
			case "members":
				if (values.length === 0 || values.some(value => !value)) malformed(child);
				family.members.push(...values);
				break;
			case "route": {
				if (values.length !== 2 || !values[1]) malformed(child);
				const tier = parseVariantTier(child, values[0]);
				if (tier in family.routing) malformed(child);
				family.routing[tier] = values[1];
				break;
			}
			case "budget": {
				if (values.length !== 2) malformed(child);
				const tier = parseVariantTier(child, values[0]);
				if (tier === "off") malformed(child);
				const amount = Number(values[1]);
				if (!Number.isSafeInteger(amount) || amount < 0) malformed(child);
				family.effortBudgets ??= {};
				if (tier in family.effortBudgets) malformed(child);
				family.effortBudgets[tier] = amount;
				break;
			}
			case "mode":
				if (values.length !== 1 || !values[0] || family.mode !== undefined) malformed(child);
				if (!isThinkingMode(values[0])) malformed(child);
				family.mode = values[0];
				break;
			case "efforts":
				if (values.length === 0 || family.efforts !== undefined) malformed(child);
				family.efforts = values.map(value => {
					const tier = parseVariantTier(child, value);
					if (tier === "off") malformed(child);
					return tier;
				});
				break;
			case "default-level":
				if (values.length !== 1 || family.defaultLevel !== undefined) malformed(child);
				{
					const tier = parseVariantTier(child, values[0]);
					if (tier === "off") malformed(child);
					family.defaultLevel = tier;
				}
				break;
			case "default-member":
				if (values.length !== 1 || !values[0] || family.defaultMember !== undefined) malformed(child);
				family.defaultMember = values[0];
				break;
			case "retired":
				if (values.length === 0 || values.some(value => !value)) malformed(child);
				family.retiredMembers ??= [];
				family.retiredMembers.push(...values);
				break;
			case "aliases":
				if (values.length === 0 || values.some(value => !value)) malformed(child);
				family.extraAliases ??= [];
				family.extraAliases.push(...values);
				break;
			default:
				unexpected(child, "variant-family");
		}
	}
	if (family.members.length === 0) malformed(node);
	const wireIds = [
		...family.members,
		...Object.values(family.routing),
		...(family.retiredMembers ?? []),
		...(family.extraAliases ?? []),
		...(family.defaultMember !== undefined ? [family.defaultMember] : []),
	];
	if (wireIds.some(id => id.includes(REVISION_PLACEHOLDER) !== templated)) malformed(node);
	return family;
}

function parseDiscovery(node: KdlNodeView): CompiledDiscovery {
	validateProps(node, []);
	if (node.args.length > 0 || !node.children) malformed(node);
	const discovery: CompiledDiscovery = {
		canonicalRecovery: [],
		responsesHintGroups: [],
		responsesRouteModels: {},
		billingVariantSuffixes: [],
		trailingMarkers: [],
		referenceOnlyTrailingMarkers: [],
		proReasoningAliases: {},
		proReasoningSweep: [],
		canonicalFamilyTokens: [],
		wrapperPrefixes: [],
		syntheticPrefixes: [],
	};
	const grouped = new Set<string>();
	for (const child of node.children) {
		validateProps(child, []);
		const args = positionalStrings(child);
		if (args.length === 0 || args.some(value => !value) || child.children) malformed(child);
		switch (child.name) {
			case "recover-canonical-params":
				for (const provider of args.map(value => value.toLowerCase())) {
					if (discovery.canonicalRecovery.includes(provider)) malformed(child);
					discovery.canonicalRecovery.push(provider);
				}
				break;
			case "borrow-responses-route": {
				const group: string[] = [];
				for (const provider of args.map(value => value.toLowerCase())) {
					if (grouped.has(provider)) malformed(child);
					grouped.add(provider);
					group.push(provider);
				}
				discovery.responsesHintGroups.push(group);
				break;
			}
			case "responses-route-models": {
				const [provider, ...models] = args;
				if (models.length === 0) malformed(child);
				const key = provider.toLowerCase();
				if (key in discovery.responsesRouteModels) malformed(child);
				const unique = new Set<string>();
				discovery.responsesRouteModels[key] = models.map(model => {
					const lower = model.toLowerCase();
					if (unique.has(lower)) malformed(child);
					unique.add(lower);
					return lower;
				});
				break;
			}
			case "billing-variant-suffix":
				for (const suffix of args.map(value => value.toLowerCase())) {
					if (suffix === "-" || discovery.billingVariantSuffixes.includes(suffix)) malformed(child);
					discovery.billingVariantSuffixes.push(suffix);
				}
				break;
			case "trailing-marker":
				for (const marker of args.map(value => value.toLowerCase())) {
					if (!marker || discovery.trailingMarkers.includes(marker)) malformed(child);
					discovery.trailingMarkers.push(marker);
				}
				break;
			case "reference-only-trailing-marker":
				for (const marker of args.map(value => value.toLowerCase())) {
					if (!marker || discovery.referenceOnlyTrailingMarkers.includes(marker)) malformed(child);
					discovery.referenceOnlyTrailingMarkers.push(marker);
				}
				break;
			case "pro-reasoning-alias": {
				const [provider, ...bases] = args;
				if (bases.length === 0) malformed(child);
				const key = provider.toLowerCase();
				if (key in discovery.proReasoningAliases) malformed(child);
				const unique = new Set<string>();
				discovery.proReasoningAliases[key] = bases.map(base => {
					const lower = base.toLowerCase();
					if (unique.has(lower)) malformed(child);
					unique.add(lower);
					return lower;
				});
				break;
			}
			case "pro-reasoning-sweep":
				for (const provider of args.map(value => value.toLowerCase())) {
					if (discovery.proReasoningSweep.includes(provider)) malformed(child);
					discovery.proReasoningSweep.push(provider);
				}
				break;
			case "canonical-family-token":
				for (const token of args.map(value => value.toLowerCase())) {
					if (!token || discovery.canonicalFamilyTokens.includes(token)) malformed(child);
					discovery.canonicalFamilyTokens.push(token);
				}
				break;
			case "wrapper-prefix":
				for (const prefix of args.map(value => value.toLowerCase())) {
					if (!prefix || discovery.wrapperPrefixes.includes(prefix)) malformed(child);
					discovery.wrapperPrefixes.push(prefix);
				}
				break;
			case "synthetic-prefix":
				for (const prefix of args.map(value => value.toLowerCase())) {
					if (!prefix || discovery.syntheticPrefixes.includes(prefix)) malformed(child);
					discovery.syntheticPrefixes.push(prefix);
				}
				break;
			default:
				unexpected(child, "discovery");
		}
	}
	if (
		discovery.canonicalRecovery.length === 0 &&
		discovery.responsesHintGroups.length === 0 &&
		Object.keys(discovery.responsesRouteModels).length === 0 &&
		discovery.billingVariantSuffixes.length === 0
	) {
		malformed(node);
	}
	return discovery;
}

/** Compiles every taxonomy source (`file` is rules-relative) into one taxonomy. */
export function compileTaxonomy(sources: readonly { file: string; text: string }[]): CompiledTaxonomy {
	const classes: CompiledClass[] = [];
	let collapse: CompiledCollapse | undefined;
	let discovery: CompiledDiscovery | undefined;
	const classNames = new Set<string>();
	const overrideIds = new Set<string>();
	const overrideKeys = new Set<string>();

	for (const { file, text } of sources) {
		for (const node of parseKdl(file, text)) {
			switch (node.name) {
				case "class": {
					const cls = parseClass(node);
					if (classNames.has(cls.id)) {
						throw new CompatCompileError(file, node.line, `duplicate class \`${cls.id}\``);
					}
					classNames.add(cls.id);
					for (const override of cls.overrides) {
						if (overrideIds.has(override.id)) {
							throw new CompatCompileError(file, node.line, `duplicate override id \`${override.id}\``);
						}
						overrideIds.add(override.id);
						const key = `${override.provider?.toLowerCase() ?? ""}\0${override.model.toLowerCase()}`;
						if (overrideKeys.has(key)) {
							throw new CompatCompileError(file, node.line, `duplicate override pair for \`${override.model}\``);
						}
						overrideKeys.add(key);
					}
					classes.push(cls);
					break;
				}
				case "collapse":
					if (collapse) throw new CompatCompileError(file, node.line, "duplicate `collapse` definition");
					collapse = parseCollapse(node);
					break;
				case "discovery":
					if (discovery) throw new CompatCompileError(file, node.line, "duplicate `discovery` definition");
					discovery = parseDiscovery(node);
					break;
				default:
					unexpected(node, "taxonomy");
			}
		}
	}
	if (!collapse || collapse.suffixes.length === 0) {
		throw new CompatCompileError("taxonomy", undefined, "missing non-empty `collapse` definition");
	}
	classes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return {
		classes,
		collapse,
		discovery: discovery ?? {
			canonicalRecovery: [],
			responsesHintGroups: [],
			responsesRouteModels: {},
			billingVariantSuffixes: [],
			trailingMarkers: [],
			referenceOnlyTrailingMarkers: [],
			proReasoningAliases: {},
			proReasoningSweep: [],
			canonicalFamilyTokens: [],
			wrapperPrefixes: [],
			syntheticPrefixes: [],
		},
	};
}
