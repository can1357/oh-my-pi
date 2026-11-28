/**
 * Regression test for issue #1234.
 *
 * `omp acp` must not auto-discover host `.mcp.json` servers when creating a
 * session for an ACP client. MCP server ownership belongs entirely to the ACP
 * client (`session/new.mcpServers` → `AcpAgent#configureMcpServers`); letting
 * `createAgentSession` run on-disk discovery in parallel registers host MCP
 * tools that shadow the client-supplied ones in the session tool registry.
 *
 * The contract enforced here is narrow on purpose: every call routed through
 * the ACP session factory must reach `createAgentSession` with
 * `enableMCP: false`, regardless of what `baseOptions` carries.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

describe("createAcpSessionFactory MCP isolation (issue #1234)", () => {
	it("forces enableMCP=false even when baseOptions opts in", async () => {
		const tempDir = TempDir.createSync("@pi-acp-mcp-isolation-");
		try {
			const settings = Settings.isolated({});
			const fakeSession = { addDisposer: mock(), setScopedModelsRefresher: mock() } as unknown as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions deliberately sets enableMCP=true to prove the factory ignores it.
			const factory = createAcpSessionFactory({
				baseOptions: { enableMCP: true } as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { invalidFlagValues: [] },
				rawArgs: [],
				createSession,
			});

			const result = await factory(tempDir.path());
			expect(result.session).toBe(fakeSession);
			expect(captured).toHaveLength(1);
			expect(captured[0].enableMCP).toBe(false);
		} finally {
			await tempDir.remove();
		}
	});

	it("rejects allowlisted tools absent from the completed ACP session registry", async () => {
		const tempDir = TempDir.createSync("@pi-acp-tool-allowlist-");
		try {
			const settings = Settings.isolated({});
			let disposed = false;
			const fakeSession = {
				extensionRunner: undefined,
				getAllToolNames: () => ["read"],
				dispose: async () => {
					disposed = true;
				},
			} as unknown as AgentSession;
			const factory = createAcpSessionFactory({
				baseOptions: {} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { tools: ["read", "missing"], invalidFlagValues: [] },
				rawArgs: ["--tools", "read,missing"],
				createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			});

			await expect(factory(tempDir.path())).rejects.toThrow(/Unknown tool in --tools: missing/);
			expect(disposed).toBe(true);
		} finally {
			await tempDir.remove();
		}
	});

	it("shares the trusted extension EventBus with the ACP session", async () => {
		const tempDir = TempDir.createSync("@pi-acp-trusted-extension-");
		try {
			const settings = Settings.isolated({});
			const trustedPath = tempDir.join("trusted.ts");
			const firedPath = tempDir.join("trusted-event-fired");
			const ambientFiredPath = tempDir.join("ambient-extension-loaded");
			await Bun.write(
				tempDir.join(".omp/extensions/ambient.ts"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ambientFiredPath)}, "loaded"); export default function () {}`,
			);
			await Bun.write(
				trustedPath,
				`import { writeFileSync } from "node:fs"; export default function (pi) { pi.events.on("acp-session-live", () => writeFileSync(${JSON.stringify(firedPath)}, "fired")); }`,
			);
			let captured: CreateAgentSessionOptions | undefined;
			const fakeSession = { addDisposer: mock(), setScopedModelsRefresher: mock() } as unknown as AgentSession;
			const factory = createAcpSessionFactory({
				baseOptions: {
					disableExtensionDiscovery: true,
					additionalExtensionPaths: [trustedPath],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { trustedExtensions: [trustedPath], invalidFlagValues: [] },
				rawArgs: [],
				createSession: async options => {
					captured = options;
					options.eventBus?.emit("acp-session-live", undefined);
					return {
						session: fakeSession,
						extensionsResult: options.preloadedExtensions,
						setToolUIContext: () => {},
						eventBus: options.eventBus,
					} as CreateAgentSessionResult;
				},
			});

			await factory(tempDir.path());

			expect(captured?.eventBus).toBeDefined();
			expect(captured?.preloadedExtensions?.extensions).toHaveLength(1);
			expect(await Bun.file(firedPath).text()).toBe("fired");
			expect(await Bun.file(ambientFiredPath).exists()).toBe(false);
		} finally {
			await tempDir.remove();
		}
	});

	it("fails before ACP session creation when a trusted extension cannot load", async () => {
		const tempDir = TempDir.createSync("@pi-acp-trusted-extension-failure-");
		try {
			const settings = Settings.isolated({});
			const trustedPath = tempDir.join("throwing.ts");
			await Bun.write(trustedPath, 'throw new Error("trusted extension fixture");');
			let createCalls = 0;
			const factory = createAcpSessionFactory({
				baseOptions: {
					disableExtensionDiscovery: true,
					additionalExtensionPaths: [trustedPath],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { trustedExtensions: [trustedPath], invalidFlagValues: [] },
				rawArgs: [],
				createSession: async () => {
					createCalls++;
					throw new Error("must not create ACP session");
				},
			});

			await expect(factory(tempDir.path())).rejects.toThrow(/Trusted extension failed to load.*fixture/);
			expect(createCalls).toBe(0);
		} finally {
			await tempDir.remove();
		}
	});
});

describe("createAcpSessionFactory TITLE_SYSTEM.md per-cwd resolution (PR #3736)", () => {
	it("re-resolves the title prompt for the per-session cwd instead of inheriting the launch cwd's override", async () => {
		const tempDir = TempDir.createSync("@pi-acp-title-prompt-");
		try {
			const settings = Settings.isolated({});

			const projectDir = tempDir.join("project");
			await Bun.write(`${projectDir}/.omp/TITLE_SYSTEM.md`, "Project-specific title policy.");

			const fakeSession = { addDisposer: mock(), setScopedModelsRefresher: mock() } as unknown as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the LAUNCH cwd's prompt; the factory must
			// override it with the per-session cwd's `TITLE_SYSTEM.md`.
			const factory = createAcpSessionFactory({
				baseOptions: {
					titleSystemPrompt: "Launch-cwd policy that must not leak.",
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { invalidFlagValues: [] },
				rawArgs: [],
				createSession,
			});

			await factory(projectDir);

			expect(captured).toHaveLength(1);
			expect(captured[0].titleSystemPrompt).toBe("Project-specific title policy.");
		} finally {
			await tempDir.remove();
		}
	});
});

describe("createAcpSessionFactory scope rebuild after discovery", () => {
	it("does not write the scope of a session disposed while discovery is pending", async () => {
		using tempDir = TempDir.createSync("@pi-acp-scope-disposal-");
		const scopeModel = (id: string): Model<Api> =>
			buildModel({
				id,
				name: id,
				api: "anthropic-messages",
				provider: "prov",
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			});
		let available = [scopeModel("a")];
		const discovery = Promise.withResolvers<void>();
		const registry = {
			getAvailable: () => available,
			getDiscoverableProviders: () => [],
			createStartupModelCacheHydrator: () => async () => {},
			refresh: async () => {},
			awaitBackgroundRefresh: () => discovery.promise,
			reapplyModelPolicies: () => {},
		} as unknown as ModelRegistry;
		const scopeWrites: string[][] = [];
		const fakeSession = {
			isDisposed: false,
			scopedModels: [] as Array<{ model: Model }>,
			addDisposer: mock(),
			setScopedModelsRefresher: mock(),
			setScopedModels(models: Array<{ model: Model }>) {
				scopeWrites.push(models.map(entry => entry.model.id));
				this.scopedModels = models;
			},
		};
		const factory = createAcpSessionFactory({
			baseOptions: {},
			settings: Settings.isolated({ enabledModels: ["prov/a", "prov/b"] }),
			sessionDir: tempDir.join("sessions"),
			authStorage,
			modelRegistry: registry,
			parsedArgs: { invalidFlagValues: [] },
			rawArgs: [],
			createSession: async () =>
				({
					session: fakeSession as unknown as AgentSession,
					setToolUIContext: () => {},
				}) as unknown as CreateAgentSessionResult,
		});

		await factory(tempDir.path());
		expect(scopeWrites).toEqual([["a"]]);

		fakeSession.isDisposed = true;
		available = [scopeModel("a"), scopeModel("b")];
		discovery.resolve();
		await Bun.sleep(0);

		expect(scopeWrites).toEqual([["a"]]);
	});
});
