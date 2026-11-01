/**
 * A session's account-pool restriction outlives the extension work the session admitted.
 *
 * Disposal lifts the pool only once the session's live work has drained, so what an extension is
 * still doing must count as live work until it is really over. Two shapes escaped that: a callback
 * that returns its operation through a `then` getter, which the runtime read twice and so watched
 * a different answer than the one the operation gave; and a custom API stream whose authored
 * iterator does its cleanup in an asynchronous `finally`, which the host starts at the terminal
 * and nobody held the session for.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import {
	type AssistantMessage,
	clearCustomApis,
	createAssistantMessageEventStream,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER_SESSION_ID = "extension-work-lifetime";
const POOLED = "pooled-access";
const UNRESTRICTED = "unrestricted-key";

describe("a disposed session's account pool waits for the extension work it admitted", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let bus: EventBus;
	/** Released by the test once the session is disposed; the extension's work then finishes. */
	let finish: PromiseWithResolvers<void>;
	/** Settles when the extension's work has read its first key and is about to wait. */
	let entered: PromiseWithResolvers<void>;
	/** Settles when the extension's work has read its last key. */
	let ended: PromiseWithResolvers<void>;
	let keys: Array<string | undefined>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-extension-work-lifetime-");
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", UNRESTRICTED);
		await auth.credentials.set("anthropic", [
			{
				type: "oauth",
				access: POOLED,
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "pooled@example.com",
				orgId: "org",
			},
		]);
		registry = new ModelRegistry(auth, path.join(tempDir.path(), "models.json"));
		bus = new EventBus();
		finish = Promise.withResolvers();
		entered = Promise.withResolvers();
		ended = Promise.withResolvers();
		keys = [];
	});

	afterEach(() => {
		finish.resolve();
		clearCustomApis();
		auth.close();
		tempDir.removeSync();
	});

	/** The extension's work: read the key, wait for the test, read it again. */
	async function work(): Promise<void> {
		keys.push(await auth.keys.get("anthropic", PROVIDER_SESSION_ID));
		entered.resolve();
		await finish.promise;
		keys.push(await auth.keys.get("anthropic", PROVIDER_SESSION_ID));
		ended.resolve();
	}

	/** Starts a session pooled to the one account, with `extension`, runs `start`, disposes the
	 *  session while the extension's work waits, then lets that work finish. Returns how many times
	 *  disposal reported the work outliving its drain. */
	async function disposeDuringWork(extension: ExtensionFactory, start: () => Promise<void>): Promise<number> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage: auth,
			modelRegistry: registry,
			model: createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["unused"] }] }).model,
			settings: Settings.isolated({ "memory.backend": "off", "todo.enabled": false, "compaction.enabled": false }),
			eventBus: bus,
			disableExtensionDiscovery: true,
			extensions: [extension],
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
			providerSessionId: PROVIDER_SESSION_ID,
			oauthAccountPools: { anthropic: ["email:pooled@example.com|org:org"] },
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let outlived = 0;
		try {
			await start();
			await entered.promise;
			// Past the deadline: disposal returns while the work still waits, and must leave the pool.
			await session.dispose({ drainTimeoutMs: 30 });
			outlived = warn.mock.calls.filter(([message]) =>
				String(message).startsWith("Extension work outlived the dispose drain"),
			).length;
			finish.resolve();
			await ended.promise;
		} finally {
			warn.mockRestore();
			await session.dispose();
		}
		return outlived;
	}

	test("for an operation a callback returns through a `then` getter that answers only once", async () => {
		let thenReads = 0;
		const outlived = await disposeDuringWork(
			pi => {
				pi.events.on("review", () => {
					const operation = work();
					return {
						// oxlint-disable-next-line unicorn/no-thenable -- the operation under test is a thenable read once
						get then() {
							thenReads++;
							return thenReads === 1
								? (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
										operation.then(resolve, reject)
								: undefined;
						},
					};
				});
			},
			async () => {
				bus.emit("review", {});
			},
		);

		expect({ keys, thenReads, outlived }).toEqual({ keys: [POOLED, POOLED], thenReads: 1, outlived: 1 });
	});

	test("for a custom API stream whose authored iterator cleans up in an asynchronous finally", async () => {
		const outlived = await disposeDuringWork(
			pi => {
				pi.registerProvider("lifetime-stream", {
					api: "lifetime-stream-api",
					apiKey: "key",
					baseUrl: "https://example.invalid",
					models: [
						{
							id: "m",
							name: "m",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100_000,
							maxTokens: 1_000,
						},
					],
					streamSimple() {
						const output = createAssistantMessageEventStream();
						output[Symbol.asyncIterator] = async function* () {
							try {
								const message: AssistantMessage = {
									role: "assistant",
									content: [],
									api: "lifetime-stream-api",
									provider: "lifetime-stream",
									model: "m",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "stop",
									timestamp: 0,
								};
								output.push({ type: "done", reason: "stop", message });
								yield { type: "done", reason: "stop", message };
							} finally {
								await work();
							}
						};
						return output;
					},
				});
			},
			async () => {
				const model = registry.find("lifetime-stream", "m");
				if (!model) throw new Error("the extension's model is not registered");
				// The caller's result settles at the terminal; the iterator's close follows it.
				await streamSimple(model, { messages: [] }, { apiKey: "key", loopGuard: { enabled: false } }).result();
			},
		);

		expect({ keys, outlived }).toEqual({ keys: [POOLED, POOLED], outlived: 1 });
	});
});
