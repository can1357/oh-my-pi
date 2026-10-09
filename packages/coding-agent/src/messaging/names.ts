import * as path from "node:path";
import { previewLine, sanitizeCarriageReturns, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { SessionTitleSource } from "../session/session-entries";
import { generateNameSuffix } from "../task/name-generator";
import { formatCardTitle, splitCardTitle } from "../utils/title-card";
import { MAX_PEER_TEXT_CHARS } from "./protocol";

export const RESERVED_SESSION_NAME_ERROR =
	'Session names cannot be "all" or start with "@" (reserved for broadcast and extension peer namespaces).';

/** Below the wire cap so a collision suffix still fits. */
const MAX_SESSION_NAME_CHARS = MAX_PEER_TEXT_CHARS - 96;
export const SESSION_NAME_TOO_LONG_ERROR = `Session names can be at most ${MAX_SESSION_NAME_CHARS} characters.`;

/** Peer-supplied text for a one-line UI slot: terminal escapes and controls stripped, whitespace collapsed, width-bounded. */
export function peerDisplayText(text: string, maxWidth: number = TRUNCATE_LENGTHS.LINE): string {
	return previewLine(sanitizeText(sanitizeCarriageReturns(text)), maxWidth);
}

/** A title card (`🧪 BETA: beta`) is display decoration; a session answers to the title without it. */
function withoutCard(name: string): string {
	return splitCardTitle(name)?.title ?? name;
}

export function isReservedAddress(name: string): boolean {
	const bare = withoutCard(name);
	return bare === "all" || bare.startsWith("@");
}

export function sessionShortId(sessionId: string): string {
	return new Bun.CryptoHasher("sha256").update(sessionId).digest("hex").slice(0, 8);
}

export function defaultSessionName(cwd: string, sessionId: string): string {
	const slug =
		path
			.basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "session";
	return `${slug}-${sessionShortId(sessionId).slice(0, 2)}`;
}

export function sessionAddress(s: {
	cwd: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	directPrint: boolean;
}): string | null {
	if (s.titleSource === "user" && s.sessionName !== undefined && !isReservedAddress(s.sessionName))
		return withoutCard(s.sessionName);
	return s.directPrint ? null : defaultSessionName(s.cwd, s.sessionId);
}

/** `requested` if its address is free, else with a two-word suffix; a title card is kept. */
export function claimSessionName(requested: string, taken: ReadonlySet<string>): string {
	if (isReservedAddress(requested)) throw new Error(RESERVED_SESSION_NAME_ERROR);
	const card = splitCardTitle(requested);
	const bare = card?.title ?? requested;
	if (bare.length > MAX_SESSION_NAME_CHARS) throw new Error(SESSION_NAME_TOO_LONG_ERROR);
	let name = bare;
	while (taken.has(name)) name = `${bare}-${generateNameSuffix()}`;
	return card ? formatCardTitle(card, name) : name;
}

export function formatAddressForUrl(name: string): string {
	return encodeURIComponent(name);
}

export function encodeAddressForUrl(name: string): string {
	return encodeURIComponent(name);
}
