/**
 * Compiles `rules/runtime/behavior.kdl` into {@link CompiledBehavior}.
 *
 * Ports the o2 runtime-behavior grammar (openai-responses-heuristic,
 * model-operations, cursor-effort, cursor-model-parameter, quota-tiers,
 * hosted-default) and adds the pi-only nodes: api-routes, model-limits,
 * exclude-models, plan-requirement, pricing-peer. Every node kind is
 * optional; per-node shapes are strict.
 */
import type {
	CompiledApiRoutes,
	CompiledBehavior,
	CompiledExcludeModels,
	CompiledMatchList,
	CompiledModelLimits,
	CompiledModelOperations,
	CompiledPlanRequirement,
	CompiledPricingPeer,
	CompiledQuotaRule,
	CompiledResponsesHeuristic,
} from "../../src/compat/types";
import {
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

function ensureContainer(node: KdlNodeView, properties: readonly string[]): KdlNodeView[] {
	validateProps(node, properties);
	if (node.args.length > 0 || !node.children) malformed(node);
	return node.children;
}

function ensureLeaf(node: KdlNodeView, properties: readonly string[]): void {
	validateProps(node, properties);
	if (node.children) malformed(node);
}

/**
 * Reads matcher tokens from a node's named entries (`exact=` / `prefix=` /
 * `substring=` / `glob=`, repeatable) into a match list. `skip` names
 * non-matcher properties the caller consumes separately.
 */
function matchListFromProps(node: KdlNodeView, skip: readonly string[]): CompiledMatchList {
	const match: CompiledMatchList = {};
	for (const prop of node.props) {
		if (skip.includes(prop.name)) continue;
		if (typeof prop.value !== "string" || !prop.value) malformed(node);
		switch (prop.name) {
			case "exact":
				match.exact ??= [];
				match.exact.push(prop.value);
				break;
			case "token":
				match.token ??= [];
				match.token.push(prop.value.toLowerCase());
				break;
			case "prefix":
				match.prefix ??= [];
				match.prefix.push(prop.value);
				break;
			case "substring":
				match.substring ??= [];
				match.substring.push(prop.value);
				break;
			case "glob":
				match.glob ??= [];
				match.glob.push(prop.value.toLowerCase());
				break;
			default:
				unexpected({ ...node, name: prop.name }, node.name);
		}
	}
	return match;
}

function hasMatchers(match: CompiledMatchList): boolean {
	return Boolean(match.exact?.length || match.prefix?.length || match.substring?.length || match.glob?.length);
}

function parseResponsesHeuristic(node: KdlNodeView): CompiledResponsesHeuristic {
	const children = ensureContainer(node, []);
	let include: string[] | undefined;
	let excludePrefix: string[] | undefined;
	let excludeSubstring: string[] | undefined;
	for (const child of children) {
		validateProps(child, []);
		const values = positionalStrings(child);
		if (values.length === 0 || child.children) malformed(child);
		switch (child.name) {
			case "include-prefix":
				if (include) malformed(child);
				include = values;
				break;
			case "exclude-prefix":
				if (excludePrefix) malformed(child);
				excludePrefix = values;
				break;
			case "exclude-substring":
				if (excludeSubstring) malformed(child);
				excludeSubstring = values;
				break;
			default:
				unexpected(child, "openai-responses-heuristic");
		}
	}
	if (!include || !excludePrefix || !excludeSubstring) malformed(node);
	return { includePrefixes: include, excludePrefixes: excludePrefix, excludeSubstrings: excludeSubstring };
}

function parseModelOperations(node: KdlNodeView): CompiledModelOperations {
	const children = ensureContainer(node, ["provider"]);
	const provider = requiredProp(node, "provider");
	const match: CompiledMatchList = {};
	const operations: string[] = [];
	for (const child of children) {
		validateProps(child, []);
		const values = positionalStrings(child);
		if (values.length === 0 || child.children) malformed(child);
		switch (child.name) {
			case "exact":
				match.exact ??= [];
				match.exact.push(...values);
				break;
			case "prefix":
				match.prefix ??= [];
				match.prefix.push(...values);
				break;
			case "operation":
				operations.push(...values);
				break;
			default:
				unexpected(child, "model-operations");
		}
	}
	if (!provider || !hasMatchers(match) || operations.length === 0) malformed(node);
	return { provider, models: match, operations };
}

function parseQuotaTiers(node: KdlNodeView): CompiledQuotaRule {
	const children = ensureContainer(node, ["provider"]);
	const provider = requiredProp(node, "provider");
	const rule: CompiledQuotaRule = { provider, tiers: [], fallbacks: [] };
	for (const child of children) {
		switch (child.name) {
			case "tier": {
				validateProps(child, []);
				const [label, ...models] = positionalStrings(child);
				if (!label || models.length === 0 || child.children) malformed(child);
				rule.tiers.push({ label, models });
				break;
			}
			case "fallback": {
				ensureLeaf(child, ["substring"]);
				const values = positionalStrings(child);
				const substring = requiredProp(child, "substring");
				if (values.length !== 1 || !values[0] || !substring) malformed(child);
				rule.fallbacks.push({ label: values[0], substring });
				break;
			}
			default:
				unexpected(child, "quota-tiers");
		}
	}
	if (!provider || rule.tiers.length === 0) malformed(node);
	return rule;
}

function parseApiRoutes(node: KdlNodeView): CompiledApiRoutes {
	const children = ensureContainer(node, ["provider", "default"]);
	const provider = requiredProp(node, "provider");
	const routes: CompiledApiRoutes = { provider, routes: [] };
	const defaultApi = propString(node, "default");
	if (defaultApi !== undefined) {
		if (!defaultApi) malformed(node);
		routes.default = defaultApi;
	}
	for (const child of children) {
		if (child.name !== "route") unexpected(child, "api-routes");
		if (child.children) malformed(child);
		const values = positionalStrings(child);
		if (values.length !== 1 || !values[0]) malformed(child);
		const match = matchListFromProps(child, ["strip-prefix"]);
		if (!hasMatchers(match)) malformed(child);
		const route: CompiledApiRoutes["routes"][number] = { api: values[0], match };
		const strip = propBool(child, "strip-prefix");
		if (strip !== undefined) route.stripPrefix = strip;
		routes.routes.push(route);
	}
	if (!provider || routes.routes.length === 0) malformed(node);
	return routes;
}

function parseModelLimits(node: KdlNodeView): CompiledModelLimits {
	const children = ensureContainer(node, ["provider"]);
	const provider = requiredProp(node, "provider");
	const rule: CompiledModelLimits = { provider, limits: [] };
	for (const child of children) {
		if (child.name !== "limits") unexpected(child, "model-limits");
		ensureLeaf(child, ["context", "max-tokens"]);
		const values = positionalStrings(child);
		if (values.length !== 1 || !values[0]) malformed(child);
		const context = propInt(child, "context");
		const maxTokens = propInt(child, "max-tokens");
		if (context === undefined && maxTokens === undefined) malformed(child);
		const limit: CompiledModelLimits["limits"][number] = { model: values[0] };
		if (context !== undefined) limit.context = context;
		if (maxTokens !== undefined) limit.maxTokens = maxTokens;
		rule.limits.push(limit);
	}
	if (!provider || rule.limits.length === 0) malformed(node);
	return rule;
}

function parseExcludeModels(node: KdlNodeView): CompiledExcludeModels {
	// Matcher props are repeatable; `matchListFromProps` rejects unknown names.
	if (node.children || node.args.length > 0) malformed(node);
	if (node.props.filter(prop => prop.name === "provider").length !== 1) malformed(node);
	const provider = requiredProp(node, "provider");
	const match = matchListFromProps(node, ["provider"]);
	if (!provider || !hasMatchers(match)) malformed(node);
	return { provider, match };
}

function parsePlanRequirement(node: KdlNodeView): CompiledPlanRequirement {
	const children = ensureContainer(node, ["provider"]);
	const provider = requiredProp(node, "provider");
	const rule: CompiledPlanRequirement = { provider, tiers: [] };
	for (const child of children) {
		if (child.name !== "tier") unexpected(child, "plan-requirement");
		if (child.children) malformed(child);
		const values = positionalStrings(child);
		if (values.length !== 1 || !values[0]) malformed(child);
		const match = matchListFromProps(child, []);
		if (!hasMatchers(match)) malformed(child);
		rule.tiers.push({ tier: values[0], match });
	}
	if (!provider || rule.tiers.length === 0) malformed(node);
	return rule;
}

function parsePricingPeer(node: KdlNodeView): CompiledPricingPeer {
	validateProps(node, ["provider", "peers"]);
	if (!node.children) malformed(node);
	const children = node.children;
	const provider = requiredProp(node, "provider");
	// `peers="a" "b"` — first peer is the property value, the rest positional.
	const peers = [requiredProp(node, "peers"), ...positionalStrings(node)];
	const rule: CompiledPricingPeer = { provider, peers, aliases: [] };
	for (const child of children) {
		if (child.name !== "alias") unexpected(child, "pricing-peer");
		ensureLeaf(child, ["peer-id"]);
		const values = positionalStrings(child);
		const peerId = requiredProp(child, "peer-id");
		if (values.length !== 1 || !values[0] || !peerId) malformed(child);
		rule.aliases.push({ model: values[0], peerId });
	}
	if (!provider || peers.some(peer => !peer)) malformed(node);
	return rule;
}

/** Compiles the runtime behavior source (may be absent → empty vocabulary). */
export function compileBehavior(source: { file: string; text: string } | undefined): CompiledBehavior {
	const behavior: CompiledBehavior = {
		modelOperations: [],
		cursorParameters: [],
		quotaTiers: [],
		hostedDefaults: [],
		apiRoutes: [],
		modelLimits: [],
		excludeModels: [],
		planRequirements: [],
		pricingPeers: [],
	};
	if (!source) return behavior;
	const nodes = parseKdl(source.file, source.text);
	if (nodes.length !== 1) {
		malformed(nodes[0] ?? { name: "behavior", file: source.file, line: 0, args: [], props: [], children: null });
	}
	const root = nodes[0];
	if (root.name !== "behavior" || root.args.length > 0 || root.props.length > 0) malformed(root);
	for (const node of ensureContainer(root, [])) {
		switch (node.name) {
			case "openai-responses-heuristic":
				if (behavior.openaiResponsesHeuristic) malformed(node);
				behavior.openaiResponsesHeuristic = parseResponsesHeuristic(node);
				break;
			case "model-operations":
				behavior.modelOperations.push(parseModelOperations(node));
				break;
			case "cursor-effort": {
				if (behavior.cursorEffort) malformed(node);
				const children = ensureContainer(node, ["family-marker"]);
				const familyMarker = requiredProp(node, "family-marker");
				if (!familyMarker || children.length !== 1 || children[0].name !== "tier" || children[0].children) {
					malformed(node);
				}
				validateProps(children[0], []);
				const tiers = positionalStrings(children[0]);
				if (tiers.length === 0) malformed(node);
				behavior.cursorEffort = { familyMarker, tiers };
				break;
			}
			case "cursor-model-parameter": {
				ensureLeaf(node, ["model", "id", "value"]);
				const model = requiredProp(node, "model");
				const id = requiredProp(node, "id");
				const value = requiredProp(node, "value");
				if (!model || !id || !value || node.args.length > 0) malformed(node);
				behavior.cursorParameters.push({ model, id, value });
				break;
			}
			case "quota-tiers":
				behavior.quotaTiers.push(parseQuotaTiers(node));
				break;
			case "hosted-default": {
				ensureLeaf(node, ["provider", "model"]);
				const provider = requiredProp(node, "provider");
				const model = requiredProp(node, "model");
				if (!provider || !model || node.args.length > 0) malformed(node);
				behavior.hostedDefaults.push({ provider, model });
				break;
			}
			case "api-routes":
				behavior.apiRoutes.push(parseApiRoutes(node));
				break;
			case "model-limits":
				behavior.modelLimits.push(parseModelLimits(node));
				break;
			case "exclude-models":
				behavior.excludeModels.push(parseExcludeModels(node));
				break;
			case "plan-requirement":
				behavior.planRequirements.push(parsePlanRequirement(node));
				break;
			case "pricing-peer":
				behavior.pricingPeers.push(parsePricingPeer(node));
				break;
			default:
				unexpected(node, "behavior");
		}
	}
	return behavior;
}
