import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	AuthStorage,
	type AuthCredentialStore,
	type CredentialDisabledEvent,
	type DisabledCredentialSummary,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/oauth";
import {
	collectDisabledCredentialNotices,
	formatCredentialDisabledNotice,
	formatDisabledCredentialReplayNotice,
	type RetainedCredentialDisable,
} from "@oh-my-pi/pi-coding-agent/config/credential-notices";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { withEnv } from "../../ai/test/helpers";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const oauthCredential = (expires: number) => ({
	type: "oauth" as const,
	access: "access-token",
	refresh: "refresh-token",
	expires,
	email: "signed-out@example.com",
	accountId: "acct-1",
});

describe("credential sign-out notices", () => {
	it("replays a racing teardown without a subscription mark, but deduplicates one observed live", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		try {
			for (const subscribed of [false, true]) {
				const lookup = Promise.withResolvers<DisabledCredentialSummary[]>();
				vi.spyOn(store, "listDisabledCredentials").mockReturnValueOnce(lookup.promise);
				const live: AgentSessionEvent[] = [];
				const mark = session.disabledCredentialNoticeMark;
				const unsubscribe = subscribed
					? session.subscribe(event => {
							live.push(event);
						})
					: () => {};
				const replay = session.getDisabledCredentialNotices(subscribed ? { announcedAfter: mark } : undefined);
				session.announceCredentialDisabled({
					provider: "anthropic",
					credentialId: 99,
					credentialType: "oauth",
					email: "race@example.com",
					disabledCause: "invalid_grant",
				});
				lookup.resolve([
					{ provider: "anthropic", id: 99, type: "oauth", email: "race@example.com", cause: "invalid_grant" },
				]);
				const notices = await replay;
				if (subscribed) {
					expect(notices).toEqual([]);
					expect(live.filter(event => event.type === "notice")).toHaveLength(1);
				} else {
					expect(notices).toHaveLength(1);
					expect(notices[0]).toContain("race@example.com");
				}
				unsubscribe();
			}
		} finally {
			await session.dispose();
		}
	});
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-notices-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(["disable", "logout"] as const)("uses post-revalidation history after a sibling %s", async transition => {
		const database = path.join(tempDir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(database);
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [
			{ ...oauthCredential(Date.now() + 60_000), email: "earlier@example.test", accountId: "earlier" },
			{ ...oauthCredential(Date.now() + 60_000), email: "racing@example.test", accountId: "racing" },
		]);
		const [earlier, racing] = authStorage.listStoredCredentials("anthropic");
		if (!earlier || !racing) throw new Error("expected two accounts");
		const retained = new Map<number, RetainedCredentialDisable>();
		authStorage.onCredentialDisabled(event => {
			retained.set(event.credentialId, { event, disabledAtMs: Date.now() });
		});
		authStorage.disableCredentialById(earlier.id, "invalid_grant");
		const sibling = await SqliteAuthCredentialStore.open(database);
		const revalidate = authStorage.revalidateCredentials.bind(authStorage);
		vi.spyOn(authStorage, "revalidateCredentials").mockImplementationOnce(async signal => {
			sibling.deleteAuthCredential(
				transition === "disable" ? racing.id : earlier.id,
				transition === "disable" ? "invalid_grant" : "deleted by user",
			);
			await revalidate(signal);
		});
		try {
			const notices = await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained);
			if (transition === "disable") {
				expect(notices).toHaveLength(2);
				expect(notices.join("\n")).toContain("earlier@example.test");
				expect(notices.join("\n")).toContain("racing@example.test");
			} else {
				expect(notices).toEqual([]);
				expect(retained.has(earlier.id)).toBe(false);
			}
		} finally {
			sibling.close();
		}
	});

	it("replays an automatic sign-out at startup until the account signs in again", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [oauthCredential(Date.now() - 60_000)]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant revoked"}');
		});
		await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			expect(await authStorage!.getApiKey("anthropic", "session")).toBeUndefined();
		});

		const notices = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("anthropic signed-out@example.com was signed out");
		expect(notices[0]).toContain("sign-in expired");
		expect(notices[0]).toContain("/login anthropic");
		// A teardown a live notice already announced to the caller is not
		// repeated, and membership is read once the lookup has settled, so an
		// announcement landing mid-lookup still counts.
		const [tombstone] = await authStorage.listDisabledCredentials("anthropic");
		if (!tombstone) throw new Error("tombstone missing");
		const announced = new Set<number>();
		const listing = store.listDisabledCredentials.bind(store);
		vi.spyOn(store, "listDisabledCredentials").mockImplementationOnce(async (...args) => {
			const result = await listing(...args);
			expect(result.map(summary => summary.id)).toEqual([tombstone.id]);
			announced.add(tombstone.id);
			return result;
		});
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), id => announced.has(id))).toEqual([]);

		await authStorage.set("anthropic", [oauthCredential(Date.now() + 3_600_000)]);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("coalesces repeated SQLite sign-outs before the startup cap without retiring forensic events", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		const retained = new Map<number, RetainedCredentialDisable>();
		const nowMs = Math.floor(Date.now() / 1000) * 1000;
		let disabledAtMs = nowMs - 20 * 60_000;
		authStorage.onCredentialDisabled(event => {
			retained.set(event.credentialId, { event, disabledAtMs });
		});
		const db = new Database(dbPath);
		let latestId = 0;
		try {
			// Each re-login creates a new row; older disables keep their original clocks.
			for (let index = 0; index < 18; index++) {
				const email = index < 8 ? `distinct${index}@example.com` : "repeated@example.com";
				await authStorage.set("anthropic", { ...oauthCredential(nowMs + 60_000), email });
				latestId = authStorage.listStoredCredentials("anthropic")[0]!.id;
				disabledAtMs += 60_000;
				expect(authStorage.disableCredentialById(latestId, `invalid_grant generation-${index}`)).toBe(true);
				db.prepare("UPDATE auth_credentials SET updated_at = ? WHERE id = ?").run(disabledAtMs / 1000, latestId);
			}
			const history = await store.listDisabledCredentials();
			const retainedBefore = [...retained];
			const notices = await collectDisabledCredentialNotices(authStorage, nowMs, undefined, retained);
			expect(notices).toHaveLength(9);
			expect(notices[0]).toContain("repeated@example.com");
			// Coalescing keeps one notice per account; the cause it shows is classified.
			expect(notices.filter(notice => notice.includes("repeated@example.com"))).toHaveLength(1);
			expect(notices[0]).toContain("2m ago");
			expect(notices[1]).toContain("distinct7@example.com");
			expect(notices[7]).toContain("distinct1@example.com");
			expect(notices[8]).toContain("1 more");
			expect(await store.listDisabledCredentials()).toEqual(history);
			expect([...retained]).toEqual(retainedBefore);
			// Suppressing the latest live announcement must not resurrect an older generation.
			const announced = await collectDisabledCredentialNotices(authStorage, nowMs, id => id === latestId, retained);
			expect(announced).toHaveLength(8);
			expect(announced.join("\n")).not.toContain("repeated@example.com");
			// Without a history endpoint the same projection applies to retained SDK events.
			vi.spyOn(store, "listDisabledCredentials").mockRejectedValue(new Error("broker offline"));
			const fallback = await collectDisabledCredentialNotices(authStorage, nowMs, undefined, retained);
			expect(fallback).toHaveLength(9);
			expect(fallback.filter(notice => notice.includes("repeated@example.com"))).toHaveLength(1);
			expect(fallback[1]).toContain("distinct7@example.com");
			expect(fallback[8]).toContain("1 more");
			expect([...retained]).toEqual(retainedBefore);
		} finally {
			db.close();
		}
	});

	it("merges a new SDK disable with older same-account forensic history before capping accounts", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		const unsubscribe = authStorage.onCredentialDisabled(event => session.announceCredentialDisabled(event));
		try {
			for (let index = 0; index < 8; index++) {
				await authStorage.set("anthropic", {
					...oauthCredential(Date.now() + 60_000),
					email: `distinct${index}@example.com`,
				});
				const id = authStorage.listStoredCredentials("anthropic")[0]!.id;
				expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
			}
			await authStorage.set("anthropic", oauthCredential(Date.now() + 60_000));
			const oldId = authStorage.listStoredCredentials("anthropic")[0]!.id;
			expect(authStorage.disableCredentialById(oldId, "invalid_grant older-generation")).toBe(true);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const list = store.listDisabledCredentials.bind(store);
			vi.spyOn(store, "listDisabledCredentials").mockImplementationOnce(async provider => {
				const rows = await list(provider);
				started.resolve();
				await release.promise;
				return rows;
			});
			const replay = session.getDisabledCredentialNotices();
			await started.promise;
			await authStorage.set("anthropic", { ...oauthCredential(Date.now() + 60_000), access: "new-access" });
			const newId = authStorage.listStoredCredentials("anthropic")[0]!.id;
			expect(authStorage.disableCredentialById(newId, "invalid_grant racing-generation")).toBe(true);
			release.resolve();
			const notices = await replay;
			expect(notices).toHaveLength(9);
			expect(notices.filter(notice => notice.includes("signed-out@example.com"))).toHaveLength(1);
			expect(notices[8]).toContain("1 more");
			expect((await store.listDisabledCredentials()).slice(-2).map(row => row.id)).toEqual([oldId, newId]);
			const subsequent = await session.getDisabledCredentialNotices();
			expect(subsequent).toHaveLength(9);
			// Distinguished by account and recency, not by provider-controlled text.
			expect(subsequent[0]).toContain("signed-out@example.com");
			expect(subsequent[8]).toContain("1 more");
		} finally {
			unsubscribe();
			await session.dispose();
		}
	});

	it("preserves separately retained API-key generations and unknown OAuth accounts", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(":memory:");
		store.listDisabledCredentials = undefined;
		authStorage = new AuthStorage(store);
		const retained = new Map<number, RetainedCredentialDisable>();
		for (const credentialId of [1, 2, 3, 4]) {
			retained.set(credentialId, {
				event: {
					credentialId,
					provider: "anthropic",
					credentialType: credentialId < 3 ? "api_key" : "oauth",
					disabledCause: `disabled generation-${credentialId}`,
				},
				disabledAtMs: credentialId,
			});
		}
		const notices = await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained);
		expect(notices).toHaveLength(4);
		// One notice per retained generation; the cause each shows is classified.
		expect(notices).toHaveLength(retained.size);
	});

	it("retires recovered OAuth teardown without losing a retained API-key notice", async () => {
		authStorage = await AuthStorage.create(":memory:");
		const retained = new Map<number, RetainedCredentialDisable>();
		authStorage.onCredentialDisabled(event => {
			retained.set(event.credentialId, { event, disabledAtMs: Date.now() });
		});
		await authStorage.set("anthropic", { type: "api_key", key: "retained-api-key" });
		const apiKeyId = authStorage.exportSnapshot().credentials[0]!.id;
		expect(authStorage.disableCredentialById(apiKeyId, "disabled via auth-broker")).toBe(true);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toHaveLength(1);
		await authStorage.set("openai-codex", oauthCredential(Date.now() + 60_000));
		const id = authStorage.exportSnapshot().credentials[0]!.id;
		expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toHaveLength(2);
		const claims = Buffer.from(JSON.stringify({ email: "signed-out@example.com", sub: "acct-1" })).toString(
			"base64url",
		);
		await authStorage.set("openai-codex", {
			type: "oauth",
			access: `eyJhbGciOiJub25lIn0.${claims}.signature`,
			refresh: "new-refresh",
			expires: Date.now() + 60_000,
		});
		const notices = await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("API key");
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toEqual(notices);
	});

	it("keeps an API-key teardown notice when only a key that predates it survives", async () => {
		authStorage = await AuthStorage.create(":memory:");
		const retained = new Map<number, RetainedCredentialDisable>();
		authStorage.onCredentialDisabled(event => {
			// Mirror AgentSession: carry the emitter's attribution, do not re-derive.
			retained.set(event.credentialId, {
				event,
				disabledAtMs: Date.now(),
				siblingApiKeyIds: event.siblingApiKeyIds,
			});
		});
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "first-api-key" },
			{ type: "api_key", key: "second-api-key" },
		]);
		const [lost] = authStorage.exportSnapshot().credentials;
		expect(authStorage.disableCredentialById(lost!.id, "disabled via auth-broker")).toBe(true);

		// The surviving key was already there: the pool lost one, it did not recover.
		const notices = await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("API key");

		// A genuinely new key retires it.
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "second-api-key" },
			{ type: "api_key", key: "replacement-api-key" },
		]);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toEqual([]);
	});

	it("retires a retained notice against a refreshed pool even when the broker has no history endpoint", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(":memory:");
		// An older broker: the snapshot refreshes, but tombstones are unavailable.
		store.listDisabledCredentials = undefined;
		store.refreshSnapshot = async () => undefined;
		authStorage = new AuthStorage(store);
		const retained = new Map<number, RetainedCredentialDisable>();
		authStorage.onCredentialDisabled(event => {
			retained.set(event.credentialId, { event, disabledAtMs: Date.now() });
		});
		await authStorage.set("openai-codex", oauthCredential(Date.now() + 60_000));
		const id = authStorage.listStoredCredentials("openai-codex")[0]!.id;
		expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toHaveLength(1);

		// The same account signs back in: a refreshed pool is enough to retire it.
		await authStorage.set("openai-codex", oauthCredential(Date.now() + 60_000));
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toEqual([]);
	});

	it("retires retained events when raw history replaces their automatic cause", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		const retained = new Map<number, RetainedCredentialDisable>();
		authStorage.onCredentialDisabled(event => {
			retained.set(event.credentialId, { event, disabledAtMs: Date.now() });
		});
		await authStorage.set("anthropic", oauthCredential(Date.now() + 60_000));
		const id = authStorage.listStoredCredentials("anthropic")[0]!.id;
		expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
		store.deleteAuthCredential(id, "deleted by user");
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained)).toEqual([]);
		expect(retained.has(id)).toBe(false);
	});

	it("does not discard a retained entry replaced during an authoritative empty history query", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		const event: CredentialDisabledEvent = {
			provider: "anthropic",
			credentialId: 1,
			credentialType: "oauth",
			email: "before@example.test",
			disabledCause: "invalid_grant",
		};
		const retained = new Map<number, RetainedCredentialDisable>([[1, { event, disabledAtMs: Date.now() }]]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const list = store.listDisabledCredentials.bind(store);
		vi.spyOn(store, "listDisabledCredentials").mockImplementationOnce(async provider => {
			const rows = await list(provider);
			started.resolve();
			await release.promise;
			return rows;
		});
		const replay = collectDisabledCredentialNotices(authStorage, Date.now(), undefined, retained);
		await started.promise;
		const replacement = { event: { ...event, email: "during@example.test" }, disabledAtMs: Date.now() };
		retained.set(1, replacement);
		release.resolve();
		const notices = await replay;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("during@example.test");
		expect(retained.get(1)).toBe(replacement);
	});

	it("makes no broker round-trip when clean history leaves nothing to reconcile", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		let refreshes = 0;
		store.refreshSnapshot = async () => {
			refreshes += 1;
		};
		await authStorage.set("anthropic", oauthCredential(Date.now() + 60_000));

		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
		expect(refreshes).toBe(0);

		const id = authStorage.listStoredCredentials("anthropic")[0]!.id;
		expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toHaveLength(1);
		expect(refreshes).toBe(1);
	});

	it("includes a retained teardown that arrives during fallback recovery revalidation", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(":memory:");
		store.listDisabledCredentials = undefined;
		authStorage = new AuthStorage(store);
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		store.refreshSnapshot = async () => {
			started.resolve();
			await release.promise;
		};
		try {
			session.announceCredentialDisabled({
				provider: "anthropic",
				credentialId: 1,
				credentialType: "oauth",
				email: "early@example.com",
				disabledCause: "invalid_grant",
			});
			const pending = session.getDisabledCredentialNotices();
			await started.promise;
			session.announceCredentialDisabled({
				provider: "openai",
				credentialId: 2,
				credentialType: "api_key",
				disabledCause: "disabled via auth-broker",
			});
			release.resolve();
			const notices = await pending;
			expect(notices).toHaveLength(2);
			expect(notices.some(notice => notice.includes("API key"))).toBe(true);
		} finally {
			release.resolve();
			await session.dispose();
		}
	});

	it("drops the query of a managed MCP provider id in real live and replay notices", async () => {
		authStorage = await AuthStorage.create(":memory:");
		const live: string[] = [];
		authStorage.onCredentialDisabled(event => {
			live.push(formatCredentialDisabledNotice(event));
		});
		const provider = "mcp_oauth:profile:default:https://mcp.example.com/mcp?apiKey=PROVIDERSECRET";
		await authStorage.set(provider, {
			...oauthCredential(Date.now() + 60_000),
			email: "signed-out@example.com",
		});
		const id = authStorage.exportSnapshot().credentials[0]!.id;
		expect(authStorage.disableCredentialById(id, "invalid_grant")).toBe(true);
		const replay = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(live).toHaveLength(1);
		expect(replay).toHaveLength(1);
		for (const notice of [...live, ...replay]) {
			expect(notice).toContain("sign-in expired");
			expect(notice).toContain("https://mcp.example.com");
			expect(notice).not.toContain("PROVIDERSECRET");
		}
	});

	it("never lets a failed tombstone listing break startup", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		vi.spyOn(store, "listDisabledCredentials").mockRejectedValue(new Error("broker offline"));

		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("gives up on a stalled tombstone listing within the startup budget", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		// A broker that never answers: the listing only settles when the caller's
		// signal fires, which is what bounds startup.
		store.listDisabledCredentials = (_provider, signal) => {
			const { promise, reject } = Promise.withResolvers<never>();
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		};

		const startedAt = Date.now();
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("shares one replay deadline even when retained-event recovery ignores cancellation", async () => {
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(":memory:");
		authStorage = new AuthStorage(store);
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		try {
			session.announceCredentialDisabled({
				provider: "anthropic",
				credentialId: 99,
				credentialType: "oauth",
				email: "retained@example.com",
				disabledCause: "invalid_grant",
			});
			store.listDisabledCredentials = async () => {
				await Bun.sleep(1_000);
				throw new Error("history unavailable");
			};
			store.refreshSnapshot = () => Promise.withResolvers<void>().promise;
			const notices = await withTimeout(
				session.getDisabledCredentialNotices(),
				2_700,
				"Replay recovery exceeded the shared startup budget",
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("retained@example.com");
		} finally {
			await session.dispose();
		}
	});

	it("names at most a screenful of signed-out accounts at startup and counts the rest", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		const nowMs = Date.now();
		// SQLite lists tombstones by ascending id; the newest sign-out is the last row.
		vi.spyOn(store, "listDisabledCredentials").mockResolvedValue(
			Array.from({ length: 11 }, (_, index) => ({
				id: index + 1,
				provider: "openai-codex",
				type: "oauth" as const,
				email: `user${index + 1}@example.com`,
				cause: "oauth refresh failed: invalid_grant",
				disabledAtMs: nowMs - (11 - index) * 60_000,
			})),
		);

		const notices = await collectDisabledCredentialNotices(authStorage, nowMs);
		expect(notices).toHaveLength(9);
		expect(notices[0]).toContain("user11@example.com");
		expect(notices[7]).toContain("user4@example.com");
		expect(notices[8]).toContain("3 more");
		expect(notices[8]).toContain("omp usage");
	});

	it("bounds a runaway provider description without cutting the remedy", () => {
		const notice = formatCredentialDisabledNotice({
			credentialId: 1,
			credentialType: "oauth",
			email: `${"x".repeat(200)}@example.com`,
			provider: `extension-provider-${"y".repeat(120)}`,
			disabledCause: `HTTP 400 {"error":"invalid_grant","error_description":"${"grant revoked ".repeat(40)}"}`,
		});
		// provider (TITLE) + label (TITLE) + cause (CONTENT) + fixed wording.
		expect(notice.length).toBeLessThan(60 + 60 + 80 + 80);
		expect(notice).toMatch(/extension-provider-y+…/);
		expect(notice).toMatch(/x+…/);
		// `/login` matches its argument exactly: a cut id is not offered as one.
		expect(notice).toContain("/login");
		expect(notice).not.toContain("/login extension-provider-");
		// Nor is an id the display sanitizer would alter.
		const sanitized = formatCredentialDisabledNotice({
			credentialId: 2,
			credentialType: "oauth",
			email: "x@example.com",
			provider: "ext\tprovider",
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		expect(sanitized).toContain("x@example.com");
		expect(sanitized).toContain("/login");
		expect(sanitized).not.toContain("/login ext");
		expect(sanitized).not.toContain("\t");
	});

	it.each(["account", "cause", "provider", "mcp"] as const)(
		"bounds the rendered width of tab-heavy %s previews in live and replay warnings",
		field => {
			const event: CredentialDisabledEvent = {
				credentialId: 1,
				credentialType: "oauth",
				provider: "ext\tprovider",
				email: "account",
				disabledCause: "denied",
			};
			const expanded = { ...event };
			const text = "x\t".repeat(100);
			let baselinePreview = "account";
			if (field === "account") expanded.email = text;
			if (field === "cause") {
				expanded.disabledCause = text;
				baselinePreview = "denied";
			}
			if (field === "provider") {
				expanded.provider = text;
				baselinePreview = replaceTabs(event.provider);
			}
			if (field === "mcp") {
				event.provider = "mcp_oauth:profile:default:https://mcp.test/x";
				expanded.provider = `mcp_oauth:profile:default:https://mcp.test/${text}`;
				baselinePreview = "https://mcp.test/x";
			}
			const limit = field === "cause" ? TRUNCATE_LENGTHS.CONTENT : TRUNCATE_LENGTHS.TITLE;
			const live = [event, expanded].map(formatCredentialDisabledNotice);
			const replay = [event, expanded].map(notice =>
				formatDisabledCredentialReplayNotice(
					{ ...notice, id: notice.credentialId, type: notice.credentialType, cause: notice.disabledCause },
					Date.now(),
				),
			);
			for (const [baseline, notice] of [live, replay]) {
				expect(
					Bun.stringWidth(notice!) - Bun.stringWidth(baseline!) + Bun.stringWidth(baselinePreview),
				).toBeLessThanOrEqual(limit);
				expect(notice).not.toMatch(/[\x00-\x1F\x7F]/);
			}
		},
	);

	it("strips terminal control sequences and tabs from provider-controlled notice text", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.set("anthropic", [
			{ ...oauthCredential(Date.now() - 60_000), email: "who\x1b[2Jami@example.com" },
		]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error(
				'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant\trevoked\x1b[31m!"}',
			);
		});
		await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			expect(await authStorage!.getApiKey("anthropic", "session")).toBeUndefined();
		});

		const [notice] = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notice).toContain("whoami@example.com");
		// Unescaped controls make this JSON malformed; its body is withheld.
		expect(notice).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(notice).toContain("/login anthropic");
		const live = formatCredentialDisabledNotice({
			provider: "anthropic",
			credentialId: 1,
			credentialType: "oauth",
			email: "who\x1b[2Jami@example.com",
			disabledCause: "oauth refresh failed: grant\trevoked\x1b[31m!",
		});
		expect(live).toContain("whoami@example.com");
		// The cause is classified, so provider-controlled control sequences in it
		// never reach the surface at all.
		expect(live).toContain("token revoked");
		expect(live).toContain("/login anthropic");
		expect(live).not.toMatch(/[\x00-\x1F\x7F]/);
	});

	it("writes a warning notice raised during a text-mode print run to stderr", async () => {
		const stderrOutput: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		let notify: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			state: { messages: [answer] },
			getLastAssistantMessage: () => answer,
			settings: { get: () => false },
			sessionManager: {
				getHeader: () => undefined,
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				// Print mode subscribes to persistence failures before it runs.
				onPersistenceError: () => () => {},
			},
			extensionRunner: undefined,
			disabledCredentialNoticeMark: 3,
			// Replay must not race past listener registration.
			getDisabledCredentialNotices: async () => {
				if (!notify) throw new Error("replayed before subscribing");
				return [
					"anthropic b@example.com was signed out 5s ago: invalid_grant. Sign in again with /login anthropic.",
				];
			},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				notify = listener;
				return () => {};
			},
			prompt: async () => {
				// The account behind the request is torn down mid-turn while a sibling serves it.
				notify?.({
					type: "notice",
					level: "warning",
					message: "Signed out of anthropic a@example.com",
					source: "auth",
				});
				notify?.({ type: "notice", level: "info", message: "Prewalk: armed", source: "prewalk" });
			},
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {},
		} as unknown as AgentSession;

		expect(await runPrintMode(session, { mode: "text", initialMessage: "hello" })).toBe(0);
		const output = stderrOutput.join("");
		expect(output).toContain("invalid_grant");
		expect(output).toContain("/login anthropic");
		expect(output).toContain("b@example.com");
		expect(output.indexOf("b@example.com")).toBeLessThan(output.indexOf("a@example.com"));
		expect(output).toContain("a@example.com");
		expect(output).not.toContain("Prewalk: armed");
	});

	it("announces the sign-out before `omp -p` gives up on an empty pool", async () => {
		const home = path.join(tempDir, "home");
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const seeded = await AuthStorage.create(path.join(agentDir, "agent.db"));
		try {
			await seeded.set("openai-codex", [oauthCredential(Date.now() - 60_000)]);
			const id = seeded.exportSnapshot().credentials[0]!.id;
			expect(seeded.disableCredentialById(id, "oauth refresh failed: OAuthError: 400 invalid_grant")).toBe(true);
		} finally {
			seeded.close();
		}

		// Only the tombstone is left: the run has no model and exits before any prompt.
		const proc = Bun.spawn([process.execPath, cliEntry, "-p", "hello", "--no-extensions"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
			},
		});
		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(1);
		const noticeAt = stderr.indexOf("signed-out@example.com");
		const exitAt = stderr.indexOf("No models available");
		expect(noticeAt, stderr).toBeGreaterThanOrEqual(0);
		expect(exitAt, stderr).toBeGreaterThan(noticeAt);
		expect(stderr).toContain("/login openai-codex");
	}, 60_000);

	it("names the account, cause, and recovery operation for live teardown", () => {
		const oauth = formatCredentialDisabledNotice({
			provider: "openai-codex",
			credentialId: 16,
			credentialType: "oauth",
			email: "signed-out@example.com",
			orgName: "Example Org",
			disabledCause: "oauth refresh failed: OAuthError: invalid_grant; refresh token expired",
		});
		expect(oauth).toContain("signed-out@example.com");
		expect(oauth).toContain("Example Org");
		expect(oauth).toContain("sign-in expired");
		expect(oauth).toContain("/login openai-codex");
		const apiKey = formatCredentialDisabledNotice({
			provider: "kagi",
			credentialId: 2,
			credentialType: "api_key",
			disabledCause: "disabled via auth-broker",
		});
		expect(apiKey).toContain("API key");
		expect(apiKey).toContain("authentication failed");
		expect(apiKey).toContain("/login kagi");
		const mcp = formatCredentialDisabledNotice({
			provider: "mcp_oauth:profile:default:https://mcp.example.com/sse?ref=abc&apiKey=sk-secret",
			credentialId: 3,
			credentialType: "oauth",
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		expect(mcp).toContain("mcp.example.com");
		// The whole query is dropped structurally, benign parameters included.
		expect(mcp).not.toContain("ref=abc");
		expect(mcp).not.toContain("sk-secret");
		expect(mcp).toContain("sign-in expired");
		expect(mcp).toContain("/mcp reauth");
		expect(mcp).not.toContain("/login");
	});
});
