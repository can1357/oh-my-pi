import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerRefresher } from "@oh-my-pi/pi-ai/auth-broker";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("AuthBrokerRefresher", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-refresher-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("refreshes credentials inside the skew window", async () => {
		const now = 1_700_000_000_000;
		const skew = 5 * 60_000;
		// Credential expires in 1 minute — well within the 5-min skew → must refresh.
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
			access: "fresh",
			refresh: "fresh-refresh",
			expires: now + 2 * 60 * 60_000,
			accountId: "a",
		});

		storage = new AuthStorage(store!);
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: skew,
			now: () => now,
		});
		await refresher.tick();

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		const persisted = store!.getOAuth("anthropic");
		expect(persisted?.access).toBe("fresh");
		expect(persisted?.refresh).toBe("fresh-refresh");
	});

	test("does not refresh credentials safely outside the skew window", async () => {
		const now = 1_700_000_000_000;
		const skew = 5 * 60_000;
		store!.saveOAuth("anthropic", {
			access: "ok",
			refresh: "ok-refresh",
			expires: now + 60 * 60_000, // 1 hour out
			accountId: "a",
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
			access: "should-not-run",
			refresh: "x",
			expires: now,
		});

		storage = new AuthStorage(store!);
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: skew,
			now: () => now,
		});
		await refresher.tick();

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("disables credentials on definitive failure (invalid_grant)", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("invalid_grant"));

		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		await refresher.tick();

		expect(disableEvents).toHaveLength(1);
		expect(disableEvents[0]).toMatch(/invalid_grant/);
		// The active row is now disabled; storage.exportSnapshot reflects it.
		expect(storage.exportSnapshot().credentials).toHaveLength(0);
	});

	test("keeps credentials on transient failures (timeout/network)", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		await refresher.tick();

		expect(disableEvents).toHaveLength(0);
		expect(storage.exportSnapshot().credentials).toHaveLength(1);
	});

	test("does not disable a credential a peer rotated during the refresh (CAS)", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "stale",
			refresh: "stale-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const id = store!.listAuthCredentials("anthropic")[0]!.id;

		// Our refresh fails with a dead-grant error, but a peer (another process /
		// a fresh login) rotates the persisted row to a new token first. The
		// CAS disable must see the row no longer holds the token we attempted and
		// leave the freshly-rotated credential intact instead of clobbering it.
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			store!.updateAuthCredential(id, {
				type: "oauth",
				access: "fresh-from-peer",
				refresh: "fresh-refresh-from-peer",
				expires: now + 60 * 60_000,
				accountId: "a",
			});
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
		});

		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		await refresher.tick();

		expect(disableEvents).toHaveLength(0);
		const rows = store!.listAuthCredentials("anthropic");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.refresh).toBe("fresh-refresh-from-peer");
		}
	});
});
