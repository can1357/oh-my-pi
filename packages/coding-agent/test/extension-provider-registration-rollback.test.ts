import { describe, expect, test } from "bun:test";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAgentIdentity,
	IrcApi,
	ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const testProviderConfig: ProviderConfig = {
	baseUrl: "https://example.invalid/v1",
	apiKey: "TEST_PROVIDER_API_KEY",
	api: "openai-completions",
	models: [
		{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 4_096,
		},
	],
};

describe("extension provider registration rollback", () => {
	test("replaces a queued provider after unregistering it", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("cliproxyapi", testProviderConfig);
				pi.unregisterProvider("cliproxyapi");
				pi.registerProvider("cliproxyapi", {
					baseUrl: "https://replacement.example.invalid/v1",
				});
			},
			process.cwd(),
			events,
			runtime,
			"pi-cliproxyapi-provider@1.4.13",
		);

		expect(runtime.pendingProviderRegistrations).toEqual([
			{
				name: "cliproxyapi",
				config: { baseUrl: "https://replacement.example.invalid/v1" },
				sourceId: "pi-cliproxyapi-provider@1.4.13",
			},
		]);
	});

	test("preserves provider registrations from earlier successful extensions", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("working-provider", testProviderConfig);
			},
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("broken-provider", testProviderConfig);
					throw new Error("second extension failed");
				},
				process.cwd(),
				events,
				runtime,
				"broken-extension",
			),
		).rejects.toThrow("second extension failed");

		expect(runtime.pendingProviderRegistrations.map(r => r.name)).toEqual(["working-provider"]);
	});

	test("restores an earlier registration when unregistering extension fails", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("working-provider", testProviderConfig);
			},
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.unregisterProvider("working-provider");
					throw new Error("failed after unregistering");
				},
				process.cwd(),
				events,
				runtime,
				"broken-extension",
			),
		).rejects.toThrow("failed after unregistering");

		expect(runtime.pendingProviderRegistrations.map(registration => registration.name)).toEqual(["working-provider"]);
	});

	test("applies provider replacement after runtime initialization", async () => {
		const tempDir = TempDir.createSync("@provider-replacement-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		try {
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
			modelRegistry.registerProvider("cliproxyapi", testProviderConfig, "pi-cliproxyapi-provider");

			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			let replaceProvider: (() => void) | undefined;
			const extension = await loadExtensionFromFactory(
				pi => {
					replaceProvider = () => {
						pi.unregisterProvider("cliproxyapi");
						pi.registerProvider("cliproxyapi", {
							baseUrl: "https://replacement.example.invalid/v1",
							api: "openai-completions",
							models: testProviderConfig.models,
							oauth: {
								name: "CLIProxyAPI",
								login: async () => "test-token",
							},
						});
					};
				},
				process.cwd(),
				events,
				runtime,
				"pi-cliproxyapi-provider",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				modelRegistry,
			);
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

			if (!replaceProvider) throw new Error("Extension did not expose its provider replacement action");
			replaceProvider();

			expect(modelRegistry.authStorage.keys.source("cliproxyapi") !== undefined).toBe(false);
			expect(modelRegistry.find("cliproxyapi", "test-model")?.baseUrl).toBe(
				"https://replacement.example.invalid/v1",
			);
		} finally {
			unregisterOAuthProvider("cliproxyapi");
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("uses extension usage providers and restores built-in resolution on unregister", async () => {
		const tempDir = TempDir.createSync("@extension-usage-provider-");
		const usageFetch: typeof fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 500 }),
			{ preconnect: fetch.preconnect },
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"), { usageFetch });
		const provider = "extension-usage-provider";
		const report: UsageReport = {
			provider,
			fetchedAt: 123,
			limits: [
				{
					id: "requests",
					label: "Requests",
					scope: { provider },
					amount: { used: 25, limit: 100, unit: "requests" },
					status: "ok",
				},
			],
		};
		const extensionUsage: UsageProvider = {
			id: provider,
			fetchUsage: async params => {
				expect(params.provider).toBe(provider);
				expect(params.credential).toEqual({ type: "api_key", apiKey: "extension-usage-key" });
				return report;
			},
		};

		try {
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			await loadExtensionFromFactory(
				pi => {
					pi.registerProvider(provider, { apiKey: "extension-usage-key", usage: extensionUsage });
				},
				process.cwd(),
				events,
				runtime,
				"extension-usage-provider",
			);
			for (const registration of runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(registration.name, registration.config, registration.sourceId);
				modelRegistry.registerProvider("synthetic", { apiKey: "must-not-be-probed" });
			}

			await expect(authStorage.usage.reports()).resolves.toEqual([report]);
			expect(authStorage.usage.providerFor(provider)).toBe(extensionUsage);

			modelRegistry.unregisterProvider(provider);
			expect(authStorage.usage.providerFor(provider)).toBeUndefined();

			const builtinUsage = authStorage.usage.providerFor("synthetic");
			if (!builtinUsage) throw new Error("Expected the synthetic built-in usage provider");
			const syntheticOverride: UsageProvider = { ...extensionUsage, id: "synthetic" };
			modelRegistry.registerProvider("synthetic", { usage: syntheticOverride }, "extension-usage-provider");
			expect(authStorage.usage.providerFor("synthetic")).toBe(syntheticOverride);
			modelRegistry.unregisterProvider("synthetic");
			expect(authStorage.usage.providerFor("synthetic")).toBe(builtinUsage);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("rolls back every provider added by the failed extension", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("broken-provider-one", testProviderConfig);
					pi.registerProvider("broken-provider-two", testProviderConfig);
					throw new Error("failed after multiple registrations");
				},
				process.cwd(),
				events,
				runtime,
				"broken-multi-provider-extension",
			),
		).rejects.toThrow("failed after multiple registrations");

		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	test("clears a remote transport installed by an extension that then fails to load", async () => {
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			const transport: RemoteTransport = {
				async send(message) {
					return { to: message.to, outcome: "injected" };
				},
			};

			// No transport is installed before the failing extension runs.
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", transport);
						throw new Error("failed after installing transport");
					},
					process.cwd(),
					events,
					runtime,
					"broken-transport-extension",
				),
			).rejects.toThrow("failed after installing transport");

			// The half-installed transport must not survive: a leaf session must
			// not observe hasRemoteTransport() or route registry-miss sends out
			// through an extension that never finished loading.
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
		} finally {
			IrcBus.resetGlobalForTests();
		}
	});

	test("a failed load's transport rollback leaves an earlier load's transport intact", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			const seenFirst: string[] = [];
			// Load #1 installs its transport and registers a peer routed through it.
			await loadExtensionFromFactory(
				pi => {
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message, opts) {
							seenFirst.push(opts?.toName ?? message.to);
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "alice", displayName: "alice" });
				},
				process.cwd(),
				events,
				runtime,
				"first-transport-extension",
			);

			// Load #2 installs its own transport, then throws.
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-b", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
						throw new Error("second extension failed");
					},
					process.cwd(),
					events,
					runtime,
					"second-transport-extension",
				),
			).rejects.toThrow("second extension failed");

			// Load #2's transport entry is rolled back, but load #1's is owner-scoped and untouched:
			// its peer still routes through it.
			const receipt = await IrcBus.global().send({ from: "Main", to: "@cluster-a/alice", body: "hi" });
			expect(receipt.outcome).toBe("injected");
			expect(seenFirst).toEqual(["alice"]);
		} finally {
			IrcBus.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	test("keeps a remote proxy registered by an extension that loads successfully", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			await loadExtensionFromFactory(
				pi => {
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				events,
				runtime,
				"ok-bridge-extension",
			);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")?.kind).toBe("remote");
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("retracts remote proxies registered by an extension that then fails to load", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();

			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
						pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
						throw new Error("failed after seeding remote peer");
					},
					process.cwd(),
					events,
					runtime,
					"broken-bridge-extension",
				),
			).rejects.toThrow("failed after seeding remote peer");

			// The orphaned proxy must not survive a failed load — attributed rollback by ownerToken.
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a failed bridge load's attributed rollback leaves a live local agent intact", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			// A live local agent (no bridge ownerToken) exists before the bridge loads.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "Main",
				kind: "main",
				session: null,
				status: "running",
			});

			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
						pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
						throw new Error("boom");
					},
					process.cwd(),
					events,
					runtime,
					"clumsy-bridge",
				),
			).rejects.toThrow("boom");

			// Attributed rollback (by ownerToken) drops the bridge's own proxy but never the local agent
			// — and a remote id `@cluster-a/beatrice` could never have collided with the local `Main`.
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
			expect(AgentRegistry.global().get("Main")?.kind).toBe("main");
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a failed load does not retract remote proxies from an earlier successful load of the same path", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			// Load #1 of path P succeeds and seeds a proxy.
			await loadExtensionFromFactory(
				pi => {
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				events,
				runtime,
				"same/bridge.ts",
			);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")?.kind).toBe("remote");

			// Load #2 of the SAME path fails after seeding its own proxy.
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-b", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
						pi.irc.registerRemotePeer?.({ name: "carol", displayName: "carol" });
						throw new Error("boom");
					},
					process.cwd(),
					events,
					runtime,
					"same/bridge.ts",
				),
			).rejects.toThrow("boom");

			// Per-load ownerToken: load #2's proxy is retracted; load #1's survives untouched.
			expect(AgentRegistry.global().get("@cluster-b/carol")).toBeUndefined();
			expect(AgentRegistry.global().get("@cluster-a/beatrice")?.kind).toBe("remote");
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("session shutdown releases a successful load's IRC claim + proxies (symmetric with rollback)", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"bridge-extension",
			);

			// Claimed + registered while the load is live.
			expect(IrcBus.global().hasRemoteTransport()).toBe(true);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")?.kind).toBe("remote");

			// The session's shutdown path releases the load's IRC state — with no session_shutdown
			// handler registered by anyone, so the release is not riding on the handler walk.
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
			);
			expect(await emitSessionShutdownEvent(runner)).toBe(false);

			// Transport + claim gone (namespace re-claimable), proxy unregistered — symmetric with the
			// factory-failure rollback.
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
			expect(() =>
				IrcBus.global().setRemoteTransport(
					"cluster-a",
					{
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					},
					"other-owner",
				),
			).not.toThrow();
		} finally {
			authStorage.close();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("suspending a bridge (live disabledExtensions) releases its IRC claim and keeps it inert through resume and shutdown (#14071)", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const runtime = new ExtensionRuntime();
			let irc: IrcApi | undefined;
			const bridge = await loadExtensionFromFactory(
				pi => {
					irc = pi.irc;
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
					pi.on("session_shutdown", async () => {});
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"/ext/bridge.ts",
			);
			const other = await loadExtensionFromFactory(
				() => {},
				process.cwd(),
				new EventBus(),
				runtime,
				"/ext/other.ts",
			);
			const runner = new ExtensionRunner(
				[bridge, other],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
			);

			// A live `disabledExtensions` edit suspends the bridge: it leaves the active handler walk,
			// and its claim, transport and proxies go with it — a disabled bridge neither routes nor
			// injects.
			const { suspended } = runner.setSuspendedExtensions(extension => extension.path === "/ext/bridge.ts");
			expect(suspended).toEqual([bridge]);
			expect(runner.hasHandlers("session_shutdown")).toBe(false);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
			const inbound = await irc!.deliverInbound({ from: "@cluster-a/beatrice", to: "Main", body: "still there?" });
			expect(inbound.receipt).toMatchObject({ outcome: "failed", error: expect.stringContaining("released") });
			// Nothing re-fires session_start on resume, so the released load stays inert.
			runner.setSuspendedExtensions(() => false);
			expect(() =>
				irc!.setRemoteTransport?.("cluster-a", {
					async send(message) {
						return { to: message.to, outcome: "injected" };
					},
				}),
			).toThrow(/released/);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);

			// Shutdown with the bridge still out of the handler walk is clean: the runner's release pass
			// covers every load — suspended or not — and is idempotent for the one already released.
			runner.setSuspendedExtensions(extension => extension.path === "/ext/bridge.ts");
			expect(await emitSessionShutdownEvent(runner)).toBe(false);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
		} finally {
			authStorage.close();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("rejects IRC installs/registrations/inbound after shutdown released the load (#7401)", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const transport: RemoteTransport = {
				async send(message) {
					return { to: message.to, outcome: "injected" };
				},
			};
			const runtime = new ExtensionRuntime();
			let irc: IrcApi | undefined;
			const extension = await loadExtensionFromFactory(
				pi => {
					irc = pi.irc;
					pi.irc.setRemoteTransport?.("cluster-a", transport);
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"bridge-extension",
			);

			// Shutdown releases the load's IRC state AND closes its surface.
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
			);
			await emitSessionShutdownEvent(runner);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();

			// A post-teardown reconnect must not re-establish state no teardown will ever release:
			// install throws, registration no-ops, inbound fails, and nothing leaks back onto the
			// bus/registry.
			expect(() => irc?.setRemoteTransport?.("cluster-a", transport)).toThrow(/released/);
			expect(irc?.registerRemotePeer?.({ name: "carol", displayName: "carol" })).toBeUndefined();
			const inbound = await irc!.deliverInbound({ from: "@cluster-a/beatrice", to: "Main", body: "late" });
			expect(inbound.receipt.outcome).toBe("failed");
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
			expect(
				AgentRegistry.global()
					.list()
					.some(ref => ref.kind === "remote"),
			).toBe(false);
		} finally {
			authStorage.close();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a factory that claims, leaves a reconnect callback running, then throws cannot re-claim after rollback (#14071)", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const transport: RemoteTransport = {
				async send(message) {
					return { to: message.to, outcome: "injected" };
				},
			};
			let reconnect: (() => void) | undefined;
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", transport);
						// An async connect that will try to (re)install once it settles.
						reconnect = () => pi.irc.setRemoteTransport?.("cluster-a", transport);
						throw new Error("factory boom");
					},
					process.cwd(),
					new EventBus(),
					new ExtensionRuntime(),
					"bridge-extension",
				),
			).rejects.toThrow("factory boom");
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);

			// The rollback closed the discarded API's surface: the stranded callback is refused, so no
			// claim with no loaded extension to release it ever exists.
			expect(() => reconnect?.()).toThrow(/released/);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a bridge's own session_shutdown clear never throws against the runner's release", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const runtime = new ExtensionRuntime();
			let cleared = false;
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.irc.setRemoteTransport?.("cluster-a", {
						async send(message) {
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
					// The bridge's own cleanup awaits (e.g. flushing a socket) before clearing its
					// transport; the runner releases the claim once every handler has settled.
					pi.on("session_shutdown", async () => {
						await Promise.resolve();
						pi.irc.setRemoteTransport?.("cluster-a", undefined);
						cleared = true;
					});
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"bridge-extension",
			);

			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
			);
			expect(await emitSessionShutdownEvent(runner)).toBe(true);

			expect(cleared).toBe(true); // the extension's clear completed without throwing
			expect(IrcBus.global().hasRemoteTransport()).toBe(false);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
		} finally {
			authStorage.close();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a namespace claimed after the factory (runtime handler) is released at shutdown", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const runtime = new ExtensionRuntime();
			let claim: (() => void) | undefined;
			const extension = await loadExtensionFromFactory(
				pi => {
					// The bridge defers its claim to a runtime handler (e.g. session_start, once it has
					// ctx.agent.id or an async socket). Nothing is claimed during factory load.
					claim = () => {
						pi.irc.setRemoteTransport?.("cluster-a", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
						pi.irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
					};
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"bridge-extension",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
			);

			// The delayed (post-factory) claim is covered without any handler registration.
			claim?.();
			expect(IrcBus.global().hasClaimedNamespace()).toBe(true);
			expect(runner.hasHandlers("session_shutdown")).toBe(false);

			await emitSessionShutdownEvent(runner);
			expect(IrcBus.global().hasClaimedNamespace()).toBe(false);
			expect(AgentRegistry.global().get("@cluster-a/beatrice")).toBeUndefined();
		} finally {
			authStorage.close();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	test("a bridge inherited by a subagent (same extension path) re-claims its namespace without throwing", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			const claim = (agent?: ExtensionAgentIdentity) =>
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
					},
					process.cwd(),
					events,
					runtime,
					"/ext/bridge.ts",
					AgentRegistry.global(),
					agent,
				);
			// Parent load of the bridge claims the namespace.
			await claim();
			// The SAME extension path re-loaded by a spawned subagent inheriting the bridge re-claims
			// WITHOUT throwing, and does not become an owner.
			const child = await claim({ kind: "sub", id: "0-Scout", name: "scout", depth: 1, parentId: "Main" });
			expect(child).toBeDefined();
			child.releaseIrc?.();
			expect(IrcBus.global().hasRemoteTransport()).toBe(true);
			// A genuinely DIFFERENT extension (path) claiming the same namespace is still rejected.
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.setRemoteTransport?.("cluster-a", {
							async send(message) {
								return { to: message.to, outcome: "injected" };
							},
						});
					},
					process.cwd(),
					events,
					runtime,
					"/other/bridge.ts",
				),
			).rejects.toThrow(/already claimed/);
		} finally {
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});
});
