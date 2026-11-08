/**
 * Reading a JWT's own claims, without verifying it.
 *
 * Nothing here decides whether a credential may be *sent*: a process has no
 * trusted wall clock, so a token is sent until the provider refuses it. The
 * claims are read to decide whether a client-side cache should be replaced —
 * whether to mint again, never whether to withhold a request.
 */

/** Decodes a JWT payload without verification; `null` for malformed tokens. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		return decoded !== null && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Epoch ms of a JWT `exp` claim minus `skewMs`, or undefined when absent. */
export function jwtExpiryMs(token: string, skewMs = 0): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 - skewMs : undefined;
}
