/**
 * Native Devin `Metadata.f` device attestation.
 *
 * The envelope is the released CLI's, reverse-engineered from 3000.10.21:
 * AES-256-GCM under a key derived from the CLI's embedded secret, sealing
 * `device digest|credential|unix nanoseconds`, nonce-prefixed and
 * hex-encoded. The gateway decrypts this field, so its byte format must
 * match the native client exactly.
 *
 * The sealed device identity is OMP's own: SHA-512 over a domain separator
 * and the normalized credential. It is stable per account, distinct across
 * accounts (so `f` cannot link them), and reads no hardware identifiers —
 * the native digest derives from MAC addresses, a board serial, and the OS
 * username, which we deliberately do not collect.
 */

const FINGERPRINT_ENCRYPTION_SECRET = "df97465349f38646af1d66c263e25e08";
const DEVICE_PSEUDONYM_DOMAIN = "omp-devin-private-device-v1";
const encoder = new TextEncoder();

let encryptionKey: Promise<CryptoKey> | undefined;

function hex(bytes: ArrayBuffer): string {
	return Buffer.from(bytes).toString("hex");
}

/** Private OMP device identity: stable per account, distinct across accounts, hardware-free. */
async function createDevicePseudonym(credential: string): Promise<string> {
	const input = encoder.encode(`${DEVICE_PSEUDONYM_DOMAIN}\0${credential}`);
	return hex(await crypto.subtle.digest("SHA-512", input));
}

function getEncryptionKey(): Promise<CryptoKey> {
	if (!encryptionKey) {
		encryptionKey = crypto.subtle
			.digest("SHA-256", encoder.encode(FINGERPRINT_ENCRYPTION_SECRET))
			.then(key => crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]));
	}
	return encryptionKey;
}

function unixEpochNanoseconds(): bigint {
	return BigInt(Math.trunc((performance.timeOrigin + performance.now()) * 1_000_000));
}

/** Seal the native-format `Metadata.f` envelope around OMP's private device identity. */
export async function createDevinFingerprint(credential: string): Promise<string> {
	const plaintext = `${await createDevicePseudonym(credential)}|${credential}|${unixEpochNanoseconds()}`;
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await getEncryptionKey(), encoder.encode(plaintext)),
	);
	const sealed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
	sealed.set(nonce);
	sealed.set(ciphertext, nonce.byteLength);
	return Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength).toString("hex");
}
