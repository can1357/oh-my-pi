import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	isAutoDisabledCredential,
	type OAuthCredential,
	registerOAuthProvider,
	SqliteAuthCredentialStore,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

/** What `omp auth-broker logout` records. */
const LOGGED_OUT_BY_USER = "logged out by user";

const DISABLE_CAUSE =
	'oauth refresh failed: OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}';

function mintOAuth(email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
		accountId: `account-${email}`,
	};
}

describe("disabled credential tombstones", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-disabled-creds-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage?.close();
		await removeWithRetries(tempDir);
	});

	test("sqlite store lists identity + cause + disabledAtMs and never token material", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("dead@example.test"));
		await store!.saveOAuth("openai-codex", mintOAuth("alive@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		await store!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const all = await storage!.credentials.listDisabled();
		expect(all).toHaveLength(1);
		const summary = all[0];
		expect(summary).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "dead@example.test",
			accountId: "account-dead@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(typeof summary.disabledAtMs).toBe("number");
		// Tombstones are display-only: no token bytes may leak through them.
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("access-dead");
		expect(serialized).not.toContain("refresh-dead");

		// Provider filter is exact; a provider with only active rows yields [].
		expect(await storage!.credentials.listDisabled("anthropic")).toHaveLength(1);
		expect(await storage!.credentials.listDisabled("openai-codex")).toHaveLength(0);
	});

	test("sqlite disable returns false for missing or already-disabled rows without overwriting the tombstone", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("once@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		expect(await store!.deleteAuthCredential(row.id + 1, "missing")).toBe(false);
		expect(await store!.deleteAuthCredential(row.id, "original cause")).toBe(true);
		expect(await store!.deleteAuthCredential(row.id, "later cause")).toBe(false);
		expect((await store!.listDisabledCredentials("anthropic"))[0]?.cause).toBe("original cause");
	});

	test("client maps a broker without the endpoint (404) to an empty list", async () => {
		const fetchImpl: typeof fetch = Object.assign(async () => new Response("not found", { status: 404 }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		expect(await client.listDisabledCredentials()).toEqual([]);
	});

	test("a user's removal or logout reads as theirs, also over a login a failure already disabled", async () => {
		// The only login a failure disabled, then the user removes the provider: no active row is left to mark.
		await store!.saveOAuth("anthropic", mintOAuth("failed@example.test"));
		await store!.deleteAuthCredential(store!.listAuthCredentials("anthropic")[0]!.id, DISABLE_CAUSE);
		await storage!.credentials.remove("anthropic");
		// A broker logout of an active login, and of a provider a failure already emptied.
		await store!.saveOAuth("openai-codex", mintOAuth("active@example.test"));
		await store!.deleteAuthCredentials("openai-codex", LOGGED_OUT_BY_USER);
		await store!.saveOAuth("github-copilot", mintOAuth("emptied@example.test"));
		await store!.deleteAuthCredential(store!.listAuthCredentials("github-copilot")[0]!.id, DISABLE_CAUSE);
		await store!.deleteAuthCredentials("github-copilot", LOGGED_OUT_BY_USER);
		// A failure-disabled login of a provider the user did not touch stays recoverable.
		await store!.saveOAuth("google-gemini-cli", mintOAuth("untouched@example.test"));
		await store!.deleteAuthCredential(store!.listAuthCredentials("google-gemini-cli")[0]!.id, DISABLE_CAUSE);

		const recoverable = Object.fromEntries(
			(await storage!.credentials.listDisabled()).map(row => [row.provider, isAutoDisabledCredential(row)]),
		);
		expect(recoverable).toEqual({
			anthropic: false,
			"openai-codex": false,
			"github-copilot": false,
			"google-gemini-cli": true,
		});
	});

	test("removing one account a failure already disabled records the user's removal on it, and only on it", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("first@example.test"));
		await store!.saveOAuth("anthropic", mintOAuth("second@example.test"));
		await storage!.credentials.reload();
		const [first, second] = store!.listAuthCredentials("anthropic");
		await store!.deleteAuthCredential(first!.id, DISABLE_CAUSE);
		await store!.deleteAuthCredential(second!.id, DISABLE_CAUSE);
		await storage!.credentials.reload();

		expect(await storage!.credentials.removeById("anthropic", first!.id)).toBe(true);
		// A per-id removal of another provider's id, or of one already removed, reaches nothing.
		expect(await storage!.credentials.removeById("openai-codex", second!.id)).toBe(false);
		expect(await storage!.credentials.removeById("anthropic", first!.id)).toBe(false);

		const byEmail = Object.fromEntries(
			(await storage!.credentials.listDisabled("anthropic")).map(row => [row.email, isAutoDisabledCredential(row)]),
		);
		expect(byEmail).toEqual({ "first@example.test": false, "second@example.test": true });
	});
});

describe("broker /v1/credentials/disabled round-trip", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "disabled-creds-bearer";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-disabled-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.credentials.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		clientStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: handle.url, token }),
				streamSnapshots: false,
			}),
		);
		await clientStorage.credentials.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		await removeWithRetries(tempDir);
	});

	test("a row disabled on the broker surfaces to remote clients as a tombstone", async () => {
		await serverStore!.saveOAuth("anthropic", mintOAuth("gone@example.test"));
		const row = serverStore!.listAuthCredentials("anthropic")[0];
		await serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const disabled = await clientStorage!.credentials.listDisabled("anthropic");
		expect(disabled).toHaveLength(1);
		expect(disabled[0]).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "gone@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(JSON.stringify(disabled[0])).not.toContain("refresh-gone");
	});

	test("a remote client's removal reaches a login the broker already disabled", async () => {
		await serverStore!.saveOAuth("anthropic", mintOAuth("failed@example.test"));
		await serverStore!.deleteAuthCredential(serverStore!.listAuthCredentials("anthropic")[0]!.id, DISABLE_CAUSE);
		await clientStorage!.credentials.reload();

		await clientStorage!.credentials.remove("anthropic");

		const tombstones = await serverStorage!.credentials.listDisabled("anthropic");
		expect(tombstones.map(row => ({ cause: row.cause, recoverable: isAutoDisabledCredential(row) }))).toEqual([
			{ cause: "deleted by user", recoverable: false },
		]);
	});

	test("a remote client's removal of one account reaches that login after the broker disabled it", async () => {
		await serverStore!.saveOAuth("anthropic", mintOAuth("first@example.test"));
		await serverStore!.saveOAuth("anthropic", mintOAuth("second@example.test"));
		const [first, second] = serverStore!.listAuthCredentials("anthropic");
		await serverStore!.deleteAuthCredential(first!.id, DISABLE_CAUSE);
		await serverStore!.deleteAuthCredential(second!.id, DISABLE_CAUSE);
		await clientStorage!.credentials.reload();

		expect(await clientStorage!.credentials.removeById("anthropic", first!.id)).toBe(true);
		expect(await clientStorage!.credentials.disable(second!.id, "deleted by user")).toBe(true);

		const tombstones = await serverStorage!.credentials.listDisabled("anthropic");
		expect(tombstones.map(row => ({ email: row.email, cause: row.cause }))).toEqual([
			{ email: "first@example.test", cause: "deleted by user" },
			{ email: "second@example.test", cause: "deleted by user" },
		]);
	});

	test("revalidateCredentials re-hydrates broker-side identity changes past a stale snapshot", async () => {
		// Client connected before this credential existed (e.g. a re-login that
		// swapped an org-less row for an org-scoped one while a disk-cached
		// snapshot was still fresh).
		await serverStore!.saveOAuth("anthropic", { ...mintOAuth("late@example.test"), orgId: "org-late" });
		await clientStorage!.credentials.revalidate();
		const rows = clientStorage!.credentials.all().anthropic;
		const list = Array.isArray(rows) ? rows : [rows];
		const late = list.find(entry => entry?.type === "oauth" && entry.email === "late@example.test");
		if (late?.type !== "oauth") throw new Error("expected refreshed oauth credential");
		expect(late.orgId).toBe("org-late");
	});
});

describe("OAuth login stamps authorizedAt", () => {
	const PROVIDER_ID = "test-authorized-at-oauth";
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-authorized-at-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "AuthorizedAt Test",
			sourceId: "authorized-at-test",
			login: async () => ({
				refresh: "refresh-initial",
				access: "access-initial",
				expires: Date.now() + 60_000,
				email: "stamped@example.test",
			}),
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders("authorized-at-test");
		storage?.close();
		await removeWithRetries(tempDir);
	});

	test("login records the interactive-login instant; refresh persists keep it while rotating tokens", async () => {
		const before = Date.now();
		await storage!.oauth.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		const stored = store!.listAuthCredentials(PROVIDER_ID)[0];
		if (stored.credential.type !== "oauth") throw new Error("expected oauth credential");
		const authorizedAt = stored.credential.authorizedAt;
		expect(typeof authorizedAt).toBe("number");
		expect(authorizedAt!).toBeGreaterThanOrEqual(before);
		expect(authorizedAt!).toBeLessThanOrEqual(Date.now());

		// Refresh rotates tokens but must not touch the login anchor — the
		// rebuild in refreshCredentialById previously dropped unknown fields.
		const refreshingStorage = new AuthStorage(store!, {
			refreshOAuthCredential: async () => ({
				access: "access-rotated",
				refresh: "refresh-rotated",
				expires: Date.now() + 120_000,
			}),
		});
		try {
			await refreshingStorage.credentials.reload();
			await refreshingStorage.oauth.refresh(stored.id);
			const after = store!.listAuthCredentials(PROVIDER_ID)[0];
			if (after.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(after.credential.refresh).toBe("refresh-rotated");
			expect(after.credential.authorizedAt).toBe(authorizedAt);
		} finally {
			refreshingStorage.close();
		}
	});
});
