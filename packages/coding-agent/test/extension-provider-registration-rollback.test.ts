import { describe, expect, test } from "bun:test";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
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
	test("removes provider registrations when inline extension initialization fails", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("should-not-survive", testProviderConfig);
					throw new Error("intentional initialization failure");
				},
				process.cwd(),
				events,
				runtime,
				"broken-inline-extension",
			),
		).rejects.toThrow("intentional initialization failure");

		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

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

	test("keeps provider registrations when extension initialization succeeds", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("provider-one", {
					baseUrl: "https://one.example.invalid/v1",
				});
				pi.registerProvider("provider-two", {
					baseUrl: "https://two.example.invalid/v1",
				});
			},
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		expect(runtime.pendingProviderRegistrations.map(r => r.name)).toEqual(["provider-one", "provider-two"]);
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
					getAgentId: () => undefined,
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

			expect(modelRegistry.authStorage.hasAuth("cliproxyapi")).toBe(false);
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

			await expect(authStorage.fetchUsageReports()).resolves.toEqual([report]);
			expect(authStorage.usageProviderFor(provider)).toBe(extensionUsage);

			modelRegistry.unregisterProvider(provider);
			expect(authStorage.usageProviderFor(provider)).toBeUndefined();

			const builtinUsage = authStorage.usageProviderFor("synthetic");
			if (!builtinUsage) throw new Error("Expected the synthetic built-in usage provider");
			const syntheticOverride: UsageProvider = { ...extensionUsage, id: "synthetic" };
			modelRegistry.registerProvider("synthetic", { usage: syntheticOverride }, "extension-usage-provider");
			expect(authStorage.usageProviderFor("synthetic")).toBe(syntheticOverride);
			modelRegistry.unregisterProvider("synthetic");
			expect(authStorage.usageProviderFor("synthetic")).toBe(builtinUsage);
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
						pi.irc.setRemoteTransport?.(transport);
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
					pi.irc.setRemoteTransport?.({
						async send(message) {
							seenFirst.push(message.to);
							return { to: message.to, outcome: "injected" };
						},
					});
					pi.irc.registerRemotePeer?.({ id: "alice", displayName: "alice" });
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
						pi.irc.setRemoteTransport?.({
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
			const receipt = await IrcBus.global().send({ from: "Main", to: "alice", body: "hi" });
			expect(receipt.outcome).toBe("injected");
			expect(seenFirst).toEqual(["alice"]);
		} finally {
			IrcBus.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	test("keeps a remote proxy registered by an extension that loads successfully", async () => {
		AgentRegistry.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			await loadExtensionFromFactory(
				pi => {
					pi.irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				events,
				runtime,
				"ok-bridge-extension",
			);
			const ref = AgentRegistry.global().get("beatrice");
			expect(ref?.kind).toBe("remote");
			expect(ref?.ownerToken?.startsWith("ok-bridge-extension:")).toBe(true);
		} finally {
			AgentRegistry.resetGlobalForTests();
		}
	});

	test("retracts remote proxies registered by an extension that then fails to load", async () => {
		AgentRegistry.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();

			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice" });
						throw new Error("failed after seeding remote peer");
					},
					process.cwd(),
					events,
					runtime,
					"broken-bridge-extension",
				),
			).rejects.toThrow("failed after seeding remote peer");

			// The orphaned proxy must not survive a failed load — attributed rollback by ownerToken.
			expect(AgentRegistry.global().get("beatrice")).toBeUndefined();
		} finally {
			AgentRegistry.resetGlobalForTests();
		}
	});

	test("a failed factory does not remove a colliding local ref it could not overwrite", async () => {
		AgentRegistry.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			// A local agent already occupies "Main" before the bridge loads.
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
						// Colliding with the local agent is refused (no-op), so it is never stamped…
						expect(pi.irc.registerRemotePeer?.({ id: "Main", displayName: "spoof" })).toBe(false);
						throw new Error("boom");
					},
					process.cwd(),
					events,
					runtime,
					"clumsy-bridge",
				),
			).rejects.toThrow("boom");

			// …so the attributed rollback leaves the real local agent intact.
			expect(AgentRegistry.global().get("Main")?.kind).toBe("main");
		} finally {
			AgentRegistry.resetGlobalForTests();
		}
	});

	test("a failed load does not retract remote proxies from an earlier successful load of the same path", async () => {
		AgentRegistry.resetGlobalForTests();
		try {
			const runtime = new ExtensionRuntime();
			const events = new EventBus();
			// Load #1 of path P succeeds and seeds a proxy.
			await loadExtensionFromFactory(
				pi => {
					pi.irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice" });
				},
				process.cwd(),
				events,
				runtime,
				"same/bridge.ts",
			);
			expect(AgentRegistry.global().get("beatrice")?.kind).toBe("remote");

			// Load #2 of the SAME path fails after seeding its own proxy.
			await expect(
				loadExtensionFromFactory(
					pi => {
						pi.irc.registerRemotePeer?.({ id: "carol", displayName: "carol" });
						throw new Error("boom");
					},
					process.cwd(),
					events,
					runtime,
					"same/bridge.ts",
				),
			).rejects.toThrow("boom");

			// Per-load ownerToken: load #2's proxy is retracted; load #1's survives untouched.
			expect(AgentRegistry.global().get("carol")).toBeUndefined();
			expect(AgentRegistry.global().get("beatrice")?.kind).toBe("remote");
		} finally {
			AgentRegistry.resetGlobalForTests();
		}
	});
});
