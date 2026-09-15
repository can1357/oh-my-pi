import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	AuthStorage,
	type CredentialDisabledEvent,
	isActionableCredentialDisable,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	type CredentialBlockResponse,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { snapshotResponseSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { removeWithRetries } from "../../utils/src/temp";

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("RemoteAuthCredentialStore + AuthStorage integration", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "remote-bearer";
	let testUsageProviders: Map<string, UsageProvider> | undefined;

	beforeEach(async () => {
		testUsageProviders = undefined;
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		serverStore.saveOAuth("anthropic", {
			access: "server-access-1",
			refresh: "server-refresh-1",
			expires: Date.now() - 60_000, // expired so refresh is forced
			accountId: "account-1",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore, {
			usageProviderResolver: provider =>
				testUsageProviders
					? testUsageProviders.get(provider)
					: provider === "anthropic"
						? claudeUsage.claudeUsageProvider
						: undefined,
		});
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		testUsageProviders = undefined;
		vi.restoreAllMocks();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	for (const operation of ["refreshSnapshot", "waitForFreshSnapshot", "background"] as const) {
		test.each(["replace", "sign-out"] as const)(
			`delayed ${operation} cannot roll back newer broker %s`,
			async change => {
				const responseReady = Promise.withResolvers<void>();
				const releaseResponse = Promise.withResolvers<void>();
				const nextPoll = Promise.withResolvers<void>();
				const releaseNextPoll = Promise.withResolvers<void>();
				const client = new AuthBrokerClient({ url: handle!.url, token });
				const fetchSnapshot = client.fetchSnapshot.bind(client);
				let held = false;
				vi.spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
					const background = opts?.waitMs === 30_000;
					if (held && background) {
						nextPoll.resolve();
						await releaseNextPoll.promise;
					}
					const result = await fetchSnapshot(opts);
					if (!held && background === (operation === "background")) {
						held = true;
						responseReady.resolve();
						await releaseResponse.promise;
					}
					return result;
				});
				const remote = new RemoteAuthCredentialStore({ client, streamSnapshots: operation !== "background" });
				let pending: Promise<SnapshotResponse | boolean> | undefined;
				try {
					if (operation !== "background") {
						await waitUntil(() => remote.snapshot.credentials.length === 1);
						pending = operation === "refreshSnapshot" ? remote.refreshSnapshot() : remote.waitForFreshSnapshot(0);
					}
					await responseReady.promise;
					if (change === "replace") {
						serverStorage!.upsertCredential("anthropic", {
							type: "oauth",
							access: "newer-broker-access",
							refresh: "newer-broker-refresh",
							expires: Date.now() + 60_000,
							email: "a@example.com",
							accountId: "account-1",
						});
					} else {
						await serverStorage!.remove("anthropic");
					}
					if (operation === "background") await remote.refreshSnapshot();
					await waitUntil(() => {
						const credential = remote.snapshot.credentials[0]?.credential;
						return change === "sign-out"
							? remote.snapshot.credentials.length === 0
							: credential?.type === "oauth" && credential.access === "newer-broker-access";
					});
					const current = remote.snapshot;
					releaseResponse.resolve();
					const returned = pending ? await pending : await nextPoll.promise;
					if (operation === "refreshSnapshot") expect(returned).toEqual(current);
					if (operation === "waitForFreshSnapshot") expect(returned).toBe(true);
					expect(remote.snapshot).toEqual(current);
					await Bun.sleep(0);
					expect(remote.snapshot).toEqual(current);
					expect(remote.listAuthCredentials("anthropic").map(row => row.credential)).toEqual(
						current.credentials.map(entry => entry.credential),
					);
				} finally {
					remote.close();
					releaseResponse.resolve();
					releaseNextPoll.resolve();
					await pending?.catch(() => {});
				}
			},
		);
	}

	test.each(["refreshSnapshot", "waitForFreshSnapshot", "background", "stream"] as const)(
		"resynchronizes a cached generation from a prior broker process (%s)",
		async operation => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected snapshot");
			const remote = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: { ...initial.snapshot, generation: initial.generation + 100, credentials: [] },
				streamSnapshots: operation === "stream",
				backgroundIdleMs: operation === "background" || operation === "stream" ? 20_000 : 0,
			});
			try {
				if (operation === "refreshSnapshot") {
					expect((await remote.refreshSnapshot()).credentials).toEqual(initial.snapshot.credentials);
				} else if (operation === "waitForFreshSnapshot") {
					expect(await remote.waitForFreshSnapshot(0)).toBe(true);
				}
				await waitUntil(() => remote.snapshot.generation === initial.generation);
				expect(remote.listAuthCredentials("anthropic").map(row => row.credential)).toEqual(
					initial.snapshot.credentials.map(entry => entry.credential),
				);
			} finally {
				remote.close();
			}
		},
	);

	test("delayed stream bootstrap cannot undo a newer foreground snapshot", async () => {
		const responseReady = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		const applied = Promise.withResolvers<void>();
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const openStream = client.openSnapshotStream.bind(client);
		vi.spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			for await (const event of openStream(opts)) {
				if (event.kind === "snapshot") {
					responseReady.resolve();
					await releaseResponse.promise;
				}
				yield event;
				applied.resolve();
			}
		});
		const remote = new RemoteAuthCredentialStore({ client });
		try {
			await responseReady.promise;
			await serverStorage!.remove("anthropic");
			const current = await remote.refreshSnapshot();
			expect(current.credentials).toEqual([]);
			releaseResponse.resolve();
			await applied.promise;
			expect(remote.snapshot).toEqual(current);
			await Bun.sleep(0);
			expect(remote.listAuthCredentials("anthropic")).toEqual([]);
		} finally {
			releaseResponse.resolve();
			remote.close();
		}
	});

	test("stream reconnect resynchronizes a restarted broker and continues applying deltas", async () => {
		serverStorage!.upsertCredential("kagi", { type: "api_key", key: "initial-key" });
		serverStorage!.upsertCredential("kagi", { type: "api_key", key: "before-restart" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const remote = new RemoteAuthCredentialStore({ client });
		try {
			await waitUntil(() => remote.snapshot.generation === serverStorage!.getGeneration());
			const previousGeneration = remote.snapshot.generation;
			const url = new URL(handle!.url);
			await handle!.close();
			serverStorage!.close();
			serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			serverStore!.saveApiKey("kagi", "after-restart");
			serverStorage = new AuthStorage(serverStore!);
			await serverStorage.reload();
			handle = startAuthBroker({
				storage: serverStorage,
				bind: url.host,
				bearerTokens: [token],
				disableRefresher: true,
			});
			await waitUntil(() =>
				remote
					.listAuthCredentials("kagi")
					.some(row => row.credential.type === "api_key" && row.credential.key === "after-restart"),
			);
			expect(remote.snapshot.generation).toBeLessThan(previousGeneration);
			expect(remote.listAuthCredentials("kagi").map(row => row.credential)).toEqual([
				{ type: "api_key", key: "after-restart" },
			]);
			serverStorage.upsertCredential("kagi", { type: "api_key", key: "after-reconnect" });
			await waitUntil(() =>
				remote
					.listAuthCredentials("kagi")
					.some(row => row.credential.type === "api_key" && row.credential.key === "after-reconnect"),
			);
			expect(remote.snapshot.generation).toBe(serverStorage.getGeneration());
		} finally {
			remote.close();
		}
	});

	test.each(["same-provider-key", "other-provider-key", "same-provider-oauth", "none"] as const)(
		"pending API-key disable lookup checks latest recovery (%s)",
		async replacement => {
			serverStore!.saveApiKey("kagi", "disabled-api-key");
			await serverStorage!.reload();
			const failureDb = new Database(path.join(tempDir, "agent.db"));
			try {
				failureDb.run(`
					CREATE TRIGGER retain_disabled_history BEFORE DELETE ON auth_credentials
					WHEN OLD.disabled_cause IS NOT NULL
					BEGIN
						SELECT RAISE(ABORT, 'forced tombstone cleanup failure');
					END;
				`);
			} finally {
				failureDb.close();
			}
			const responseReady = Promise.withResolvers<void>();
			const releaseResponse = Promise.withResolvers<void>();
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const listDisabled = client.listDisabledCredentials.bind(client);
			const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
				const disabled = await listDisabled(...args);
				responseReady.resolve();
				await releaseResponse.promise;
				return disabled;
			});
			const remote = new RemoteAuthCredentialStore({ client });
			const events: CredentialDisabledEvent[] = [];
			remote.onCredentialDisabled(event => {
				events.push(event);
			});
			try {
				await waitUntil(() => remote.listAuthCredentials("kagi").length === 1);
				const id = remote.listAuthCredentials("kagi")[0]!.id;
				const cause = "authentication failed";
				await client.disableCredential(id, cause);
				await responseReady.promise;
				if (replacement !== "none") {
					const provider = replacement === "other-provider-key" ? "other-provider" : "kagi";
					serverStorage!.upsertCredential(
						provider,
						replacement === "same-provider-oauth"
							? { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 }
							: { type: "api_key", key: "replacement-api-key" },
					);
					await waitUntil(() => remote.listAuthCredentials(provider).some(row => row.id !== id));
				}
				releaseResponse.resolve();
				await Promise.all(lookups.mock.results.map(result => result.value));
				await Bun.sleep(0);
				expect(events).toEqual(
					replacement === "same-provider-key"
						? []
						: [
								expect.objectContaining({
									credentialId: id,
									credentialType: "api_key",
									disabledCause: summarizeDisableCause(cause),
								}),
							],
				);
				expect(await serverStore!.listDisabledCredentials("kagi")).toEqual([
					expect.objectContaining({ id, type: "api_key", cause }),
				]);
			} finally {
				releaseResponse.resolve();
				remote.close();
				await Promise.all(lookups.mock.results.map(result => result.value));
			}
		},
	);

	test.each([true, false])("retries a failed removal lookup on snapshot activity (SSE=%s)", async streamSnapshots => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const listDisabled = client.listDisabledCredentials.bind(client);
		let attempts = 0;
		const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
			if (++attempts === 1) {
				throw streamSnapshots
					? new DOMException("lookup timed out", "TimeoutError")
					: new Error("connection reset");
			}
			return listDisabled(...args);
		});
		const remote = new RemoteAuthCredentialStore({ client, streamSnapshots });
		const clientStorage = new AuthStorage(remote);
		const events: CredentialDisabledEvent[] = [];
		clientStorage.onCredentialDisabled(event => {
			events.push(event);
		});
		try {
			await waitUntil(() => remote.listAuthCredentials("anthropic").length === 1);
			const id = remote.listAuthCredentials("anthropic")[0]!.id;
			await client.disableCredential(id, "oauth refresh failed: invalid_grant");
			await waitUntil(() => attempts === 1 && remote.listAuthCredentials("anthropic").length === 0);
			await Promise.allSettled(lookups.mock.results.map(result => result.value));
			expect(events).toEqual([]);
			await remote.refreshSnapshot();
			expect(attempts).toBe(1);
			const now = Date.now;
			vi.spyOn(Date, "now").mockImplementation(() => now() + 1_000);
			await remote.refreshSnapshot();
			await waitUntil(() => events.length === 1);
			expect(events).toEqual([
				expect.objectContaining({ credentialId: id, disabledCause: "oauth refresh failed: invalid_grant" }),
			]);
			await remote.refreshSnapshot();
			expect(attempts).toBe(2);
			expect(events).toHaveLength(1);
		} finally {
			clientStorage.close();
			remote.close();
		}
	});

	test("credential-disable listener failures do not starve later subscribers", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		let unsubscribeLater = () => {};
		remote.onCredentialDisabled(() => {
			unsubscribeLater();
			throw new Error("listener failed");
		});
		unsubscribeLater = remote.onCredentialDisabled(event => {
			events.push(event);
		});
		try {
			await waitUntil(() => remote.listAuthCredentials("anthropic").length === 1);
			const id = remote.listAuthCredentials("anthropic")[0]!.id;
			await client.disableCredential(id, "oauth refresh failed: invalid_grant");
			await waitUntil(() => events.length === 1);
			await remote.refreshSnapshot();
			expect(events).toEqual([
				expect.objectContaining({ credentialId: id, disabledCause: "oauth refresh failed: invalid_grant" }),
			]);
		} finally {
			remote.close();
		}
	});

	test.each(["live", "unsubscribe", "close", "idle"] as const)(
		"quiet SSE removal retry respects the %s lifecycle",
		async lifecycle => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const listDisabled = client.listDisabledCredentials.bind(client);
			const lookups = vi
				.spyOn(client, "listDisabledCredentials")
				.mockImplementation(listDisabled)
				.mockRejectedValueOnce(new DOMException("lookup timeout", "TimeoutError"));
			const remote = new RemoteAuthCredentialStore({
				client,
				backgroundIdleMs: lifecycle === "idle" ? 50 : undefined,
			});
			const events: CredentialDisabledEvent[] = [];
			const unsubscribe = remote.onCredentialDisabled(event => {
				events.push(event);
			});
			try {
				await waitUntil(() => remote.listAuthCredentials("anthropic").length === 1);
				const id = remote.listAuthCredentials("anthropic")[0]!.id;
				await client.disableCredential(id, "oauth refresh failed: invalid_grant");
				await waitUntil(() => lookups.mock.calls.length === 1);
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				if (lifecycle === "close") remote.close();
				if (lifecycle === "unsubscribe") {
					unsubscribe();
					remote.onCredentialDisabled(event => {
						events.push(event);
					});
				}
				// No foreground calls, snapshot refreshes, or new broker generations.
				await Bun.sleep(650);
				if (lifecycle === "live") {
					expect(events).toEqual([expect.objectContaining({ credentialId: id })]);
					expect(lookups).toHaveBeenCalledTimes(2);
				} else {
					expect(events).toEqual([]);
					expect(lookups).toHaveBeenCalledTimes(1);
				}
				if (lifecycle === "idle") {
					remote.listAuthCredentials();
					await waitUntil(() => events.length === 1);
					expect(events).toEqual([expect.objectContaining({ credentialId: id })]);
				}
			} finally {
				remote.close();
			}
		},
	);

	test("an unidentified OAuth removal retries despite an unrelated live sibling", async () => {
		serverStorage!.upsertCredential("anthropic", {
			type: "oauth",
			access: "unidentified-access",
			refresh: "unidentified-refresh",
			expires: Date.now() + 60_000,
		});
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const listDisabled = client.listDisabledCredentials.bind(client);
		let attempts = 0;
		const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
			if (++attempts === 1) throw new Error("transient lookup error");
			return listDisabled(...args);
		});
		const remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		remote.onCredentialDisabled(event => {
			events.push(event);
		});
		try {
			await waitUntil(() => remote.listAuthCredentials("anthropic").length === 2);
			const id = remote.listAuthCredentials("anthropic").find(row => row.identityKey === null)!.id;
			await client.disableCredential(id, "oauth refresh failed: invalid_grant");
			await waitUntil(() => attempts === 1);
			await Promise.allSettled(lookups.mock.results.map(result => result.value));
			const now = Date.now;
			vi.spyOn(Date, "now").mockImplementation(() => now() + 1_000);
			await remote.refreshSnapshot();
			await waitUntil(() => events.length === 1);
			expect(events).toEqual([expect.objectContaining({ credentialId: id })]);
			expect(remote.listAuthCredentials("anthropic")).toMatchObject([{ credential: { email: "a@example.com" } }]);
		} finally {
			remote.close();
		}
	});

	test("removal lookup backoff is capped without discarding persistent transient failures", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const listDisabled = client.listDisabledCredentials.bind(client);
		let attempts = 0;
		let failing = true;
		const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
			attempts++;
			if (failing) throw new Error("temporarily unavailable");
			return listDisabled(...args);
		});
		const now = Date.now;
		let elapsed = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
		const remote = new RemoteAuthCredentialStore({ client });
		const events: CredentialDisabledEvent[] = [];
		remote.onCredentialDisabled(event => {
			events.push(event);
		});
		try {
			await waitUntil(() => remote.listAuthCredentials("anthropic").length === 1);
			const id = remote.listAuthCredentials("anthropic")[0]!.id;
			await client.disableCredential(id, "oauth refresh failed: invalid_grant");
			await waitUntil(() => attempts === 1);
			await Promise.allSettled(lookups.mock.results.map(result => result.value));
			for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
				const before = attempts;
				await remote.refreshSnapshot();
				expect(attempts).toBe(before);
				elapsed += delay;
				await remote.refreshSnapshot();
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				expect(attempts).toBe(before + 1);
			}
			failing = false;
			elapsed += 30_000;
			await remote.refreshSnapshot();
			await waitUntil(() => events.length === 1);
			expect(events).toEqual([expect.objectContaining({ credentialId: id })]);
		} finally {
			remote.close();
		}
	});

	test.each(["no-listener", "unsubscribe", "close", "deliberate", "missing"] as const)(
		"removal lookup work retires at the %s boundary",
		async boundary => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const listDisabled = client.listDisabledCredentials.bind(client);
			let attempts = 0;
			const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
				if (++attempts === 1) throw new Error("transient lookup error");
				return boundary === "missing" ? [] : listDisabled(...args);
			});
			const remote = new RemoteAuthCredentialStore({ client });
			const events: CredentialDisabledEvent[] = [];
			const unsubscribe =
				boundary === "no-listener"
					? undefined
					: remote.onCredentialDisabled(event => {
							events.push(event);
						});
			try {
				await waitUntil(() => remote.listAuthCredentials("anthropic").length === 1);
				const id = remote.listAuthCredentials("anthropic")[0]!.id;
				await client.disableCredential(
					id,
					boundary === "deliberate" ? "deleted by user" : "oauth refresh failed: invalid_grant",
				);
				await waitUntil(() => remote.listAuthCredentials("anthropic").length === 0);
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				if (boundary === "close") remote.close();
				if (boundary === "unsubscribe") unsubscribe!();
				if (boundary === "no-listener" || boundary === "unsubscribe")
					remote.onCredentialDisabled(event => {
						events.push(event);
					});
				const now = Date.now;
				vi.spyOn(Date, "now").mockImplementation(() => now() + 1_000);
				await remote.refreshSnapshot();
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				await remote.refreshSnapshot();
				expect(attempts).toBe(
					boundary === "no-listener" ? 0 : boundary === "deliberate" || boundary === "missing" ? 2 : 1,
				);
				// Neither later activity nor new listeners may resurrect retired work.
				expect(events).toEqual([]);
			} finally {
				remote.close();
			}
		},
	);

	test.each(["api_key", "oauth"] as const)(
		"a recovered %s removal never reappears after a subsequent logout",
		async type => {
			if (type === "api_key") serverStore!.saveApiKey("kagi", "old-key");
			await serverStorage!.reload();
			const provider = type === "api_key" ? "kagi" : "anthropic";
			const failureDb = new Database(path.join(tempDir, "agent.db"));
			try {
				failureDb.run(`CREATE TRIGGER retain_disabled_history BEFORE DELETE ON auth_credentials
				WHEN OLD.disabled_cause IS NOT NULL BEGIN SELECT RAISE(ABORT, 'retain history'); END;`);
			} finally {
				failureDb.close();
			}
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const listDisabled = client.listDisabledCredentials.bind(client);
			let attempts = 0;
			const lookups = vi.spyOn(client, "listDisabledCredentials").mockImplementation(async (...args) => {
				if (++attempts === 1) throw new Error("transient lookup error");
				return listDisabled(...args);
			});
			const remote = new RemoteAuthCredentialStore({ client });
			const events: CredentialDisabledEvent[] = [];
			remote.onCredentialDisabled(event => {
				events.push(event);
			});
			try {
				await waitUntil(() => remote.listAuthCredentials(provider).length === 1);
				const old = serverStore!.listAuthCredentials(provider)[0]!;
				await client.disableCredential(old.id, "authentication failed");
				await waitUntil(() => attempts === 1 && remote.listAuthCredentials(provider).length === 0);
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				serverStorage!.upsertCredential(
					provider,
					old.credential.type === "api_key"
						? { type: "api_key", key: "new-key" }
						: { ...old.credential, access: "recovered", refresh: "recovered-refresh" },
				);
				await waitUntil(() => remote.listAuthCredentials(provider).length === 1);
				await serverStorage!.remove(provider);
				await waitUntil(() => remote.listAuthCredentials(provider).length === 0);
				const now = Date.now;
				vi.spyOn(Date, "now").mockImplementation(() => now() + 1_000);
				await remote.refreshSnapshot();
				await Promise.allSettled(lookups.mock.results.map(result => result.value));
				expect(await listDisabled(provider)).toContainEqual(
					expect.objectContaining({ id: old.id, cause: "authentication failed" }),
				);
				expect(events).toEqual([]);
			} finally {
				remote.close();
			}
		},
	);

	test("client-side AuthStorage refreshes via broker override, never via local OAuth path", async () => {
		// Real refresh executed by the broker server; mock surfaces the rotated tokens.
		const rotated = {
			access: "server-access-rotated",
			refresh: "server-refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialSnapshot = initialResult.snapshot;
		expect(initialSnapshot.credentials).toHaveLength(1);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
		});

		let overrideCalls = 0;
		const clientStorage = new AuthStorage(remoteStore, {
			refreshOAuthCredential: async (_provider, credentialId, _credential) => {
				overrideCalls += 1;
				const { entry } = await brokerClient.refreshCredential(credentialId);
				if (entry.credential.type !== "oauth") throw new Error("unexpected");
				return {
					access: entry.credential.access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: entry.credential.expires,
					accountId: entry.credential.accountId,
					email: entry.credential.email,
				};
			},
		});
		await clientStorage.reload();

		const apiKey = await clientStorage.getApiKey("anthropic");
		expect(apiKey).toBe("server-access-rotated");
		expect(overrideCalls).toBe(1);
		// The local oauth refresh helper was used exactly once — by the broker server.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		clientStorage.close();
	});
	test.each(["normal", "forced", "stored", "changed-identity"] as const)(
		"%s refresh immediately projects authoritative broker identities, including untouched siblings",
		async mode => {
			testUsageProviders = new Map();
			const credential = (email: string, expires: number) => ({
				type: "oauth" as const,
				access: `opaque-${email}`,
				refresh: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`,
				expires,
			});
			const expires = Date.now() + 3_600_000;
			await serverStorage!.set("anthropic", [
				credential("original@example.com", mode === "normal" ? Date.now() - 60_000 : expires),
				credential("sibling@example.com", expires),
			]);
			const nextEmail = mode === "changed-identity" ? "replacement@example.com" : "original@example.com";
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
				...credential(nextEmail, expires),
				access: "rotated-opaque-access",
			});
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected full snapshot");
			const target = initial.snapshot.credentials.find(entry => entry.identityKey === "email:original@example.com")!;
			const remoteStore = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});
			const clientStorage = new AuthStorage(remoteStore);
			try {
				await clientStorage.reload();
				if (mode === "stored") {
					const result = await clientStorage.refreshStoredOAuthCredential("anthropic", {
						credentialId: target.id,
						forceRefresh: true,
						credentialFromRow: row => row,
						refresh: (current, signal) =>
							remoteStore.refreshOAuthCredential("anthropic", target.id, current, signal),
					});
					expect(result.refreshed).toBe(true);
					expect(result.credential?.access).toBe("rotated-opaque-access");
				} else if (mode === "normal") {
					const result = await clientStorage.getOAuthAccessByCredentialId("anthropic", target.id);
					expect(result).toMatchObject({ ok: true, accessToken: "rotated-opaque-access" });
				} else {
					const result = await clientStorage.forceRefreshCredentialById(target.id);
					expect(result.credential).toMatchObject({ access: "rotated-opaque-access" });
					expect(result.identityKey).toBe(`email:${nextEmail}`);
				}
				const expectedKeys = [`email:${nextEmail}`, "email:sibling@example.com"].sort();
				expect(remoteStore.snapshot.credentials.map(entry => entry.identityKey).sort()).toEqual(expectedKeys);
				// No reload after refresh: both synchronous public views must already use the new store authority.
				expect(
					clientStorage
						.listCredentialAccountIdentities()
						.map(entry => entry.identity?.key)
						.sort(),
				).toEqual(expectedKeys);
				expect(
					clientStorage
						.exportSnapshot()
						.credentials.map(entry => entry.identityKey)
						.sort(),
				).toEqual(expectedKeys);
			} finally {
				clientStorage.close();
			}
		},
	);

	for (const mode of ["normal", "forced", "stored"] as const) {
		test.each(["added", "changed", "removed"] as const)(
			`${mode} refresh mirrors a peer's %s scope and complete broker credential`,
			async scope => {
				testUsageProviders = new Map();
				const email = "hidden@example.com";
				const expires = Date.now() + 3_600_000;
				const original: OAuthCredential = {
					type: "oauth",
					access: "legacy-access",
					refresh: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`,
					expires: mode === "normal" ? Date.now() - 60_000 : expires,
					accountId: "old-account",
					email: scope === "removed" ? "stale@example.com" : undefined,
					projectId: "old-project",
					enterpriseUrl: "https://old.example.com",
					apiEndpoint: "https://old.example.com/api",
					orgId: scope === "added" ? undefined : "old-org",
					orgName: scope === "added" ? undefined : "Old organization",
					authorizedAt: 1000,
				};
				await serverStorage!.set("anthropic", original);
				const client = new AuthBrokerClient({ url: handle!.url, token });
				const initial = await client.fetchSnapshot();
				if (initial.status !== 200) throw new Error("expected snapshot");
				const target = initial.snapshot.credentials[0]!;
				const orgId = scope === "removed" ? undefined : "current-org";
				const identityKey = `email:${email}${orgId ? `|org:${orgId}` : ""}`;
				const accountPool = new Map([["anthropic", new Set([target.identityKey!, identityKey])]]);
				const remoteStore = new RemoteAuthCredentialStore({
					client,
					initialSnapshot: initial.snapshot,
					streamSnapshots: false,
					accountPool,
				});
				const clientStorage = new AuthStorage(remoteStore);
				try {
					await clientStorage.reload();
					const current: OAuthCredential = {
						...original,
						email: undefined,
						accountId: scope === "removed" ? undefined : "current-account",
						projectId: scope === "removed" ? undefined : "current-project",
						enterpriseUrl: scope === "removed" ? undefined : "https://current.example.com",
						apiEndpoint: scope === "removed" ? undefined : "https://current.example.com/api",
						orgId,
						orgName: orgId ? "Current organization" : undefined,
						authorizedAt: scope === "removed" ? undefined : 2000,
					};
					// A peer upgrades the existing legacy row while the client retains its old projection.
					if (scope === "added") serverStore!.upsertAuthCredentialForProvider("anthropic", current);
					else serverStore!.updateAuthCredential(target.id, current);
					expect(serverStore!.listAuthCredentials("anthropic").map(row => row.id)).toEqual([target.id]);
					vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
						...current,
						access: "rotated-access",
						expires,
					});
					if (mode === "stored") {
						const result = await clientStorage.refreshStoredOAuthCredential("anthropic", {
							credentialId: target.id,
							forceRefresh: true,
							credentialFromRow: row => row,
							refresh: (credential, signal) =>
								remoteStore.refreshOAuthCredential("anthropic", target.id, credential, signal),
						});
						expect(result.credential?.access).toBe("rotated-access");
						expect(result.refreshed).toBe(true);
						const brokerCredential = serverStorage!.exportSnapshot().credentials[0]!.credential;
						if (brokerCredential.type !== "oauth") throw new Error("expected OAuth credential");
						expect(result.credential).toEqual(brokerCredential);
					} else if (mode === "normal") {
						expect(await clientStorage.getOAuthAccessByCredentialId("anthropic", target.id)).toMatchObject({
							ok: true,
							accessToken: "rotated-access",
							accountId: current.accountId,
							email: current.email,
							projectId: current.projectId,
							enterpriseUrl: current.enterpriseUrl,
							orgId: current.orgId,
							orgName: current.orgName,
						});
					} else {
						expect((await clientStorage.forceRefreshCredentialById(target.id)).credential).toMatchObject({
							access: "rotated-access",
						});
					}
					// Recovery and downstream account-pool projection consume these views without another reload.
					const projected = clientStorage.exportSnapshot();
					expect(projected.credentials).toEqual(serverStorage!.exportSnapshot().credentials);
					expect(projected.credentials[0]!.identityKey).toBe(identityKey);
					expect(
						isActionableCredentialDisable(
							{
								id: 999,
								provider: "anthropic",
								type: "oauth",
								cause: "oauth refresh failed: invalid_grant",
								email,
								orgId,
							},
							clientStorage.listCredentialAccountIdentities(),
						),
					).toBe(false);
					const pooled = new RemoteAuthCredentialStore({
						client,
						streamSnapshots: false,
						accountPool: new Map([["anthropic", new Set([identityKey])]]),
						initialSnapshot: {
							...remoteStore.snapshot,
							...projected,
							credentials: projected.credentials.map(entry => ({ ...entry, rotatesInMs: null })),
						},
					});
					try {
						expect(pooled.listAuthCredentials("anthropic").map(row => row.id)).toEqual([target.id]);
					} finally {
						pooled.close();
					}
				} finally {
					clientStorage.close();
				}
			},
		);
	}

	test("direct broker refresh returns the complete redacted credential", async () => {
		testUsageProviders = new Map();
		const refreshed = {
			access: "direct-access",
			refresh: "private-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "direct-account",
			email: "direct@example.com",
			projectId: "direct-project",
			enterpriseUrl: "https://direct.example.com",
			apiEndpoint: "https://direct.example.com/api",
			orgId: "direct-org",
			orgName: "Direct organization",
			authorizedAt: 2000,
		};
		await serverStorage!.set("anthropic", {
			...refreshed,
			type: "oauth",
			access: "direct-expired",
			expires: Date.now() - 60_000,
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected snapshot");
		const target = initial.snapshot.credentials[0]!;
		if (target.credential.type !== "oauth") throw new Error("expected OAuth credential");
		const remoteStore = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		try {
			expect(await remoteStore.refreshOAuthCredential("anthropic", target.id, target.credential)).toMatchObject({
				...refreshed,
				refresh: REMOTE_REFRESH_SENTINEL,
			});
		} finally {
			remoteStore.close();
		}
	});

	test.each(["normal", "selection", "forced", "stored"] as const)(
		"%s refresh adopts a different peer credential already installed after the broker response",
		async mode => {
			testUsageProviders = new Map();
			const expires = Date.now() + 3_600_000;
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
				access: "intermediate-access",
				refresh: "intermediate-refresh",
				expires,
			});
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected snapshot");
			const target = initial.snapshot.credentials[0]!;
			const refresh = client.refreshCredential.bind(client);
			vi.spyOn(client, "refreshCredential").mockImplementation(async (...args) => {
				const result = await refresh(...args);
				serverStore!.updateAuthCredential(target.id, {
					type: "oauth",
					access: "peer-access",
					refresh: "peer-refresh",
					expires,
					accountId: mode === "normal" ? undefined : "peer-account",
					email: mode === "normal" ? undefined : "peer@example.com",
					orgId: mode === "normal" ? undefined : "peer-org",
				});
				return result;
			});
			const remoteStore = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});
			const clientStorage = new AuthStorage(remoteStore);
			const refreshRemote = remoteStore.refreshOAuthCredential.bind(remoteStore);
			vi.spyOn(remoteStore, "refreshOAuthCredential").mockImplementation(async (...args) => {
				const result = await refreshRemote(...args);
				// Another caller can hydrate the new snapshot before this refresh is mirrored.
				await clientStorage.reload();
				return result;
			});
			try {
				await clientStorage.reload();
				if (mode === "normal") {
					expect(await clientStorage.getOAuthAccessByCredentialId("anthropic", target.id)).toMatchObject({
						ok: true,
						accessToken: "peer-access",
						accountId: undefined,
						orgId: undefined,
					});
					expect(clientStorage.exportSnapshot().credentials[0]!.identityKey).toBeNull();
				} else if (mode === "selection") {
					expect(await clientStorage.getApiKey("anthropic", "mirror-selection")).toBe("peer-access");
				} else if (mode === "stored") {
					const result = await clientStorage.refreshStoredOAuthCredential("anthropic", {
						credentialId: target.id,
						forceRefresh: true,
						credentialFromRow: row => row,
						refresh: (credential, signal) =>
							remoteStore.refreshOAuthCredential("anthropic", target.id, credential, signal),
					});
					expect(result.refreshed).toBe(true);
					expect(result.credential?.access).toBe("peer-access");
				} else {
					expect(await clientStorage.forceRefreshCredentialById(target.id)).toMatchObject({
						credential: { access: "peer-access" },
						identityKey: "email:peer@example.com|org:peer-org",
					});
				}
				expect(clientStorage.exportSnapshot().credentials).toEqual(serverStorage!.exportSnapshot().credentials);
			} finally {
				clientStorage.close();
			}
		},
	);

	test("successful replacement distinguishes authoritative null from absent identity metadata", async () => {
		testUsageProviders = new Map();
		const credential = {
			type: "oauth" as const,
			access: "identified-access",
			refresh: "identified-refresh",
			expires: Date.now() + 3_600_000,
			email: "identified@example.com",
		};
		await serverStorage!.set("anthropic", credential);
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected full snapshot");
		const entry = initial.snapshot.credentials[0]!;
		// A broker can explicitly withhold identity authority despite locally readable identifiers.
		entry.identityKey = null;
		const remoteStore = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		try {
			await clientStorage.reload();
			await clientStorage.getOAuthAccessByCredentialId("anthropic", entry.id);
			expect(clientStorage.listCredentialAccountIdentities().map(row => row.identity?.key)).toEqual([null]);
			expect(clientStorage.exportSnapshot().credentials.map(row => row.identityKey)).toEqual([null]);
			// Local SQLite has no authoritative key; it must still derive the identity after CAS success.
			await serverStorage!.getOAuthAccessByCredentialId("anthropic", entry.id);
			expect(serverStorage!.listCredentialAccountIdentities().map(row => row.identity?.key)).toEqual([
				"email:identified@example.com",
			]);
			expect(serverStorage!.exportSnapshot().credentials.map(row => row.identityKey)).toEqual([
				"email:identified@example.com",
			]);
			// Updating a mutable backend row must not silently mutate an already-hydrated client entry.
			remoteStore.updateAuthCredential(entry.id, { ...credential, email: "replacement@example.com" });
			expect(clientStorage.exportSnapshot().credentials.map(row => row.identityKey)).toEqual([null]);
			await clientStorage.reload();
			expect(clientStorage.exportSnapshot().credentials.map(row => row.identityKey)).toEqual([
				"email:replacement@example.com",
			]);
		} finally {
			clientStorage.close();
		}
	});

	test("suspect credential refresh updates the client snapshot from the broker response", async () => {
		const rotated = {
			access: "server-access-after-401",
			refresh: "server-refresh-after-401",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials[0];
		if (!initialEntry) throw new Error("expected credential");

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});

		await remoteStore.markCredentialSuspect(initialEntry.id);
		const rows = remoteStore.listAuthCredentials("anthropic");

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.access).toBe("server-access-after-401");
			expect(rows[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		remoteStore.close();
	});

	test("invalidated OAuth tokens disable the remote row and rotate to a sibling", async () => {
		serverStore!.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "server-access-2",
			refresh: "server-refresh-2",
			expires: Date.now() + 120_000,
			accountId: "account-2",
			email: "b@example.com",
		});
		await serverStorage!.reload();
		const seededRows = serverStore!.listAuthCredentials("anthropic");
		expect(seededRows).toHaveLength(2);
		const failedRow = seededRows[0];
		if (failedRow?.credential.type !== "oauth") throw new Error("expected failed OAuth row");

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientEvents: CredentialDisabledEvent[] = [];
		const clientStorage = new AuthStorage(remoteStore, {
			onCredentialDisabled: event => {
				clientEvents.push(event);
			},
		});
		const first = {
			accessToken: failedRow.credential.access,
			credentialId: failedRow.id,
		};

		const rotated = await clientStorage.rotateSessionCredential("anthropic", "invalidated-session", {
			error: new Error("Encountered invalidated oauth token for user, failing request"),
			apiKey: first.accessToken,
			credentialId: first.credentialId,
		});

		expect(rotated).toBe(true);
		expect(serverStore!.listAuthCredentials("anthropic").map(row => row.id)).not.toContain(first.credentialId);
		// The broker tombstones the row on its host; the session that observed the
		// invalidation still announces the sign-out to its own subscribers.
		expect(clientEvents).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				credentialId: first.credentialId,
				credentialType: "oauth",
				email: failedRow.credential.email,
				disabledCause: expect.stringContaining("invalidated oauth token"),
			}),
		]);
		const next = await clientStorage.getOAuthAccess("anthropic", "invalidated-session");
		expect(next?.credentialId).not.toBe(first.credentialId);
		clientStorage.close();
		remoteStore.close();
	});

	test("RemoteAuthCredentialStore rejects writes from the client", () => {
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		expect(() => remoteStore.replaceAuthCredentialsForProvider("anthropic", [])).toThrow(/read-only/);
		expect(() => remoteStore.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "x" })).toThrow(
			/read-only/,
		);
		expect(() => remoteStore.deleteAuthCredentialsForProvider("anthropic", "x")).toThrow(/read-only/);
		remoteStore.close();
	});

	test("getUsageReport coalesces parallel callers and matches by identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const reportForA = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com" },
		};
		const reportForB = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: Date.now(), reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const credB = { ...credA, email: "b@example.com" };

		const [resA, resB] = await Promise.all([
			remoteStore.getUsageReport("anthropic", credA),
			remoteStore.getUsageReport("anthropic", credB),
		]);
		// Parallel callers share a single broker round-trip.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resA?.metadata?.email).toBe("a@example.com");
		expect(resB?.metadata?.email).toBe("b@example.com");

		// Cached on the second call — still one fetch total.
		const cached = await remoteStore.getUsageReport("anthropic", credA);
		expect(cached?.metadata?.email).toBe("a@example.com");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Unknown provider → null, no extra fetch.
		const miss = await remoteStore.getUsageReport("openai-codex", credA);
		expect(miss).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("broker block snapshots invalidate cached usage before the next fetchUsageReports", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const blockedUntilMs = now + 60_000;
		const credentialEntry = {
			id: 7,
			provider: "anthropic" as const,
			credential: {
				type: "oauth" as const,
				access: "remote-access",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: now + 120_000,
				accountId: "remote-account",
				email: "remote@example.com",
			},
			identityKey: "email:remote@example.com",
			rotatesInMs: null,
		};
		const initialSnapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [credentialEntry],
		};
		const blockedSnapshot: SnapshotResponse = {
			...initialSnapshot,
			generation: 2,
			generatedAt: now + 1,
			serverNowMs: now + 1,
			credentials: [
				{
					...credentialEntry,
					blocks: [{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs }],
				},
			],
		};
		const healthyReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 10, limit: 100, usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "remote-account", email: "remote@example.com", brokerFetch: "before-block" },
		};
		const blockedReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now + 1,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
			metadata: { accountId: "remote-account", email: "remote@example.com", brokerFetch: "after-block" },
		};
		const fetchUsageSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValueOnce({ generatedAt: now, reports: [healthyReport] })
			.mockResolvedValueOnce({ generatedAt: now + 1, reports: [blockedReport] });
		const backgroundSnapshotFetch = Promise.withResolvers<FetchSnapshotResult>();
		vi.spyOn(brokerClient, "fetchSnapshot")
			.mockReturnValueOnce(backgroundSnapshotFetch.promise)
			.mockResolvedValueOnce({
				status: 200,
				generation: blockedSnapshot.generation,
				snapshot: blockedSnapshot,
			});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot,
		});
		try {
			const first = await remoteStore.fetchUsageReports();
			expect(fetchUsageSpy).toHaveBeenCalledTimes(1);
			expect(first).not.toBeNull();
			expect(first?.[0]?.metadata?.brokerFetch).toBe("before-block");
			expect(requireLimit(first![0]!, "anthropic:7d:fable").status).toBe("ok");

			await remoteStore.refreshSnapshot();
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);

			const second = await remoteStore.fetchUsageReports();
			expect(fetchUsageSpy).toHaveBeenCalledTimes(2);
			expect(second).not.toBeNull();
			expect(second?.[0]?.metadata?.brokerFetch).toBe("after-block");
			const afterBlockLimit = requireLimit(second![0]!, "anthropic:7d:fable");
			expect(afterBlockLimit.status).toBe("exhausted");
			expect(afterBlockLimit.amount.usedFraction).toBe(1);
		} finally {
			remoteStore.close();
		}
	});

	test("getUsageReport caches broker fetch failure for USAGE_CACHE_TTL_MS", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));

		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000_000);

		// First sequential failure caches null.
		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Second call within 15s TTL is served from the cached null — no new fetch.
		nowSpy.mockReturnValue(1_000_000 + 14_999);
		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// getUsageReport shares the same negative cache.
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// After the documented 15s TTL expires, the client retries once and hits the broker again.
		nowSpy.mockReturnValue(1_000_000 + 15_000 + 1);
		const retried = await remoteStore.fetchUsageReports();
		expect(retried).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		remoteStore.close();
	});

	test("snapshot wire schema accepts entries with and without credential blocks", () => {
		const futureBlock = Date.now() + 60_000;
		const validated = snapshotResponseSchema({
			generation: 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [
				{
					id: 1,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "access-without-blocks",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: futureBlock,
						accountId: "account-without-blocks",
						email: "without-blocks@example.com",
					},
					identityKey: "email:without-blocks@example.com",
					rotatesInMs: null,
				},
				{
					id: 2,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "access-with-blocks",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: futureBlock,
						accountId: "account-with-blocks",
						email: "with-blocks@example.com",
					},
					identityKey: "email:with-blocks@example.com",
					rotatesInMs: null,
					blocks: [{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock }],
				},
			],
		});

		expect(validated).not.toBeInstanceOf(type.errors);
		if (validated instanceof type.errors) throw new Error("expected valid snapshot");
		expect(validated.credentials[0]!.blocks).toBeUndefined();
		expect(validated.credentials[1]!.blocks).toEqual([
			{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock },
		]);
	});

	test("getUsageReport routes each org-scoped credential to its own org's report", async () => {
		// Two subscriptions (orgs) on one account email: the broker aggregate
		// carries both pools. Matching by shared email/account would hand the
		// healthy Max credential the exhausted Team report (and vice versa).
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const makeCredential = (id: number, orgId?: string) => ({
			type: "oauth" as const,
			access: `remote-access-${id}`,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "account-shared",
			email: "shared@example.com",
			orgId,
		});
		const makeOrgReport = (orgId: string, usedFraction: number, status: "ok" | "exhausted"): UsageReport => ({
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
					status,
				},
			],
			metadata: { email: "shared@example.com", accountId: "account-shared", orgId },
		});
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({
			generatedAt: now,
			reports: [makeOrgReport("org-team", 1, "exhausted"), makeOrgReport("org-max", 0.1, "ok")],
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credential: makeCredential(1, "org-team"),
						identityKey: "email:shared@example.com|org:org-team",
						rotatesInMs: null,
					},
					{
						id: 2,
						provider: "anthropic",
						credential: makeCredential(2, "org-max"),
						identityKey: "email:shared@example.com|org:org-max",
						rotatesInMs: null,
					},
				],
			},
		});
		try {
			const teamReport = await remoteStore.getUsageReport("anthropic", makeCredential(1, "org-team"));
			expect(teamReport?.metadata?.orgId).toBe("org-team");
			expect(requireLimit(teamReport!, "anthropic:5h").status).toBe("exhausted");

			const maxReport = await remoteStore.getUsageReport("anthropic", makeCredential(2, "org-max"));
			expect(maxReport?.metadata?.orgId).toBe("org-max");
			expect(requireLimit(maxReport!, "anthropic:5h").status).toBe("ok");

			// An org-less (legacy) credential must not receive an org-attributed
			// sibling's pool via the shared email/account — "no usage data" is
			// the correct answer.
			const legacyReport = await remoteStore.getUsageReport("anthropic", makeCredential(3));
			expect(legacyReport).toBeNull();
		} finally {
			remoteStore.close();
		}
	});

	test("getUsageReport gates same-org siblings on the member's own identity", async () => {
		// Two Team members share the org id but draw on per-user pools: the
		// shared org is a gate, not a match, so Bob must never receive Alice's
		// report just because it is the first (or only) same-org candidate.
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const makeMemberCredential = (name: string, orgId?: string) => ({
			type: "oauth" as const,
			access: `remote-access-${name}`,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			...(name === "org-only" ? {} : { accountId: `account-${name}`, email: `${name}@example.com` }),
			orgId,
		});
		const makeMemberReport = (
			name: string,
			orgId: string,
			usedFraction: number,
			status: "ok" | "exhausted",
		): UsageReport => ({
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
					status,
				},
			],
			metadata: { email: `${name}@example.com`, accountId: `account-${name}`, orgId },
		});
		// Bob's report deliberately precedes Alice's so a first-same-org match
		// would hand his pool to Alice; org-duo holds only Dave's report.
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({
			generatedAt: now,
			reports: [
				makeMemberReport("bob", "org-team", 0.1, "ok"),
				makeMemberReport("alice", "org-team", 1, "exhausted"),
				makeMemberReport("dave", "org-duo", 0.5, "ok"),
			],
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		try {
			// Each member routes to their OWN pool inside the shared org.
			const aliceReport = await remoteStore.getUsageReport("anthropic", makeMemberCredential("alice", "org-team"));
			expect(aliceReport?.metadata?.accountId).toBe("account-alice");
			expect(requireLimit(aliceReport!, "anthropic:5h").status).toBe("exhausted");
			const bobReport = await remoteStore.getUsageReport("anthropic", makeMemberCredential("bob", "org-team"));
			expect(bobReport?.metadata?.accountId).toBe("account-bob");
			expect(requireLimit(bobReport!, "anthropic:5h").status).toBe("ok");

			// Erin's own report is missing: the lone same-org sibling report
			// (Dave's) must not stand in for hers — "no usage data" is correct.
			expect(await remoteStore.getUsageReport("anthropic", makeMemberCredential("erin", "org-duo"))).toBeNull();

			// An org-only credential (no base identifiers) still matches on the
			// org alone, but only when the same-org report is unambiguous.
			const duoReport = await remoteStore.getUsageReport("anthropic", makeMemberCredential("org-only", "org-duo"));
			expect(duoReport?.metadata?.accountId).toBe("account-dave");
			expect(await remoteStore.getUsageReport("anthropic", makeMemberCredential("org-only", "org-team"))).toBeNull();

			// Header-ingest overlays partition per member too: Alice's ingest
			// must merge into HER aggregate row, not Bob's earlier same-org row.
			const overlay: UsageReport = {
				provider: "anthropic",
				fetchedAt: now,
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						scope: { provider: "anthropic", windowId: "5h" },
						window: { id: "5h", label: "5 Hour" },
						amount: { used: 90, limit: 100, usedFraction: 0.9, unit: "percent" },
						status: "ok",
					},
				],
				metadata: { email: "alice@example.com", accountId: "account-alice", orgId: "org-team" },
			};
			expect(remoteStore.ingestUsageReport("anthropic", makeMemberCredential("alice", "org-team"), overlay)).toBe(
				true,
			);
			const merged = await remoteStore.fetchUsageReports();
			const mergedAlice = merged?.find(report => report.metadata?.accountId === "account-alice");
			const mergedBob = merged?.find(report => report.metadata?.accountId === "account-bob");
			expect(requireLimit(mergedAlice!, "anthropic:5h").amount.used).toBe(90);
			expect(requireLimit(mergedBob!, "anthropic:5h").amount.used).toBe(10);
			const bobAfterIngest = await remoteStore.getUsageReport("anthropic", makeMemberCredential("bob", "org-team"));
			expect(requireLimit(bobAfterIngest!, "anthropic:5h").amount.used).toBe(10);
		} finally {
			remoteStore.close();
		}
	});

	test("getUsageReport never hands an org-less aggregate to an org-scoped credential", async () => {
		// Presence mismatch is a non-match in BOTH directions: when every
		// surviving report is org-less (e.g. a legacy sibling row supplied the
		// sole report because the scoped row's own fetch failed), the scoped
		// credential must get "no usage data" — not the legacy row's pool.
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const orgLessReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
			metadata: { email: "shared@example.com", accountId: "account-shared" },
		};
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [orgLessReport] });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		try {
			const scoped = await remoteStore.getUsageReport("anthropic", {
				type: "oauth",
				access: "remote-access-scoped",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: now + 120_000,
				accountId: "account-shared",
				email: "shared@example.com",
				orgId: "org-team",
			});
			expect(scoped).toBeNull();
		} finally {
			remoteStore.close();
		}
	});

	test("does not trust a lone org-less candidate from a mixed aggregate without its base identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const orgReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [],
			metadata: { email: "alice@example.com", accountId: "account-alice", orgId: "org-team" },
		};
		const legacyReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [],
			metadata: { email: "carol@example.com", accountId: "account-carol" },
		};
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({
			generatedAt: now,
			reports: [orgReport, legacyReport],
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const bobCredential = {
			type: "oauth" as const,
			access: "remote-access-bob",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "account-bob",
			email: "bob@example.com",
		};
		const bobOverlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [],
			metadata: { email: "bob@example.com", accountId: "account-bob" },
		};
		try {
			expect(await remoteStore.getUsageReport("anthropic", bobCredential)).toBeNull();
			expect(remoteStore.ingestUsageReport("anthropic", bobCredential, bobOverlay)).toBe(true);
			expect(await remoteStore.fetchUsageReports()).toHaveLength(3);
		} finally {
			remoteStore.close();
		}
	});

	test("applies block upserts before broker acknowledgement and retains them when persistence is rejected", async () => {
		const futureBlock = Date.now() + 60_000;
		const laterBlock = futureBlock + 60_000;
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const fetchSnapshotPending = Promise.withResolvers<FetchSnapshotResult>();
		const fetchSnapshotSpy = vi.spyOn(brokerClient, "fetchSnapshot").mockReturnValue(fetchSnapshotPending.promise);
		const upsertPending = Promise.withResolvers<CredentialBlockResponse>();
		const upsertSpy = vi.spyOn(brokerClient, "upsertCredentialBlock").mockReturnValue(upsertPending.promise);
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: Date.now(),
				serverNowMs: Date.now(),
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 7,
						provider: "anthropic",
						credential: {
							type: "oauth",
							access: "remote-access",
							refresh: REMOTE_REFRESH_SENTINEL,
							expires: futureBlock,
							accountId: "remote-account",
							email: "remote@example.com",
						},
						identityKey: "email:remote@example.com",
						rotatesInMs: null,
						blocks: [
							{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock },
							{ providerKey: "anthropic:oauth", blockScope: "shared", blockedUntilMs: futureBlock },
						],
					},
				],
			},
		});
		try {
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(futureBlock);

			fetchSnapshotSpy.mockClear();
			remoteStore.upsertCredentialBlock({
				credentialId: 7,
				providerKey: "anthropic:oauth",
				blockScope: "tier:fable",
				blockedUntilMs: laterBlock,
			});

			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(laterBlock);
			expect(upsertSpy).toHaveBeenCalledWith(7, {
				providerKey: "anthropic:oauth",
				blockScope: "tier:fable",
				blockedUntilMs: laterBlock,
			});
			remoteStore.deleteCredentialBlock(7, "anthropic:oauth", "tier:fable");
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(laterBlock);
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "shared")).toBe(futureBlock);
			upsertPending.reject(new Error("500 persistent credential block store unavailable"));
			await upsertPending.promise.catch(() => {});
			await Promise.resolve();
			expect(fetchSnapshotSpy).not.toHaveBeenCalled();
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(laterBlock);
		} finally {
			remoteStore.close();
		}
	});
	test("retains the legacy Codex shared block from an older broker snapshot", () => {
		const blockedUntilMs = Date.now() + 60_000;
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" }),
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: Date.now(),
				serverNowMs: Date.now(),
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 7,
						provider: "openai-codex",
						credential: {
							type: "oauth",
							access: "remote-codex-access",
							refresh: REMOTE_REFRESH_SENTINEL,
							expires: blockedUntilMs,
							accountId: "remote-codex-account",
							email: "remote-codex@example.com",
						},
						identityKey: "email:remote-codex@example.com",
						rotatesInMs: null,
						blocks: [
							{
								providerKey: "openai-codex:oauth",
								blockScope: "shared",
								blockedUntilMs,
							},
						],
					},
				],
			},
		});
		try {
			expect(remoteStore.getCredentialBlock(7, "openai-codex:oauth", "shared")).toBe(blockedUntilMs);
		} finally {
			remoteStore.close();
		}
	});

	test("ingestUsageReport overlays only the matching Anthropic report and getUsageReport returns the overlaid Fable row", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const now = Date.now();

		const reportForA: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 20_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 11, limit: 100, usedFraction: 0.11, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com" },
		};
		const reportForB: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 10_000,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 13, limit: 100, usedFraction: 0.13, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-b", email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: now, reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const credB = { ...credA, access: "bx", accountId: "account-b", email: "b@example.com" };
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day", resetsAt: 1_780_617_600_000 },
					amount: {
						used: 61,
						limit: 100,
						usedFraction: 0.61,
						remainingFraction: 0.39,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", credA, overlay)).toBe(true);

		const reports = await remoteStore.fetchUsageReports();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(reports).not.toBeNull();
		const reportA = reports?.find(report => report.metadata?.accountId === "account-a");
		const reportB = reports?.find(report => report.metadata?.accountId === "account-b");
		if (!reportA || !reportB) throw new Error("expected anthropic reports for both broker accounts");

		expect(reportA.metadata?.email).toBe("a@example.com");
		expect(reportA.metadata?.headersUpdatedAt).toBe(1_780_000_000_000);
		expect(reportA.limits.filter(limit => limit.id === "anthropic:7d:fable")).toHaveLength(1);
		expect(requireLimit(reportA, "anthropic:5h").amount.used).toBe(42);
		expect(requireLimit(reportA, "anthropic:7d").amount.used).toBe(84);
		expect(requireLimit(reportA, "anthropic:7d:opus").amount.used).toBe(12);
		const overlaidFable = requireLimit(reportA, "anthropic:7d:fable");
		expect(overlaidFable.amount.used).toBe(61);
		expect(overlaidFable.amount.usedFraction).toBeCloseTo(0.61);
		expect(overlaidFable.window?.resetsAt).toBe(1_780_617_600_000);

		expect(reportB.metadata?.email).toBe("b@example.com");
		expect(reportB.metadata?.headersUpdatedAt).toBeUndefined();
		expect(requireLimit(reportB, "anthropic:7d:fable").amount.used).toBe(13);

		const perCredA = await remoteStore.getUsageReport("anthropic", credA);
		const perCredB = await remoteStore.getUsageReport("anthropic", credB);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(perCredA).not.toBeNull();
		expect(perCredB).not.toBeNull();
		expect(requireLimit(perCredA!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(requireLimit(perCredB!, "anthropic:7d:fable").amount.used).toBe(13);

		remoteStore.close();
	});

	test("fetchUsageReports keeps a broker failure null even when a client overlay exists", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));
		const now = Date.now();
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 61, limit: 100, usedFraction: 0.61, remainingFraction: 0.39, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", cred, overlay)).toBe(true);

		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).not.toBeNull();
		expect(requireLimit(perCred!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("client AuthStorage.set forwards api_key login to the broker (replace semantics)", async () => {
		// Pre-existing api_key for the same provider on the server side — a fresh
		// login should disable it and replace it with the new key.
		serverStore!.saveApiKey("kagi", "old-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.set("kagi", { type: "api_key", key: "new-key" });

		// Server is the source of truth — only the new key should be active.
		const activeOnServer = serverStore!.listAuthCredentials("kagi");
		expect(activeOnServer).toHaveLength(1);
		expect(activeOnServer[0].credential).toEqual({ type: "api_key", key: "new-key" });

		// Client reflects the new key through the broker's `POST /v1/credential`
		// response without waiting for the long-poll snapshot tick.
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});
	test("snapshot with a login-sourced api_key passes client wire validation", async () => {
		// Regression: keys stored via the /login flow carry `source: "login"`.
		// exportSnapshot() forwards them verbatim; the client wire schema used
		// to reject the field ("credentials[0].credential.source must be removed").
		await serverStorage!.set("custom-host", { type: "api_key", key: "sk-custom", source: "login" });

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const result = await brokerClient.fetchSnapshot();
		if (result.status !== 200) throw new Error("expected snapshot");
		const entry = result.snapshot.credentials.find(candidate => candidate.provider === "custom-host");
		expect(entry?.credential).toEqual({ type: "api_key", key: "sk-custom", source: "login" });
	});

	test("client AuthStorage.remove disables every broker-side credential for the provider (logout)", async () => {
		serverStore!.saveApiKey("kagi", "k1");
		serverStore!.saveOAuth("kagi", {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
			accountId: "acct-kagi",
			email: "user@example.com",
		});
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.remove("kagi");

		expect(serverStore!.listAuthCredentials("kagi")).toEqual([]);
		expect(clientStorage.get("kagi")).toBeUndefined();
		clientStorage.close();
	});

	test("client AuthStorage invalidateUsageCache notifies broker to invalidate server-side cache", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		const serverInvalidateSpy = vi.spyOn(serverStorage!, "invalidateUsageCache");

		await remoteStore.invalidateUsageCache();

		expect(serverInvalidateSpy).toHaveBeenCalled();
		clientStorage.close();
	});

	test("broker invalidation drops server-side last-good usage reports", async () => {
		const credential = serverStore!.listAuthCredentials("anthropic")[0];
		if (credential?.credential.type !== "oauth") throw new Error("expected OAuth credential");
		serverStore!.updateAuthCredential(credential.id, {
			...credential.credential,
			expires: Date.now() + 3_600_000,
		});
		await serverStorage!.reload();

		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls > 1) return null;
			return {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						scope: { provider: "anthropic", windowId: "5h" },
						amount: { used: 80, limit: 100, unit: "percent" },
						status: "ok",
					},
				],
				metadata: { accountId: "account-1", email: "a@example.com" },
			};
		});
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		try {
			expect(await clientStorage.fetchUsageReports()).toHaveLength(1);
			await clientStorage.invalidateUsageCache();
			expect(await clientStorage.fetchUsageReports()).toEqual([]);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			clientStorage.close();
		}
	});

	test("broker returns an upgraded plan through a delayed serialized Codex refresh", async () => {
		const accountIds = ["account-free", "account-upgraded", "account-other"];
		const refreshStarted = new Map<string, PromiseWithResolvers<void>>();
		const refreshReleases = new Map<string, PromiseWithResolvers<void>>();
		for (const accountId of accountIds) {
			refreshStarted.set(accountId, Promise.withResolvers<void>());
			refreshReleases.set(accountId, Promise.withResolvers<void>());
		}
		const startedAccounts: string[] = [];
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			supports: params => params.provider === "openai-codex" && params.credential.type === "oauth",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				const started = refreshStarted.get(accountId);
				const release = refreshReleases.get(accountId);
				if (!started || !release) throw new Error(`unexpected account ${accountId}`);
				startedAccounts.push(accountId);
				started.resolve();
				await release.promise;
				return {
					provider: "openai-codex",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "openai-codex:7d",
							label: "7 days",
							scope: { provider: "openai-codex", windowId: "7d" },
							amount: { used: 0, limit: 100, unit: "percent" },
							status: "ok",
						},
					],
					metadata: {
						accountId,
						email: `${accountId.slice("account-".length)}@example.com`,
						planType: accountId === "account-upgraded" ? "pro" : "free",
					},
				};
			},
		};
		testUsageProviders = new Map([["openai-codex", usageProvider]]);
		for (const accountId of accountIds) {
			serverStore!.upsertAuthCredentialForProvider("openai-codex", {
				type: "oauth",
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 3_600_000,
				accountId,
				email: `${accountId.slice("account-".length)}@example.com`,
			});
		}
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token, timeoutMs: 10_000 });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		try {
			await clientStorage.invalidateUsageCache();
			const refresh = clientStorage.fetchUsageReports();
			const freeStarted = refreshStarted.get("account-free");
			const freeRelease = refreshReleases.get("account-free");
			if (!freeStarted || !freeRelease) throw new Error("missing free-account refresh gates");
			await freeStarted.promise;
			expect(startedAccounts).toEqual(["account-free"]);
			freeRelease.resolve();

			const upgradedStarted = refreshStarted.get("account-upgraded");
			const upgradedRelease = refreshReleases.get("account-upgraded");
			if (!upgradedStarted || !upgradedRelease) throw new Error("missing upgraded-account refresh gates");
			await upgradedStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded"]);
			upgradedRelease.resolve();

			const otherStarted = refreshStarted.get("account-other");
			const otherRelease = refreshReleases.get("account-other");
			if (!otherStarted || !otherRelease) throw new Error("missing other-account refresh gates");
			await otherStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded", "account-other"]);
			otherRelease.resolve();

			const reports = await refresh;
			expect(reports).toHaveLength(3);
			expect(reports?.find(report => report.metadata?.accountId === "account-upgraded")?.metadata?.planType).toBe(
				"pro",
			);
		} finally {
			for (const release of refreshReleases.values()) release.resolve();
			clientStorage.close();
		}
	});

	test("sizes broker usage timeout from the unfiltered account-pool snapshot", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const credentials: SnapshotResponse["credentials"] = [];
		for (let index = 0; index < 6; index += 1) {
			const accountId = `account-${index}`;
			credentials.push({
				id: index + 1,
				provider: "openai-codex",
				credential: {
					type: "oauth",
					access: `access-${index}`,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: now + 120_000,
					accountId,
					email: `${index}@example.com`,
				},
				identityKey: `email:${index}@example.com`,
				rotatesInMs: null,
			});
		}
		const visible = credentials[0];
		if (!visible?.identityKey) throw new Error("expected visible account identity");
		const initialSnapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials,
		};
		const response = Promise.withResolvers<Response>();
		const snapshotResponse = Promise.withResolvers<Response>();
		let usageSignal: AbortSignal | undefined;
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const pathname = new URL(String(input)).pathname;
				if (pathname === "/v1/snapshot") return snapshotResponse.promise;
				if (pathname !== "/v1/usage") throw new Error(`unexpected path ${pathname}`);
				const signal = init?.signal;
				if (signal) usageSignal = signal;
				return response.promise;
			},
			{ preconnect: fetch.preconnect },
		);
		const brokerClient = new AuthBrokerClient({
			url: "http://broker.invalid",
			token: "unused",
			timeoutMs: 10_000,
			maxRetries: 0,
			fetchImpl,
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			accountPool: new Map([["openai-codex", new Set([visible.identityKey])]]),
			initialSnapshot,
		});
		try {
			const usage = remoteStore.fetchUsageReports();
			await Promise.resolve();
			const oneAccountBudget = AbortSignal.timeout(20_000);
			vi.advanceTimersByTime(20_001);
			await Promise.resolve();
			expect(oneAccountBudget.aborted).toBe(true);
			expect(usageSignal?.aborted).toBe(false);

			response.resolve(
				Response.json({
					generatedAt: Date.now(),
					reports: [
						{
							provider: "openai-codex",
							fetchedAt: Date.now(),
							limits: [],
							metadata: { accountId: "account-0", email: "0@example.com" },
						},
					],
				}),
			);
			expect(await usage).toHaveLength(1);
		} finally {
			remoteStore.close();
			snapshotResponse.resolve(new Response(null, { status: 304, headers: { ETag: '"1"' } }));
			vi.useRealTimers();
		}
	});
	test("account pool exposes only qualified usage reports for visible OAuth identities", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const makeCredential = (orgId: string) => ({
			type: "oauth" as const,
			access: `access-${orgId}`,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "account-shared",
			email: "shared@example.com",
			orgId,
		});
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { accountId: "account-shared", email: "shared@example.com", orgId: "org-team" },
			},
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { accountId: "account-shared", email: "shared@example.com", orgId: "org-max" },
			},
			{ provider: "anthropic", fetchedAt: now, limits: [] },
		];
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({ generatedAt: now, reports });
		const teamIdentity = "email:shared@example.com|org:org-team";
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set([teamIdentity])]]),
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credential: makeCredential("org-team"),
						identityKey: teamIdentity,
						rotatesInMs: null,
					},
					{
						id: 2,
						provider: "anthropic",
						credential: makeCredential("org-max"),
						identityKey: "email:shared@example.com|org:org-max",
						rotatesInMs: null,
					},
				],
			},
		});
		try {
			expect(remoteStore.snapshot.credentials.map(entry => entry.identityKey)).toEqual([teamIdentity]);
			const visibleReports = await remoteStore.fetchUsageReports();
			expect(visibleReports?.map(report => report.metadata?.orgId)).toEqual(["org-team"]);
			expect(await remoteStore.getUsageReport("anthropic", makeCredential("org-max"))).toBeNull();
		} finally {
			remoteStore.close();
		}
	});

	test("account pool hides unattributable usage even with a visible API key", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const oauthCredential = {
			type: "oauth" as const,
			access: "oauth-access",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "oauth-account",
			email: "oauth@example.com",
		};
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { accountId: "oauth-account", email: "oauth@example.com" },
			},
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { accountId: "api-key-account" },
			},
		];
		vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({ generatedAt: now, reports });
		const oauthIdentity = "email:oauth@example.com";
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set([oauthIdentity])]]),
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credential: oauthCredential,
						identityKey: oauthIdentity,
						rotatesInMs: null,
					},
					{
						id: 2,
						provider: "anthropic",
						credential: { type: "api_key", key: "visible-api-key" },
						identityKey: null,
						rotatesInMs: null,
					},
				],
			},
		});
		try {
			expect(await remoteStore.fetchUsageReports()).toEqual([reports[0]]);
		} finally {
			remoteStore.close();
		}
	});

	test("usage report filter memoizes per (reports, snapshot) and invalidates when the snapshot changes", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const oauthCredential = {
			type: "oauth" as const,
			access: "oauth-access",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "oauth-account",
			email: "oauth@example.com",
		};
		const matchingReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [],
			metadata: { accountId: "oauth-account", email: "oauth@example.com" },
		};
		const strangerReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [],
			metadata: { accountId: "stranger-account", email: "stranger@example.com" },
		};
		const nonPooledReport: UsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			limits: [],
			metadata: { accountId: "codex-account" },
		};
		const reports: UsageReport[] = [matchingReport, strangerReport, nonPooledReport];
		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({ generatedAt: now, reports });
		vi.spyOn(brokerClient, "disableCredential").mockResolvedValue({ ok: true });
		const oauthIdentity = "email:oauth@example.com";
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set([oauthIdentity])]]),
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credential: oauthCredential,
						identityKey: oauthIdentity,
						rotatesInMs: null,
					},
				],
			},
		});
		try {
			// Semantics: matching oauth report kept, pooled report without a
			// matching credential dropped, non-pooled provider passed through.
			const first = await remoteStore.fetchUsageReports();
			expect(first).toEqual([matchingReport, nonPooledReport]);
			// Same cached reports array + same snapshot → memoized output, same identity.
			const second = await remoteStore.fetchUsageReports();
			expect(second).toBe(first!);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			// Snapshot replacement (credential removal) invalidates the memo: the
			// previously matching report is no longer attributable and disappears.
			remoteStore.deleteAuthCredential(1, "test");
			const third = await remoteStore.fetchUsageReports();
			expect(third).not.toBe(first!);
			expect(third).toEqual([nonPooledReport]);
		} finally {
			remoteStore.close();
		}
	});

	test("rejects a refreshed credential whose identity leaves the account pool", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const allowedCredential = {
			type: "oauth" as const,
			access: "allowed-access",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 120_000,
			accountId: "account-allowed",
			email: "allowed@example.com",
		};
		const allowedIdentity = "email:allowed@example.com";
		vi.spyOn(brokerClient, "refreshCredential").mockResolvedValue({
			entry: {
				id: 1,
				provider: "anthropic",
				credential: {
					...allowedCredential,
					access: "excluded-access",
					accountId: "account-excluded",
					email: "excluded@example.com",
				},
				identityKey: "email:excluded@example.com",
			},
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set([allowedIdentity])]]),
			initialSnapshot: {
				generation: 1,
				generatedAt: now,
				serverNowMs: now,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credential: allowedCredential,
						identityKey: allowedIdentity,
						rotatesInMs: null,
					},
				],
			},
		});
		try {
			await expect(remoteStore.refreshOAuthCredential("anthropic", 1, allowedCredential)).rejects.toThrow(
				"outside the configured account pool",
			);
			expect(remoteStore.snapshot.credentials).toEqual([]);
		} finally {
			remoteStore.close();
		}
	});
});
