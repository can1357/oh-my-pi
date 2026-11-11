/**
 * Zed Hosted Models OAuth / Native App Sign-in flow.
 *
 * Drives zed.dev/native_app_signin via ephemeral RSA keypair:
 * 1. Generates 2048-bit RSA keypair.
 * 2. Launches browser with native_app_public_key and native_app_port.
 * 3. Listens on loopback HTTP server for callback with encrypted access_token.
 * 4. Decrypts access token with local private key.
 * 5. Fetches authenticated user info from cloud.zed.dev/client/users/me.
 */

import * as crypto from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { fetchZedAuthenticatedUser, resolveZedOrganizationId, ZED_WEB_BASE_URL } from "../../providers/zed-hosted";
import templateHtml from "./oauth.html" with { type: "text" };
import type { Server } from "bun";
import type { OAuthController, OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types";

const DEFAULT_NATIVE_PORT = 58443;
const PRIVATE_KEY_PREFIX = "zed-rsa-pkcs1:";

function b64urlPadded(value: Buffer): string {
	return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
function serializeCallbackState(state: unknown): string {
	return JSON.stringify(state).replaceAll("<", "\\u003c");
}

export function encodeZedPrivateKeyVerifier(privateKeyPem: string): string {
	return `${PRIVATE_KEY_PREFIX}${Buffer.from(privateKeyPem).toString("base64url")}`;
}

export function decodeZedPrivateKeyVerifier(verifier: unknown): string {
	const value = String(verifier || "");
	if (!value.startsWith(PRIVATE_KEY_PREFIX)) {
		throw new AIError.OAuthError("Missing or invalid Zed private key verifier; restart the login flow", {
			kind: "validation",
			provider: "zed-hosted",
		});
	}
	return Buffer.from(value.slice(PRIVATE_KEY_PREFIX.length), "base64url").toString("utf8");
}

export type ZedNativeAuthData = {
	authUrl: string;
	privateKeyPem: string;
	privateKeyVerifier: string;
	nativeAppPort: number;
	systemId: string;
	publicKey: string;
};

export function createZedNativeAuthData(
	options: { nativeAppPort?: number; systemId?: string } = {},
): ZedNativeAuthData {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "der" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});

	const nativeAppPort = options.nativeAppPort || DEFAULT_NATIVE_PORT;
	const systemId = options.systemId || crypto.randomUUID();
	const publicKeyBuffer = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey as unknown as ArrayBuffer);
	const publicKeyString = b64urlPadded(publicKeyBuffer);

	const signInUrl = new URL(`${ZED_WEB_BASE_URL}/native_app_signin`);
	signInUrl.searchParams.set("native_app_port", String(nativeAppPort));
	signInUrl.searchParams.set("native_app_public_key", publicKeyString);
	if (systemId) signInUrl.searchParams.set("system_id", systemId);

	const privateKeyPem = String(privateKey);
	return {
		authUrl: signInUrl.toString(),
		privateKeyPem,
		privateKeyVerifier: encodeZedPrivateKeyVerifier(privateKeyPem),
		nativeAppPort,
		systemId,
		publicKey: publicKeyString,
	};
}

export type ZedCallbackPayload = {
	userId: string;
	encryptedAccessToken: string;
};

export function parseZedCallbackPayload(input: unknown): ZedCallbackPayload {
	const raw = String(input || "").trim();
	if (!raw) {
		throw new AIError.OAuthError("Missing Zed callback data", {
			kind: "validation",
			provider: "zed-hosted",
		});
	}

	const data: Record<string, string> = {};
	try {
		const parsed = JSON.parse(raw);
		if (isRecord(parsed)) {
			for (const [k, v] of Object.entries(parsed)) {
				data[k] = String(v);
			}
		}
	} catch {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			try {
				url = new URL(`http://127.0.0.1/?${raw.replace(/^\?/, "")}`);
			} catch {
				throw new AIError.OAuthError("Invalid Zed callback URL", {
					kind: "validation",
					provider: "zed-hosted",
				});
			}
		}
		url.searchParams.forEach((value, key) => {
			data[key] = value;
		});
	}

	const userId = data.user_id || data.userId;
	const encryptedAccessToken = data.access_token || data.accessToken || data.token;
	if (!userId || !encryptedAccessToken) {
		throw new AIError.OAuthError("Zed callback must include user_id and access_token", {
			kind: "validation",
			provider: "zed-hosted",
		});
	}
	return {
		userId: String(userId),
		encryptedAccessToken: String(encryptedAccessToken),
	};
}

export function decryptZedAccessToken(encryptedAccessToken: string, privateKeyPemOrVerifier: string): string {
	const privateKey = privateKeyPemOrVerifier.startsWith(PRIVATE_KEY_PREFIX)
		? decodeZedPrivateKeyVerifier(privateKeyPemOrVerifier)
		: privateKeyPemOrVerifier;

	const encrypted = Buffer.from(encryptedAccessToken, "base64url");
	try {
		return crypto
			.privateDecrypt(
				{ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
				encrypted,
			)
			.toString("utf8");
	} catch (oaepError) {
		try {
			return crypto
				.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, encrypted)
				.toString("utf8");
		} catch {
			const message = oaepError instanceof Error ? oaepError.message : String(oaepError);
			throw new AIError.OAuthError(`Failed to decrypt Zed access token: ${message}`, {
				kind: "validation",
				provider: "zed-hosted",
			});
		}
	}
}

/**
 * Executes the whole interactive Zed native sign-in flow.
 */
export async function loginZedHostedHook(ctrl: OAuthController): Promise<OAuthCredentials> {
	// Try preferred native port 58443, fall back to ephemeral port 0
	let server: Server<unknown> | undefined;
	let boundPort = DEFAULT_NATIVE_PORT;

	const { promise: callbackPromise, resolve: resolveCallback } = Promise.withResolvers<ZedCallbackPayload>();

	const handleRequest = (req: Request): Response => {
		const url = new URL(req.url);
		const userId = url.searchParams.get("user_id") || url.searchParams.get("userId");
		const token = url.searchParams.get("access_token") || url.searchParams.get("accessToken");

		if (userId && token) {
			try {
				decryptZedAccessToken(token, authData.privateKeyPem);
				queueMicrotask(() => {
					resolveCallback({ userId, encryptedAccessToken: token });
				});
				return new Response(
					(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", () =>
						serializeCallbackState({ ok: true, provider: "zed-hosted" }),
					),
					{
						status: 200,
						headers: { "Content-Type": "text/html; charset=utf-8" },
					},
				);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return new Response(
					(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", () =>
						serializeCallbackState({ ok: false, error: message }),
					),
					{
						status: 400,
						headers: { "Content-Type": "text/html; charset=utf-8" },
					},
				);
			}
		}

		return new Response("Not Found", { status: 404 });
	};

	try {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: boundPort,
			fetch: handleRequest,
		});
	} catch {
		ctrl.onProgress?.(`Port ${DEFAULT_NATIVE_PORT} busy, binding random port...`);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: handleRequest,
		});
		boundPort = server.port ?? DEFAULT_NATIVE_PORT;
	}

	const authData = createZedNativeAuthData({ nativeAppPort: boundPort });

	ctrl.onAuth?.({
		url: authData.authUrl,
		instructions: "Complete sign-in in your browser. Zed will redirect to your local session.",
	});
	ctrl.onProgress?.("Waiting for Zed browser sign-in...");

	let rawResult: ZedCallbackPayload;

	// In manual input mode or if signal aborts
	const manualInputPromise = ctrl.onManualCodeInput
		? ctrl.onManualCodeInput(ctrl.signal).then(input => parseZedCallbackPayload(input))
		: null;

	const { promise: abortPromise, reject: rejectAbort } = Promise.withResolvers<never>();
	if (ctrl.signal) {
		ctrl.signal.addEventListener(
			"abort",
			() => {
				rejectAbort(
					new AIError.OAuthError("Sign-in was cancelled", { kind: "device-auth", provider: "zed-hosted" }),
				);
			},
			{ once: true },
		);
	}

	try {
		const raceWinners = [callbackPromise, abortPromise];
		if (manualInputPromise) raceWinners.push(manualInputPromise);
		rawResult = await Promise.race(raceWinners);
	} finally {
		server.stop();
	}

	ctrl.onProgress?.("Decrypting access token and loading Zed profile...");

	const accessToken = decryptZedAccessToken(rawResult.encryptedAccessToken, authData.privateKeyPem);
	const credentials = {
		userId: rawResult.userId,
		accessToken,
		systemId: authData.systemId,
	};

	const userInfo = await fetchZedAuthenticatedUser(credentials, { fetch: ctrl.fetch, signal: ctrl.signal });
	const organizationId = resolveZedOrganizationId(credentials, userInfo);

	const email = (userInfo.email || userInfo.github_login || userInfo.name || rawResult.userId) as string;

	return {
		access: accessToken,
		refresh: "",
		expires: Number.POSITIVE_INFINITY,
		accountId: rawResult.userId,
		email,
		orgId: organizationId,
		authorizedAt: Date.now(),
	};
}

export class ZedHostedOAuthProvider implements OAuthProviderInterface {
	readonly id = "zed-hosted";
	readonly name = "Zed Hosted (Claude, Gemini, GPT)";

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginZedHostedHook(callbacks);
	}

	getApiKey(credentials: OAuthCredentials): string {
		return JSON.stringify({
			token: credentials.access,
			accountId: credentials.accountId,
			email: credentials.email,
			orgId: credentials.orgId,
		});
	}
}
