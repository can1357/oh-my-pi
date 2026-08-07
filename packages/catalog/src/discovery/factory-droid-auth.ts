import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/**
 * Factory Droid credential bridge.
 *
 * The Droid Core subscription LLM proxy (`/api/llm/*`) authenticates with the
 * WorkOS session created by `droid auth login` — Factory API keys only cover
 * the control plane and are rejected with 403 on the data plane. The CLI
 * stores that session in `~/.factory/auth.v2.file`, AES-256-GCM encrypted
 * with a raw 32-byte key kept base64-encoded in `~/.factory/auth.v2.key`
 * (both 0600, same directory). This module mirrors the CLI's credential
 * lifecycle: decrypt on read, refresh through WorkOS's public
 * `user_management/authenticate` endpoint when the access token is within
 * {@link TOKEN_EXPIRY_SKEW_MS} of expiry, and re-encrypt on write so the
 * installed CLI keeps working with the rotated tokens.
 */

const WORKOS_REFRESH_URL = "https://api.workos.com/user_management/authenticate";
/** Public WorkOS client id the Droid CLI uses for its user-management flow. */
const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** droid's encryption.ts: ZVh = 16-byte IV, gL8 = 16-byte GCM auth tag. */
const IV_BYTES = 16;

interface FactoryDroidCredentials {
	access_token: string;
	refresh_token: string;
	active_organization_id?: string;
}

export interface FactoryDroidAuth {
	accessToken: string;
	orgId?: string;
}

function credentialsDir(): string {
	return path.join(os.homedir(), ".factory");
}

function credentialsPath(): string {
	return path.join(credentialsDir(), "auth.v2.file");
}

function keyPath(): string {
	return path.join(credentialsDir(), "auth.v2.key");
}

function encryptCredentials(plaintext: string, key: Buffer): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptCredentials(payload: string, key: Buffer): string {
	const [ivB64, tagB64, dataB64] = payload.split(":");
	if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted data format");
	const iv = Buffer.from(ivB64, "base64");
	const tag = Buffer.from(tagB64, "base64");
	if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Invalid IV or auth tag length");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

function parseCredentials(plaintext: string): FactoryDroidCredentials | null {
	try {
		const parsed: unknown = JSON.parse(plaintext);
		if (
			parsed != null &&
			typeof parsed === "object" &&
			"access_token" in parsed &&
			"refresh_token" in parsed &&
			typeof parsed.access_token === "string" &&
			typeof parsed.refresh_token === "string"
		) {
			const org = "active_organization_id" in parsed ? parsed.active_organization_id : undefined;
			return {
				access_token: parsed.access_token,
				refresh_token: parsed.refresh_token,
				active_organization_id: typeof org === "string" ? org : undefined,
			};
		}
	} catch (error) {
		logger.warn("Factory Droid credentials file is not valid JSON", { error });
	}
	return null;
}

async function readStoredCredentials(): Promise<FactoryDroidCredentials | null> {
	let key: Buffer;
	let payload: string;
	try {
		const keyText = await Bun.file(keyPath()).text();
		key = Buffer.from(keyText.trim(), "base64");
		if (key.length !== 32) return null;
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Factory Droid key file unreadable", { error });
		return null;
	}
	try {
		payload = (await Bun.file(credentialsPath()).text()).trim();
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Factory Droid credentials file unreadable", { error });
		return null;
	}
	try {
		return parseCredentials(decryptCredentials(payload, key));
	} catch (error) {
		logger.warn("Factory Droid credentials decrypt failed", { error });
		return null;
	}
}

async function writeStoredCredentials(credentials: FactoryDroidCredentials): Promise<void> {
	const keyText = await Bun.file(keyPath()).text();
	const key = Buffer.from(keyText.trim(), "base64");
	if (key.length !== 32) throw new Error("Factory Droid key file is invalid");
	await Bun.write(credentialsPath(), encryptCredentials(JSON.stringify(credentials), key));
}

/** Decodes the WorkOS JWT payload without verifying the signature (server verifies). */
export function factoryDroidTokenClaims(accessToken: string): Record<string, unknown> | null {
	const [, payloadSegment] = accessToken.split(".");
	if (!payloadSegment) return null;
	try {
		const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
		return payload != null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Factory's external org id (`X-Factory-Org-Id` header value) from a token's claims. */
export function factoryDroidOrgIdFromToken(accessToken: string): string | undefined {
	const external = factoryDroidTokenClaims(accessToken)?.external_org_id;
	return typeof external === "string" && external.length > 0 ? external : undefined;
}

/** Decodes the JWT payload expiry without verifying the signature (server verifies). */
function accessTokenExpiryMs(accessToken: string): number | null {
	const payload = factoryDroidTokenClaims(accessToken);
	return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

async function refreshStoredCredentials(credentials: FactoryDroidCredentials): Promise<FactoryDroidCredentials> {
	const response = await fetch(WORKOS_REFRESH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh_token,
			client_id: WORKOS_CLIENT_ID,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Factory Droid token refresh failed with ${response.status}: sign in again with \`droid auth login\``,
		);
	}
	const body: unknown = await response.json();
	if (
		body == null ||
		typeof body !== "object" ||
		!("access_token" in body) ||
		!("refresh_token" in body) ||
		typeof body.access_token !== "string" ||
		typeof body.refresh_token !== "string"
	) {
		throw new Error("Factory Droid token refresh returned an unexpected payload");
	}
	const refreshed: FactoryDroidCredentials = {
		access_token: body.access_token,
		refresh_token: body.refresh_token,
		active_organization_id: credentials.active_organization_id,
	};
	// WorkOS rotates refresh tokens on use; persist so the CLI's next run (and
	// ours) keeps working. Matches droid's own CredentialsStorage.save.
	await writeStoredCredentials(refreshed);
	return refreshed;
}

let inflight: Promise<FactoryDroidAuth | null> | null = null;

async function resolveFactoryDroidAuthUncached(): Promise<FactoryDroidAuth | null> {
	// Headless override for environments without a local droid login.
	const envToken = process.env.FACTORY_DROID_ACCESS_TOKEN?.trim();
	if (envToken) {
		return { accessToken: envToken, orgId: process.env.FACTORY_DROID_ORG_ID?.trim() || undefined };
	}
	let credentials = await readStoredCredentials();
	if (!credentials) return null;
	const expiryMs = accessTokenExpiryMs(credentials.access_token);
	if (expiryMs !== null && expiryMs - Date.now() < TOKEN_EXPIRY_SKEW_MS) {
		credentials = await refreshStoredCredentials(credentials);
	}
	return { accessToken: credentials.access_token, orgId: credentials.active_organization_id };
}

/**
 * Resolves a data-plane access token for the Factory LLM proxy, refreshing
 * the stored WorkOS session when expired. Single-flight so concurrent turns
 * share one refresh (WorkOS rotates refresh tokens on use).
 */
export function resolveFactoryDroidAuth(): Promise<FactoryDroidAuth | null> {
	inflight ??= resolveFactoryDroidAuthUncached().finally(() => {
		inflight = null;
	});
	return inflight;
}

/** Test hook: drop the single-flight slot so a retry refreshes again. */
export function resetFactoryDroidAuthForTests(): void {
	inflight = null;
}
