import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension, ExtensionError, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { withEnv } from "../../ai/test/helpers";

interface SessionDirs {
	cwd: string;
	agentDir: string;
}

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

const expiredOAuth = () =>
	({
		type: "oauth" as const,
		access: "expired-access",
		refresh: "stale-refresh",
		expires: Date.now() - 60_000,
		email: "signed-out@example.com",
	}) as const;

/** The enriched event every automatic teardown of `expiredOAuth()` must carry. */
const disabledEvent = (provider: string) =>
	expect.objectContaining({
		provider,
		disabledCause: expect.stringContaining("invalid_grant"),
		credentialId: expect.any(Number),
		credentialType: "oauth",
		email: "signed-out@example.com",
	});

const failOAuthRefresh = (): void => {
	// AuthStorage refreshes through `refreshOAuthToken` before calling
	// `getOAuthApiKey`. Mock the refresh path so the simulated invalid_grant
	// failure actually reaches the disable classifier.
	vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
		throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
	});
};

/**
 * Drives `ExtensionRunner.initialize` with no-op stubs so credential_disabled events flush
 * out of the runner's pre-init buffer. Mode controllers (interactive/RPC/ACP/print/subagent)
 * normally do this with mode-specific actions; tests just need any initialize call to flip
 * the runner's `#initialized` flag and drain the buffer.
 */
const initializeRunnerForTest = (runner: ExtensionRunner | undefined): void => {
	if (!runner) return;
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
	);
};

describe("createAgentSession credential_disabled subscription", () => {
	const tempDirs: string[] = [];

	const makeDirs = (label: string): SessionDirs => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-credential-disabled-${label}-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		return { cwd, agentDir };
	};

	const baseOptions = (dirs: SessionDirs, authStorage: AuthStorage, extensions: ExtensionFactory[] = []) => ({
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		authStorage,
		// Pin the model registry at a temp models.json. Without an explicit path, ModelRegistry
		// loads the developer's real ~/.omp models config on every construction (~100ms each,
		// and non-isolated). Pointing it at the (absent) temp file keeps construction at ~2ms and
		// avoids leaking host config into the test. Providing the registry also skips the
		// fire-and-forget background model discovery, which is irrelevant to credential_disabled.
		modelRegistry: new ModelRegistry(authStorage, path.join(dirs.agentDir, "models.json")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		extensions,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		workspaceTree: emptyWorkspaceTree(dirs.cwd),
		// This suite exercises the SDK's credential event bridge, not ambient tools.
		// Avoid rebuilding the full built-in/custom-tool surface for every session.
		toolNames: ["read"],
		preloadedCustomToolPaths: [],
		skipPythonPreflight: true,
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});

	/**
	 * Make an inline extension factory whose `credential_disabled` handler resolves a fresh
	 * promise on every event. The returned `next()` produces a promise that resolves to the
	 * next event the extension observes. Drives test-side awaiting without relying on
	 * arbitrary `Bun.sleep` settling.
	 */
	const makeRecordingExtension = () => {
		const events: CredentialDisabledEvent[] = [];
		const waiters: Array<{ resolve: (event: CredentialDisabledEvent) => void }> = [];
		const factory: ExtensionFactory = pi => {
			pi.on("credential_disabled", event => {
				const observed = {
					provider: event.provider,
					disabledCause: event.disabledCause,
					credentialId: event.credentialId,
					credentialType: event.credentialType,
					email: event.email,
				};
				events.push(observed);
				const waiter = waiters.shift();
				if (waiter) waiter.resolve(observed);
			});
		};
		const next = (): Promise<CredentialDisabledEvent> => {
			if (events.length > waiters.length) {
				return Promise.resolve(events[waiters.length] as CredentialDisabledEvent);
			}
			const { promise, resolve } = Promise.withResolvers<CredentialDisabledEvent>();
			waiters.push({ resolve });
			return promise;
		};
		return { factory, events, next };
	};

	const drainCredentialDisabledDispatch = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	it("fans events out to both embedder and session-extension subscribers", async () => {
		const dirs = makeDirs("fanout");
		const embedderEvents: CredentialDisabledEvent[] = [];
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"), {
			onCredentialDisabled: event => {
				embedderEvents.push(event);
			},
		});
		const ext = makeRecordingExtension();

		const { session } = await createAgentSession(baseOptions(dirs, authStorage, [ext.factory]));
		initializeRunnerForTest(session.extensionRunner);

		try {
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();

			const observed = ext.next();
			await authStorage.getApiKey("anthropic", "session-fanout");
			const extEvent = await observed;

			expect(embedderEvents).toEqual([disabledEvent("anthropic")]);
			expect(extEvent.provider).toBe("anthropic");
			expect(extEvent.disabledCause).toContain("invalid_grant");
		} finally {
			await session.dispose();
		}
	});

	it("session.dispose() unsubscribes the session's listener; the embedder's listener keeps firing", async () => {
		const dirs = makeDirs("dispose");
		const embedderEvents: CredentialDisabledEvent[] = [];
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"), {
			onCredentialDisabled: event => {
				embedderEvents.push(event);
			},
		});
		const ext = makeRecordingExtension();
		const { session } = await createAgentSession(baseOptions(dirs, authStorage, [ext.factory]));
		initializeRunnerForTest(session.extensionRunner);

		failOAuthRefresh();

		// Pre-dispose: both fire.
		await authStorage.set("anthropic", [expiredOAuth()]);
		const firstExt = ext.next();
		await authStorage.getApiKey("anthropic", "pre-dispose");
		await firstExt;
		expect(embedderEvents).toHaveLength(1);
		expect(ext.events).toHaveLength(1);

		await session.dispose();

		// Post-dispose: only the embedder fires; the extension's listener was unsubscribed.
		await authStorage.set("openai", [expiredOAuth()]);
		await authStorage.getApiKey("openai", "post-dispose");
		// Drain async dispatch turns before asserting absence.
		await drainCredentialDisabledDispatch();

		expect(embedderEvents).toEqual([disabledEvent("anthropic"), disabledEvent("openai")]);
		expect(ext.events).toHaveLength(1);
		expect(ext.events[0]?.provider).toBe("anthropic");
	});

	it("concurrent sessions each subscribe their own listener; each dispose only removes its own", async () => {
		const sharedDirs = makeDirs("concurrent");
		const embedderEvents: CredentialDisabledEvent[] = [];
		const authStorage = await AuthStorage.create(path.join(sharedDirs.agentDir, "agent.db"), {
			onCredentialDisabled: event => {
				embedderEvents.push(event);
			},
		});

		const ext1 = makeRecordingExtension();
		const ext2 = makeRecordingExtension();
		const ext3 = makeRecordingExtension();
		const dirs1 = makeDirs("concurrent-1");
		const dirs2 = makeDirs("concurrent-2");
		const dirs3 = makeDirs("concurrent-3");
		const session1 = await createAgentSession(baseOptions(dirs1, authStorage, [ext1.factory]));
		const session2 = await createAgentSession(baseOptions(dirs2, authStorage, [ext2.factory]));
		const session3 = await createAgentSession(baseOptions(dirs3, authStorage, [ext3.factory]));
		initializeRunnerForTest(session1.session.extensionRunner);
		initializeRunnerForTest(session2.session.extensionRunner);
		initializeRunnerForTest(session3.session.extensionRunner);

		failOAuthRefresh();

		// All three sessions + embedder receive the first event.
		await authStorage.set("anthropic", [expiredOAuth()]);
		const wait1All = Promise.all([ext1.next(), ext2.next(), ext3.next()]);
		await authStorage.getApiKey("anthropic", "concurrent-1");
		await wait1All;
		expect(embedderEvents.map(e => e.provider)).toEqual(["anthropic"]);
		expect(ext1.events.map(e => e.provider)).toEqual(["anthropic"]);
		expect(ext2.events.map(e => e.provider)).toEqual(["anthropic"]);
		expect(ext3.events.map(e => e.provider)).toEqual(["anthropic"]);

		// Dispose session1; sessions 2 and 3 + embedder still receive.
		await session1.session.dispose();

		await authStorage.set("openai", [expiredOAuth()]);
		const wait2 = Promise.all([ext2.next(), ext3.next()]);
		await authStorage.getApiKey("openai", "concurrent-2");
		await wait2;
		await drainCredentialDisabledDispatch();
		expect(embedderEvents.map(e => e.provider)).toEqual(["anthropic", "openai"]);
		expect(ext1.events.map(e => e.provider)).toEqual(["anthropic"]);
		expect(ext2.events.map(e => e.provider)).toEqual(["anthropic", "openai"]);
		expect(ext3.events.map(e => e.provider)).toEqual(["anthropic", "openai"]);

		// Dispose session2; only session3 + embedder receive.
		await session2.session.dispose();

		await authStorage.set("google", [expiredOAuth()]);
		const wait3 = ext3.next();
		await authStorage.getApiKey("google", "concurrent-3");
		await wait3;
		await drainCredentialDisabledDispatch();
		expect(embedderEvents.map(e => e.provider)).toEqual(["anthropic", "openai", "google"]);
		expect(ext1.events.map(e => e.provider)).toEqual(["anthropic"]);
		expect(ext2.events.map(e => e.provider)).toEqual(["anthropic", "openai"]);
		expect(ext3.events.map(e => e.provider)).toEqual(["anthropic", "openai", "google"]);

		// Dispose the last session; only the embedder receives.
		await session3.session.dispose();

		await authStorage.set("anthropic", [expiredOAuth()]);
		await authStorage.getApiKey("anthropic", "concurrent-final");
		await drainCredentialDisabledDispatch();
		expect(embedderEvents.map(e => e.provider)).toEqual(["anthropic", "openai", "google", "anthropic"]);
		expect(ext1.events).toHaveLength(1);
		expect(ext2.events).toHaveLength(2);
		expect(ext3.events).toHaveLength(3);
	});

	it("buffers credential_disabled events fired before runner.initialize and replays them once initialize runs", async () => {
		// Without deferral the runner would fan out with `hasUI=false`, an unset model, and
		// no-op runtime actions — extension handlers would observe the constructor defaults
		// rather than the real context wired in by mode controllers.
		const dirs = makeDirs("pre-init");
		// No constructor handler — verifies the default case still defers properly.
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"));
		const ext = makeRecordingExtension();

		const { session } = await createAgentSession(baseOptions(dirs, authStorage, [ext.factory]));

		try {
			// Fire the event BEFORE initializing. Extension must NOT see it yet — the runner
			// would otherwise emit with `hasUI=false`, an unset model, and no-op runtime
			// actions, defeating the headline re-login flow.
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();
			await authStorage.getApiKey("anthropic", "pre-init");
			await drainCredentialDisabledDispatch();
			expect(ext.events).toHaveLength(0);

			// Initializing flushes the buffer through `emit()` with the now-populated
			// context. The recording extension records the event.
			const observed = ext.next();
			initializeRunnerForTest(session.extensionRunner);
			const extEvent = await observed;

			expect(extEvent.provider).toBe("anthropic");
			expect(extEvent.disabledCause).toContain("invalid_grant");
		} finally {
			await session.dispose();
		}
	});

	it.each(["missing", "empty", "supported"] as const)(
		"replays actual startup disables with %s tombstone support and deduplicates observed live accounts",
		async tombstones => {
			const dirs = makeDirs("startup-replay");
			const embedderEvents: CredentialDisabledEvent[] = [];
			const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(path.join(dirs.agentDir, "agent.db"));
			if (tombstones === "missing") store.listDisabledCredentials = undefined;
			if (tombstones === "empty") store.listDisabledCredentials = async () => [];
			const authStorage = new AuthStorage(store, {
				onCredentialDisabled: event => {
					embedderEvents.push(event);
				},
			});
			const ext = makeRecordingExtension();
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();
			// Exercise the SDK's real auth-fallback probe before the runner and
			// session exist, with an embedder preventing AuthStorage's own buffering.
			const { session } = await createAgentSession({
				...baseOptions(dirs, authStorage, [ext.factory]),
				modelPattern: "anthropic/claude-sonnet-4-5",
				modelPatternAuthFallback: "anthropic/claude-sonnet-4-5",
			});
			try {
				expect(embedderEvents).toEqual([disabledEvent("anthropic")]);
				expect(authStorage.getAll().anthropic).toBeUndefined();
				expect(ext.events).toEqual([]);
				const startupReplay = await session.getDisabledCredentialNotices();
				expect(startupReplay).toHaveLength(1);
				expect(startupReplay[0]).toContain("signed-out@example.com");
				expect(startupReplay[0]).toContain("/login anthropic");

				const observed = ext.next();
				initializeRunnerForTest(session.extensionRunner);
				expect(await observed).toEqual(embedderEvents[0]!);
				expect(embedderEvents).toHaveLength(1);

				const live: string[] = [];
				const mark = session.disabledCredentialNoticeMark;
				const unsubscribe = session.subscribe(event => {
					if (event.type === "notice" && event.source === "auth") live.push(event.message);
				});
				await authStorage.set("anthropic", [{ ...expiredOAuth(), email: "live@example.com" }]);
				await authStorage.getApiKey("anthropic", "live-account");
				expect(live).toHaveLength(1);
				expect(live[0]).toContain("live@example.com");
				// Same provider, different credential ids: only the account this
				// marked listener actually saw is excluded from replay.
				const replay = await session.getDisabledCredentialNotices({ announcedAfter: mark });
				expect(replay).toHaveLength(1);
				expect(replay[0]).toContain("signed-out@example.com");
				unsubscribe();

				const unobservedMark = session.disabledCredentialNoticeMark;
				await authStorage.set("anthropic", [{ ...expiredOAuth(), email: "unobserved@example.com" }]);
				await authStorage.getApiKey("anthropic", "no-subscriber");
				expect(await session.getDisabledCredentialNotices({ announcedAfter: unobservedMark })).toEqual(
					expect.arrayContaining([expect.stringContaining("unobserved@example.com")]),
				);

				// The returned session has a stale empty credential view when another
				// process logs in. Empty/missing listings do not trigger store replay
				// revalidation, but retained notices must still recognize recovery.
				const sibling = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"));
				try {
					await sibling.set(
						"anthropic",
						[
							expiredOAuth(),
							{ ...expiredOAuth(), email: "live@example.com" },
							{ ...expiredOAuth(), email: "unobserved@example.com" },
						].map(credential => ({ ...credential, expires: Date.now() + 3_600_000 })),
					);
				} finally {
					sibling.close();
				}
				expect(authStorage.getAll().anthropic).toBeUndefined();
				expect(await session.getDisabledCredentialNotices()).toEqual([]);
			} finally {
				await session.dispose();
				authStorage.close();
			}
		},
	);

	it("releases the subscription when initialization fails before tool startup", async () => {
		const dirs = makeDirs("early-startup-failure");
		const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(path.join(dirs.agentDir, "agent.db"));
		store.listDisabledCredentials = undefined;
		const authStorage = new AuthStorage(store);
		const options = baseOptions(dirs, authStorage);
		vi.spyOn(options.modelRegistry, "hydrateCredentialScopedModelCaches").mockRejectedValueOnce(
			new Error("early initialization failed"),
		);
		try {
			await expect(createAgentSession(options)).rejects.toThrow("early initialization failed");
			failOAuthRefresh();
			await authStorage.set("anthropic", [expiredOAuth()]);
			await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
				await authStorage.getApiKey("anthropic", "after-early-failure");
			});
			// No tombstone endpoint: an orphan listener would consume the disable
			// instead of allowing AuthStorage to buffer it for the next session.
			const { session } = await createAgentSession(options);
			try {
				const notices = await session.getDisabledCredentialNotices();
				expect(notices).toHaveLength(1);
				expect(notices[0]).toContain("signed-out@example.com");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it.each(["missing", "mixed"] as const)(
		"caps %s stored and retained sign-outs together, newest first",
		async tombstones => {
			const dirs = makeDirs("replay-cap");
			const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(path.join(dirs.agentDir, "agent.db"));
			if (tombstones === "missing") store.listDisabledCredentials = undefined;
			// An embedder consumes pre-session events; only tombstones can replay them.
			const authStorage = new AuthStorage(store, { onCredentialDisabled: () => {} });
			failOAuthRefresh();
			const disable = async (index: number): Promise<void> => {
				await authStorage.set("anthropic", [{ ...expiredOAuth(), email: "account" + index + "@example.com" }]);
				await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
					await authStorage.getApiKey("anthropic", "cap-" + index);
				});
			};
			if (tombstones === "mixed") {
				for (let index = 1; index <= 6; index++) await disable(index);
			}
			const { session } = await createAgentSession(baseOptions(dirs, authStorage));
			try {
				for (let index = tombstones === "mixed" ? 7 : 1; index <= 12; index++) await disable(index);
				if (tombstones === "mixed") {
					const list = authStorage.listActionableDisabledCredentials.bind(authStorage);
					const nowMs = Date.now();
					vi.spyOn(authStorage, "listActionableDisabledCredentials").mockImplementation(async (...args) =>
						(await list(...args)).flatMap(summary => {
							const index = Number(summary.email?.match(/^account(\d+)@/)?.[1]);
							return index <= 9 ? [{ ...summary, disabledAtMs: nowMs - (13 - index) * 1_000 }] : [];
						}),
					);
				}
				const mark = session.disabledCredentialNoticeMark;
				const live: string[] = [];
				const unsubscribe = session.subscribe(event => {
					if (event.type === "notice" && event.source === "auth") live.push(event.message);
				});
				try {
					await disable(13);
					const notices = await session.getDisabledCredentialNotices({ announcedAfter: mark });
					expect(live).toHaveLength(1);
					expect(live[0]).toContain("account13@example.com");
					expect(notices).toHaveLength(9);
					for (let index = 0; index < 8; index++) {
						expect(notices[index]).toContain("account" + (12 - index) + "@example.com");
					}
					expect(notices[8]).toContain("4 more signed-out accounts");
				} finally {
					unsubscribe();
				}
			} finally {
				await session.dispose();
				authStorage.close();
			}
		},
	);

	it("rechecks stored notices when fallback recovery observes a newer sibling login", async () => {
		const dirs = makeDirs("mixed-recovery");
		const databasePath = path.join(dirs.agentDir, "agent.db");
		const authStorage = await AuthStorage.create(databasePath, { onCredentialDisabled: () => {} });
		failOAuthRefresh();
		const disable = async (email: string): Promise<void> => {
			await authStorage.set("anthropic", [{ ...expiredOAuth(), email }]);
			await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
				await authStorage.getApiKey("anthropic", email);
			});
		};
		await disable("stored@example.com");
		const { session } = await createAgentSession(baseOptions(dirs, authStorage));
		const sibling = await AuthStorage.create(databasePath);
		try {
			await disable("retained@example.com");
			const list = authStorage.listActionableDisabledCredentials.bind(authStorage);
			vi.spyOn(authStorage, "listActionableDisabledCredentials").mockImplementation(async (...args) =>
				(await list(...args)).filter(summary => summary.email === "stored@example.com"),
			);
			const revalidate = authStorage.revalidateCredentials.bind(authStorage);
			vi.spyOn(authStorage, "revalidateCredentials")
				.mockImplementationOnce(revalidate)
				.mockImplementationOnce(async signal => {
					// A was actionable during tombstone lookup; the refresh needed
					// for fallback B is the first one that observes A's recovery.
					await sibling.set("anthropic", [
						{
							...expiredOAuth(),
							email: "stored@example.com",
							expires: Date.now() + 3_600_000,
						},
					]);
					await revalidate(signal);
				});
			const notices = await session.getDisabledCredentialNotices();
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("retained@example.com");
		} finally {
			await session.dispose();
			sibling.close();
			authStorage.close();
		}
	});

	it("releases the session subscription if createAgentSession throws mid-startup", async () => {
		const dirs = makeDirs("startup-failure");
		const embedderEvents: CredentialDisabledEvent[] = [];
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"), {
			onCredentialDisabled: event => {
				embedderEvents.push(event);
			},
		});

		const throwingFactory: ExtensionFactory = () => {
			throw new Error("simulated mid-startup failure");
		};

		await expect(createAgentSession(baseOptions(dirs, authStorage, [throwingFactory]))).rejects.toThrow(
			/simulated mid-startup failure/,
		);

		// A retry must also fail without accumulating stale subscribers (this is what the
		// outer-catch cleanup in createAgentSession exists to guarantee).
		await expect(createAgentSession(baseOptions(dirs, authStorage, [throwingFactory]))).rejects.toThrow(
			/simulated mid-startup failure/,
		);

		// Now fire a real disable. Only the embedder must observe it — no leftover listener
		// from either failed startup attempt.
		failOAuthRefresh();
		await authStorage.set("anthropic", [expiredOAuth()]);
		await authStorage.getApiKey("anthropic", "post-failure");
		await drainCredentialDisabledDispatch();

		expect(embedderEvents).toEqual([disabledEvent("anthropic")]);
	});
	it("subscribes through the registry's auth storage when only options.modelRegistry is provided", async () => {
		const dirs = makeDirs("registry-only");
		const embedderEvents: CredentialDisabledEvent[] = [];
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"), {
			onCredentialDisabled: event => {
				embedderEvents.push(event);
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(dirs.agentDir, "models.json"));
		const ext = makeRecordingExtension();

		const { session } = await createAgentSession({
			cwd: dirs.cwd,
			agentDir: dirs.agentDir,
			modelRegistry, // registry-only — no separate options.authStorage
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [ext.factory],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: emptyWorkspaceTree(dirs.cwd),
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		initializeRunnerForTest(session.extensionRunner);

		try {
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();

			const observed = ext.next();
			await modelRegistry.getApiKeyForProvider("anthropic", "registry-only");
			const extEvent = await observed;

			expect(embedderEvents).toEqual([disabledEvent("anthropic")]);
			expect(extEvent.provider).toBe("anthropic");
			expect(extEvent.disabledCause).toContain("invalid_grant");
		} finally {
			await session.dispose();
		}
	});

	it("rejects when options.authStorage and options.modelRegistry.authStorage are different instances", async () => {
		const dirs = makeDirs("mismatch");
		const registryStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent-registry.db"));
		const otherStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent-other.db"));
		const modelRegistry = new ModelRegistry(registryStorage, path.join(dirs.agentDir, "models-registry.json"));

		await expect(
			createAgentSession({
				cwd: dirs.cwd,
				agentDir: dirs.agentDir,
				authStorage: otherStorage,
				modelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				workspaceTree: emptyWorkspaceTree(dirs.cwd),
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}),
		).rejects.toThrow(/options\.authStorage.*modelRegistry\.authStorage/);
	});

	it("redacts credential-disabled flush failures while preserving the extension event", async () => {
		const dirs = makeDirs("flush-redaction");
		const authStorage = await AuthStorage.create(":memory:");
		const provider = "mcp_oauth:profile:default:https://host.test/mcp?key=QUERYSECRET&region=west";
		const cause = "oauth refresh failed: HTTP 400 client_secret=BODYSECRET";
		const events: CredentialDisabledEvent[] = [];
		const factory: ExtensionFactory = pi => {
			pi.on("credential_disabled", event => {
				events.push(event);
				throw new Error(event.disabledCause);
			});
		};
		const warning = Promise.withResolvers<unknown>();
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "credential_disabled handler threw during initialize flush") warning.resolve(context);
		});
		const { session } = await createAgentSession(baseOptions(dirs, authStorage, [factory]));
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			await runner.emitCredentialDisabled({
				provider,
				disabledCause: cause,
				credentialId: 1,
				credentialType: "oauth",
			});
			runner.onError(error => {
				throw new Error(`${error.error}; password=FLUSHSECRET`);
			});
			initializeRunnerForTest(runner);
			const context = await warning.promise;
			expect(context).toMatchObject({
				provider: "mcp_oauth:profile:default:https://host.test/mcp?key=[redacted]&region=west",
				error: expect.stringContaining("HTTP 400"),
			});
			for (const secret of ["QUERYSECRET", "BODYSECRET", "FLUSHSECRET"]) {
				expect(JSON.stringify(context)).not.toContain(secret);
			}
			expect(events).toEqual([expect.objectContaining({ provider, disabledCause: cause })]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("routes handler errors through onError when listener is registered synchronously after initialize()", async () => {
		// Regression: the flush of #pendingCredentialDisabled used to run synchronously
		// inside initialize(), before mode controllers had a chance to call onError().
		// Handler exceptions were therefore silently dropped. The flush is now deferred
		// by one microtask so a sync onError() registration lands in time.
		const dirs = makeDirs("error-routing");
		const authStorage = await AuthStorage.create(path.join(dirs.agentDir, "agent.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(dirs.agentDir, "models.json"));
		try {
			const throwingExtension: Extension = {
				path: "test://throwing-credential-disabled",
				resolvedPath: "test://throwing-credential-disabled",
				handlers: new Map([
					[
						"credential_disabled",
						[
							async () => {
								throw new Error("boom");
							},
						],
					],
				]),
				tools: new Map(),
				assistantThinkingRenderers: [],
				fileWriteFallbackHandlers: [],
				fileDeleteFallbackHandlers: [],
				messageRenderers: new Map(),
				composerShapes: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			};
			const runtime = new ExtensionRuntime();
			const sessionManager = SessionManager.inMemory();
			const runner = new ExtensionRunner([throwingExtension], runtime, dirs.cwd, sessionManager, modelRegistry);

			// 1. Buffer the event BEFORE initialize so it lands in #pendingCredentialDisabled.
			await runner.emitCredentialDisabled({
				provider: "anthropic",
				disabledCause: "test",
				credentialId: 1,
				credentialType: "oauth",
			});

			// 2. initialize(); the flush is queued as a microtask.
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
				undefined,
				undefined,
			);

			// 3. Synchronous onError registration — must land before the deferred flush
			// invokes the throwing handler. This is the contract this test defends.
			const receivedError = Promise.withResolvers<ExtensionError>();
			runner.onError(error => {
				receivedError.resolve(error);
			});

			// 4. Await the observable callback instead of assuming a fixed number of
			// microtask turns inside the lifecycle runner.
			const error = await receivedError.promise;

			expect(error).toMatchObject({
				extensionPath: "test://throwing-credential-disabled",
				event: "credential_disabled",
				error: "boom",
			});
		} finally {
			authStorage.close();
		}
	});
});
