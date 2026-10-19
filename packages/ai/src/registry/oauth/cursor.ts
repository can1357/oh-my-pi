import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { isRecord } from "../../utils";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/oauth/token";
/** OAuth client the Cursor IDE renews its login session with. */
const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_PROFILE_URL = "https://cursor.com/api/auth/me";
const CURSOR_PROFILE_TIMEOUT_MS = 3_000;

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	return { verifier, challenge, uuid, loginUrl };
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await Bun.sleep(delay);

		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
				};
			}

			throw new AIError.OAuthError(`Poll failed: ${response.status}`, {
				kind: "polling",
				provider: "cursor",
				status: response.status,
			});
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw new AIError.OAuthError("Too many consecutive errors during Cursor auth polling", {
					kind: "polling",
					provider: "cursor",
				});
			}
		}
	}

	throw new AIError.OAuthError("Cursor authentication polling timeout", {
		kind: "timeout",
		provider: "cursor",
	});
}

export async function loginCursor(
	onAuthUrl: (url: string) => void,
	onPollStart?: () => void,
): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

	onAuthUrl(loginUrl);
	onPollStart?.();

	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);

	const expiresAt = getTokenExpiry(accessToken);

	return {
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

export async function loginCursorHook(callbacks: OAuthController): Promise<OAuthCredentials> {
	const credentials = await loginCursor(
		url => callbacks.onAuth?.({ url }),
		callbacks.onProgress ? () => callbacks.onProgress?.("Waiting for browser authentication...") : undefined,
	);
	return withCursorAccountEmail(credentials, callbacks.fetch ?? fetch, callbacks.signal);
}

export async function refreshCursorToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", client_id: CURSOR_CLIENT_ID, refresh_token: refreshToken }),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Cursor token refresh failed: ${error}`, {
			kind: "token-refresh",
			provider: "cursor",
		});
	}

	const data = (await response.json()) as { access_token?: string; refresh_token?: string; shouldLogout?: boolean };
	// Cursor answers a session it will not renew with 200, an empty token and `shouldLogout`.
	if (data.shouldLogout === true) {
		throw new AIError.OAuthError("invalid_grant: Cursor ended this session; run /login cursor again", {
			kind: "token-refresh",
			provider: "cursor",
		});
	}
	if (!data.access_token) {
		throw new AIError.OAuthError("Cursor token refresh returned no access token", {
			kind: "token-refresh",
			provider: "cursor",
		});
	}

	// Cursor's renewal answers only an access token; the IDE keeps its stored refresh token, so do the same
	// unless a rotated one is returned.
	return {
		access: data.access_token,
		refresh: data.refresh_token || refreshToken,
		expires: getTokenExpiry(data.access_token),
	};
}

export async function refreshCursorHook(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const refreshed = await refreshCursorToken(credentials.refresh);
	// A stored email survives the refresh merge; rows stored before email capture gain it here.
	return credentials.email ? refreshed : withCursorAccountEmail(refreshed, fetch, signal);
}

/** Request headers that present `accessToken` to cursor.com as its user's web session. */
export function cursorSessionHeaders(userId: string, accessToken: string): Record<string, string> {
	return {
		Accept: "application/json",
		Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
	};
}

/**
 * Email of the Cursor account that owns `accessToken`, read from its cursor.com
 * profile. Undefined when the token names no user or the profile names another.
 */
export async function fetchCursorAccountEmail(
	accessToken: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const userId = extractCursorAccessTokenUserId(accessToken);
	if (!userId) return undefined;
	const response = await fetchImpl(CURSOR_PROFILE_URL, { headers: cursorSessionHeaders(userId, accessToken), signal });
	if (!response.ok) {
		throw new AIError.ProviderHttpError(`Cursor profile request failed: ${response.status}`, response.status);
	}
	const payload: unknown = await response.json();
	if (!isRecord(payload) || payload.sub !== userId || typeof payload.email !== "string") return undefined;
	return payload.email.trim() || undefined;
}

/** Attach the account email so account policies and pickers can name this login; a failed lookup leaves it off. */
async function withCursorAccountEmail(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	// Refresh runs under a 10s deadline; a stalled lookup must not discard tokens the exchange already minted.
	const timeout = AbortSignal.timeout(CURSOR_PROFILE_TIMEOUT_MS);
	const email = await fetchCursorAccountEmail(
		credentials.access,
		fetchImpl,
		signal ? AbortSignal.any([signal, timeout]) : timeout,
	).catch(() => undefined);
	return email ? { ...credentials, email } : credentials;
}

function decodeCursorAccessTokenPayload(token: string): unknown | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

export function extractCursorAccessTokenUserId(accessToken: string): string | undefined {
	try {
		const payload = decodeCursorAccessTokenPayload(accessToken);
		if (!payload || typeof payload !== "object" || !("sub" in payload) || typeof payload.sub !== "string") {
			return undefined;
		}
		const { sub } = payload;
		const parts = sub.split("|");
		const userId = (parts.length > 1 ? parts[1] : sub).trim();
		return userId || undefined;
	} catch {
		return undefined;
	}
}

function getTokenExpiry(token: string): number {
	try {
		const decoded = decodeCursorAccessTokenPayload(token);
		if (decoded && typeof decoded === "object" && "exp" in decoded && typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {
		// Ignore parsing errors
	}
	return Date.now() + 3600 * 1000;
}

export function isCursorTokenExpiringSoon(token: string, thresholdSeconds = 300): boolean {
	try {
		const decoded = decodeCursorAccessTokenPayload(token);
		if (!decoded || typeof decoded !== "object" || !("exp" in decoded) || typeof decoded.exp !== "number") {
			return true;
		}
		const currentTime = Math.floor(Date.now() / 1000);
		return decoded.exp - currentTime < thresholdSeconds;
	} catch {
		return true;
	}
}
