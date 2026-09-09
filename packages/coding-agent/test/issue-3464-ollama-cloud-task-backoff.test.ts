import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Semaphore } from "@oh-my-pi/pi-coding-agent/task/parallel";
import { wrapStreamFnWithProviderConcurrency } from "@oh-my-pi/pi-coding-agent/task/provider-concurrency";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function requireModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

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

	it("bounds concurrent ollama-cloud LLM streams by the configured maxConcurrency", async () => {
		const cloudModel = requireModel("ollama-cloud", "gpt-oss:120b");
		const settings = Settings.isolated({
			"providers.ollama-cloud.maxConcurrency": 2,
		});

		let inFlight = 0;
		let peakInFlight = 0;
		let invocations = 0;
		const gates: Deferred[] = [];
		const base: StreamFn = model => {
			const gate = deferred();
			gates.push(gate);
			invocations++;
			inFlight++;
			peakInFlight = Math.max(peakInFlight, inFlight);
			const stream = new AssistantMessageEventStream();
			void gate.promise.then(() => {
				inFlight--;
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		};
		const wrapped = wrapStreamFnWithProviderConcurrency(settings, base);

		const waitForInvocations = async (target: number): Promise<void> => {
			for (let i = 0; i < 1000 && invocations < target; i++) {
				await Promise.resolve();
			}
			expect(invocations).toBe(target);
		};

		const calls = Array.from({ length: 4 }, async () => wrapped(cloudModel, { messages: [] }, {}));
		// Two slots admit two calls; the next two queue behind them.
		await waitForInvocations(2);
		expect(inFlight).toBe(2);

		// Release the first slot; exactly one queued waiter is admitted.
		gates[0]!.resolve();
		await waitForInvocations(3);
		expect(inFlight).toBe(2);
		expect(peakInFlight).toBe(2);

		gates[1]!.resolve();
		await waitForInvocations(4);
		expect(inFlight).toBe(2);

		gates[2]!.resolve();
		gates[3]!.resolve();
		await Promise.all(calls);
		expect(inFlight).toBe(0);
		expect(peakInFlight).toBe(2);
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
