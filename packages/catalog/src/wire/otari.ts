import { isRecord } from "../utils";

/** Hosted US gateway, the default region. */
export const OTARI_US_BASE_URL = "https://api.otari.ai/api/v1";
/** Hosted EU gateway. Workspaces and keys are region-local: a key issued in one region is rejected by the other. */
export const OTARI_EU_BASE_URL = "https://eu.api.otari.ai/api/v1";

/** Otari credential persisted by `/login otari`: a workspace key plus the API root it authenticates against. */
export interface OtariCredential {
	token: string;
	/** Absent means `OTARI_BASE_URL` when set, else the US gateway ({@link OTARI_US_BASE_URL}). */
	baseUrl?: string;
}

/** Parses a structured login credential or a plain key; null when empty or malformed. */
export function parseOtariCredential(value: string): OtariCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string") return null;
		const credential: OtariCredential = { token: parsed.token.trim() };
		const baseUrl = parsed.baseUrl?.trim().replace(/\/+$/, "");
		if (baseUrl) credential.baseUrl = baseUrl;
		return credential;
	} catch {
		return null;
	}
}

/** Serializes a login credential; a US login with no base URL stays a plain key. */
export function serializeOtariCredential(credential: OtariCredential): string {
	const token = credential.token.trim();
	const baseUrl = credential.baseUrl?.trim().replace(/\/+$/, "");
	if (!baseUrl || baseUrl === OTARI_US_BASE_URL) return token;
	return JSON.stringify({ token, baseUrl });
}
