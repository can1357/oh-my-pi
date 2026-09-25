/**
 * Probe auth facade — re-exports the shipping catalog Grok Bot auth helpers so
 * live probes exercise the same checksum / URL join / mint / header-merge path
 * as discovery and the provider stream client (no divergent mirror).
 *
 * Tests inject secrets/env via {@link runWithGrokbotAuthSource} rather than
 * mutating `process.env` or a process-wide agent dir.
 */
export {
	GROKBOT_AUTHENTICATED_SENTINEL,
	GROKBOT_BACKEND,
	GROKBOT_CLIENT_TYPE,
	GROKBOT_DEFAULT_CLIENT_VERSION,
	GROKBOT_DEFAULT_NAMESPACE,
	GROKBOT_DEFAULT_TOKEN_TTL_MS,
	GROKBOT_RENEWAL_PATH,
	GROKBOT_STAMPED_CLIENT_VERSION,
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	getAccessTokenExpiryMs,
	grokbotClientHeaders,
	grokbotSecretsPath,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mergeGrokbotHeaders,
	mintGrokbotAccessToken,
	resolveGrokbotCacheCredential,
	resolveGrokbotCacheCredentialAsync,
	resolveGrokbotClientVersion,
	resolveGrokbotDiscoveryIdentity,
	resolveGrokbotDiscoveryIdentityAsync,
	resolveGrokbotEnvApiKey,
	resolveGrokbotMachineId,
	runWithGrokbotAuthSource,
	runWithGrokbotAuthSourceAsync,
	stampedVersionBaseOf,
} from "../packages/catalog/src/discovery/grokbot-auth.ts";

/** AvailableModels Connect path used by keep-model full Anthropic probe. */
export const GROKBOT_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
