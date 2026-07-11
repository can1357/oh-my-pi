import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import * as sdkModule from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import {
	AgentSession,
	type AgentSessionEvent,
	type PromptOptions,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import { Semaphore } from "@pk-nerdsaver-ai/pi-coding-agent/task/parallel";
import type { AgentDefinition } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import { EventBus } from "@pk-nerdsaver-ai/pi-coding-agent/utils/event-bus";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

type MockPromptSession = AgentSession & {
	emit(event: AgentSessionEvent): void;
};

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function createGateSession(onPrompt: () => Promise<void>): MockPromptSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await onPrompt();
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
	return session as unknown as MockPromptSession;
}

function requireModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General task agent",
	systemPrompt: "test",
	source: "bundled",
};

describe("issue #3464: ollama-cloud task backoff", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-issue-3464-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("ollama-cloud", "ollama-cloud-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	it("uses the default fallback chain for a configured task role with no task chain", async () => {
		const primary = requireModel("anthropic", "claude-sonnet-4-5");
		const fallback = requireModel("openai", "gpt-4o-mini");
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primary.provider && model.id === primary.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		settings.setModelRole("task", `${primary.provider}/${primary.id}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Task role should inherit the default fallback chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`]);
		expect(session.model?.provider).toBe(fallback.provider);
		expect(session.model?.id).toBe(fallback.id);
	});

	it("bounds concurrent subagent runs by the resolved ollama-cloud provider limit", async () => {
		const cloudModel = requireModel("ollama-cloud", "gpt-oss:120b");
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		const firstStarted = deferred();
		const secondStarted = deferred();
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const id = options?.agentId ?? "unknown";
			const gate = deferred();
			gates.set(id, gate);
			return createSessionResult(
				createGateSession(async () => {
					started.push(id);
					if (id === "CloudOne") firstStarted.resolve();
					if (id === "CloudTwo") secondStarted.resolve();
					await gate.promise;
				}),
			);
		});
		const settings = Settings.isolated({
			"providers.ollama-cloud.maxConcurrency": 1,
		});

		const first = runSubprocess({
			cwd: "/tmp",
			agent: taskAgent,
			task: "first",
			index: 0,
			id: "CloudOne",
			modelOverride: `${cloudModel.provider}/${cloudModel.id}`,
			settings,
			modelRegistry,
			enableLsp: false,
		});
		const second = runSubprocess({
			cwd: "/tmp",
			agent: taskAgent,
			task: "second",
			index: 1,
			id: "CloudTwo",
			modelOverride: `${cloudModel.provider}/${cloudModel.id}`,
			settings,
			modelRegistry,
			enableLsp: false,
		});

		await firstStarted.promise;
		expect(started).toEqual(["CloudOne"]);
		expect(gates.has("CloudTwo")).toBe(false);

		gates.get("CloudOne")?.resolve();
		await first;
		await secondStarted.promise;
		expect(started).toEqual(["CloudOne", "CloudTwo"]);
		gates.get("CloudTwo")?.resolve();
		await second;
	});

	it("frees a queued slot when its acquire waiter is aborted", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const controller = new AbortController();
		const aborted = semaphore.acquire(controller.signal);
		controller.abort();
		await aborted.then(
			() => {
				throw new Error("Aborted semaphore.acquire should reject");
			},
			() => {},
		);

		const nextStarted = deferred();
		const next = (async () => {
			await semaphore.acquire();
			nextStarted.resolve();
		})();
		semaphore.release();
		await nextStarted.promise;
		semaphore.release();
		await next;
	});

	it("raises the ceiling in place and admits queued waiters without a release", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const admitted: number[] = [];
		const w1 = (async () => {
			await semaphore.acquire();
			admitted.push(1);
		})();
		const w2 = (async () => {
			await semaphore.acquire();
			admitted.push(2);
		})();
		await Bun.sleep(0);
		expect(admitted).toEqual([]);

		semaphore.resize(3);
		await Bun.sleep(0);
		expect(admitted).toEqual([1, 2]);
		await Promise.all([w1, w2]);
	});

	it("lowers the ceiling without admitting waiters past the new cap", async () => {
		const semaphore = new Semaphore(3);
		await semaphore.acquire();
		await semaphore.acquire();
		await semaphore.acquire();
		let admitted = false;
		const waiter = (async () => {
			await semaphore.acquire();
			admitted = true;
		})();
		await Bun.sleep(0);
		expect(admitted).toBe(false);

		semaphore.resize(1);
		semaphore.release();
		await Bun.sleep(0);
		expect(admitted).toBe(false);
		semaphore.release();
		await Bun.sleep(0);
		expect(admitted).toBe(false);
		semaphore.release();
		await Bun.sleep(0);
		expect(admitted).toBe(true);
		await waiter;
		semaphore.release();
	});

	it("counts holders acquired while unlimited after a finite cap is re-enabled", async () => {
		const semaphore = new Semaphore(0); // unlimited
		await semaphore.acquire();
		await semaphore.acquire(); // two holders counted despite being unlimited
		let admitted = false;
		semaphore.resize(1); // re-enable a finite cap below the in-flight count
		const waiter = (async () => {
			await semaphore.acquire();
			admitted = true;
		})();
		await Bun.sleep(0);
		expect(admitted).toBe(false);
		semaphore.release();
		await Bun.sleep(0);
		expect(admitted).toBe(false);
		semaphore.release();
		await Bun.sleep(0);
		expect(admitted).toBe(true);
		await waiter;
		semaphore.release();
	});
});
