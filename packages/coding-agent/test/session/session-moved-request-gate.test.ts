import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	captureRequestHolds,
	completeSimple,
	type Model,
	RequestHoldsAlias,
	runWithRequestHolds,
} from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { CodexLiveTransport } from "@oh-my-pi/pi-coding-agent/live/transport";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Every model request a session's tree starts waits for the session's move
 * hold (the `session_moved` handlers), whoever starts it: the agent's own
 * request after its `onPayload` hook, an advisor's request, a description the
 * context build asks for, a request started from outside any session work.
 */

/** Storage that reports the opened file as owned by another live process, so the next write moves the session. */
class StorageWithForeignOwner extends FileSessionStorage {
	original = "";
	override claimSession(id: string, file: string) {
		return file === this.original ? null : super.claimSession(id, file);
	}
}

async function eventLoopTurns(count = 10): Promise<void> {
	for (let turn = 0; turn < count; turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

const SSE_REPLY = [
	'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}',
	'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

/** A local OpenAI-compatible endpoint that records the requests it receives. */
function localModelServer() {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: request => {
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return new Response(SSE_REPLY, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const model: Model = buildModel({
		api: "openai-completions",
		provider: "openai",
		id: "local",
		name: "local",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_000,
		maxTokens: 1024,
	});
	return { requests, model, stop: () => server.stop(true) };
}

/**
 * A session opened on a file another process owns, with a `session_moved` handler held until `finish`.
 * `onMoved` runs inside the handler, before it waits.
 */
async function movableSession(temp: TempDir, onMoved?: () => void) {
	const dir = path.join(temp.path(), "sessions");
	const seed = SessionManager.create(temp.path(), dir, new FileSessionStorage());
	seed.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await seed.ensureOnDisk();
	await seed.flush();
	const file = seed.getSessionFile()!;
	await seed.close();
	const storage = new StorageWithForeignOwner();
	storage.original = file;
	const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
	const finish = Promise.withResolvers<void>();
	const moved = Promise.withResolvers<void>();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("session_moved", async () => {
				onMoved?.();
				moved.resolve();
				await finish.promise;
			});
		},
		temp.path(),
		new EventBus(),
		runtime,
		"probe",
	);
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	return {
		manager,
		finish,
		moved,
		auth,
		registry,
		runner: new ExtensionRunner([extension], runtime, temp.path(), manager, registry),
	};
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A temp dir under the OS temp dir, removed after every other cleanup of the test (they run in reverse). */
function tempDir(prefix: string): TempDir {
	const temp = TempDir.createSync(prefix);
	cleanups.push(() => temp.remove());
	return temp;
}

describe("a session's move hold holds every model request its tree starts", () => {
	it("holds the agent's HTTP request when its onPayload hook moves the session", async () => {
		const temp = tempDir("@gate-payload-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const parts = await movableSession(temp);
		parts.auth.keys.setRuntime("openai", "test-key");
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "test-key",
			onPayload: async payload => {
				parts.manager.appendCustomEntry("moved-in-payload", {});
				await parts.moved.promise;
				return payload;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			extensionRunner: parts.runner,
		});
		cleanups.push(
			() => parts.auth.close(),
			() => session.dispose(),
			() => parts.finish.resolve(),
		);
		const run = agent.prompt("go");
		await parts.moved.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		parts.finish.resolve();
		await run;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	}, 60_000);

	it("holds an advisor's request, the advisor running on its own agent", async () => {
		const temp = tempDir("@gate-advisor-");
		const parts = await movableSession(temp);
		parts.auth.keys.setRuntime("anthropic", "test-key");
		const mock = createMockModel({ provider: "anthropic", responses: [{ content: ["done"] }] });
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const advisorRequests: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "test-key",
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings,
			extensionRunner: parts.runner,
			advisorTools: [],
			// A stream function that sends without a transport: only the loop's own last check can hold it.
			advisorStreamFn: (...args) => {
				advisorRequests.push("advisor-request");
				return mock.stream(...args);
			},
		});
		cleanups.push(
			() => parts.auth.close(),
			() => session.dispose(),
			() => parts.finish.resolve(),
		);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent()!;
		parts.manager.appendCustomEntry("move", {});
		await parts.moved.promise;
		// Prompted from outside any session work: the advisor still carries the session's context.
		const run = advisor.prompt("review");
		await eventLoopTurns();
		expect(advisorRequests).toEqual([]);
		parts.finish.resolve();
		await run;
		expect(advisorRequests).toEqual(["advisor-request"]);
	}, 60_000);

	it("holds the vision description a side request's context build sends", async () => {
		registerMockApi();
		const temp = tempDir("@gate-vision-");
		const parts = await movableSession(temp);
		parts.auth.keys.setRuntime("mock", "test-key");
		const vision = createMockModel({
			provider: "mock",
			id: "vision",
			responses: [{ content: ["a described image"] }],
		});
		vision.model.input.push("image");
		const text = createMockModel({ provider: "mock", id: "text", responses: [{ content: ["side complete"] }] });
		const available = spyOn(parts.registry, "getAvailable").mockReturnValue([vision.model]);
		const resolveKey = spyOn(parts.registry, "getApiKey").mockImplementation(async model => {
			if (model.id === "vision") parts.manager.appendCustomEntry("move", {});
			return "test-key";
		});
		cleanups.push(
			() => available.mockRestore(),
			() => resolveKey.mockRestore(),
		);
		const settings = Settings.isolated({
			"images.describeForTextModels": true,
			"compaction.enabled": false,
			"advisor.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("vision", "mock/vision");
		const agent = new Agent({
			initialState: { model: text.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "test-key",
			streamFn: text.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings,
			extensionRunner: parts.runner,
			sideStreamFn: text.stream,
		});
		cleanups.push(
			() => parts.auth.close(),
			() => session.dispose(),
			() => parts.finish.resolve(),
		);
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
		const run = session.runEphemeralTurn({
			promptText: "describe image",
			promptImages: [{ type: "image", data: png, mimeType: "image/png" }],
			tools: false,
		});
		await parts.moved.promise;
		await eventLoopTurns();
		expect(vision.calls).toHaveLength(0);
		parts.finish.resolve();
		await run;
		expect(vision.calls).toHaveLength(1);
	}, 60_000);

	it("holds a request started from outside any session work once it enters the session's context", async () => {
		const temp = tempDir("@gate-entry-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const parts = await movableSession(temp);
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			extensionRunner: parts.runner,
		});
		cleanups.push(
			() => parts.auth.close(),
			() => session.dispose(),
			() => parts.finish.resolve(),
		);
		parts.manager.appendCustomEntry("move", {});
		await parts.moved.promise;
		const context = { messages: [{ role: "user" as const, content: "q", timestamp: 0 }] };
		// A command handler, a UI callback, a worker's message: none runs in session work.
		const outside = completeSimple(server.model, context, { apiKey: "k" });
		await outside;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		const inside = session.runInRequestContext(() => completeSimple(server.model, context, { apiKey: "k" }));
		await eventLoopTurns();
		expect(server.requests).toHaveLength(1);
		parts.finish.resolve();
		await inside;
		expect(server.requests).toHaveLength(2);
	}, 60_000);

	it("holds a live call's signaling request in the session's context", async () => {
		const temp = tempDir("@gate-live-");
		const parts = await movableSession(temp);
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			extensionRunner: parts.runner,
		});
		const signaled: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			signaled.push(String(input instanceof Request ? input.url : input));
			return new Response("refused", { status: 500 });
		}) as typeof fetch);
		cleanups.push(
			() => fetchSpy.mockRestore(),
			() => parts.auth.close(),
			() => session.dispose(),
			() => parts.finish.resolve(),
		);
		const claims = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_held" } }),
			"utf8",
		).toBase64();
		await parts.auth.credentials.set("openai-codex", [
			{
				type: "oauth",
				access: `aaa.${claims}.bbb`,
				refresh: "r",
				expires: Date.now() + 3_600_000,
				accountId: "acc_held",
			},
		]);
		parts.manager.appendCustomEntry("move", {});
		await parts.moved.promise;
		const transport = new CodexLiveTransport({
			authStorage: parts.auth,
			sessionId: session.sessionId,
			instructions: "live",
			voice: "alloy",
			sdpOffer: "v=0",
			requestHolds: session.runInRequestContext(captureRequestHolds),
			callbacks: { onEvent: () => {}, onOutputLevel: () => {} },
		});
		const connecting = transport.connect().catch(() => undefined);
		await eventLoopTurns(20);
		expect(signaled).toEqual([]);
		parts.finish.resolve();
		await connecting;
		// The signaling request went out once the hold let go.
		expect(signaled.length).toBeGreaterThan(0);
		await transport.close();
	}, 60_000);
});

describe("session work started outside a prompt still waits for the session's holds", () => {
	/** A session whose extension's `user_bash` hook calls a model, held by one agent hold until `release`. */
	async function heldSession(temp: TempDir) {
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth);
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"), new FileSessionStorage());
		const request = () =>
			completeSimple(
				server.model,
				{ messages: [{ role: "user", content: "helper", timestamp: 0 }] },
				{ apiKey: "k" },
			);
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("user_bash", async () => {
					await request();
					return {
						result: {
							output: "intercepted",
							exitCode: 0,
							cancelled: false,
							truncated: false,
							totalLines: 1,
							totalBytes: 11,
							outputLines: 1,
							outputBytes: 11,
						},
					};
				});
			},
			temp.path(),
			new EventBus(),
			runtime,
			"hook-probe",
		);
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "k",
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			extensionRunner: new ExtensionRunner([extension], runtime, temp.path(), manager, registry),
		});
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = true;
		agent.addHold(() => ({
			pending: () => {
				if (!held) return undefined;
				reached.resolve();
				return release.promise;
			},
		}));
		const letGo = () => {
			held = false;
			release.resolve();
		};
		cleanups.push(
			() => auth.close(),
			() => session.dispose(),
			letGo,
		);
		return { server, session, request, reached, letGo };
	}

	const starts: Array<[string, (session: AgentSession, request: () => Promise<unknown>) => Promise<unknown>]> = [
		["an extension hook the session fires (`user_bash`)", session => session.executeBash("printf 1")],
		[
			"a deferred extension load",
			(session, request) => {
				session.setDeferredExtensionLoader(async () => {
					await request();
				});
				return session.loadDeferredExtensions();
			},
		],
	];
	for (const [path_, start] of starts) {
		it(`holds the model request of ${path_}, started from outside session work`, async () => {
			const temp = tempDir("@gate-hook-");
			const { server, session, request, reached, letGo } = await heldSession(temp);
			const run = start(session, request);
			// The request reached the session's hold, and nothing went out while it held.
			await reached.promise;
			await eventLoopTurns();
			expect(server.requests).toEqual([]);
			letGo();
			await run;
			expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		}, 60_000);
	}
});

describe("work a session left running, or started before it existed, waits for its holds", () => {
	it("holds a request a finished `session_moved` handler left behind, once a new hold is added", async () => {
		const temp = tempDir("@gate-left-behind-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const later = Promise.withResolvers<void>();
		// Wrapped: resolving with the request itself would wait for it.
		const started = Promise.withResolvers<{ work: Promise<unknown> }>();
		const parts = await movableSession(temp, () => {
			// Work the handler schedules for after it is done.
			void later.promise.then(() =>
				started.resolve({
					work: completeSimple(
						server.model,
						{ messages: [{ role: "user", content: "later", timestamp: 0 }] },
						{ apiKey: "k" },
					),
				}),
			);
		});
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: parts.manager,
			modelRegistry: parts.registry,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			extensionRunner: parts.runner,
		});
		cleanups.push(
			() => parts.auth.close(),
			() => session.dispose(),
		);
		parts.manager.appendCustomEntry("move", {});
		await parts.moved.promise;
		parts.finish.resolve();
		await eventLoopTurns();
		// The handler is done; a new hold arrives, then the work it left runs.
		const release = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let held = true;
		agent.addHold(() => ({
			pending: () => {
				if (!held) return undefined;
				reached.resolve();
				return release.promise;
			},
		}));
		later.resolve();
		const { work } = await started.promise;
		// The request asked the new hold, and nothing went out while it held.
		await reached.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		held = false;
		release.resolve();
		await work;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	}, 60_000);

	it("refuses a second live session on an extension runner another live session owns", async () => {
		const temp = tempDir("@gate-shared-runner-");
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		const registry = new ModelRegistry(auth);
		const manager = SessionManager.inMemory(temp.path());
		const runner = new ExtensionRunner([], new ExtensionRuntime(), temp.path(), manager, registry);
		const mock = createMockModel({ responses: [] });
		const build = () =>
			new AgentSession({
				agent: new Agent({ initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] } }),
				sessionManager: manager,
				modelRegistry: registry,
				settings: Settings.isolated({
					"advisor.enabled": false,
					"compaction.enabled": false,
					"todo.enabled": false,
				}),
				extensionRunner: runner,
			});
		const first = build();
		expect(build).toThrow("This extension runner already belongs to another live session");
		await first.dispose();
		// Once the first is disposed, the runner can move on.
		const second = build();
		await second.dispose();
	}, 60_000);

	it("holds a request an extension factory scheduled at start-up, before the session existed", async () => {
		const temp = tempDir("@gate-factory-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		const go = Promise.withResolvers<void>();
		let work: Promise<unknown> | undefined;
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			sessionManager: SessionManager.inMemory(temp.path()),
			model: server.model,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			disableExtensionDiscovery: true,
			extensions: [
				() => {
					work = go.promise.then(() =>
						completeSimple(
							server.model,
							{ messages: [{ role: "user", content: "factory", timestamp: 0 }] },
							{ apiKey: "k" },
						),
					);
				},
			],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(() => session.dispose());
		const release = Promise.withResolvers<void>();
		let held = true;
		const reached = Promise.withResolvers<void>();
		session.agent.addHold(() => ({
			pending: () => {
				if (!held) return undefined;
				reached.resolve();
				return release.promise;
			},
		}));
		go.resolve();
		await reached.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		held = false;
		release.resolve();
		await work;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	}, 60_000);

	/** Options for a minimal real session on `server`'s model. */
	function minimalSessionOptions(temp: TempDir, auth: AuthStorage, model: Model): CreateAgentSessionOptions {
		return {
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			sessionManager: SessionManager.inMemory(temp.path()),
			model,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	for (const where of [
		"in its start-up holds, before the session",
		"in the host's extension-roots callback",
	] as const) {
		it(`holds a request that work a host prepared ${where} schedules`, async () => {
			const temp = tempDir("@gate-host-preload-");
			const server = localModelServer();
			cleanups.push(server.stop);
			const auth = await AuthStorage.create(":memory:");
			cleanups.push(() => auth.close());
			const go = Promise.withResolvers<void>();
			let work: Promise<unknown> | undefined;
			const schedule = () => {
				work = go.promise.then(() =>
					completeSimple(
						server.model,
						{ messages: [{ role: "user", content: "preloaded", timestamp: 0 }] },
						{ apiKey: "k" },
					),
				);
			};
			const options = minimalSessionOptions(temp, auth, server.model);
			if (where === "in its start-up holds, before the session") {
				// The host prepares session work (an extension preload, say) before it calls createAgentSession.
				const startupHolds = new RequestHoldsAlias();
				runWithRequestHolds(startupHolds, schedule);
				options.startupHolds = startupHolds;
			} else {
				// The first call is the one start-up makes before anything else.
				let calls = 0;
				options.extensionRoots = () => {
					if (calls++ === 0) schedule();
					return { explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" };
				};
			}
			const { session } = await createAgentSession(options);
			cleanups.push(() => session.dispose());
			const release = Promise.withResolvers<void>();
			let held = true;
			const reached = Promise.withResolvers<void>();
			session.agent.addHold(() => ({
				pending: () => {
					if (!held) return undefined;
					reached.resolve();
					return release.promise;
				},
			}));
			go.resolve();
			await reached.promise;
			await eventLoopTurns();
			expect(server.requests).toEqual([]);
			held = false;
			release.resolve();
			await work;
			expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		}, 60_000);
	}

	it("refuses start-up holds a start-up still running was given", async () => {
		const temp = tempDir("@gate-startup-overlap-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		const startupHolds = new RequestHoldsAlias();
		const first = createAgentSession({ ...minimalSessionOptions(temp, auth, server.model), startupHolds });
		const second = createAgentSession({ ...minimalSessionOptions(temp, auth, server.model), startupHolds });
		await expect(second).rejects.toThrow("These start-up holds already belong to another live session");
		await (await first).session.dispose();
	}, 60_000);

	it("holds a request a host callback starts while the session is being built", async () => {
		const temp = tempDir("@gate-constructor-callback-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "k",
		});
		const release = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let held = true;
		agent.addHold(() => ({
			pending: () => {
				if (!held) return undefined;
				reached.resolve();
				return release.promise;
			},
		}));
		let work: Promise<unknown> | undefined;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			// Called while the session is constructed, outside any session work.
			getEvalPreludes: () => {
				work ??= completeSimple(
					server.model,
					{ messages: [{ role: "user", content: "from a callback", timestamp: 0 }] },
					{ apiKey: "k" },
				);
				return [];
			},
		});
		cleanups.push(() => session.dispose());
		expect(work).toBeDefined();
		// The callback's request asked the session's hold, and nothing went out while it held.
		await reached.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		held = false;
		release.resolve();
		await work;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	}, 60_000);

	it("refuses start-up holds another live session was built with, and accepts them once it is disposed", async () => {
		const temp = tempDir("@gate-startup-owner-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		const startupHolds = new RequestHoldsAlias();
		const first = await createAgentSession({ ...minimalSessionOptions(temp, auth, server.model), startupHolds });
		await expect(
			createAgentSession({ ...minimalSessionOptions(temp, auth, server.model), startupHolds }),
		).rejects.toThrow("These start-up holds already belong to another live session");
		await first.session.dispose();
		const second = await createAgentSession({ ...minimalSessionOptions(temp, auth, server.model), startupHolds });
		await second.session.dispose();
	}, 60_000);

	it("holds a cold-revived subagent by its live parent's holds, whoever revives it", async () => {
		AgentRegistry.resetGlobalForTests();
		cleanups.push(() => AgentRegistry.resetGlobalForTests());
		const temp = tempDir("@gate-revive-");
		const server = localModelServer();
		cleanups.push(server.stop);
		const auth = await AuthStorage.create(":memory:");
		cleanups.push(() => auth.close());
		auth.keys.setRuntime("openai", "k");
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
		registry.registerProvider("openai", {
			baseUrl: server.model.baseUrl,
			apiKey: "k",
			api: "openai-completions",
			models: [
				{
					id: "local",
					name: "local",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16_000,
					maxTokens: 1024,
				},
			],
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			modelRoles: { default: "openai/local" },
		});
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["parent"], messages: [], tools: [] },
			getApiKey: () => "k",
		});
		const parent = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: registry,
			settings,
		});
		cleanups.push(() => parent.dispose());
		const seed = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		seed.appendSessionInit({
			systemPrompt: ["child"],
			task: "revive",
			tools: [],
			restrictToolNames: true,
			resolvedModel: "openai/local",
		});
		seed.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		await seed.ensureOnDisk();
		await seed.flush();
		const file = seed.getSessionFile();
		if (!file) throw new Error("Expected a persisted subagent transcript");
		await seed.close();
		const ref = AgentRegistry.global().register({
			id: "ReviveChild",
			displayName: "ReviveChild",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: file,
			status: "parked",
		});
		const revive = await createPersistedSubagentReviverFactory({
			session: parent,
			authStorage: auth,
			modelRegistry: registry,
			settings,
			enableLsp: false,
		})(ref);
		if (!revive) throw new Error("Expected a reviver");
		// Revived from outside any of the parent's work.
		const child = await revive(ref);
		cleanups.push(() => child.dispose());
		const release = Promise.withResolvers<void>();
		let held = true;
		const reached = Promise.withResolvers<void>();
		agent.addHold(() => ({
			pending: () => {
				if (!held) return undefined;
				reached.resolve();
				return release.promise;
			},
		}));
		const run = child.prompt("revived work");
		await reached.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		held = false;
		release.resolve();
		await run;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	}, 60_000);
});
