/**
 * Grok Bot provider credential minting (`grokbot` / `grokbot-sand`).
 *
 * Core mint/checksum/secrets live in `@oh-my-pi/pi-catalog/discovery/grokbot-auth`
 * so catalog AvailableModels discovery can share them. This module re-exports that
 * surface and adds `/grokbot` status formatting.
 */
import { GROKBOT_BACKEND, grokbotSecretsPath, loadGrokbotConfig } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
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
	loadGrokbotConfig,
	loadGrokbotSecretFile,
	loadGrokbotSecretFileSync,
	mintGrokbotAccessToken,
	resolveGrokbotClientVersion,
	resolveGrokbotEnvApiKey,
	stampedVersionBaseOf,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";

/** @deprecated Prefer {@link shortenPath} from `@oh-my-pi/pi-utils`. */
export { shortenPath as shortenGrokbotDisplayPath } from "@oh-my-pi/pi-utils";

/** Max display cells for `/grokbot` status field values (matches TUI title width). */
const STATUS_VALUE_MAX_WIDTH = 60;

/** Sanitize a status field: strip controls/ANSI, expand tabs, single-line, width-cap. */
function formatGrokbotStatusValue(value: string): string {
	const cleaned = replaceTabs(
		sanitizeText(value)
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(cleaned, STATUS_VALUE_MAX_WIDTH);
}

/** Human-readable status lines for `/grokbot` (no secret values). */
export async function formatGrokbotStatus(): Promise<string> {
	const cfg = await loadGrokbotConfig();
	return [
		"Grok Bot provider (`grokbot` / `grokbot-sand`) — InferenceService/Stream",
		"Not the Cursor provider (`cursor` / AgentService/Run) and not xAI / Grok CLI (`xai`, `xai-oauth`).",
		"Usage allowances are independent: Grok Bot, Cursor, and xAI / Grok CLI each have their own quota — using one does not consume the others.",
		`Host: ${GROKBOT_BACKEND}`,
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
