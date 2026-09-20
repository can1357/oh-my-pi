import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { resolveAgentServiceTierOverride } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const runtimeProviderExtension: ExtensionFactory = pi => {
	pi.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "runtime-model",
				name: "Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

const deferredCodexProviderExtension: ExtensionFactory = pi => {
	pi.registerProvider("openai-codex", {
		baseUrl: "https://chatgpt.com/backend-api",
		apiKey: "RUNTIME_CODEX_KEY",
		api: "openai-codex-responses",
		models: [
			{
				id: "deferred-model",
				name: "Deferred Codex Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

const originalWebSocket = globalThis.WebSocket;

class CapturingWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: CapturingWebSocket[] = [];
	static created?: PromiseWithResolvers<CapturingWebSocket>;

	readonly headers: Record<string, string>;
	readyState = CapturingWebSocket.CONNECTING;
	binaryType = "arraybuffer";
	onopen: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(
		readonly url: string,
		options?: { headers?: Record<string, string>; proxy?: string },
	) {
		this.headers = options?.headers ?? {};
		CapturingWebSocket.instances.push(this);
		CapturingWebSocket.created?.resolve(this);
		queueMicrotask(() => {
			if (this.readyState !== CapturingWebSocket.CONNECTING) return;
			this.readyState = CapturingWebSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	send(_data: unknown): void {}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === CapturingWebSocket.CLOSED) return;
		this.readyState = CapturingWebSocket.CLOSED;
		this.onclose?.({ code, reason } as CloseEvent);
	}
}

function installCapturingWebSocket(): void {
	CapturingWebSocket.instances = [];
	CapturingWebSocket.created = Promise.withResolvers<CapturingWebSocket>();
	globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
}

async function waitForPrewarmSocket(): Promise<CapturingWebSocket> {
	const socket = CapturingWebSocket.instances[0];
	if (socket) return socket;
	const created = CapturingWebSocket.created;
	if (!created) throw new Error("Capturing WebSocket was not installed");
	return await created.promise;
}

describe.serial("createAgentSession resolveServiceTierByFamily", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
	});

	function openAuthStorage(): AuthStorage {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		return authStorage;
	}

	function sessionOptions(cwd: string, authStorage: AuthStorage, settings: Settings, sessionManager: SessionManager) {
		return {
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		};
	}

	it("prewarms the final deferred Codex model with the child resolver tier", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-prewarm-");
		const authStorage = openAuthStorage();
		installCapturingWebSocket();
		const { session } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				Settings.isolated({
					"providers.openaiWebsockets": "on",
					enabledModels: ["openai-codex/deferred-model"],
					"tier.openai": "none",
					"tier.anthropic": "none",
					"tier.google": "none",
				}),
				SessionManager.inMemory(),
			),
			extensions: [deferredCodexProviderExtension],
			// This is the same exact-agent resolver used by task dispatch; the global
			// OpenAI tier above intentionally stays `none`.
			resolveServiceTierByFamily: model => resolveAgentServiceTierOverride("priority", model, {}),
		});
		try {
			const socket = await waitForPrewarmSocket();
			expect(session.model?.id).toBe("deferred-model");
			expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
			expect(socket.headers["x-codex-routing-hint"]).toBe("model=deferred-model;tier=priority");
		} finally {
			await session.dispose();
		}
	});

	it("keeps omitted and explicit default tiers distinct during Codex prewarm", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-prewarm-default-");
		const createDeferredSession = async (
			resolveServiceTierByFamily?: (model: Model | undefined) => ServiceTierByFamily,
		) =>
			await createAgentSession({
				...sessionOptions(
					tempDir.path(),
					openAuthStorage(),
					Settings.isolated({
						"providers.openaiWebsockets": "on",
						enabledModels: ["openai-codex/deferred-model"],
						"tier.openai": "none",
						"tier.anthropic": "none",
						"tier.google": "none",
					}),
					SessionManager.inMemory(),
				),
				extensions: [deferredCodexProviderExtension],
				modelPattern: "openai-codex/deferred-model",
				...(resolveServiceTierByFamily ? { resolveServiceTierByFamily } : {}),
			});

		installCapturingWebSocket();
		const { session: omitted } = await createDeferredSession();
		try {
			const socket = await waitForPrewarmSocket();
			expect(omitted.serviceTierByFamily).toEqual({});
			expect(socket.headers["x-codex-routing-hint"]).toBe("model=deferred-model");
		} finally {
			await omitted.dispose();
		}
		installCapturingWebSocket();
		const { session: explicitDefault } = await createDeferredSession(model =>
			resolveAgentServiceTierOverride("default", model, {}),
		);
		try {
			const socket = await waitForPrewarmSocket();
			expect(explicitDefault.serviceTierByFamily).toEqual({ openai: "default" });
			expect(socket.headers["x-codex-routing-hint"]).toBe("model=deferred-model;tier=default");
		} finally {
			await explicitDefault.dispose();
		}
	});

	it("evaluates the resolver against the model resolved from a deferred pattern and replaces the configured tiers", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-");
		const authStorage = openAuthStorage();
		const resolvedModels: Array<Model | undefined> = [];
		const { session } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				Settings.isolated({ "tier.anthropic": "priority" }),
				SessionManager.inMemory(),
			),
			extensions: [runtimeProviderExtension],
			// Only the extension can resolve this pattern, so dispatch-time
			// resolution would have seen no model at all.
			modelPattern: "runtime-provider/runtime-model",
			resolveServiceTierByFamily: model => {
				resolvedModels.push(model);
				return { openai: "scale" };
			},
		});
		try {
			expect(resolvedModels.map(model => model && `${model.provider}/${model.id}`)).toEqual([
				"runtime-provider/runtime-model",
			]);
			expect(session.model?.id).toBe("runtime-model");
			expect(session.serviceTierByFamily).toEqual({ openai: "scale" });
		} finally {
			await session.dispose();
		}
	});

	it("persists an empty resolved tier map so a reopened session does not re-derive tiers from settings", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-reopen-");
		const authStorage = openAuthStorage();
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		// The settings a cold revival rebuilds from say `priority`; the spawn's
		// per-agent override resolved to no tier at all.
		const settings = Settings.isolated({ "tier.openai": "priority" });

		const { session: spawned } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				settings,
				await SessionManager.open(sessionFile, tempDir.path()),
			),
			resolveServiceTierByFamily: () => ({}),
		});
		try {
			expect(spawned.serviceTierByFamily).toEqual({});
		} finally {
			await spawned.dispose();
		}

		const { session: revived } = await createAgentSession(
			sessionOptions(tempDir.path(), authStorage, settings, await SessionManager.open(sessionFile, tempDir.path())),
		);
		try {
			expect(revived.serviceTierByFamily).toEqual({});
		} finally {
			await revived.dispose();
		}
	});
});
