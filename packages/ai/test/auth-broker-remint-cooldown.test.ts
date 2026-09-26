import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, withAuth } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AuthBrokerRefresher,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "openai-codex";
const DAY_MS = 24 * 60 * 60_000;

// Issue #13350: an upstream outage answering 401 for every valid bearer made
// each auth retry re-mint the credential twice through the broker (step (b)
// force-refresh, then step (c) `markCredentialSuspect`), rotating the refresh
// token and bumping the broker generation on every cycle, indefinitely.
describe("auth-broker refresh-then-401", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let clientStorage: AuthStorage | undefined;
	let upstreamRefreshes = 0;
	let clockOffset = 0;

	beforeEach(async () => {
		upstreamRefreshes = 0;
		clockOffset = 0;
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			upstreamRefreshes += 1;
			return {
				...credential,
				access: `minted-${upstreamRefreshes}`,
				refresh: `refresh-${upstreamRefreshes}`,
				expires: Date.now() + 10 * DAY_MS,
			};
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remint-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		await serverStore.saveOAuth(PROVIDER, {
			access: "valid",
			refresh: "refresh-0",
			expires: Date.now() + 10 * DAY_MS,
			accountId: "account-25",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.credentials.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: ["remint-bearer"],
			disableRefresher: true,
		});
		const client = new AuthBrokerClient({ url: handle.url, token: "remint-bearer" });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected snapshot");
		clientStorage = new AuthStorage(
			new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false }),
		);
		await clientStorage.credentials.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
	});

	/** Run one request that the provider rejects with 401 on every bearer. */
	async function failingCycle(): Promise<{ bearers: string[]; refreshes: number }> {
		const refreshesBefore = upstreamRefreshes;
		const bearers: string[] = [];
		await expect(
			withAuth(clientStorage!.keys.resolver(PROVIDER, { sessionId: "worker" }), async key => {
				bearers.push(key);
				throw Object.assign(new Error("401 invalid_api_key"), { status: 401 });
			}),
		).rejects.toThrow("401 invalid_api_key");
		// Outlive the 60 s post-401 credential block, like the outer turn retry.
		clockOffset += 90_000;
		return { bearers, refreshes: upstreamRefreshes - refreshesBefore };
	}

	test("re-mints once, then reuses the freshly minted token instead of rotating it every retry", async () => {
		const generationBefore = serverStorage!.credentials.generation;
		expect(await failingCycle()).toEqual({ bearers: ["valid", "minted-1"], refreshes: 1 });
		const generationAfterFirstCycle = serverStorage!.credentials.generation;
		expect(await failingCycle()).toEqual({ bearers: ["minted-1"], refreshes: 0 });
		// Only the credential block is written, not refresh-start/credential churn.
		expect(serverStorage!.credentials.generation - generationAfterFirstCycle).toBeLessThan(
			generationAfterFirstCycle - generationBefore,
		);

		// Well past the re-mint cooldown, a 401 may again mean a stale grant.
		clockOffset += 60 * 60_000;
		expect(await failingCycle()).toEqual({ bearers: ["minted-1", "minted-2"], refreshes: 1 });
	});

	test("the broker's scheduled expiry sweep still mints a token refreshed moments ago", async () => {
		expect(await failingCycle()).toEqual({ bearers: ["valid", "minted-1"], refreshes: 1 });
		// A window wider than the minted token's lifetime makes every row due.
		await new AuthBrokerRefresher({ storage: serverStorage!, refreshSkewMs: 11 * DAY_MS }).tick();
		expect(upstreamRefreshes).toBe(2);
	});
});
