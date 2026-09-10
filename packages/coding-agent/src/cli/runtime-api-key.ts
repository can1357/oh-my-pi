import type { Args } from "./args";
import { parseModelString } from "../config/model-resolver";

/**
 * AuthStorage keys runtime overrides by exact provider id (catalog spelling).
 * CLI selectors are case-insensitive for lookup, so normalize before install.
 */
function normalizeCliProviderId(provider: string): string {
	return provider.trim().toLowerCase();
}

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
 * `--provider` only claims the key when `--model` is also present (the form it
 * scopes). `--provider` with `--models` alone is ignored by session options, and
 * `--provider` alone stays unbound so main.ts can enforce `--api-key requires a
 * model`.
 */
export function resolveCliRuntimeApiKeyProvider(
	parsed: Pick<Args, "provider" | "model" | "models">,
): string | undefined {
	if (parsed.provider?.trim()) {
		if (!parsed.model?.trim()) return undefined;
		return normalizeCliProviderId(parsed.provider);
	}
	if (parsed.model?.trim()) {
		const parsedModel = parseModelString(parsed.model.trim());
		if (parsedModel?.provider) return normalizeCliProviderId(parsedModel.provider);
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
		providers.add(normalizeCliProviderId(parsedModel.provider));
	}
	if (providers.size === 1) {
		const [only] = providers;
		return only;
	}
	return undefined;
}
