import type { CatalogPolicyInputs } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";
import { classifyModel } from "./taxonomy";

/**
 * Anthropic model ids the API accepts as the advisor-tool advisor for
 * `model`, strongest first, authored on the `advisor-models` catalog axis.
 * Empty when no rule assigns pairings (the model, host or provider does not
 * support the advisor tool).
 */
export function advisorModels(model: CatalogPolicyInputs): readonly string[] {
	const value = resolveCatalogPolicy(model).advisorModels;
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Resolve a configured advisor (`fable`, `opus`, `sonnet`, `haiku`, `mythos`,
 * or a full model id) against `model`'s accepted advisors. A family alias
 * picks the strongest accepted member of that family; a full id must itself
 * be accepted. Undefined when the pairing is not accepted.
 */
export function resolveAdvisorModel(model: CatalogPolicyInputs, configured: string): string | undefined {
	const wanted = configured.trim().toLowerCase();
	if (!wanted) return undefined;
	const accepted = advisorModels(model);
	if (accepted.includes(wanted)) return wanted;
	return accepted.find(id => classifyModel("anthropic", id).family === wanted);
}
