/**
 * Encryption at rest for the credential store's `data` column.
 *
 * A 256-bit master key lives in the OS credential vault (macOS Keychain, Windows
 * Credential Manager, a Secret Service keyring on Linux). Every sealed row
 * carries its own random salt; HKDF-SHA256 derives that row's AES-256-GCM key and
 * nonce from the master key and the salt, so no key/nonce pair repeats. Hosts
 * without a vault (headless Linux, WSL, containers, macOS with `HOME` pointed away
 * from the login keychain) get no cipher, and their credentials stay plaintext in
 * the owner-only `agent.db`.
 *
 * Uses `node:crypto`: the SQLite store is synchronous and WebCrypto is not.
 *
 * @example
 * ```ts ignore
 * const cipher = await loadCredentialCipher({ create: true });
 * const sealed = cipher?.seal(JSON.stringify(credential));
 * const data = sealed && cipher?.open(sealed);
 * ```
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";

/** The master key's vault entry, shared by every agent dir and profile on this machine. */
const VAULT_ENTRY = { service: "sh.omp.agent", name: "credential-key" } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = Buffer.from("omp credential v1");
/** Tests and the CLIs they spawn (which inherit `NODE_ENV=test`) never reach the real vault. */
const TEST_PROCESS = isBunTestRuntime() || Bun.env.NODE_ENV === "test" || Bun.env.BUN_ENV === "test";

/** A sealed `data` column and the per-row salt it was sealed with, both base64. */
export interface SealedCredential {
	data: string;
	salt: string;
}

/** AES-256-GCM sealing of credential rows under one master key. */
export class CredentialCipher {
	readonly #key: Buffer;

	/** @throws {Error} when `masterKey` is not 32 bytes. */
	constructor(masterKey: Uint8Array) {
		if (masterKey.byteLength !== KEY_BYTES) throw new Error(`Credential master key must be ${KEY_BYTES} bytes`);
		this.#key = Buffer.from(masterKey);
	}

	/** Seal `plaintext` under a fresh salt. */
	seal(plaintext: string): SealedCredential {
		const salt = randomBytes(SALT_BYTES);
		const { key, nonce } = this.#derive(salt);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
		return { data: data.toString("base64"), salt: salt.toString("base64") };
	}

	/**
	 * The plaintext of a {@link seal}ed row.
	 * @throws {Error} when the row was sealed under another master key or altered.
	 */
	open(sealed: SealedCredential): string {
		const bytes = Buffer.from(sealed.data, "base64");
		if (bytes.length < TAG_BYTES) throw new Error("Sealed credential is truncated");
		const { key, nonce } = this.#derive(Buffer.from(sealed.salt, "base64"));
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
		return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString(
			"utf8",
		);
	}

	#derive(salt: Buffer): { key: Buffer; nonce: Buffer } {
		const okm = Buffer.from(hkdfSync("sha256", this.#key, salt, HKDF_INFO, KEY_BYTES + NONCE_BYTES));
		return { key: okm.subarray(0, KEY_BYTES), nonce: okm.subarray(KEY_BYTES) };
	}
}

let unlocked: CredentialCipher | undefined;

/**
 * Whether storing a vault entry can land without a dialog. macOS resolves the
 * user's keychains under `$HOME`; with HOME overridden (test harnesses spawning
 * the CLI, sandboxes) there is no default keychain, reads quietly find nothing,
 * and a store pops "Keychain Not Found" instead of failing.
 */
async function vaultWritable(): Promise<boolean> {
	if (process.platform !== "darwin") return true;
	return Bun.file(path.join(os.homedir(), "Library", "Keychains", "login.keychain-db")).exists();
}

/**
 * The cipher for the master key in the OS credential vault; with `create`, a
 * missing key is generated and stored first. Memoized once found. `undefined`
 * when the vault is unavailable or, without `create`, holds no key. Callers that
 * create serialize across processes themselves (`SqliteAuthCredentialStore.unlock`
 * holds the database write lock), or two first runs could each seal rows under a
 * key the other overwrote. Test processes get no cipher.
 */
export async function loadCredentialCipher(options: { create?: boolean } = {}): Promise<CredentialCipher | undefined> {
	if (unlocked) return unlocked;
	if (TEST_PROCESS) return undefined;
	try {
		let stored = await Bun.secrets.get(VAULT_ENTRY);
		if (stored === null && options.create && (await vaultWritable())) {
			await Bun.secrets.set({ ...VAULT_ENTRY, value: randomBytes(KEY_BYTES).toString("base64") });
			// Seal under what the vault returns, not what was handed to it.
			stored = await Bun.secrets.get(VAULT_ENTRY);
		}
		if (stored === null) return undefined;
		const key = Buffer.from(stored, "base64");
		if (key.length !== KEY_BYTES) {
			logger.warn("The credential master key in the OS vault is malformed; credentials stay unencrypted", {
				service: VAULT_ENTRY.service,
				name: VAULT_ENTRY.name,
			});
			return undefined;
		}
		unlocked = new CredentialCipher(key);
		return unlocked;
	} catch (error) {
		logger.debug("OS credential vault unavailable; credentials stay unencrypted", { error });
		return undefined;
	}
}

/**
 * Whether this host's OS vault can hold the master key without asking anyone:
 * a read of the (possibly missing) entry, which never prompts, must succeed.
 * Headless hosts (SSH sessions, CI, Linux without a display) and tests answer
 * `false` without touching the vault.
 */
export async function credentialVaultAvailable(): Promise<boolean> {
	const env = Bun.env;
	const headless =
		Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT || env.CI) ||
		(process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
	if (TEST_PROCESS || headless) return false;
	try {
		await Bun.secrets.get(VAULT_ENTRY);
		return true;
	} catch (error) {
		logger.debug("OS credential vault unavailable; new credentials stay unencrypted", { error });
		return false;
	}
}

/**
 * The master key in the OS vault, base64, for moving it to another machine
 * (`omp auth key`); `null` when the vault holds none.
 * @throws {Error} when the vault is unavailable, or in a test process.
 */
export async function readCredentialMasterKey(): Promise<string | null> {
	if (TEST_PROCESS) throw new Error("The OS credential vault is off limits to tests");
	return Bun.secrets.get(VAULT_ENTRY);
}

/**
 * Replace the master key in the OS vault and use it for the rest of this process.
 * `SqliteAuthCredentialStore.rekey` calls it while holding re-sealed rows uncommitted.
 * @throws {Error} when the vault is unavailable, or in a test process.
 */
export async function storeCredentialMasterKey(masterKey: Uint8Array): Promise<CredentialCipher> {
	if (TEST_PROCESS) throw new Error("The OS credential vault is off limits to tests");
	const cipher = new CredentialCipher(masterKey);
	await Bun.secrets.set({ ...VAULT_ENTRY, value: Buffer.from(masterKey).toString("base64") });
	unlocked = cipher;
	return cipher;
}

/** The cipher an earlier {@link loadCredentialCipher} found in this process; lets synchronous openers read sealed rows. */
export function unlockedCredentialCipher(): CredentialCipher | undefined {
	return unlocked;
}
