import * as path from "node:path";
import type { SessionTitleSource } from "../session/session-entries";
import { generateNameSuffix } from "../task/name-generator";

export function isReservedAddress(name: string): boolean {
	return name.startsWith("@");
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
		return s.sessionName;
	return s.directPrint ? null : defaultSessionName(s.cwd, s.sessionId);
}

export function claimSessionName(requested: string, taken: ReadonlySet<string>): string {
	if (isReservedAddress(requested))
		throw new Error('Session names can\'t start with "@" (reserved for extension peer namespaces).');
	let name = requested;
	while (taken.has(name)) name = `${requested}-${generateNameSuffix()}`;
	return name;
}

export function formatAddressForUrl(name: string): string {
	return encodeURIComponent(name);
}

export function encodeAddressForUrl(name: string): string {
	return encodeURIComponent(name);
}
