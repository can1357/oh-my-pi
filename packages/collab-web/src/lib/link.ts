/**
 * Collab link + wire-envelope handling (browser-safe vendored mirror of the
 * link/envelope half of `@oh-my-pi/pi-coding-agent/src/collab/protocol.ts`;
 * base64url goes through atob/btoa instead of Buffer).
 *
 * Link format: `wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`
 * Wire envelope: `[4B uint32 BE peerId][sealed payload]` — the guest always
 * sends peerId 0; the relay rewrites it to the sender's id.
 */

import type { ParsedCollabLink } from "@oh-my-pi/pi-wire";
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "@oh-my-pi/pi-wire";

export { COLLAB_PROTO } from "@oh-my-pi/pi-wire";
export type { ParsedCollabLink };
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

// ═══════════════════════════════════════════════════════════════════════════
// base64url (no Buffer in the browser)
// ═══════════════════════════════════════════════════════════════════════════

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: string): Uint8Array | null {
	if (!B64URL_RE.test(text)) return null;
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope
// ═══════════════════════════════════════════════════════════════════════════

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format
// ═══════════════════════════════════════════════════════════════════════════

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !LOCAL_HOSTNAMES[url.hostname]) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Render the shareable link. Compact forms: the default relay collapses to
 * `<roomId>.<key>`; custom wss relays drop the scheme (`host[:port]/r/…`);
 * plain-ws localhost relays keep the full `ws://` URL.
 *
 * The room secret is dot-joined (`<roomId>.<key>`) rather than `#`-joined:
 * RFC 3986 forbids a raw `#` inside a fragment, so strict URL stacks (macOS
 * Foundation behind terminal click-to-open) percent-encode a second `#` to
 * `%23` and break the link. Parsers still accept the legacy `#` form and the
 * mangled `%23` form.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare key.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	let secret = key;
	if (writeToken) {
		secret = new Uint8Array(key.byteLength + writeToken.byteLength);
		secret.set(key, 0);
		secret.set(writeToken, key.byteLength);
	}
	const keyText = encodeBase64Url(secret);
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}.${keyText}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1] as string;
	// Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
	// carry it in the fragment (`/r/<roomId>#<key>`).
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = decodeBase64Url(fragment);
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
