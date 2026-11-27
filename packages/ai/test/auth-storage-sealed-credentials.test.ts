/**
 * Credential rows sealed under the OS-vault master key: secrets never reach the
 * `data` column in plaintext, plaintext rows stay readable, and the refresh
 * pipeline's compare-and-set still matches rows whose bytes change on every seal.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { CredentialCipher } from "@oh-my-pi/pi-ai/auth/credential-cipher";
import {
	SqliteAuthCredentialStore,
	type SqliteAuthCredentialStoreOptions,
	serializeCredential,
} from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "anthropic";
const login: AuthCredential = {
	type: "oauth",
	access: "ya29.secret-access",
	refresh: "1//secret-refresh",
	expires: 1,
	accountId: "109969486677617556451",
	email: "me@example.com",
};
const rotated: AuthCredential = { ...login, access: "ya29.rotated", refresh: "1//rotated" };

describe("sealed credential rows", () => {
	let dir: TempDir;
	let dbPath: string;
	const cipher = new CredentialCipher(new Uint8Array(32).fill(7));

	const open = (options: SqliteAuthCredentialStoreOptions = {}) =>
		new SqliteAuthCredentialStore(new Database(dbPath), options);

	function rawRows(): Array<{ data: string; salt: string | null }> {
		const db = new Database(dbPath, { readonly: true });
		try {
			return db.query("SELECT data, salt FROM auth_credentials ORDER BY id").all() as Array<{
				data: string;
				salt: string | null;
			}>;
		} finally {
			db.close();
		}
	}

	beforeEach(() => {
		dir = TempDir.createSync("@pi-auth-sealed-");
		dbPath = path.join(dir.path(), "agent.db");
	});

	afterEach(() => {
		dir.removeSync();
	});

	it("seals new rows, reads them back, and leaves earlier plaintext rows readable", async () => {
		const plain = open();
		await plain.upsertAuthCredential("perplexity", { type: "api_key", key: "pplx-plaintext" });
		plain.close();

		const sealing = open({ cipher, encrypt: true });
		await sealing.upsertAuthCredential(PROVIDER, login);
		expect(sealing.listAuthCredentials(PROVIDER).map(row => row.credential)).toEqual([login]);
		expect(sealing.getApiKey("perplexity")).toBe("pplx-plaintext");
		sealing.close();

		const [plainRow, sealedRow] = rawRows();
		expect(plainRow!.salt).toBeNull();
		expect(sealedRow!.salt).not.toBeNull();
		expect(sealedRow!.data).not.toContain("secret");
		expect(sealedRow!.data).not.toContain("me@example.com");

		// Without the key the sealed login is skipped like a corrupt row; the rest still loads.
		const locked = open();
		expect(locked.listAuthCredentials().map(row => row.provider)).toEqual(["perplexity"]);
		locked.close();

		const otherKey = open({ cipher: new CredentialCipher(new Uint8Array(32).fill(9)) });
		expect(otherKey.listAuthCredentials(PROVIDER)).toEqual([]);
		otherKey.close();
	});

	it("compare-and-sets a sealed row by its opened contents", async () => {
		const store = open({ cipher, encrypt: true });
		const [stored] = await store.upsertAuthCredential(PROVIDER, login);
		const expected = serializeCredential(PROVIDER, login)!.data;

		expect(store.tryUpdateAuthCredentialIfMatches(stored!.id, expected, rotated)).toBe(true);
		expect(store.listAuthCredentials(PROVIDER)[0]!.credential).toEqual(rotated);
		// A peer already rotated the row: the stale expectation must miss.
		expect(store.tryUpdateAuthCredentialIfMatches(stored!.id, expected, login)).toBe(false);
		expect(store.tryDisableAuthCredentialIfMatches(stored!.id, expected, "refresh failed")).toBe(false);

		const current = serializeCredential(PROVIDER, rotated)!.data;
		expect(store.tryDisableAuthCredentialIfMatches(stored!.id, current, "refresh failed")).toBe(true);
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		store.close();
	});

	it("auto keeps a plaintext store plaintext and an encrypted store encrypted", async () => {
		const plain = open({ cipher });
		await plain.upsertAuthCredential("perplexity", { type: "api_key", key: "pplx-plaintext" });
		await plain.unlock({ encrypt: "auto" });
		await plain.upsertAuthCredential("zai", { type: "api_key", key: "zai-plaintext" });
		plain.close();
		expect(rawRows().map(row => row.salt === null)).toEqual([true, true]);

		dir.removeSync();
		dir = TempDir.createSync("@pi-auth-sealed-");
		dbPath = path.join(dir.path(), "agent.db");
		const sealing = open({ cipher, encrypt: true });
		await sealing.upsertAuthCredential(PROVIDER, login);
		sealing.close();
		const auto = open({ cipher });
		await auto.unlock({ encrypt: "auto" });
		await auto.upsertAuthCredential("perplexity", { type: "api_key", key: "pplx-new" });
		auto.close();
		expect(rawRows().map(row => row.salt === null)).toEqual([false, false]);
	});

	it("opting out writes plaintext but still opens rows sealed earlier", async () => {
		const sealing = open({ cipher, encrypt: true });
		await sealing.upsertAuthCredential(PROVIDER, login);
		sealing.close();

		const optedOut = open({ cipher });
		await optedOut.upsertAuthCredential("perplexity", { type: "api_key", key: "pplx-new" });
		expect(optedOut.listAuthCredentials(PROVIDER).map(row => row.credential)).toEqual([login]);
		optedOut.close();

		expect(rawRows().map(row => row.salt === null)).toEqual([false, true]);
	});
});
