import { KIND_ROLE_IDS } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { type ModelStringParseOptions, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Parse a trimmed fallback selector without requiring provider discovery. */
export function parseRetryFallbackModelString(
	selector: string,
	isLiteralModelId?: ModelStringParseOptions["isLiteralModelId"],
) {
	const parsed = parseModelString(selector, { allowMaxSuffix: true, allowAutoAlias: true, isLiteralModelId });
	return parsed?.provider.trim() && parsed.id.trim() ? parsed : undefined;
}

/** Reject malformed configuration before writes or layer replacement; catalog checks remain runtime warnings. */
export function validateRetryFallbackChainsSetting(value: unknown): void {
	// Missing/null settings are unset, as with other registry validators.
	if (value === undefined || value === null) return;
	if (!isRecord(value)) {
		throw new Error("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
	}

	for (const [key, chain] of Object.entries(value)) {
		if (!key.trim() || (key.includes("/") && !parseRetryFallbackModelString(key.trim()))) {
			throw new Error(`Invalid retry.fallbackChains key: ${JSON.stringify(key)}`);
		}
		if (!Array.isArray(chain)) {
			throw new Error(`retry.fallbackChains[${JSON.stringify(key)}] must be an array of selector strings.`);
		}
		// Model-kind roles already accept role aliases, comma lists, and fuzzy patterns.
		const isKindRole = KIND_ROLE_IDS.some(role => role === key);
		for (const [index, selector] of chain.entries()) {
			const location = `retry.fallbackChains[${JSON.stringify(key)}][${index}]`;
			if (typeof selector !== "string") throw new Error(`${location} must be a selector string.`);
			const trimmed = selector.trim();
			if (!trimmed || (!isKindRole && !parseRetryFallbackModelString(trimmed))) {
				throw new Error(
					`Invalid ${location}: expected ${isKindRole ? "a model pattern" : "provider/model-id or provider/*"}, got ${JSON.stringify(selector)}.`,
				);
			}
		}
	}
}
