/** SHA-256 base64url fingerprint of a bearer, so token bytes never leave the call site or enter caches. */
export function fingerprintBearer(bearer: string): string {
	return Bun.SHA256.hash(bearer, "base64url");
}
