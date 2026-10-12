import * as path from "node:path";
import { previewLine, sanitizeCarriageReturns, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { SessionTitleSource } from "../session/session-entries";
import { cleanSessionTitle, storedUserTitle } from "../session/session-title-slot";
import { generateNameSuffix } from "../task/name-generator";
import { formatCardTitle, splitCardTitle } from "../utils/title-card";

export const RESERVED_SESSION_NAME_ERROR =
	'Session names cannot be "all" or start with "@" (reserved for broadcast and extension peer namespaces).';

export const SESSION_NAME_TOO_LONG_ERROR =
	"Session name is too long: saved sessions keep only about 150 characters of a name (fewer for non-ASCII), so this session could not be reached by it once stopped.";

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
	if (s.titleSource === "user" && s.sessionName !== undefined) {
		// Listings read a stopped session's name from its fixed-width title slot; live sessions answer to the same.
		const stored = storedUserTitle(s.sessionName);
		if (!isReservedAddress(stored)) return withoutCard(stored);
	}
	return s.directPrint ? null : defaultSessionName(s.cwd, s.sessionId);
}

/** The stored spelling of `requested` if its address is free, else with a two-word suffix; a title card is kept. */
export function claimSessionName(requested: string, taken: ReadonlySet<string>): string {
	const clean = cleanSessionTitle(requested);
	if (isReservedAddress(clean)) throw new Error(RESERVED_SESSION_NAME_ERROR);
	const card = splitCardTitle(clean);
	const bare = card?.title ?? clean;
	let name = bare;
	while (taken.has(name)) name = `${bare}-${generateNameSuffix()}`;
	const claimed = card ? formatCardTitle(card, name) : name;
	if (storedUserTitle(claimed) !== claimed) throw new Error(SESSION_NAME_TOO_LONG_ERROR);
	return claimed;
}

export function formatAddressForUrl(name: string): string {
	return encodeURIComponent(name);
}
