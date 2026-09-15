import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	AuthStorage,
	type CredentialDisabledEvent,
	fingerprintOAuthBearer,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

/** Ambient Anthropic keys would short-circuit `getApiKey` past the stored OAuth row under test. */
const withoutAmbientAnthropicKeys = (fn: () => Promise<void>): Promise<void> =>
	withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, fn);

function mintOAuthCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: "access-a",
		refresh: "refresh-a",
		expires: Date.now() + 60 * 60_000,
		accountId: "account-a",
		email: "a@example.com",
	};
}

describe("credential disable bearer CAS", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let credential: OAuthCredential;
	let rotated: OAuthCredential;
	let id: number;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let peer: AuthStorage | undefined;
	let brokerEvents: CredentialDisabledEvent[];
	let peerEvents: CredentialDisabledEvent[];
	let announcements: unknown[];
	let restoreWarn: () => void;

	beforeEach(async () => {
		brokerEvents = [];
		peerEvents = [];
		announcements = [];
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation((_message, meta) => {
			if (typeof meta?.disabledCause === "string") announcements.push(meta);
		});
		restoreWarn = () => warnSpy.mockRestore();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-cas-disable-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		credential = mintOAuthCredential();
		rotated = { ...credential, access: "access-a2", refresh: "refresh-a2" };
		store.saveOAuth("anthropic", credential);
		id = store.listAuthCredentials("anthropic")[0]!.id;
		storage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				brokerEvents.push(event);
			},
		});
		await storage.reload();
	});

	afterEach(async () => {
		peer?.close();
		remote?.close();
		await handle?.close();
		peer = undefined;
		remote = undefined;
		handle = undefined;
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		restoreWarn();
	});

	test("local invalidated-token rotation keeps the row another process rotated", () =>
		withoutAmbientAnthropicKeys(async () => {
			expect(await storage.getApiKey("anthropic", "s1")).toBe("access-a");
			const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			try {
				peerStore.updateAuthCredential(id, rotated);
				expect(
					await storage.rotateSessionCredential("anthropic", "s1", {
						error: new Error("401 invalidated oauth token"),
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				expect(await storage.getApiKey("anthropic", "s1")).toBe(rotated.access);
				expect(brokerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			} finally {
				peerStore.close();
			}
		}));

	test("local invalidated-token failure binds its row id to the bearer sent before a peer refresh", () =>
		withoutAmbientAnthropicKeys(async () => {
			const failed = await storage.getOAuthAccess("anthropic", "s1");
			expect(failed).toMatchObject({ accessToken: credential.access, credentialId: id });
			const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			try {
				peerStore.updateAuthCredential(id, rotated);
				// The failed bearer is gone, so nothing is retired under it and there
				// is nothing to switch to on this request: auth-retry keys attempts
				// by row id, so the replacement on the same row counts as attempted.
				expect(
					await storage.rotateSessionCredential("anthropic", "s1", {
						error: new Error("401 invalidated oauth token"),
						apiKey: failed!.accessToken,
						credentialId: failed!.credentialId,
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				expect(await storage.getApiKey("anthropic", "s1")).toBe(rotated.access);
				expect(brokerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			} finally {
				peerStore.close();
			}
		}));

	test("a refresh delivered while resolving a failure cannot replace its captured bearer", () =>
		withoutAmbientAnthropicKeys(async () => {
			const failed = await storage.getOAuthAccess("anthropic", "s1");
			const list = store.listAuthCredentials.bind(store);
			const readSpy = vi.spyOn(store, "listAuthCredentials").mockImplementationOnce(provider => {
				const rows = list(provider);
				queueMicrotask(() => storage.upsertCredential("anthropic", rotated));
				return rows;
			});
			try {
				await storage.rotateSessionCredential("anthropic", "s1", {
					error: new Error("401 invalidated oauth token"),
					apiKey: failed!.accessToken,
					credentialId: failed!.credentialId,
				});
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				expect(await storage.getApiKey("anthropic", "s1")).toBe(rotated.access);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				expect(brokerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			} finally {
				readSpy.mockRestore();
			}
		}));

	test("local invalidated-token rotation disables the failed bearer and emits its cause", () =>
		withoutAmbientAnthropicKeys(async () => {
			const error = new Error("401 invalidated oauth token; client_secret=LOG_CANARY");
			expect(
				await storage.rotateSessionCredential("anthropic", "s1", {
					error,
					apiKey: credential.access,
					credentialId: id,
				}),
			).toBe(false);
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(brokerEvents).toEqual([
				expect.objectContaining({
					provider: "anthropic",
					credentialId: id,
					accountId: credential.accountId,
					email: credential.email,
					disabledCause: expect.stringContaining(error.message),
				}),
			]);
			// The store keeps the verbatim cause; the event carries the classified one.
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([
				{ id, cause: expect.stringContaining("invalidated oauth token") },
			]);
			expect(announcements).toEqual([
				expect.objectContaining({
					credentialId: id,
					accountId: credential.accountId,
					email: credential.email,
				}),
			]);
			expect(JSON.stringify(announcements)).not.toContain("LOG_CANARY");
		}));

	test("local conditional disable emits the normalized automatic cause only for its winner", async () => {
		const cause = "oauth refresh failed: invalid_grant";
		const fingerprint = fingerprintOAuthBearer(credential.access);
		expect(await storage.disableCredentialIfFingerprintMatches(id, fingerprint, ` \t${cause} \n`)).toBe("disabled");
		expect(await storage.disableCredentialIfFingerprintMatches(id, fingerprint, "another failure")).toBe("missing");
		expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
		expect(brokerEvents).toEqual([expect.objectContaining({ credentialId: id, disabledCause: cause })]);
	});

	test("local deliberate removal normalizes its cause and silently purges the tombstone on retry", async () => {
		const cause = "logged out by user via CLI";
		expect(storage.disableCredentialById(id, ` \t${cause} \n`)).toBe(true);
		expect(store.listAuthCredentials("anthropic")).toEqual([]);
		expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
		expect(brokerEvents).toEqual([]);
		expect(storage.disableCredentialById(id, ` \t${cause} \n`)).toBe(true);
		expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
		expect(brokerEvents).toEqual([]);
		expect(announcements).toEqual([]);
	});

	test("local unconditional disable emits the persisted default for an empty cause", async () => {
		expect(storage.disableCredentialById(id, " \t\n")).toBe(true);
		expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause: "disabled" }]);
		expect(brokerEvents).toEqual([expect.objectContaining({ credentialId: id, disabledCause: "disabled" })]);
	});

	test.each([
		["automatic", "oauth refresh failed: invalid_grant", true],
		["deliberate", "deleted by user", false],
	] as const)("stored refresh classifies its normalized %s callback cause", async (_kind, cause, automatic) => {
		const result = await storage.refreshStoredOAuthCredential("anthropic", {
			credentialId: id,
			forceRefresh: true,
			credentialFromRow: row => row,
			refresh: async () => {
				throw new Error("invalid_grant");
			},
			isDefinitiveFailure: error => error instanceof Error && error.message === "invalid_grant",
			disabledCause: () => ` \t${cause} \n`,
		});
		expect(result).toEqual({ credential: undefined, refreshed: false, removed: true });
		expect(store.listAuthCredentials("anthropic")).toEqual([]);
		expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
		expect(brokerEvents).toEqual(
			automatic ? [expect.objectContaining({ credentialId: id, disabledCause: cause })] : [],
		);
	});

	describe("auth broker", () => {
		let client: AuthBrokerClient;
		const cause = "invalid_grant";
		const staleFingerprint = fingerprintOAuthBearer("access-a");
		const currentFingerprint = fingerprintOAuthBearer("access-a2");

		beforeEach(() => {
			const token = "cas-disable-bearer";
			handle = startAuthBroker({
				storage,
				bind: "127.0.0.1:0",
				bearerTokens: [token],
				disableRefresher: true,
			});
			client = new AuthBrokerClient({ url: handle.url, token });
		});

		async function openRemote(): Promise<RemoteAuthCredentialStore> {
			const result = await client.fetchSnapshot();
			if (result.status !== 200) throw new Error("expected initial snapshot");
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: result.snapshot, streamSnapshots: false });
			return remote;
		}

		test("wire disable rejects a stale bearer and tombstones only the matching bearer", async () => {
			expect(storage.upsertCredential("anthropic", rotated)).toMatchObject([{ id }]);
			const error = await client
				.disableCredential(id, cause, { expectedAccessFingerprint: staleFingerprint })
				.catch(error => error);
			expect(error).toBeInstanceOf(AuthBrokerError);
			expect(error.status).toBe(412);
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);

			expect(await client.disableCredential(id, cause, { expectedAccessFingerprint: currentFingerprint })).toEqual({
				ok: true,
			});
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
		});

		test("wire conditional user removal does not announce an automatic disable", async () => {
			expect(
				await client.disableCredential(id, " \tdeleted by user \n", {
					expectedAccessFingerprint: staleFingerprint,
				}),
			).toEqual({ ok: true });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause: "deleted by user" }]);
			expect(brokerEvents).toEqual([]);
			expect(announcements).toEqual([]);
		});

		test("wire disable without If-Match remains unconditional after a peer rotation", async () => {
			storage.upsertCredential("anthropic", rotated);
			expect(await client.disableCredential(id, ` \t${cause} \n`)).toEqual({ ok: true });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
			expect(brokerEvents).toEqual([expect.objectContaining({ credentialId: id, disabledCause: cause })]);
		});

		test("broker-backed conditional disable emits the same normalized automatic cause at both endpoints", async () => {
			peer = new AuthStorage(await openRemote(), {
				onCredentialDisabled: event => {
					peerEvents.push(event);
				},
			});
			await peer.reload();
			expect(await peer.disableCredentialIfFingerprintMatches(id, staleFingerprint, ` \t${cause} \n`)).toBe(
				"disabled",
			);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
			expect(brokerEvents).toEqual([expect.objectContaining({ credentialId: id, disabledCause: cause })]);
			expect(peerEvents).toEqual([expect.objectContaining({ credentialId: id, disabledCause: cause })]);
		});

		test("wire disable distinguishes a missing row from a non-OAuth bearer mismatch", async () => {
			const key = { type: "api_key" as const, key: "api-key" };
			const entries = storage.upsertCredential("anthropic", key);
			const keyId = entries.find(entry => entry.credential.type === "api_key")!.id;
			await expect(
				client.disableCredential(keyId, cause, { expectedAccessFingerprint: fingerprintOAuthBearer(key.key) }),
			).rejects.toMatchObject({ status: 412 });
			expect(store.listAuthCredentials("anthropic")).toContainEqual(
				expect.objectContaining({ id: keyId, credential: key }),
			);
			await expect(
				client.disableCredential(keyId + 1, cause, { expectedAccessFingerprint: staleFingerprint }),
			).rejects.toMatchObject({ status: 404 });
		});

		test("wire disable loses SQLite CAS and reloads when the broker snapshot is stale", async () => {
			store.updateAuthCredential(id, rotated);
			await expect(
				client.disableCredential(id, cause, { expectedAccessFingerprint: staleFingerprint }),
			).rejects.toMatchObject({ status: 412 });
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
			expect(storage.exportSnapshot().credentials).toMatchObject([{ id, credential: { access: rotated.access } }]);
			expect(brokerEvents).toEqual([]);
			expect(announcements).toEqual([]);
		});

		test("remote disable preserves and reconciles a rotated row before accepting its current bearer", async () => {
			const remoteStore = await openRemote();
			storage.upsertCredential("anthropic", rotated);
			expect(await remoteStore.deleteAuthCredentialRemote(id, cause, staleFingerprint)).toBe(false);
			// Reconciliation is awaited: the rotated bearer is visible as soon as the
			// CAS-loss result is, with background sync parked.
			expect(remoteStore.listAuthCredentials("anthropic")).toMatchObject([
				{ id, credential: { access: rotated.access } },
			]);
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
			expect(await remoteStore.deleteAuthCredentialRemote(id, cause, currentFingerprint)).toBe(true);
			expect(remoteStore.listAuthCredentials("anthropic")).toEqual([]);
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
		});

		test("remote disable reports a lost CAS, not a failure, when a peer removed the row first", async () => {
			const remoteStore = await openRemote();
			// The peer's disable lands on the broker while this client's snapshot still holds the row.
			expect(storage.disableCredentialById(id, "oauth refresh failed: invalid_grant")).toBe(true);
			expect(remoteStore.listAuthCredentials("anthropic")).toMatchObject([{ id }]);
			expect(await remoteStore.deleteAuthCredentialRemote(id, cause, staleFingerprint)).toBe(false);
			// Reconciled: the row is gone locally too, and the tombstone keeps the peer's cause.
			expect(remoteStore.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([
				{ id, cause: "oauth refresh failed: invalid_grant" },
			]);
		});

		test("a stale broker-backed AuthStorage cannot disable a peer-rotated invalidated bearer", () =>
			withoutAmbientAnthropicKeys(async () => {
				const remoteStore = await openRemote();
				peer = new AuthStorage(remoteStore);
				peer.onCredentialDisabled(event => {
					peerEvents.push(event);
				});
				await peer.reload();
				storage.upsertCredential("anthropic", rotated);
				expect(
					await peer.rotateSessionCredential("anthropic", "s1", {
						error: new Error("401 invalidated oauth token"),
						apiKey: credential.access,
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				// The rejected disable already reconciled the peer: its next resolve
				// serves the rotated bearer, not the one the broker just refused.
				expect(remoteStore.listAuthCredentials("anthropic")).toMatchObject([
					{ id, credential: { access: "access-a2" } },
				]);
				expect(await peer.getApiKey("anthropic", "s1")).toBe("access-a2");
				expect(brokerEvents).toEqual([]);
				expect(peerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			}));

		test("a broker snapshot received before failure cannot rebind the failed bearer to its refreshed row", () =>
			withoutAmbientAnthropicKeys(async () => {
				const remoteStore = await openRemote();
				peer = new AuthStorage(remoteStore, {
					onCredentialDisabled: event => {
						peerEvents.push(event);
					},
				});
				await peer.reload();
				const failed = await peer.getOAuthAccess("anthropic", "s1");
				expect(failed).toMatchObject({ accessToken: credential.access, credentialId: id });
				storage.upsertCredential("anthropic", rotated);
				// A stream or polling update arrives while the request is in flight.
				await remoteStore.refreshSnapshot();
				const error = new Error("401 invalidated oauth token");
				expect(
					await peer.rotateSessionCredential("anthropic", "s1", {
						error,
						apiKey: failed!.accessToken,
						credentialId: failed!.credentialId,
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				expect(await peer.getApiKey("anthropic", "s1")).toBe(rotated.access);
				expect(brokerEvents).toEqual([]);
				expect(peerEvents).toEqual([]);
				expect(announcements).toEqual([]);

				expect(
					await peer.rotateSessionCredential("anthropic", "s1", {
						error,
						apiKey: rotated.access,
						credentialId: id,
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toEqual([]);
				expect(await peer.getApiKey("anthropic", "s1")).toBeUndefined();
				expect(await store.listDisabledCredentials("anthropic")).toMatchObject([
					{ id, cause: expect.stringContaining(error.message) },
				]);
				expect(brokerEvents).toEqual([expect.objectContaining({ credentialId: id })]);
				expect(peerEvents).toEqual([expect.objectContaining({ credentialId: id })]);
				expect(announcements).toEqual([
					expect.objectContaining({ credentialId: id }),
					expect.objectContaining({ credentialId: id }),
				]);
			}));

		test("a stale broker-backed AuthStorage reconciles a missing bearer without announcing a disable", () =>
			withoutAmbientAnthropicKeys(async () => {
				const remoteStore = await openRemote();
				peer = new AuthStorage(remoteStore);
				peer.onCredentialDisabled(event => {
					peerEvents.push(event);
				});
				await peer.reload();
				expect(storage.disableCredentialById(id, "deleted by user")).toBe(true);
				expect(
					await peer.rotateSessionCredential("anthropic", "s1", {
						error: new Error("401 invalidated oauth token"),
						apiKey: credential.access,
					}),
				).toBe(false);
				expect(remoteStore.listAuthCredentials("anthropic")).toEqual([]);
				expect(await peer.getApiKey("anthropic", "s1")).toBeUndefined();
				expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause: "deleted by user" }]);
				expect(brokerEvents).toEqual([]);
				expect(peerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			}));

		test("API-key invalidation preserves a replacement, then disables its current key exactly once", () =>
			withoutAmbientAnthropicKeys(async () => {
				const key = { type: "api_key" as const, key: "old-api-key" };
				const replacement = { ...key, key: "new-api-key" };
				store.updateAuthCredential(id, key);
				await storage.reload();
				const keyId = id;
				const remoteStore = await openRemote();
				peer = new AuthStorage(remoteStore, { usageProviderResolver: () => undefined });
				peer.onCredentialDisabled(event => {
					peerEvents.push(event);
				});
				await peer.reload();
				store.updateAuthCredential(keyId, replacement);
				await storage.reload();
				const error = new Error("401 invalidated oauth token");
				expect(await peer.rotateSessionCredential("anthropic", "s1", { error, apiKey: key.key })).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id: keyId, credential: replacement }]);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				// No stream or polling: the lost CAS reconciles before returning.
				expect(await peer.getApiKey("anthropic", "s1")).toBe(replacement.key);
				expect(brokerEvents).toEqual([]);
				expect(peerEvents).toEqual([]);
				expect(announcements).toEqual([]);

				expect(await peer.rotateSessionCredential("anthropic", "s1", { error, apiKey: replacement.key })).toBe(
					false,
				);
				expect(await peer.rotateSessionCredential("anthropic", "s1", { error, apiKey: replacement.key })).toBe(
					false,
				);
				expect(store.listAuthCredentials("anthropic")).toEqual([]);
				expect(await peer.getApiKey("anthropic", "s1")).toBeUndefined();
				expect(brokerEvents).toEqual([expect.objectContaining({ provider: "anthropic", credentialId: keyId })]);
				expect(peerEvents).toEqual([expect.objectContaining({ provider: "anthropic", credentialId: keyId })]);
				// The store keeps the verbatim cause; the event carries the classified one.
				expect(await store.listDisabledCredentials("anthropic")).toMatchObject([
					{ id: keyId, cause: expect.stringContaining("invalidated oauth token") },
				]);
				// One local announcement at each endpoint, none for the stale/repeated attempts.
				expect(announcements).toEqual([
					expect.objectContaining({ credentialId: keyId }),
					expect.objectContaining({ credentialId: keyId }),
				]);
				expect(JSON.stringify(announcements)).not.toContain(key.key);
				expect(JSON.stringify(announcements)).not.toContain(replacement.key);
			}));

		test("stale API-key invalidation cannot disable an OAuth replacement with identical access bytes", () =>
			withoutAmbientAnthropicKeys(async () => {
				const key = { type: "api_key" as const, key: credential.access };
				store.updateAuthCredential(id, key);
				await storage.reload();
				const keyId = id;
				const remoteStore = await openRemote();
				peer = new AuthStorage(remoteStore);
				peer.onCredentialDisabled(event => {
					peerEvents.push(event);
				});
				await peer.reload();
				store.updateAuthCredential(keyId, credential);
				await storage.reload();
				expect(
					await peer.rotateSessionCredential("anthropic", "s1", {
						error: new Error("401 invalidated oauth token"),
						apiKey: key.key,
					}),
				).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id: keyId, credential }]);
				expect(await peer.getApiKey("anthropic", "s1")).toBe(credential.access);
				expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
				expect(brokerEvents).toEqual([]);
				expect(peerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			}));

		for (const streamSnapshots of [false, true]) {
			test.each([404, 412] as const)(
				`failed %s reconciliation stops stale bearer selection (SSE=${streamSnapshots})`,
				status =>
					withoutAmbientAnthropicKeys(async () => {
						const initial = await client.fetchSnapshot();
						if (initial.status !== 200) throw new Error("expected initial snapshot");
						const ready = Promise.withResolvers<void>();
						const waitForAbort = (signal?: AbortSignal): Promise<void> => {
							const deferred = Promise.withResolvers<void>();
							if (signal?.aborted) deferred.resolve();
							else signal?.addEventListener("abort", () => deferred.resolve(), { once: true });
							return deferred.promise;
						};
						const failure =
							status === 404
								? new DOMException("reconciliation cancelled", "AbortError")
								: new AuthBrokerError(
										'HTTP 503 {"refresh_token":"RTSECRET","error":"temporarily unavailable"}',
									);
						let rejectSnapshot = false;
						const fetchSnapshot = client.fetchSnapshot.bind(client);
						const snapshotSpy = vi.spyOn(client, "fetchSnapshot").mockImplementation(async options => {
							if (options?.waitMs !== undefined) {
								ready.resolve();
								await waitForAbort(options.signal);
								throw options.signal?.reason;
							}
							if (rejectSnapshot) throw failure;
							return fetchSnapshot(options);
						});
						const streamSpy = vi
							.spyOn(client, "openSnapshotStream")
							.mockImplementation(async function* (options) {
								yield { kind: "snapshot" as const, ...initial.snapshot };
								ready.resolve();
								await waitForAbort(options?.signal);
							});
						const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
						try {
							remote = new RemoteAuthCredentialStore({
								client,
								initialSnapshot: initial.snapshot,
								streamSnapshots,
							});
							peer = new AuthStorage(remote, { usageProviderResolver: () => undefined });
							await peer.reload();
							await ready.promise;
							expect(await peer.getApiKey("anthropic", "failed-reconcile")).toBe(credential.access);
							if (status === 412) storage.upsertCredential("anthropic", rotated);
							else storage.disableCredentialById(id, "oauth refresh failed: invalid_grant");
							rejectSnapshot = true;
							const outcome = await peer
								.rotateSessionCredential("anthropic", "failed-reconcile", {
									error: new Error("401 invalidated oauth token"),
									apiKey: credential.access,
									credentialId: id,
								})
								.catch(error => error);
							expect(outcome).toBe(failure);
							// Debug logs carry the broker error verbatim, as they already do on
							// every other auth path; the reconciliation outcome is what this asserts.
							rejectSnapshot = false;
							expect(await remote.deleteAuthCredentialRemote(id, cause, staleFingerprint)).toBe(false);
							await peer.reload();
							expect(await peer.getApiKey("anthropic", "failed-reconcile")).toBe(
								status === 412 ? rotated.access : undefined,
							);
						} finally {
							peer?.close();
							remote?.close();
							snapshotSpy.mockRestore();
							streamSpy.mockRestore();
							debugSpy.mockRestore();
						}
					}),
			);
		}

		test("stored refresh failures await remote bearer CAS instead of accepting an optimistic disable", async () => {
			const remoteStore = await openRemote();
			peer = new AuthStorage(remoteStore);
			peer.onCredentialDisabled(event => {
				peerEvents.push(event);
			});
			await peer.reload();
			const result = await peer.refreshStoredOAuthCredential("anthropic", {
				credentialId: id,
				forceRefresh: true,
				credentialFromRow: row => row,
				refresh: async () => {
					storage.upsertCredential("anthropic", rotated);
					throw new Error("invalid_grant");
				},
				isDefinitiveFailure: error => error instanceof Error && error.message === "invalid_grant",
			});
			expect(result.removed).toBe(false);
			// CAS loss hands back the row the peer rotated, not the dead bearer we attempted.
			expect(result.credential).toMatchObject({ access: "access-a2" });
			await withoutAmbientAnthropicKeys(async () => {
				expect(await peer!.getApiKey("anthropic", "s1")).toBe(rotated.access);
			});
			expect(brokerEvents).toEqual([]);
			expect(peerEvents).toEqual([]);
			expect(announcements).toEqual([]);
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
		});

		test("a snapshot captured before a successful disable cannot resurrect the row", async () => {
			const store = await openRemote();
			// A full-snapshot response already in flight when the disable lands still
			// lists the row and carries the pre-disable generation. Accepting it
			// resurrects the row, and the stream removal that follows is then read as
			// a fresh teardown — the same sign-out announced twice.
			const inFlight = await client.fetchSnapshot();
			if (inFlight.status !== 200) throw new Error("expected a snapshot");
			expect(inFlight.snapshot.credentials.some(entry => entry.id === id)).toBe(true);

			expect(await store.deleteAuthCredentialRemote(id, cause, staleFingerprint)).toBe(true);
			expect(store.listAuthCredentials("anthropic").some(entry => entry.id === id)).toBe(false);

			// Deliver it now, through the ordinary pull path.
			const pull = vi.spyOn(client, "fetchSnapshot").mockResolvedValue(inFlight);
			try {
				await store.refreshSnapshot().catch(() => undefined);
			} finally {
				pull.mockRestore();
			}
			expect(store.listAuthCredentials("anthropic").some(entry => entry.id === id)).toBe(false);
		});
	});

	test("a streamed removal releases the guard that hides a reused credential id", async () => {
		const token = "guard-release-token";
		handle?.close();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
		const client = new AuthBrokerClient({ url: handle.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial snapshot");
		const streamed = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: true,
		});
		remote = streamed;
		try {
			expect(
				await streamed.deleteAuthCredentialRemote(id, "invalid_grant", fingerprintOAuthBearer("access-a")),
			).toBe(true);
			// Wait for the broker's own `removed` frame. A healthy stream suppresses
			// the follow-up full snapshot, which is the only other thing that
			// releases the guard.
			const deadline = Date.now() + 5_000;
			while (streamed.listAuthCredentials("anthropic").length > 0 && Date.now() < deadline) await Bun.sleep(10);

			// The broker database is replaced and the id is reused by a different
			// account. A guard still held from the old incarnation filters it out,
			// and this client never sees the credential again.
			const rebuilt = await client.fetchSnapshot();
			if (rebuilt.status !== 200) throw new Error("expected snapshot");
			const previousEntry = initial.snapshot.credentials.find(entry => entry.id === id);
			if (!previousEntry) throw new Error("expected the pre-removal entry");
			const reused = {
				...previousEntry,
				credential: { ...previousEntry.credential, access: "access-reused", email: "reused@example.com" },
			};
			const pull = vi.spyOn(client, "fetchSnapshot").mockResolvedValue({
				...rebuilt,
				generation: rebuilt.generation + 1,
				snapshot: {
					...rebuilt.snapshot,
					generation: rebuilt.snapshot.generation + 1,
					credentials: [reused],
				},
			});
			try {
				await streamed.refreshSnapshot();
			} finally {
				pull.mockRestore();
			}
			expect(streamed.listAuthCredentials("anthropic")).toMatchObject([
				{ id, credential: { access: "access-reused", email: "reused@example.com" } },
			]);
		} finally {
			streamed.close();
			remote = undefined;
		}
	});

	test("a restarted broker is re-probed for disabled history", async () => {
		// The broker this client first met keeps no tombstones.
		let historySupported = false;
		const token = "reprobe-token";
		handle?.close();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
		const upstreamUrl = handle.url;
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (!historySupported && url.pathname === "/v1/credentials/disabled") {
					return new Response("unsupported", { status: 501 });
				}
				return fetch(new Request(`${upstreamUrl}${url.pathname}${url.search}`, req));
			},
		});
		const proxied = new AuthBrokerClient({ url: proxy.url.href, token });
		const initial = await proxied.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: proxied,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		try {
			// Produce a tombstone the history endpoint would report.
			expect(storage.disableCredentialById(id, "invalid_grant")).toBe(true);

			expect(await remoteStore.listDisabledCredentials("anthropic")).toEqual([]);

			// The broker is restarted onto a tombstone-capable store; its in-memory
			// generation counter runs backwards, which is the restart signature.
			historySupported = true;
			const restarted = await proxied.fetchSnapshot();
			if (restarted.status !== 200) throw new Error("expected snapshot");
			const pull = vi.spyOn(proxied, "fetchSnapshot").mockResolvedValue({
				...restarted,
				generation: 0,
				snapshot: { ...restarted.snapshot, generation: 0 },
			});
			try {
				await remoteStore.refreshSnapshot().catch(() => undefined);
			} finally {
				pull.mockRestore();
			}

			// A latch held past the restart would suppress every later replay.
			expect((await remoteStore.listDisabledCredentials("anthropic")).map(entry => entry.id)).toEqual([id]);
		} finally {
			remoteStore.close();
			proxy.stop(true);
		}
	});

	test("an invalidated-token report that cannot name the failed bearer retires nothing", async () => {
		const error = "upstream reported an invalidated OAuth token";
		await withoutAmbientAnthropicKeys(async () => {
			// Establish the sticky selection an unproven report would otherwise retire.
			expect(await storage.getApiKey("anthropic", "s1")).toBe(credential.access);
			// A sticky slot is not proof of which credential version failed.
			expect(await storage.rotateSessionCredential("anthropic", "s1", { error })).toBe(false);
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential }]);
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
			expect(brokerEvents).toEqual([]);
		});
	});
});
