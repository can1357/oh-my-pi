/**
 * OpenAI ChatGPT token-sharing credential identity.
 *
 * Every sign-in registers its own OAuth client, bound to one user and workspace.
 * One ChatGPT user in two workspaces has one subject but two clients, and the
 * credential store must keep them as two rows; a re-login with the same client
 * replaces its own row; a row written before the client qualifier existed is
 * claimed by a login of the same client, not duplicated.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const SUBJECT = "user-subject-1";

function chatgptCredential(suffix: string, clientId: string): AuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: SUBJECT,
		email: "dev@example.com",
		oauthClientId: clientId,
	};
}

function readIdentityKeys(dbPath: string): Array<string | null> {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query("SELECT identity_key FROM auth_credentials WHERE provider = 'openai' ORDER BY id ASC")
			.all() as Array<{ identity_key: string | null }>;
		return rows.map(row => row.identity_key);
	} finally {
		db.close();
	}
}

describe("openai client-scoped credential identity", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-client-identity-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("stores two registrations of one account side by side and updates a re-login in place", async () => {
		if (!store) throw new Error("test setup failed");

		await store.upsertAuthCredential("openai", chatgptCredential("personal", "client-personal"));
		await store.upsertAuthCredential("openai", chatgptCredential("team", "client-team"));

		expect(readIdentityKeys(dbPath)).toEqual([
			`account:${SUBJECT}|client:client-personal`,
			`account:${SUBJECT}|client:client-team`,
		]);

		const rows = await store.upsertAuthCredential("openai", chatgptCredential("personal-renewed", "client-personal"));

		expect(readIdentityKeys(dbPath)).toHaveLength(2);
		const personal = rows.find(
			row => row.credential.type === "oauth" && row.credential.oauthClientId === "client-personal",
		);
		expect(personal?.credential.type === "oauth" && personal.credential.access).toBe("access-personal-renewed");
	});

	it("claims a pre-qualifier row of the same client instead of duplicating it", async () => {
		if (!store) throw new Error("test setup failed");
		await store.upsertAuthCredential("openai", chatgptCredential("old", "client-personal"));
		const legacy = new Database(dbPath);
		try {
			legacy
				.query("UPDATE auth_credentials SET identity_key = ? WHERE provider = 'openai'")
				.run(`account:${SUBJECT}`);
		} finally {
			legacy.close();
		}

		await store.upsertAuthCredential("openai", chatgptCredential("renewed", "client-personal"));

		expect(readIdentityKeys(dbPath)).toEqual([`account:${SUBJECT}|client:client-personal`]);
	});

	it("does not claim a pre-qualifier row that belongs to another client", async () => {
		if (!store) throw new Error("test setup failed");
		await store.upsertAuthCredential("openai", chatgptCredential("old", "client-personal"));
		const legacy = new Database(dbPath);
		try {
			legacy
				.query("UPDATE auth_credentials SET identity_key = ? WHERE provider = 'openai'")
				.run(`account:${SUBJECT}`);
		} finally {
			legacy.close();
		}

		await store.upsertAuthCredential("openai", chatgptCredential("team", "client-team"));

		expect(readIdentityKeys(dbPath)).toEqual([`account:${SUBJECT}`, `account:${SUBJECT}|client:client-team`]);
	});
});
