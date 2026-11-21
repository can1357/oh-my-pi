/**
 * OSCrypt on macOS: a browser's keychain entry (for example "Chrome Safe Storage"), AES-128-CBC with a space IV and a
 * `v10` envelope. Used for `*_encrypted_hash` authenticators, which Chrome validates before the legacy HMAC.
 */
import { createCipheriv, pbkdf2Sync } from "node:crypto";

const KEYCHAIN_SALT = "saltysalt";
const KEYCHAIN_ITERATIONS = 1003;
const CIPHERTEXT_PREFIX = Buffer.from("v10");
const IV = Buffer.alloc(16, 0x20);

const keys = new Map<string, Buffer>();

/** Derives a browser's OSCrypt key (`components/os_crypt`), cached per keychain entry for the process. */
function keychainKey(service: string): Buffer {
	const cached = keys.get(service);
	if (cached) return cached;
	const result = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"]);
	if (result.exitCode !== 0) throw new Error(`Could not read '${service}' from the login keychain.`);
	const key = pbkdf2Sync(result.stdout.toString().trim(), KEYCHAIN_SALT, KEYCHAIN_ITERATIONS, 16, "sha1");
	keys.set(service, key);
	return key;
}

/** Encrypts `data` the way `os_crypt_async::Encryptor` does on macOS: base64 of `v10` + AES-128-CBC. */
export function encryptString(keychainService: string, data: Buffer): string {
	const cipher = createCipheriv("aes-128-cbc", keychainKey(keychainService), IV);
	return Buffer.concat([CIPHERTEXT_PREFIX, cipher.update(data), cipher.final()]).toString("base64");
}
