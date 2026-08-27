import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";

/**
 * Constants and cryptographic helpers for Zed Cloud AI Gateway.
 */

export const ZED_CLOUD_URL = "https://cloud.zed.dev";
export const ZED_WEB_URL = "https://zed.dev";
export const ZED_APP_VERSION = "0.180.0";

export const ZED_HEADERS = {
	VERSION: "x-zed-version",
	EXPIRED_TOKEN: "x-zed-expired-token",
	OUTDATED_TOKEN: "x-zed-outdated-token",
	CLIENT_STATUS: "x-zed-client-supports-status-messages",
	CLIENT_X_AI: "x-zed-client-supports-x-ai",
	CLIENT_STREAM_ENDED: "x-zed-client-supports-stream-ended-request-completion-status",
	SYSTEM_ID: "x-zed-system-id",
} as const;

export function buildZedNativeAppSignInUrl(port: number, publicKey: string, systemId?: string): string {
	const url = new URL("/native_app_signin", ZED_WEB_URL);
	url.searchParams.set("native_app_port", String(port));
	url.searchParams.set("native_app_public_key", publicKey);
	if (systemId) url.searchParams.set("system_id", systemId);
	return url.toString();
}

export interface RsaAuthKeypair {
	publicKeyDerBase64Url: string;
	privateKeyPem: string;
}

/**
 * Generate an RSA-2048 keypair for Zed web sign-in handshake.
 * Public key is exported in PKCS#1 DER format and Base64-URL-Safe encoded.
 */
export function generateZedAuthKeypair(): RsaAuthKeypair {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "der" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});

	const publicKeyDerBase64Url = Buffer.from(publicKey)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { publicKeyDerBase64Url, privateKeyPem: privateKey };
}

/**
 * Decrypt the access token returned in query params from https://zed.dev/native_app_signin.
 * Uses RSA-OAEP with SHA-256 digest (matching Zed V1 encryption format),
 * falling back to PKCS#1 v1.5 if OAEP fails.
 */
export function decryptZedAccessToken(encryptedBase64Url: string, privateKeyPem: string): string {
	let base64 = encryptedBase64Url.replace(/-/g, "+").replace(/_/g, "/");
	while (base64.length % 4 !== 0) base64 += "=";
	const encryptedBuffer = Buffer.from(base64, "base64");

	try {
		const decrypted = privateDecrypt(
			{
				key: privateKeyPem,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			encryptedBuffer,
		);
		return decrypted.toString("utf8");
	} catch {
		// Fallback to legacy PKCS#1 v1.5 padding if server sent V0 format
		const decrypted = privateDecrypt(
			{
				key: privateKeyPem,
				padding: constants.RSA_PKCS1_PADDING,
			},
			encryptedBuffer,
		);
		return decrypted.toString("utf8");
	}
}

/**
 * Parsed Zed credentials structure.
 */
export interface ZedParsedCredentials {
	userId: string;
	accessToken: string;
}

/**
 * Parse a raw credential string (either JSON or space-separated "userId accessToken").
 */
export function parseZedCredentials(apiKeyRaw: string): ZedParsedCredentials {
	const trimmed = apiKeyRaw.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			const userId = String(parsed.userId ?? parsed.accountId ?? parsed.user_id ?? parsed.id ?? "");
			const accessToken = String(parsed.accessToken ?? parsed.access_token ?? parsed.access ?? parsed.token ?? "");
			if (userId && accessToken) {
				return { userId, accessToken };
			}
		} catch {
			// fallback to text split
		}
	}

	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx > 0) {
		const userId = trimmed.slice(0, spaceIdx).trim();
		const accessToken = trimmed.slice(spaceIdx + 1).trim();
		if (userId && accessToken) {
			return { userId, accessToken };
		}
	}

	return {
		userId: "",
		accessToken: trimmed,
	};
}
