/**
 * Grok Bot provider credential minting (`grokbot` / `grokbot-sand`).
 *
 * Core mint/checksum/secrets live in `@oh-my-pi/pi-catalog/discovery/grokbot-auth`
 * so catalog AvailableModels discovery can share them. This module re-exports that
 * surface and adds `/grokbot` status formatting.
 */
import { GROKBOT_BACKEND, grokbotSecretsPath, loadGrokbotConfig } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText, shortenPath } from "@oh-my-pi/pi-utils";

export {
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	GROKBOT_BACKEND,
	GROKBOT_CLIENT_TYPE,
	GROKBOT_DEFAULT_CLIENT_VERSION,
	GROKBOT_DEFAULT_NAMESPACE,
	GROKBOT_DEFAULT_TOKEN_TTL_MS,
	GROKBOT_RENEWAL_PATH,
	GROKBOT_STAMPED_CLIENT_VERSION,
	type GrokbotConfig,
	getAccessTokenExpiryMs,
	grokbotClientHeaders,
	grokbotSecretsPath,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mergeGrokbotHeaders,
	mintGrokbotAccessToken,
	resolveGrokbotClientVersion,
	resolveGrokbotDiscoveryIdentity,
	resolveGrokbotDiscoveryIdentityAsync,
	resolveGrokbotEnvApiKey,
	stampedVersionBaseOf,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";

/** @deprecated Prefer {@link shortenPath} from `@oh-my-pi/pi-utils`. */
export { shortenPath as shortenGrokbotDisplayPath } from "@oh-my-pi/pi-utils";

/** Sanitize a status field: strip controls/ANSI, expand tabs, single-line, width-cap. */
function formatGrokbotStatusValue(value: string): string {
	const cleaned = replaceTabs(
		sanitizeText(value)
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(cleaned, TRUNCATE_LENGTHS.TITLE);
}

export type FormatGrokbotStatusOptions = {
	/**
	 * Effective renewal credential from AuthStorage / `providers.grokbot.apiKey`
	 * / runtime `--api-key`. When present, status reports Renewer as present
	 * even if env/secrets file are empty.
	 */
	renewalCredential?: string;
	/** Effective provider backend (runtime/models.yml override or catalog default). */
	baseUrl?: string;
};

/** Human-readable status lines for `/grokbot` (no secret values). */
export async function formatGrokbotStatus(options?: FormatGrokbotStatusOptions): Promise<string> {
	const configured = typeof options?.renewalCredential === "string" ? options.renewalCredential.trim() : "";
	const cfg = await loadGrokbotConfig(configured || undefined);
	const host = (options?.baseUrl?.trim() || GROKBOT_BACKEND).replace(/\/+$/, "") || GROKBOT_BACKEND;
	return [
		"Grok Bot provider (`grokbot` / `grokbot-sand`) — InferenceService/Stream",
		"Not the Cursor provider (`cursor` / AgentService/Run) and not xAI / Grok CLI (`xai`, `xai-oauth`).",
		"Usage allowances are independent: Grok Bot, Cursor, and xAI / Grok CLI each have their own quota — using one does not consume the others.",
		`Host: ${formatGrokbotStatusValue(host)}`,
		"Wire: application/connect+proto (InferenceService/Stream only; no harness / AgentService fields)",
		"Auth: Grok Bot renewal credential + machine-id checksum (not Cursor OAuth, not XAI_API_KEY)",
		`Renewer: ${cfg.renewal ? "present" : "missing"}`,
		`Machine id: ${cfg.machineId ? "present" : "missing"}`,
		`Namespace: ${formatGrokbotStatusValue(cfg.namespace)}`,
		`Client version: ${formatGrokbotStatusValue(cfg.clientVersion)}`,
		`Secrets file: ${formatGrokbotStatusValue(shortenPath(grokbotSecretsPath()))}`,
		"Select models as `grokbot/<id>` (e.g. `grokbot/sand-default`).",
		"Login: `/login` → Grok Bot — run the shown prompt inside the Grok Bot system (not omp).",
	].join("\n");
}
