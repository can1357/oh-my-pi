import { isRecord } from "../utils";

/** `<account>` is substituted per request. */
export const CLOUDFLARE_WORKERS_AI_ACCOUNT_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/<account>/ai";
export const CLOUDFLARE_WORKERS_AI_BASE_URL = `${CLOUDFLARE_WORKERS_AI_ACCOUNT_BASE_URL}/v1`;
/** Routes a session to one instance so the prompt cache hits. */
export const CLOUDFLARE_WORKERS_AI_SESSION_HEADER = "x-session-affinity";

const CANONICAL_BASE_URL_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai\/v1\/?$/;

/** Stored login credential. */
export interface CloudflareWorkersAiCredential {
	token: string;
	accountId?: string;
}

/** Accepts the JSON credential or a bare token. */
export function parseCloudflareWorkersAiCredential(value: string): CloudflareWorkersAiCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.accountId !== undefined && typeof parsed.accountId !== "string") return null;
		const credential: CloudflareWorkersAiCredential = { token: parsed.token.trim() };
		const accountId = parsed.accountId?.trim();
		if (accountId) credential.accountId = accountId;
		return credential;
	} catch {
		return null;
	}
}

export function serializeCloudflareWorkersAiCredential(token: string, accountId: string): string {
	return JSON.stringify({ token: token.trim(), accountId: accountId.trim() });
}

export function resolveCloudflareWorkersAiBaseUrl(baseUrl: string, accountId: string): string {
	return baseUrl.replace("<account>", accountId);
}

/** Back to the `<account>` template, so cached rows stay account-agnostic. */
export function toCloudflareWorkersAiSpecBaseUrl(baseUrl: string): string {
	return CANONICAL_BASE_URL_RE.test(baseUrl.trim()) ? CLOUDFLARE_WORKERS_AI_BASE_URL : baseUrl;
}

/** `…/ai/v1` → `…/ai/models/search`. */
export function toCloudflareWorkersAiModelsSearchUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	const accountRoot = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
	return `${accountRoot}/models/search`;
}
