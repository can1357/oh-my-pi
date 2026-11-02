import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { captureRequestHolds, completeSimple, type Model } from "@oh-my-pi/pi-ai";
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

/** A session opened on a file another process owns, with a `session_moved` handler held until `finish`. */
async function movableSession(temp: TempDir) {
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
					return { result: { output: "intercepted", exitCode: 0, cancelled: false, truncated: false } };
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
