import { isRecord } from "../utils";

/** Cloudflare credential persisted by the AI Gateway and Workers AI logins: a bearer token plus the routing ids collected at login. */
export interface CloudflareCredential {
	token: string;
	accountId?: string;
	gatewayId?: string;
}

/** Parses a structured login credential or a legacy plain token; null when empty or malformed. */
export function parseCloudflareCredential(value: string): CloudflareCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.accountId !== undefined && typeof parsed.accountId !== "string") return null;
		if (parsed.gatewayId !== undefined && typeof parsed.gatewayId !== "string") return null;
		const credential: CloudflareCredential = { token: parsed.token.trim() };
		const accountId = parsed.accountId?.trim();
		const gatewayId = parsed.gatewayId?.trim();
		if (accountId) credential.accountId = accountId;
		if (gatewayId) credential.gatewayId = gatewayId;
		return credential;
	} catch {
		return null;
	}
}

/** Serializes a login credential, trimming fields and omitting empty optional ids. */
export function serializeCloudflareCredential(credential: CloudflareCredential): string {
	const serialized: CloudflareCredential = { token: credential.token.trim() };
	const accountId = credential.accountId?.trim();
	const gatewayId = credential.gatewayId?.trim();
	if (accountId) serialized.accountId = accountId;
	if (gatewayId) serialized.gatewayId = gatewayId;
	return JSON.stringify(serialized);
}
