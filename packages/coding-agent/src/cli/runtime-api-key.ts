import type { Args } from "./args";
import { parseModelString } from "../config/model-resolver";

/**
 * Provider to bind for a CLI `--api-key` before ModelRegistry construction.
 * Credential-scoped catalogs (e.g. grokbot) hash the renewer into the startup
 * cache id; installing the override after model resolution leaves only offline
 * seeds and `--provider X --model <live-only-id>` exits with "Model not found".
 *
 * Multi-provider `--models` scopes and any bare (unqualified) selector are
 * intentionally unbound: ownership is indeterminate until a concrete model is
 * selected. A bare `--model` also wins over `--models` in session options, so
 * it must not fall through to deriving ownership from the secondary scope.
 *
 * `--provider` alone (no `--model` / `--models`) stays unbound so main.ts can
 * still enforce `--api-key requires a model`.
 */
export function resolveCliRuntimeApiKeyProvider(
	parsed: Pick<Args, "provider" | "model" | "models">,
): string | undefined {
	const hasModelSelector =
		Boolean(parsed.model?.trim()) || (parsed.models ?? []).some(pattern => pattern.trim().length > 0);
	if (parsed.provider?.trim()) {
		if (!hasModelSelector) return undefined;
		return parsed.provider.trim();
	}
	if (parsed.model?.trim()) {
		const parsedModel = parseModelString(parsed.model.trim());
		if (parsedModel?.provider) return parsedModel.provider;
		// Bare --model takes precedence over --models; do not consult models.
		return undefined;
	}
	const providers = new Set<string>();
	for (const pattern of parsed.models ?? []) {
		const trimmed = pattern.trim();
		if (!trimmed) continue;
		const parsedModel = parseModelString(trimmed);
		// Bare selectors (no provider/) make early key ownership indeterminate.
		if (!parsedModel?.provider) return undefined;
		providers.add(parsedModel.provider);
	}
	if (providers.size === 1) {
		const [only] = providers;
		return only;
	}
	return undefined;
}
