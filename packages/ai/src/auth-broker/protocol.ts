/**
 * Auth-broker wire-protocol helpers shared by the server and the client store.
 */
import type { CredentialBlockSnapshot } from "./types";

/** Parse a snapshot `ETag` / `If-None-Match` value (`"N"`, `W/"N"`, or bare `N`) into a generation. */
export function parseGenerationTag(header: string | null): number | undefined {
	if (!header) return undefined;
	let value = header.trim();
	if (value.startsWith("W/")) value = value.slice(2).trim();
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1);
	}
	const generation = Number(value);
	if (!Number.isInteger(generation) || generation < 0) return undefined;
	return generation;
}

/**
 * Canonical order for a credential's block snapshots. The server and the client
 * store both sort with it, because block lists are compared positionally; the
 * `updatedAtMs` tiebreak keeps otherwise-identical blocks in one stable order.
 */
export function compareCredentialBlockSnapshots(a: CredentialBlockSnapshot, b: CredentialBlockSnapshot): number {
	const provider = a.providerKey.localeCompare(b.providerKey);
	if (provider !== 0) return provider;
	const scope = a.blockScope.localeCompare(b.blockScope);
	if (scope !== 0) return scope;
	const blockedUntil = a.blockedUntilMs - b.blockedUntilMs;
	if (blockedUntil !== 0) return blockedUntil;
	return (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0);
}
