import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { $env } from "@oh-my-pi/pi-utils";
import type { Api, Model, ProviderSessionState } from "../types";
import { isFoundryEnabled } from "../utils/foundry";

/** Root key for Anthropic's per-session provider state. */
export const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";
/** Caller-map anchor for session-scoped opaque injected clients. */
export const ANTHROPIC_OPAQUE_CLIENT_ANCHOR_KEY = "anthropic-opaque-clients";

/** Normalize an Anthropic base URL to its origin path without `/v1`. */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return undefined;
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

/** Resolve the endpoint for a first-party Anthropic model without loading its provider implementation. */
export function resolveDirectAnthropicBaseUrl(model: Model<Api>): string {
	if (isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) return foundryBaseUrl;
	}
	const configured = normalizeAnthropicBaseUrl(model.baseUrl);
	if (configured && !isOfficialAnthropicApiUrl(configured)) return configured;
	return normalizeAnthropicBaseUrl($env.ANTHROPIC_BASE_URL) ?? configured ?? "https://api.anthropic.com";
}

/**
 * Whether a request to `model` reaches the official endpoint its compat was built for. `compat.officialEndpoint`
 * classifies the configured `baseUrl`, but a first-party Anthropic model is rerouted at request time by
 * `ANTHROPIC_BASE_URL` or Foundry's `FOUNDRY_BASE_URL` without rebuilding compat. Gates official-only host
 * limits such as the catalog's inline image byte and image count budgets.
 */
export function reachesOfficialEndpoint(model: Model<Api>): boolean {
	const compat = model.compat;
	if (!compat || !("officialEndpoint" in compat) || !compat.officialEndpoint) return false;
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return true;
	return isOfficialAnthropicApiUrl(resolveDirectAnthropicBaseUrl(model));
}

/** Build the endpoint-and-model-scoped Anthropic session-state key. */
export function anthropicProviderSessionStateKey(baseUrl: string, modelId: string): string {
	return `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${baseUrl}\u0000${modelId}`;
}

/** Re-arm fast mode across materialized Anthropic session-state entries. */
export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;
	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		Object.assign(value, { fastModeDisabled: false });
	}
	const anchor = providerSessionState.get(ANTHROPIC_OPAQUE_CLIENT_ANCHOR_KEY);
	if (anchor && "fastModeRearmGeneration" in anchor && typeof anchor.fastModeRearmGeneration === "number") {
		anchor.fastModeRearmGeneration++;
	}
}

/** Inspect the direct model's fast-mode fallback without materializing state. */
export function isAnthropicFastModeFallbackDisabled(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	model: Model<Api>,
): boolean {
	if (!providerSessionState || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	const baseUrl = resolveDirectAnthropicBaseUrl(model);
	const key = anthropicProviderSessionStateKey(baseUrl, model.id);
	const state = providerSessionState.get(key);
	return state !== undefined && "fastModeDisabled" in state && state.fastModeDisabled === true;
}
