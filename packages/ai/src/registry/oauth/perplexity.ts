/**
 * Perplexity login and token refresh.
 *
 * Login paths (in priority order):
 * 1. macOS native app: reads JWT from NSUserDefaults (`defaults read ai.perplexity.mac authToken`)
 * 2. HTTP email OTP: `GET /api/auth/csrf` → `POST /api/auth/signin-email` → `POST /api/auth/signin-otp`
 *
 * No browser or manual cookie paste required.
 * Refresh: Socket.IO `refreshJWT` RPC over authenticated WebSocket connection.
 *
 * Protocol: Engine.IO v4 + Socket.IO v4 over WebSocket (bypasses Cloudflare managed challenge).
 * Architecture reverse-engineered from Perplexity macOS app (ai.perplexity.mac).
 */
import * as os from "node:os";
import { $env } from "@oh-my-pi/pi-utils";
import { $, Cookie, CookieMap } from "bun";
import * as AIError from "../../error";
import type { OAuthController, OAuthCredentials } from "./types";

const API_VERSION = "2.18";
const NATIVE_APP_BUNDLE = "ai.perplexity.mac";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

function serializeCookies(cookies: CookieMap): string {
	let header = "";
	for (const [name, value] of cookies) {
		header += `${header ? "; " : ""}${name}=${value}`;
	}
	return header;
}

function rememberCookies(cookies: CookieMap, response: Response): void {
	for (const setCookie of response.headers.getSetCookie()) {
		const cookie = Cookie.parse(setCookie);
		if (cookie.isExpired()) {
			cookies.delete(cookie.name);
		} else {
			cookies.set(cookie.name, cookie.value);
		}
	}
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Extract expiry from a JWT. Perplexity tokens generally lack an `exp` claim
 * (their sessions are server-side and effectively non-expiring from the client's
 * point of view), so we return a far-future sentinel when no `exp` is present.
 * When `exp` IS present, subtract a 5-minute safety margin.
 */
const NEVER_EXPIRES = 8.64e15; // max safe Date value
function getJwtExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return NEVER_EXPIRES;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (typeof decoded?.exp === "number" && Number.isFinite(decoded.exp)) {
			return decoded.exp * 1000 - 5 * 60_000;
		}
	} catch {
		// Ignore decode errors
	}
	return NEVER_EXPIRES;
}

/** Build OAuthCredentials from a Perplexity JWT string. */
function jwtToCredentials(jwt: string, email?: string): OAuthCredentials {
	return {
		access: jwt,
		refresh: jwt,
		expires: getJwtExpiry(jwt),
		email,
	};
}

// ---------------------------------------------------------------------------
// Desktop app extraction
// ---------------------------------------------------------------------------

/**
 * Read the Perplexity JWT from the native macOS Catalyst app's UserDefaults.
 * Tokens are stored in NSUserDefaults (not Keychain), readable by any same-UID process.
 */
async function extractFromNativeApp(): Promise<string | null> {
	if (os.platform() !== "darwin") return null;

	try {
		const result = await $`defaults read ${NATIVE_APP_BUNDLE} authToken`.quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const token = result.text().trim();
		if (!token || token === "(null)") return null;
		return token;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Socket.IO email OTP login
// ---------------------------------------------------------------------------

/**
 * Send email OTP and exchange it for a Perplexity JWT via HTTP endpoints.
 */
async function httpEmailLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new AIError.OnPromptRequiredError("Perplexity");
	}
	const email = await ctrl.onPrompt({
		message: "Enter your Perplexity email address",
		placeholder: "user@example.com",
	});
	const trimmedEmail = email.trim();
	if (!trimmedEmail)
		throw new AIError.OAuthError("Email is required for Perplexity login", {
			kind: "validation",
			provider: "perplexity",
		});
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
	const fetchImpl = ctrl.fetch ?? fetch;
	const cookies = new CookieMap();
	const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (cookies.size > 0) headers.set("Cookie", serializeCookies(cookies));
		const response = await fetchImpl(url, { ...init, headers });
		rememberCookies(cookies, response);
		return response;
	};

	ctrl.onProgress?.("Fetching Perplexity CSRF token...");
	const csrfResponse = await request("https://www.perplexity.ai/api/auth/csrf", {
		headers: {
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		signal: ctrl.signal,
	});

	if (!csrfResponse.ok) {
		throw new AIError.ProviderHttpError(
			`Perplexity CSRF request failed: ${csrfResponse.status}`,
			csrfResponse.status,
		);
	}

	const csrfData = (await csrfResponse.json()) as { csrfToken?: string };
	if (!csrfData.csrfToken) {
		throw new AIError.OAuthError("Perplexity CSRF response missing csrfToken", {
			kind: "validation",
			provider: "perplexity",
		});
	}
	ctrl.onProgress?.("Sending login code to your email...");
	const sendResponse = await request("https://www.perplexity.ai/api/auth/signin-email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	if (!sendResponse.ok) {
		const body = await sendResponse.text();
		throw new AIError.ProviderHttpError(
			`Perplexity send login code failed (${sendResponse.status}): ${body}`,
			sendResponse.status,
		);
	}
	const otp = await ctrl.onPrompt({
		message: "Enter the code sent to your email",
		placeholder: "123456",
	});
	const trimmedOtp = otp.trim();
	if (!trimmedOtp)
		throw new AIError.OAuthError("OTP code is required", { kind: "validation", provider: "perplexity" });
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
	ctrl.onProgress?.("Verifying login code...");
	const verifyResponse = await request("https://www.perplexity.ai/api/auth/signin-otp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			otp: trimmedOtp,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	const verifyData = (await verifyResponse.json()) as {
		token?: string;
		challenge_token?: string;
		status?: string;
		error_code?: string;
		text?: string;
	};

	if (!verifyResponse.ok) {
		const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? "OTP verification failed";
		throw new AIError.OAuthError(`Perplexity OTP verification failed: ${reason}`, {
			kind: "validation",
			provider: "perplexity",
			status: verifyResponse.status,
		});
	}

	const token = verifyData.challenge_token || verifyData.token;
	if (!token || verifyData.error_code || (verifyData.status && verifyData.status !== "success")) {
		const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? "missing token";
		throw new AIError.OAuthError(`Perplexity OTP verification response rejected: ${reason}`, {
			kind: "validation",
			provider: "perplexity",
		});
	}

	return jwtToCredentials(token, trimmedEmail);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Login to Perplexity.
 *
 * Tries auto-extraction from the desktop app, then runs HTTP email OTP login.
 *
 * No browser/manual token paste fallback is used.
 */
export async function loginPerplexity(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new AIError.OnPromptRequiredError("Perplexity");
	}

	// Path 1: Native macOS app JWT (skip if PI_AUTH_NO_BORROW=1)
	if (!$env.PI_AUTH_NO_BORROW) {
		ctrl.onProgress?.("Checking for Perplexity desktop app...");
		const nativeJwt = await extractFromNativeApp();
		if (nativeJwt) {
			ctrl.onProgress?.("Found Perplexity JWT from native app");
			return jwtToCredentials(nativeJwt);
		}
	}

	// Path 2: HTTP email OTP
	return httpEmailLogin(ctrl);
}
