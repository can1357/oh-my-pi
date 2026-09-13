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
import { serializeCredential } from "../src/auth/sqlite-credential-store";
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
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
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation((message, meta) => {
			if (message === "Auth credential disabled") announcements.push(meta);
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

	test("local invalidated-token rotation disables the failed bearer and emits its cause", () =>
		withoutAmbientAnthropicKeys(async () => {
			const error = new Error("401 invalidated oauth token");
			expect(await storage.rotateSessionCredential("anthropic", "s1", { error, apiKey: credential.access })).toBe(
				false,
			);
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
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([
				{ id, cause: brokerEvents[0]!.disabledCause },
			]);
			expect(announcements).toEqual([
				expect.objectContaining({
					credentialId: id,
					accountId: credential.accountId,
					email: credential.email,
					disabledCause: expect.stringContaining("invalidated oauth token"),
				}),
			]);
		}));

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
				await client.disableCredential(id, "deleted by user", { expectedAccessFingerprint: staleFingerprint }),
			).toEqual({ ok: true });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause: "deleted by user" }]);
			expect(brokerEvents).toEqual([]);
			expect(announcements).toEqual([]);
		});

		test("wire disable without If-Match remains unconditional after a peer rotation", async () => {
			storage.upsertCredential("anthropic", rotated);
			expect(await client.disableCredential(id, cause)).toEqual({ ok: true });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
			expect(await store.listDisabledCredentials("anthropic")).toMatchObject([{ id, cause }]);
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

		test("sync remote disable rejects mismatched serialized credentials without disabling the row", async () => {
			const remoteStore = await openRemote();
			const expectedData = serializeCredential("anthropic", { ...credential, access: "different-access" })!.data;
			expect(remoteStore.tryDisableAuthCredentialIfMatches(id, expectedData, cause)).toBe(false);
			expect(remoteStore.listAuthCredentials("anthropic")).toMatchObject([{ id }]);
			await remoteStore.refreshSnapshot();
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential }]);
		});

		test("sync remote disable restores the peer-rotated row after optimistic removal loses bearer CAS", async () => {
			const remoteStore = await openRemote();
			const expectedData = serializeCredential(
				"anthropic",
				remoteStore.listAuthCredentials("anthropic")[0]!.credential,
			)!.data;
			storage.upsertCredential("anthropic", rotated);
			expect(remoteStore.tryDisableAuthCredentialIfMatches(id, expectedData, cause)).toBe(true);
			expect(remoteStore.listAuthCredentials("anthropic")).toEqual([]);
			await waitUntil(() => {
				const current = remoteStore.listAuthCredentials("anthropic")[0]?.credential;
				return current?.type === "oauth" && current.access === rotated.access;
			});
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
			expect(await store.listDisabledCredentials("anthropic")).toEqual([]);
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

		test("failed lost-CAS reconciliation redacts credentials without masking the CAS outcome", async () => {
			const remoteStore = await openRemote();
			storage.upsertCredential("anthropic", rotated);
			const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
			const snapshotSpy = vi
				.spyOn(remoteStore, "refreshSnapshot")
				.mockRejectedValueOnce(
					new AuthBrokerError('HTTP 503 {"refresh_token":"RTSECRET","error":"temporarily unavailable"}'),
				);
			try {
				expect(await remoteStore.deleteAuthCredentialRemote(id, cause, staleFingerprint)).toBe(false);
				expect(store.listAuthCredentials("anthropic")).toMatchObject([{ id, credential: rotated }]);
				const diagnostics = debugSpy.mock.calls.flatMap(([, meta]) => (meta?.error ? [meta.error] : []));
				expect(diagnostics).toEqual([expect.stringContaining("HTTP 503")]);
				expect(JSON.stringify(diagnostics)).not.toContain("RTSECRET");
				expect(brokerEvents).toEqual([]);
				expect(announcements).toEqual([]);
			} finally {
				snapshotSpy.mockRestore();
				debugSpy.mockRestore();
			}
		});

		test("remote disable diagnostics redact managed provider URLs and echoed credentials", async () => {
			const provider = "mcp_oauth:profile:default:https://host.test/mcp?key=QUERYSECRET&region=west";
			storage.upsertCredential(provider, credential);
			const remoteStore = await openRemote();
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const disableSpy = vi
				.spyOn(client, "disableCredential")
				.mockRejectedValue(
					new AuthBrokerError('HTTP 503 {"refresh_token":"RTSECRET","error":"temporarily unavailable"}'),
				);
			try {
				await remoteStore.deleteAuthCredentialsRemote(provider, "deleted by user");
				const diagnostics = warnSpy.mock.calls.map(([, meta]) => meta);
				expect(diagnostics).toEqual([
					expect.objectContaining({
						provider: expect.stringContaining("region=west"),
						error: expect.stringContaining("HTTP 503"),
					}),
				]);
				expect(JSON.stringify(diagnostics)).not.toContain("QUERYSECRET");
				expect(JSON.stringify(diagnostics)).not.toContain("RTSECRET");
			} finally {
				disableSpy.mockRestore();
				warnSpy.mockRestore();
			}
		});

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
	});
});
