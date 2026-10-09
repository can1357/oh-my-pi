import { GROKBOT_BACKEND, grokbotSecretsPath, loadGrokbotConfig } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Sanitize a status field: strip controls/ANSI, expand tabs, single-line, width-cap. */
function formatGrokbotStatusValue(value: string): string {
	const cleaned = replaceTabs(
		sanitizeText(value)
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(cleaned, TRUNCATE_LENGTHS.TITLE);
}

/** Strip URL userinfo and all query params before `/grokbot` Host display. */
function scrubMalformedGrokbotDisplayHost(raw: string): string {
	// Scheme-less / opaque endpoints used while diagnosing proxies — strip
	// userinfo and query/fragment conservatively (never echo secrets).
	let scrubbed = raw.replace(/^(?:([a-z][a-z0-9+.-]*:\/\/))?([^/?#]*@)/i, "$1");
	const cut = scrubbed.search(/[?#]/);
	if (cut >= 0) scrubbed = scrubbed.slice(0, cut);
	return scrubbed.replace(/\/+$/, "") || GROKBOT_BACKEND;
}

function formatGrokbotDisplayHost(raw: string): string {
	const trimmed = raw.replace(/\/+$/, "") || GROKBOT_BACKEND;
	try {
		const url = new URL(trimmed);
		// `user:sekrit@proxy.local` parses as opaque scheme `user:` with empty
		// host — do not trust pathname (still holds userinfo). Scrub raw instead.
		if (!url.host) return formatGrokbotStatusValue(scrubMalformedGrokbotDisplayHost(trimmed));
		url.username = "";
		url.password = "";
		// Omit the entire query string — reverse proxies may auth with arbitrary
		// keys (`x-api-key`, signed tokens, …) that no allowlist can exhaust.
		url.search = "";
		// Fragments commonly carry tokens (`#access_token=…`); never show them.
		url.hash = "";
		const display = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
		return formatGrokbotStatusValue(display || GROKBOT_BACKEND);
	} catch {
		return formatGrokbotStatusValue(scrubMalformedGrokbotDisplayHost(trimmed));
	}
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
		"Account allowance and model entitlement are checked separately; status is not an inference test.",
		`Host: ${formatGrokbotDisplayHost(host)}`,
		"Wire: application/connect+proto (InferenceService/Stream only; no harness / AgentService fields)",
		"Auth: Grok Bot renewal credential + machine-id checksum (not Cursor OAuth, not XAI_API_KEY)",
		`Renewer: ${cfg.renewal ? "present" : "missing"}`,
		`Machine id: ${cfg.machineId ? "present" : "missing"}`,
		`Namespace: ${formatGrokbotStatusValue(cfg.namespace)}`,
		`Client version: ${formatGrokbotStatusValue(cfg.clientVersion)}`,
		`Secrets file: ${formatGrokbotStatusValue(shortenPath(grokbotSecretsPath()))}`,
		"Select native models as `grokbot/<id>`; use `grokbot-chat/host-managed` for text-only chat.",
		"Login: `/login` → Grok Bot — run the shown prompt inside the Grok Bot system (not omp).",
	].join("\n");
}
