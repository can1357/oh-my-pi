/**
 * `disabledModels` matching: a model-level denylist applied on top of
 * `enabledModels` and `disabledProviders`.
 *
 * Rules are deliberately conservative: an exact `provider/modelId` (case-insensitive)
 * or an explicit glob (`*`, `?`, `[`) matched against `provider/modelId` and the bare
 * model id, exactly like `enabledModels` globs. No fuzzy, substring, bare-id, or
 * role-alias matching. A trailing valid `:thinkingLevel` on a rule is ignored.
 *
 * Models are matched by identity, so a rule for a base model also covers every
 * selector suffix resolution strips: thinking levels (`:high`) and `@upstream`
 * routing. A rule that itself contains `@upstream` is matched literally.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { applyOpenRouterRoutingVariant } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getBundledModels, getBundledProviders, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import {
	MAX_THINKING_SUFFIX_OPTIONS,
	splitThinkingSuffix,
	splitUpstreamRouting,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { Settings } from "./settings";
import { getOpenRouterFallbackModelIds } from "./openrouter-model-ids";
import { cfgDisabledModels } from "./model-settings";

type ModelIdentity = Pick<Model<Api>, "provider" | "id">;

interface CompiledRule {
	/** The rule as the user wrote it; diagnostics quote this verbatim. */
	rule: string;
	matches(fullId: string, id: string): boolean;
	/** Whether the rule itself names a bare (provider-less) selector id: an exact rule's id, or a glob without a provider. */
	matchesBareId(id: string): boolean;
}

/**
 * Resolves a model to the first `disabledModels` rule that matches it. An identity
 * with an empty provider is a bare selector id: it matches when a rule names that id
 * itself (see {@link CompiledRule.matchesBareId}).
 */
export type DisabledModelMatcher = (model: ModelIdentity) => string | undefined;

/** Matcher for an empty `disabledModels`; callers compare by identity to skip filtering. */
export const NO_DISABLED_MODELS: DisabledModelMatcher = () => undefined;

/** `notice` source of a disabledModels warning; print mode writes these to stderr. */
export const DISABLED_MODELS_NOTICE_SOURCE = "disabled-models";

/** A selector that names a denied model, with the matching rule. */
export interface DisabledModelSelection {
	/** `provider/id` (or bare id) the selector names, suffixes stripped. */
	label: string;
	rule: string;
}

function compileRule(rule: string): CompiledRule | undefined {
	const trimmed = rule.trim();
	if (!trimmed) return undefined;
	const { base, level } = splitThinkingSuffix(trimmed, -1, MAX_THINKING_SUFFIX_OPTIONS);
	const literal = trimmed.toLowerCase();
	const stripped = (level === undefined ? trimmed : base).toLowerCase();
	const slash = stripped.indexOf("/");
	if (/[*?[]/.test(stripped)) {
		const glob = new Bun.Glob(stripped);
		return {
			rule,
			matches: (fullId, id) => glob.match(fullId) || glob.match(id),
			// A bare id has no provider, so a provider glob such as `openai/*` never matches it here;
			// `disabledSelectorRule` checks a bare id against the catalog models with that id instead.
			matchesBareId: id => glob.match(id),
		};
	}
	// Exact rules name a provider; a bare rule matches nothing (no fuzzy or bare-id deny).
	if (slash <= 0) return undefined;
	const ruleId = stripped.slice(slash + 1);
	return {
		rule,
		matches: fullId => fullId === stripped || fullId === literal,
		matchesBareId: id => id === ruleId,
	};
}

/** Compiles `disabledModels` rules into a matcher returning the first matching rule. */
export function compileDisabledModels(rules: readonly string[]): DisabledModelMatcher {
	const compiled = rules.map(compileRule).filter(rule => rule !== undefined);
	if (compiled.length === 0) return NO_DISABLED_MODELS;
	return model => {
		const provider = model.provider.toLowerCase();
		const id = model.id.toLowerCase();
		if (provider === "") return compiled.find(rule => rule.matchesBareId(id))?.rule;
		// An OpenRouter routing variant (`x:floor`, dated `x-20250101`) is a clone of
		// its base model, so a rule for the base also denies it.
		const ids = provider === "openrouter" ? getOpenRouterFallbackModelIds(id) : [id];
		for (const candidate of ids) {
			const fullId = `${provider}/${candidate}`;
			const rule = compiled.find(entry => entry.matches(fullId, candidate))?.rule;
			if (rule !== undefined) return rule;
		}
		return undefined;
	};
}

/** `disabledModels` compiled once per settings value. */
const cfgDisabledModelMatcher = cfgDisabledModels.map(compileDisabledModels);

/** The `disabledModels` matcher for `settings`, resolved for its working directory's path scopes. */
export function disabledModelMatcher(settings: Settings | undefined): DisabledModelMatcher {
	return settings ? cfgDisabledModelMatcher.get(settings) : NO_DISABLED_MODELS;
}

/** The `disabledModels` rule that denies `model` under `settings`, if any. */
export function disabledModelRule(model: ModelIdentity, settings: Settings | undefined): string | undefined {
	return disabledModelMatcher(settings)(model);
}

/** `models` without the ones `disabledModels` denies under `settings`; the same array when none are configured. */
export function withoutDisabledModels<T extends ModelIdentity>(models: T[], settings: Settings | undefined): T[] {
	const isDisabled = disabledModelMatcher(settings);
	return isDisabled === NO_DISABLED_MODELS ? models : models.filter(model => isDisabled(model) === undefined);
}

/** A model registry's whole catalog: its bundled, custom and discovered models. */
type ModelCatalog = () => readonly ModelIdentity[];

/** The catalogs registered under one matcher; each registry counts once and is held weakly. */
interface RegisteredCatalogs {
	known: WeakSet<ModelCatalog>;
	live: Set<WeakRef<ModelCatalog>>;
}

/**
 * The catalogs of every model registry that filters with each matcher: what a bare selector can
 * name under that matcher's rules. Registries that share settings all count, so the answer does
 * not depend on which of them filtered last; a registry that is gone takes its catalog with it.
 */
const catalogsByMatcher = new WeakMap<DisabledModelMatcher, RegisteredCatalogs>();

/**
 * Adds a registry's `catalog` to the models a bare selector can name under `matcher`. The model
 * registry calls this each time it resolves its matcher; a repeat call costs one lookup.
 */
export function registerDisabledModelCatalog(matcher: DisabledModelMatcher, catalog: ModelCatalog): void {
	if (matcher === NO_DISABLED_MODELS) return;
	let registered = catalogsByMatcher.get(matcher);
	if (!registered) {
		registered = { known: new WeakSet(), live: new Set() };
		catalogsByMatcher.set(matcher, registered);
	}
	if (registered.known.has(catalog)) return;
	registered.known.add(catalog);
	registered.live.add(new WeakRef(catalog));
}

/** The bundled catalog, flattened on first use. */
let bundledCatalog: readonly ModelIdentity[] | undefined;

/** The rule that denies a model in `models` whose id is exactly `id` (lower-case), if any. */
function ruleDenyingId(
	models: readonly ModelIdentity[],
	id: string,
	matcher: DisabledModelMatcher,
): string | undefined {
	for (const model of models) {
		if (model.id.toLowerCase() !== id) continue;
		const rule = matcher(model);
		if (rule !== undefined) return rule;
	}
	return undefined;
}

/**
 * The rule that denies a catalog model whose id is exactly `id` (lower-case), if any: the bundled
 * catalog, then the catalog of every live registry that filters with `matcher`.
 */
function deniedCatalogModelRule(id: string, matcher: DisabledModelMatcher): string | undefined {
	bundledCatalog ??= getBundledProviders().flatMap(provider =>
		isGeneratedProvider(provider) ? getBundledModels(provider) : [],
	);
	const bundledRule = ruleDenyingId(bundledCatalog, id, matcher);
	if (bundledRule !== undefined) return bundledRule;
	const live = catalogsByMatcher.get(matcher)?.live;
	for (const ref of live ?? []) {
		const catalog = ref.deref();
		if (!catalog) {
			live?.delete(ref);
			continue;
		}
		const rule = ruleDenyingId(catalog(), id, matcher);
		if (rule !== undefined) return rule;
	}
	return undefined;
}

/**
 * The denied model a selector names, if any. The selector is checked with and
 * without its `@upstream` routing and `:thinkingLevel` suffixes, so `x@up:high`
 * is refused by a rule for `x`. Role aliases must be expanded by the caller first.
 *
 * A bare id (no provider) is checked only when `allowed` is given, and only when no
 * allowed model carries exactly that id: an allowed provider with the same id wins (as
 * with `disabledProviders`). It is then denied when a rule names the id itself (an exact
 * rule's id, or a glob without a provider) or denies a catalog model with exactly that id: the
 * bundled catalog, or the models of a registry that filters with these settings (custom and
 * discovered models included). A fuzzy selector that is no model's id (`sonnet` under `openai/*`)
 * is not denied: it resolves over the allowed list, which holds no denied model.
 */
export function disabledSelectorRule(
	selector: string,
	settings: Settings | undefined,
	allowed?: readonly ModelIdentity[],
): DisabledModelSelection | undefined {
	const matcher = disabledModelMatcher(settings);
	if (matcher === NO_DISABLED_MODELS) return undefined;
	const trimmed = selector.trim();
	const routed = splitUpstreamRouting(trimmed)?.base ?? trimmed;
	const forms = new Set([
		trimmed,
		routed,
		splitThinkingSuffix(trimmed, -1, MAX_THINKING_SUFFIX_OPTIONS).base,
		splitThinkingSuffix(routed, -1, MAX_THINKING_SUFFIX_OPTIONS).base,
	]);
	for (const form of forms) {
		const slash = form.indexOf("/");
		if (slash > 0) {
			const rule = matcher({ provider: form.slice(0, slash), id: form.slice(slash + 1) });
			if (rule !== undefined) return { label: form, rule };
			continue;
		}
		if (!form || !allowed) continue;
		const id = form.toLowerCase();
		if (allowed.some(model => model.id.toLowerCase() === id)) continue;
		const rule = matcher({ provider: "", id: form }) ?? deniedCatalogModelRule(id, matcher);
		if (rule !== undefined) return { label: form, rule };
	}
	return undefined;
}

/** Actionable diagnostic for a model (or `provider/id` label) denied by `rule`. */
export function formatDisabledModelError(model: ModelIdentity | string, rule: string): string {
	const label = typeof model === "string" ? model : `${model.provider}/${model.id}`;
	return `Model "${label}" is disabled by disabledModels rule "${rule}". Remove or narrow that rule to use it.`;
}

/** Request options that change which catalog identity a request names. */
export interface WireRoutingOptions {
	openrouterVariant?: string;
}

/**
 * The catalog identity a request for `model` under `options` names that `isDisabled` denies:
 * the logical id, or the OpenRouter routing-variant id (`x:floor`). Provider-internal wire ids
 * (effort routes, `requestModelId`, Fireworks/firepass/cline-pass transforms) are not catalog
 * identities and are not matched on their own: denying the catalog model blocks every route to it.
 */
export function deniedWireIdentity(
	model: Model<Api>,
	options: WireRoutingOptions | undefined,
	isDisabled: DisabledModelMatcher,
): { label: ModelIdentity; rule: string } | undefined {
	const variantId =
		model.compat !== undefined && "wireModelIdMode" in model.compat && model.compat.wireModelIdMode === "openrouter"
			? applyOpenRouterRoutingVariant(model.id, options?.openrouterVariant)
			: model.id;
	for (const id of new Set([model.id, variantId])) {
		const label = { provider: model.provider, id };
		const rule = isDisabled(label);
		if (rule !== undefined) return { label, rule };
	}
	return undefined;
}
