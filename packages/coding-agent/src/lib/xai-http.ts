// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { resolveXaiBaseUrl, XAI_DEFAULT_BASE_URL } from "@oh-my-pi/pi-ai/providers/xai-base-url";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

/** xAI provider ids supported by shared HTTP tool transport resolution. */
export type XAIHttpProvider = "xai-oauth" | "xai";

/** Resolved endpoint and configured headers for an xAI HTTP tool request. */
export interface XAIHttpTransport {
	baseURL: string;
	headers?: Record<string, string>;
}

/**
 * Resolve the HTTP base URL for an xAI tool call.
 *
 * The registry supplies the configured endpoint:
 *   1. `model.baseUrl` from the registry IF the user pinned a per-model
 *      override — i.e. `merged.baseUrl` differs from the seeded/bundled
 *      default for the (provider, id) pair. Mirrors the chat path's per-model
 *      contract (`openai-responses.ts: model.baseUrl`).
 *   2. `ModelRegistry.getProviderBaseUrl(provider)` — provider-level override
 *      (e.g. `providers.xai-oauth.baseUrl` from models.yml). Reached when the
 *      modelId does not appear in the registry under this provider, which
 *      happens for tool-only ids like `grok-imagine-image` that
 *      `applyXAIOAuthCuration` filters out via `XAI_NON_CHAT_PREFIXES`.
 *      Without this leg, a registry-configured proxy is silently bypassed for
 *      image/TTS traffic.
 *   3. Otherwise the bundled `https://api.x.ai/v1` endpoint.
 *
 * The result then goes through {@link resolveXaiBaseUrl}, the rule shared with
 * chat, image generation, and web search: a custom endpoint from steps 1–2
 * wins, and `XAI_BASE_URL` redirects only the bundled endpoint and never
 * receives an `xai-oauth` OAuth access token (`bearer`).
 *
 * The step-1 gate uses `bundled?.baseUrl ?? XAI_DEFAULT_BASE_URL` as the
 * canonical default sentinel: xai-oauth ids have no bundled entries, and
 * without the fallback every xai-oauth model id would count as pinned and
 * bypass `XAI_BASE_URL`. Lookup is scoped to (provider, id); matching by id
 * alone would let xai-oauth entries hijack a xai tool call (or vice versa)
 * when the same model id ships under both descriptors.
 */
function resolveXAIBaseURL(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId: string | undefined,
	bearer: string | undefined,
): string {
	let configured: string | undefined;
	if (modelId) {
		const merged = modelRegistry.getAll().find(m => m.id === modelId && m.provider === provider);
		if (merged?.baseUrl) {
			const bundled = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
				m => m.id === modelId,
			);
			if (merged.baseUrl !== (bundled?.baseUrl ?? XAI_DEFAULT_BASE_URL)) configured = merged.baseUrl;
		}
	}
	configured ||= modelRegistry.getProviderBaseUrl(provider);
	const baseURL = resolveXaiBaseUrl(provider, configured || XAI_DEFAULT_BASE_URL, bearer) ?? XAI_DEFAULT_BASE_URL;
	return baseURL.replace(/\/+$/, "");
}
/**
 * Resolve an xAI tool endpoint and its provider/model header overrides.
 *
 * `apiKey` is the bearer the request will send; when omitted, the provider's
 * current key is peeked so an `xai-oauth` OAuth token is never routed to
 * `XAI_BASE_URL`.
 */
export async function resolveXAIHttpTransport(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId?: string,
	apiKey?: string,
): Promise<XAIHttpTransport> {
	const model = modelId ? modelRegistry.find(provider, modelId) : undefined;
	const bearer = apiKey ?? (await modelRegistry.authStorage.keys.peek(provider));
	return {
		baseURL: resolveXAIBaseURL(modelRegistry, provider, modelId, bearer),
		headers: model
			? await modelRegistry.resolveModelHeaders(model)
			: await modelRegistry.getProviderHeaders(provider),
	};
}

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Credential priority:
 *   1. xai-oauth — only when a *dedicated* xai-oauth source exists. Composed
 *      of two checks against the registry layer:
 *        a. `authStorage.keys.source("xai-oauth", { env: "none" })` covers stored
 *           credentials (OAuth or api_key), runtime overrides (CLI
 *           `--api-key` for xai-oauth), config overrides (models.yml
 *           `providers.xai-oauth.apiKey`), and fallback resolvers.
 *        b. `$env.XAI_OAUTH_TOKEN` covers the xai-oauth-specific env var.
 *      `XAI_API_KEY` is intentionally NOT a signal here, even though the
 *      env-fallback map (`stream.ts: "xai-oauth"`) lets xai-oauth borrow it
 *      as a back-compat convenience: the borrow lets API-key-only setups
 *      satisfy the xai-oauth branch and then resolve baseUrl under
 *      xai-oauth instead of xai, silently bypassing `providers.xai.baseUrl`
 *      overrides for image/TTS traffic. The gate routes the borrow case to
 *      step 2 while preserving every dedicated xai-oauth path.
 *   2. xai (plain API key). Delegates to ModelRegistry.getApiKeyForProvider
 *      which runs AuthStorage.keys.get's full cascade: runtime override →
 *      models.yml config override → stored api_key credential → OAuth
 *      resolution → XAI_API_KEY env var → custom fallback resolver.
 *
 * baseURL: see `resolveXAIBaseURL` above, evaluated for the chosen key.
 * Resolved AFTER the credential decision so the scoped (provider, id) lookup
 * is unambiguous. `modelId` is optional; probes / tool-availability checks
 * pass `undefined` and fall through to the provider endpoint.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 */
export async function resolveXAIHttpCredentials(
	modelRegistry: ModelRegistry,
	modelId?: string,
): Promise<XAICredentials | null> {
	const hasDedicatedXaiOAuth =
		modelRegistry.authStorage.keys.source("xai-oauth", { env: "none" }) !== undefined ||
		Boolean($env.XAI_OAUTH_TOKEN);
	if (hasDedicatedXaiOAuth) {
		const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
		if (oauthKey) {
			const baseURL = resolveXAIBaseURL(modelRegistry, "xai-oauth", modelId, oauthKey);
			return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
		}
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai", modelId, apiKey);
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
