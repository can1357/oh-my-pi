/**
 * DPoP (RFC 9449) proofs for token endpoints that bind refresh tokens to a
 * device key.
 *
 * Keys are ES256 (P-256) pairs generated on this device. Callers persist the
 * private JWK ({@link DpopPrivateJwk}) on the credential it binds (`dpopKey`) and import it
 * as a non-extractable WebCrypto key to sign. WebCrypto ECDSA signatures are
 * raw `r || s` (IEEE P1363), the JWS encoding; DER signatures are rejected by
 * verifiers.
 *
 * @example
 * ```ts ignore
 * const { key, privateJwk } = await generateDpopKey();
 * const proof = await signDpopProof(key, { htm: "POST", htu: TOKEN_URL, jti: randomDpopJti() });
 * await fetch(TOKEN_URL, { method: "POST", headers: { DPoP: proof }, body });
 * ```
 */
import { isRecord } from "@oh-my-pi/pi-utils";

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGNATURE = { name: "ECDSA", hash: "SHA-256" } as const;

/** Public half of a DPoP key as sent in the proof's `jwk` header: exactly `kty`, `crv`, `x` and `y`. */
export interface DpopPublicJwk {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
}

/** The private JWK members a stored key needs; WebCrypto's `ext` and `key_ops` are dropped. */
export interface DpopPrivateJwk extends DpopPublicJwk {
	d: string;
}

/** A key ready to sign proofs; the private half cannot be exported. */
export interface DpopKey {
	readonly privateKey: CryptoKey;
	readonly jwk: DpopPublicJwk;
}

/** Claims of one proof (RFC 9449 §4.2); `iat` defaults to now. */
export interface DpopProofClaims {
	htm: string;
	htu: string;
	jti: string;
	nonce?: string;
	iat?: number;
}

function base64Url(data: ArrayBuffer | Uint8Array | string): string {
	return Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)).toString(
		"base64url",
	);
}

/** `value` as a P-256 private JWK, or `undefined` when it is not one. */
export function parseDpopPrivateJwk(value: unknown): DpopPrivateJwk | undefined {
	if (!isRecord(value)) return undefined;
	const { kty, crv, x, y, d } = value;
	if (kty !== "EC" || crv !== "P-256") return undefined;
	if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") return undefined;
	return { kty, crv, x, y, d };
}

/** Import a stored private JWK as a non-extractable signing key. */
export async function importDpopKey(stored: DpopPrivateJwk): Promise<DpopKey> {
	const privateKey = await crypto.subtle.importKey("jwk", stored, ALGORITHM, false, ["sign"]);
	return { privateKey, jwk: { kty: stored.kty, crv: stored.crv, x: stored.x, y: stored.y } };
}

/** Generate a fresh P-256 key; returns the signing key and the private JWK to persist. */
export async function generateDpopKey(): Promise<{ key: DpopKey; privateJwk: DpopPrivateJwk }> {
	const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
	const privateJwk = parseDpopPrivateJwk(await crypto.subtle.exportKey("jwk", pair.privateKey));
	if (!privateJwk) throw new Error("WebCrypto exported an unexpected P-256 JWK");
	return { key: await importDpopKey(privateJwk), privateJwk };
}

/** Sign a compact `dpop+jwt` proof with `key`. */
export async function signDpopProof(key: DpopKey, claims: DpopProofClaims): Promise<string> {
	const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk };
	const payload = {
		jti: claims.jti,
		htm: claims.htm,
		htu: claims.htu,
		iat: claims.iat ?? Math.floor(Date.now() / 1000),
		...(claims.nonce === undefined ? {} : { nonce: claims.nonce }),
	};
	const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(SIGNATURE, key.privateKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64Url(signature)}`;
}

/** A fresh random `jti` (24 bytes, base64url). */
export function randomDpopJti(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}
