/**
 * Compiles the catalog-entry half of `rules/providers/*.kdl` into
 * {@link CompiledProvider} records keyed by provider id.
 *
 * A provider file's root `provider "<id>"` node mixes two vocabularies: the
 * cascade (selectors + compat axes, `compile-cascade.ts`) and the catalog
 * entry nodes handled here — `default-model`, `env`, the boolean flags,
 * `discovery`, `kind-apis`, and `seed`. A file that declares `default-model`
 * is a catalog provider; a file without it is wire-compat only and may not
 * carry any other catalog node.
 *
 * Seed rows *define* models rather than patching them. Wire and thinking axis
 * directives inside a seed `model` block become the row's explicit `compat` /
 * `thinking` overrides (same vocabulary as the cascade, validated against the
 * row's API); catalog axes are rejected because they stay rule-owned.
 */
import { API_COMPAT_RECORDS } from "../../src/compat/axes";
import type {
	CompiledProvider,
	CompiledProviderDiscovery,
	CompiledSeed,
	CompiledSeedModel,
	SeedBundlePolicy,
} from "../../src/compat/types";
import {
	KIND_API_KINDS,
	RUNNER_APIS,
	type Api,
	type KindApiKind,
	type KnownApi,
	type TokenCost,
} from "../../src/types";
import { axisFor, collectAxis, type RuleAxes } from "./compile-axes";
import {
	CompatCompileError,
	type KdlNodeView,
	malformed,
	parseKdl,
	positionalStrings,
	propBool,
	propString,
	requiredProp,
	unexpected,
	validateProps,
} from "./kdl-reader";

const KNOWN_APIS = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"gitlab-duo-agent",
	"devin-agent",
	"apple-foundation-models",
	"grokbot-sand",
] as const satisfies readonly KnownApi[];
type _MissingKnownApis = Exclude<KnownApi, (typeof KNOWN_APIS)[number]>;
true satisfies _MissingKnownApis extends never ? true : ["KNOWN_APIS is missing KnownApi values", _MissingKnownApis];

const BUNDLE_POLICIES = ["always", "fallback", "empty"] as const satisfies readonly SeedBundlePolicy[];
const DEFAULT_BUNDLE: SeedBundlePolicy = "always";
const SEED_PROPS = ["api", "base-url", "bundle", "precedence"] as const;
const MODEL_PROPS = ["name", "api", "base-url"] as const;
const COST_PROPS = ["input", "output", "cache-read", "cache-write"] as const;
const LIMIT_PROPS = ["context", "max-tokens"] as const;
const DISCOVERY_PROPS = ["label", "oauth-provider", "allow-unauthenticated"] as const;

/** Provider-root node names owned by this compiler; the cascade compiler skips them. */
export const PROVIDER_CATALOG_NODES: ReadonlySet<string> = new Set([
	"default-model",
	"env",
	"allow-unauthenticated",
	"dynamic-models-authoritative",
	"skip-cross-provider-reference-fills",
	"discovery",
	"kind-apis",
	"seed",
]);

interface SeedDefaults {
	api?: Api;
	baseUrl?: string;
}

function isBundlePolicy(value: string): value is SeedBundlePolicy {
	return (BUNDLE_POLICIES as readonly string[]).includes(value);
}

function requiredName(node: KdlNodeView): string {
	if (node.args.length !== 1 || typeof node.args[0] !== "string" || !node.args[0]) malformed(node);
	return node.args[0];
}

function validateApi(node: KdlNodeView, api: string): Api {
	if (!KNOWN_APIS.some(value => value === api) && !RUNNER_APIS.some(value => value === api)) {
		throw new CompatCompileError(node.file, node.line, `unknown api \`${api}\``);
	}
	return api;
}

function propApi(node: KdlNodeView): Api | undefined {
	const api = propString(node, "api");
	return api === undefined ? undefined : validateApi(node, api);
}

function propNumber(node: KdlNodeView, name: string): number | undefined {
	const prop = node.props.find(entry => entry.name === name);
	if (!prop) return undefined;
	if (typeof prop.value !== "number" || !Number.isFinite(prop.value) || prop.value < 0) malformed(node);
	return prop.value;
}

function singleBoolean(node: KdlNodeView): boolean {
	validateProps(node, []);
	if (node.args.length !== 1 || typeof node.args[0] !== "boolean" || node.children) malformed(node);
	return node.args[0];
}

function stringList(node: KdlNodeView): string[] {
	validateProps(node, []);
	if (node.children) malformed(node);
	const values = positionalStrings(node);
	if (values.length === 0) malformed(node);
	return values;
}

function parseCost(node: KdlNodeView): TokenCost {
	validateProps(node, COST_PROPS);
	if (node.args.length > 0 || node.children) malformed(node);
	const input = propNumber(node, "input");
	const output = propNumber(node, "output");
	const cacheRead = propNumber(node, "cache-read");
	const cacheWrite = propNumber(node, "cache-write");
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
		malformed(node);
	}
	return { input, output, cacheRead, cacheWrite };
}

function parseInput(node: KdlNodeView): ("text" | "image")[] {
	const input: ("text" | "image")[] = [];
	for (const value of stringList(node)) {
		if ((value !== "text" && value !== "image") || input.includes(value)) malformed(node);
		input.push(value);
	}
	return input;
}

function parseModel(node: KdlNodeView, provider: string, defaults: SeedDefaults): CompiledSeedModel {
	validateProps(node, MODEL_PROPS);
	const id = requiredName(node);
	const name = requiredProp(node, "name");
	const api = propApi(node) ?? defaults.api;
	const baseUrl = propString(node, "base-url") ?? defaults.baseUrl;
	if (api === undefined || baseUrl === undefined) {
		throw new CompatCompileError(node.file, node.line, `model \`${id}\` has no api/base-url (own or seed default)`);
	}
	if (!node.children) malformed(node);
	const records = API_COMPAT_RECORDS[api] ?? [];

	let reasoning: boolean | undefined;
	let input: ("text" | "image")[] | undefined;
	let cost: TokenCost | undefined;
	let limits: { contextWindow: number | null; maxTokens: number | null } | undefined;
	let supportsTools: boolean | undefined;
	const axes: RuleAxes = { wire: {}, thinking: {}, catalog: {} };
	for (const child of node.children) {
		switch (child.name) {
			case "reasoning":
				if (reasoning !== undefined) malformed(child);
				reasoning = singleBoolean(child);
				break;
			case "input":
				if (input !== undefined) malformed(child);
				input = parseInput(child);
				break;
			case "cost":
				if (cost !== undefined) malformed(child);
				cost = parseCost(child);
				break;
			case "limits":
				if (limits !== undefined) malformed(child);
				validateProps(child, LIMIT_PROPS);
				if (child.args.length > 0 || child.children) malformed(child);
				limits = {
					contextWindow: propNumber(child, "context") ?? null,
					maxTokens: propNumber(child, "max-tokens") ?? null,
				};
				break;
			case "supports-tools":
				if (supportsTools !== undefined) malformed(child);
				supportsTools = singleBoolean(child);
				break;
			default: {
				const axis = axisFor(child);
				if (axis.set === "catalog") {
					throw new CompatCompileError(
						child.file,
						child.line,
						`catalog axis \`${child.name}\` is rule-owned; declare it in the provider's cascade block`,
					);
				}
				if (axis.set === "wire" && !axis.records?.some(record => records.includes(record))) {
					throw new CompatCompileError(
						child.file,
						child.line,
						`wire axis \`${child.name}\` does not apply to api \`${api}\``,
					);
				}
				collectAxis(child, axes);
			}
		}
	}
	if (reasoning === undefined || input === undefined || cost === undefined || limits === undefined) {
		throw new CompatCompileError(
			node.file,
			node.line,
			`model \`${id}\` must declare reasoning, input, cost, and limits`,
		);
	}
	const hasThinking = Object.keys(axes.thinking).length > 0;
	if (hasThinking && (axes.thinking.mode === undefined || axes.thinking.efforts === undefined)) {
		throw new CompatCompileError(
			node.file,
			node.line,
			`model \`${id}\` thinking overrides need both thinking-mode and thinking-efforts`,
		);
	}
	return {
		id,
		name,
		api,
		provider,
		baseUrl,
		reasoning,
		input,
		...(supportsTools !== undefined && { supportsTools }),
		cost,
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
		...(hasThinking && { thinking: axes.thinking }),
		...(Object.keys(axes.wire).length > 0 && { compat: axes.wire }),
	};
}

interface ParsedSeed {
	seed: CompiledSeed;
	modelsFrom?: string;
	node: KdlNodeView;
}

function parseSeed(node: KdlNodeView, provider: string): ParsedSeed {
	validateProps(node, SEED_PROPS);
	if (node.args.length > 0 || !node.children) malformed(node);
	const bundle = propString(node, "bundle");
	if (bundle !== undefined && !isBundlePolicy(bundle)) {
		throw new CompatCompileError(node.file, node.line, `seed bundle must be one of "${BUNDLE_POLICIES.join('"|"')}"`);
	}
	const precedence = propString(node, "precedence") ?? "upstream";
	if (precedence !== "upstream" && precedence !== "seed") malformed(node);
	const defaults: SeedDefaults = { api: propApi(node), baseUrl: propString(node, "base-url") };
	const models: CompiledSeedModel[] = [];
	let modelsFrom: string | undefined;
	for (const child of node.children) {
		switch (child.name) {
			case "model": {
				const model = parseModel(child, provider, defaults);
				if (models.some(own => own.id === model.id)) {
					throw new CompatCompileError(child.file, child.line, `duplicate seed model \`${model.id}\``);
				}
				models.push(model);
				break;
			}
			case "models-from":
				if (modelsFrom !== undefined) malformed(child);
				modelsFrom = requiredName(child);
				validateProps(child, []);
				if (child.children) malformed(child);
				break;
			default:
				unexpected(child, "seed");
		}
	}
	if (models.length === 0 && modelsFrom === undefined) malformed(node);
	return { seed: { bundle: bundle ?? DEFAULT_BUNDLE, precedence, models }, modelsFrom, node };
}

function parseKindApis(node: KdlNodeView): Partial<Record<KindApiKind, Api>> {
	validateProps(node, []);
	if (node.args.length > 0 || !node.children || node.children.length === 0) malformed(node);
	const kindApis: Partial<Record<KindApiKind, Api>> = {};
	for (const child of node.children) {
		const kind = KIND_API_KINDS.find(value => value === child.name);
		if (kind === undefined) unexpected(child, "kind-apis");
		if (kindApis[kind] !== undefined) malformed(child);
		validateProps(child, []);
		if (child.children) malformed(child);
		kindApis[kind] = validateApi(child, requiredName(child));
	}
	return kindApis;
}

function parseDiscovery(node: KdlNodeView): CompiledProviderDiscovery {
	validateProps(node, DISCOVERY_PROPS);
	if (node.args.length > 0) malformed(node);
	const discovery: CompiledProviderDiscovery = { label: requiredProp(node, "label") };
	const oauthProvider = propString(node, "oauth-provider");
	if (oauthProvider !== undefined) discovery.oauthProvider = oauthProvider;
	const allowUnauthenticated = propBool(node, "allow-unauthenticated");
	if (allowUnauthenticated !== undefined) discovery.allowUnauthenticated = allowUnauthenticated;
	for (const child of node.children ?? []) {
		if (child.name !== "env") unexpected(child, "discovery");
		if (discovery.envVars !== undefined) malformed(child);
		discovery.envVars = stringList(child);
	}
	return discovery;
}

interface ParsedProvider {
	provider: CompiledProvider;
	seed?: ParsedSeed;
	node: KdlNodeView;
}

/** Reads the catalog nodes of one root `provider` node; `undefined` when it is wire-compat only. */
function parseProvider(node: KdlNodeView): ParsedProvider | undefined {
	const id = requiredName(node);
	const provider: CompiledProvider = { id, defaultModel: "" };
	let seed: ParsedSeed | undefined;
	let sawCatalogNode = false;
	let defaultModel: string | undefined;
	for (const child of node.children ?? []) {
		if (!PROVIDER_CATALOG_NODES.has(child.name)) continue;
		sawCatalogNode = true;
		switch (child.name) {
			case "default-model":
				if (defaultModel !== undefined) malformed(child);
				defaultModel = requiredName(child);
				validateProps(child, []);
				if (child.children) malformed(child);
				break;
			case "env":
				if (provider.envVars !== undefined) malformed(child);
				provider.envVars = stringList(child);
				break;
			case "allow-unauthenticated":
				if (provider.allowUnauthenticated !== undefined) malformed(child);
				provider.allowUnauthenticated = singleBoolean(child);
				break;
			case "dynamic-models-authoritative":
				if (provider.dynamicModelsAuthoritative !== undefined) malformed(child);
				provider.dynamicModelsAuthoritative = singleBoolean(child);
				break;
			case "skip-cross-provider-reference-fills":
				if (provider.skipCrossProviderReferenceFills !== undefined) malformed(child);
				provider.skipCrossProviderReferenceFills = singleBoolean(child);
				break;
			case "discovery":
				if (provider.discovery !== undefined) malformed(child);
				provider.discovery = parseDiscovery(child);
				break;
			case "kind-apis":
				if (provider.kindApis !== undefined) malformed(child);
				provider.kindApis = parseKindApis(child);
				break;
			case "seed":
				if (seed !== undefined) malformed(child);
				seed = parseSeed(child, id);
				break;
		}
	}
	if (defaultModel === undefined) {
		if (sawCatalogNode) {
			throw new CompatCompileError(
				node.file,
				node.line,
				`provider \`${id}\` has catalog nodes but no default-model`,
			);
		}
		return undefined;
	}
	provider.defaultModel = defaultModel;
	if (seed !== undefined) provider.seed = seed.seed;
	return { provider, seed, node };
}

/** Compiles the catalog entries declared by `providers/*.kdl` (`file` is rules-relative). */
export function compileProviders(sources: readonly { file: string; text: string }[]): Record<string, CompiledProvider> {
	const parsed: ParsedProvider[] = [];
	for (const { file, text } of sources) {
		for (const node of parseKdl(file, text)) {
			if (node.name !== "provider") continue;
			const entry = parseProvider(node);
			if (entry === undefined) continue;
			if (parsed.some(other => other.provider.id === entry.provider.id)) {
				throw new CompatCompileError(file, node.line, `duplicate catalog provider \`${entry.provider.id}\``);
			}
			parsed.push(entry);
		}
	}
	for (const entry of parsed) {
		const seed = entry.seed;
		if (seed?.modelsFrom === undefined) continue;
		const source = parsed.find(other => other.provider.id === seed.modelsFrom);
		if (!source?.seed || source.seed.modelsFrom !== undefined) {
			throw new CompatCompileError(
				seed.node.file,
				seed.node.line,
				`models-from \`${seed.modelsFrom}\` must name a provider seed with its own model rows`,
			);
		}
		for (const model of source.seed.seed.models) {
			if (seed.seed.models.some(own => own.id === model.id)) {
				throw new CompatCompileError(
					seed.node.file,
					seed.node.line,
					`seed for \`${entry.provider.id}\` redeclares inherited model \`${model.id}\``,
				);
			}
			seed.seed.models.push({ ...model, provider: entry.provider.id });
		}
	}
	parsed.sort((a, b) => (a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0));
	const providers: Record<string, CompiledProvider> = {};
	for (const entry of parsed) providers[entry.provider.id] = entry.provider;
	return providers;
}

/**
 * Source of the committed `src/compat/provider-ids.ts`: the `KnownProvider`
 * union derived from the compiled catalog entries, so the descriptor table and
 * `@oh-my-pi/pi-ai`'s registry keep typed provider ids without importing the
 * JSON as a const.
 */
export function renderProviderIds(providers: Readonly<Record<string, CompiledProvider>>): string {
	const ids = Object.keys(providers).sort();
	return [
		"// Generated by `bun run gen:compat` from `src/compat/rules/providers/*.kdl`; do not edit.",
		"",
		"/** Every chat-model provider with a catalog entry (`default-model` in its provider rules). */",
		`export type KnownProvider =\n${ids.map(id => `\t| ${JSON.stringify(id)}`).join("\n")};`,
		"",
	].join("\n");
}
