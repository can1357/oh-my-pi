import { isRecord } from "../utils";

/** Provider-native AI Gateway prefix before the upstream route segment. */
export const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>";
/** Anthropic Messages passthrough endpoint. */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/anthropic`;
/** OpenAI Responses passthrough endpoint. */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/openai`;
/** OpenAI-compatible Workers AI endpoint. */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/compat`;

/** Opaque API-key credential payload persisted by Cloudflare AI Gateway login. */
export interface CloudflareAiGatewayCredential {
	token: string;
	accountId?: string;
	gatewayId?: string;
}

/** Parse both structured login credentials and legacy plain gateway tokens. */
export function parseCloudflareAiGatewayCredential(value: string): CloudflareAiGatewayCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.accountId !== undefined && typeof parsed.accountId !== "string") return null;
		if (parsed.gatewayId !== undefined && typeof parsed.gatewayId !== "string") return null;
		const credential: CloudflareAiGatewayCredential = { token: parsed.token.trim() };
		const accountId = parsed.accountId?.trim();
		const gatewayId = parsed.gatewayId?.trim();
		if (accountId) credential.accountId = accountId;
		if (gatewayId) credential.gatewayId = gatewayId;
		return credential;
	} catch {
		return null;
	}
}

/** Serialize the gateway token with the routing identifiers collected during login. */
export function serializeCloudflareAiGatewayCredential(token: string, accountId: string, gatewayId: string): string {
	return JSON.stringify({ token: token.trim(), accountId: accountId.trim(), gatewayId: gatewayId.trim() });
}
