import type { Args } from "./args";
import { parseModelString } from "../config/model-resolver";

/**
 * Provider to bind for a CLI `--api-key` before ModelRegistry construction.
 * Credential-scoped catalogs (e.g. grokbot) hash the renewer into the startup
 * cache id; installing the override after model resolution leaves only offline
 * seeds and `--provider X --model <live-only-id>` exits with "Model not found".
 *
 * Multi-provider `--models` scopes are intentionally unbound here: the first
 * selector is not a safe key owner before the session picks a concrete model.
 */
export function resolveCliRuntimeApiKeyProvider(
	parsed: Pick<Args, "provider" | "model" | "models">,
): string | undefined {
	if (parsed.provider?.trim()) return parsed.provider.trim();
	if (parsed.model?.trim()) {
		const parsedModel = parseModelString(parsed.model.trim());
		if (parsedModel?.provider) return parsedModel.provider;
	}
	const providers = new Set<string>();
	for (const pattern of parsed.models ?? []) {
		const parsedModel = parseModelString(pattern.trim());
		if (parsedModel?.provider) providers.add(parsedModel.provider);
	}
	if (providers.size === 1) {
		const [only] = providers;
		return only;
	}
	return undefined;
}
