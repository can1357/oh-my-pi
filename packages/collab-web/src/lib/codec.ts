/**
 * AES-256-GCM sealing for collab frames (browser-safe vendored mirror of
 * `@oh-my-pi/pi-coding-agent/src/collab/crypto.ts` — WebCrypto only).
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`.
 */
import type { WireFrame } from "@oh-my-pi/pi-wire";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * `crypto.subtle` only exists in secure contexts (https:// or localhost). Pages served over plain
 * http from a LAN address get `undefined`, which would otherwise surface as a cryptic TypeError.
 */
export const INSECURE_CONTEXT_ERROR =
	"This page isn't a secure context, so the browser disables the encryption collab needs. Open it over https:// or from localhost.";

function subtle(): SubtleCrypto {
	const api = globalThis.crypto?.subtle;
	if (!api) throw new Error(INSECURE_CONTEXT_ERROR);
	return api;
}

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(KEY_LENGTH);
	crypto.getRandomValues(key);
	return key;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== KEY_LENGTH) {
		throw new Error(`Room key must be ${KEY_LENGTH} bytes, got ${raw.byteLength}`);
	}
	return subtle().importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, frame: WireFrame): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
	const ciphertext = new Uint8Array(await subtle().encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export async function open(key: CryptoKey, data: Uint8Array): Promise<WireFrame> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = asStrict(data.subarray(0, IV_LENGTH));
	const ciphertext = asStrict(data.subarray(IV_LENGTH));
	const plaintext = new Uint8Array(await subtle().decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as WireFrame;
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
