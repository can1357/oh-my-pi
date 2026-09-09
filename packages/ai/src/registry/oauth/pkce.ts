/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(96);
	crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = Buffer.from(hashBuffer).toString("base64url");

	return { verifier, challenge };
}
