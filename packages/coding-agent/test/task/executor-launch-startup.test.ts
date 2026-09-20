import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { grokbotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, getModelDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) await authStorage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir[Symbol.dispose]();
});

it("overlaps registry refresh with session-file opening and session setup", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(() => refreshGate.promise);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const openGate = Promise.withResolvers<SessionManager>();
	const openStarted = Promise.withResolvers<void>();
	const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
		openStarted.resolve();
		return openGate.promise;
	});

	const sessionCreationStarted = Promise.withResolvers<void>();
	let sessionCreated = false;
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
		},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		sessionCreationStarted.resolve();
		sessionCreated = true;
		const result: CreateAgentSessionResult = {
			session,
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		return result;
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-launch-overlap",
		authStorage,
		enableLsp: false,
		enableIrc: false,
	});
	await openStarted.promise;

	expect(openSpy).toHaveBeenCalledTimes(1);
	expect(sessionCreated).toBe(false);

	openGate.resolve(sessionManager);

	await sessionCreationStarted.promise;
	expect(sessionCreated).toBe(true);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
});

it("hydrates the Grok credential cache before selecting a direct subagent model", async () => {
	const tempDir = TempDir.createSync("@pi-task-grok-cache-");
	tempDirs.push(tempDir);
	const originalAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	try {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		const apiKey = JSON.stringify({ renewal: "expired-task-cache-renewal", machineId: "expired-task-cache-machine" });
		const managerOptions = grokbotModelManagerOptions({ apiKeys: [apiKey] });
		const cacheProviderId = managerOptions.cacheProviderId;
		if (!cacheProviderId) throw new Error("Missing Grok Bot cache provider id");
		const cachedModel = buildModel({
			id: "expired-task-cache-model",
			name: "Expired task cache model",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
		const cacheDbPath = getModelDbPath();
		await fs.mkdir(path.dirname(cacheDbPath), { recursive: true });
		writeModelCache(
			cacheProviderId,
			Date.now(),
			[cachedModel],
			true,
			fingerprintStaticModels(managerOptions.staticModels ?? [], true),
			cacheDbPath,
		);
		await authStorage.set("grokbot", {
			type: "oauth",
			access: apiKey,
			refresh: "expired-task-cache-refresh",
			expires: Date.now() - 60_000,
			orgId: "expired-task-cache-machine",
		});

		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const session = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["yield"],
			getEnabledToolNames: () => ["yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "yield",
						toolName: "yield",
						result: { content: [], details: { status: "success", data: { ok: true } } },
						isError: false,
					} as AgentSessionEvent);
				}
			},
		} as unknown as AgentSession;
		let selectedModelId: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			selectedModelId = options?.model?.id;
			return {
				session,
				extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			};
		});

		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "test",
			index: 0,
			id: "task-grok-cache",
			authStorage,
			modelOverride: "grokbot/expired-task-cache-model",
			enableLsp: false,
			enableIrc: false,
		});

		expect(selectedModelId).toBe("expired-task-cache-model");
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe("grokbot/expired-task-cache-model");
	} finally {
		setAgentDir(originalAgentDir);
	}
});
