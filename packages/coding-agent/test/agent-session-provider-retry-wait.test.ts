/**
 * Contract: a provider-INTERNAL retry backoff (pi-ai sleeping between its own
 * stream attempts) surfaces on the session built by `createAgentSession` as
 * `provider_retry_wait_start` / `provider_retry_wait_end`.
 *
 * Before this wiring those sleeps were silent: `StreamOptions.providerRetryWait`
 * was never supplied outside packages/ai, so the session only learned about a
 * provider problem after pi-ai had exhausted its own retries and the
 * session-level saga emitted `auto_retry_start`. A multi-second — or, with a
 * `retry-after` header, multi-minute — wait looked like a frozen turn.
 *
 * This drives the REAL SDK stream function (`session.agent.streamFn`, the
 * settings-aware wrapper createAgentSession installs), so it fails if sdk.ts
 * stops passing its observer. The wait is not a turn supersession, so
 * `auto_retry_start` must stay silent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/** Minimal well-formed Anthropic SSE turn; shape copied from packages/ai/test/anthropic-stream-timeout.test.ts. */
function anthropicSseResponse(text: string): Response {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_retry_wait",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "request-id": "req_retry_wait" },
	});
}

describe("createAgentSession provider retry wait visibility", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-provider-retry-wait-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	/** A real session with the wrapper chain sdk.ts installs, observer included. */
	async function bootSession(model: Model<Api>): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	}

	/** Drives the SDK stream fn against `fetchMock`, keeping only the events under test. */
	async function runTurn(
		session: AgentSession,
		model: Model<Api>,
		fetchMock: FetchImpl,
	): Promise<{ stopReason: string; seen: AgentSessionEvent[] }> {
		const seen: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type.startsWith("provider_retry_wait") || event.type === "auto_retry_start") seen.push(event);
		});
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [],
			systemPrompt: [],
		};
		try {
			// The SDK wrapper chain (provider concurrency) is async, so the stream
			// itself arrives through a promise.
			const stream = await session.agent.streamFn(model, context, { apiKey: "sk-ant-test", fetch: fetchMock });
			const message = await stream.result();
			return { stopReason: message.stopReason, seen };
		} finally {
			unsubscribe();
		}
	}

	/** Asserts exactly one wait was reported, and that it was not a turn supersession. */
	function expectSingleReportedWait(seen: AgentSessionEvent[], model: Model<Api>): void {
		expect(seen).toHaveLength(2);
		const [start, end] = seen;
		expect(start).toMatchObject({
			type: "provider_retry_wait_start",
			model: model.id,
			provider: model.provider,
			api: model.api,
			// Driven through `session.agent.streamFn`: the main-turn role, and the
			// session's first wait id.
			role: "main",
			waitId: 1,
		});
		expect((start as Extract<AgentSessionEvent, { type: "provider_retry_wait_start" }>).delayMs).toBeGreaterThan(0);
		// The end echoes the start's correlation id so concurrent waits pair up.
		expect(end).toEqual({ type: "provider_retry_wait_end", aborted: false, waitId: 1 });
	}

	it("reports the provider's own stream-retry backoff as session events, with no auto-retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const session = await bootSession(model);

		// The stream-retry backoff goes through `scheduler.wait`, so the whole
		// saga settles instantly.
		mockSchedulerWaitWithClock();

		// First attempt: a 200 SSE body that ends before `message_start`. That is
		// exactly the pre-content envelope failure pi-ai classifies as
		// provider-retryable, so the anthropic stream loop backs off through
		// `providerRetryWait` and re-issues the request.
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return new Response('event: ping\ndata: {"type":"ping"}\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream", "request-id": "req_truncated" },
				});
			}
			return anthropicSseResponse("hi");
		};

		const { stopReason, seen } = await runTurn(session, model, fetchMock);
		// The retry recovered: the caller sees the second attempt's real turn.
		expect(stopReason).toBe("stop");
		expect(fetchCalls).toBe(2);
		expectSingleReportedWait(seen, model);
	});

	it("reports the HTTP client's own 529 backoff too", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const session = await bootSession(model);

		mockSchedulerWaitWithClock();

		// A 529 overloaded response is the most common real backoff, and it is
		// retried by `AnthropicMessagesClient`'s own budget — a layer below the
		// stream loop. Without the hook down there this burns silent sleeps.
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
					status: 529,
					headers: { "content-type": "application/json", "request-id": "req_overloaded" },
				});
			}
			return anthropicSseResponse("hi");
		};

		const { stopReason, seen } = await runTurn(session, model, fetchMock);
		expect(stopReason).toBe("stop");
		expect(fetchCalls).toBe(2);
		expectSingleReportedWait(seen, model);
	});

	it("keeps an auto-learn capture retry wait out of an active main turn", async () => {
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected bundled Anthropic test model to exist");
		// The capture agent builds its own provider request, so this case cannot
		// hand the stream a `fetch` the way `runTurn` does. On the bundled https
		// endpoint that request takes Anthropic's default transport, `coworkFetch`
		// over `node:https`, which a `globalThis.fetch` spy never sees: the capture
		// dials api.anthropic.com for real, 401s on the test key, and the 529 below
		// never happens. A plain-http loopback endpoint takes coworkFetch's
		// non-https bypass onto the global fetch (pinned by
		// packages/ai/test/cowork-fetch-proxy.test.ts), so the spy answers every
		// capture request and nothing leaves the machine.
		const captureBaseUrl = "http://127.0.0.1:9";
		const model: Model<Api> = { ...bundledModel, baseUrl: captureBaseUrl };
		let signalCaptureFetch!: () => void;
		const captureFetchStarted = new Promise<void>(resolve => (signalCaptureFetch = resolve));
		let releaseCaptureFetch!: () => void;
		const captureFetchReleased = new Promise<void>(resolve => (releaseCaptureFetch = resolve));
		const captureRequestUrls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				captureRequestUrls.push(input instanceof Request ? input.url : String(input));
				if (captureRequestUrls.length === 1) {
					signalCaptureFetch();
					await captureFetchReleased;
					return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
						status: 529,
						headers: { "content-type": "application/json", "request-id": "req_capture_overloaded" },
					});
				}
				return anthropicSseResponse("capture complete");
			}),
		);
		mockSchedulerWaitWithClock();

		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		let regressionSession: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({
					"autolearn.enabled": true,
					"autolearn.autoContinue": true,
					"autolearn.minToolCalls": 0,
					"compaction.enabled": false,
				}),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			const session = result.session;
			regressionSession = session;
			sessions.push(session);

			let mainCalls = 0;
			let releaseMain!: () => void;
			const mainReleased = new Promise<void>(resolve => (releaseMain = resolve));
			let signalSecondMainStream!: () => void;
			const secondMainStreamStarted = new Promise<void>(resolve => (signalSecondMainStream = resolve));
			session.agent.streamFn = () => {
				const call = ++mainCalls;
				if (call === 2) signalSecondMainStream();
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: `main ${call}` }],
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
				queueMicrotask(async () => {
					stream.push({ type: "start", partial: message });
					if (call === 2) await mainReleased;
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			};

			let signalFirstAgentEnd!: () => void;
			const firstAgentEnded = new Promise<void>(resolve => (signalFirstAgentEnd = resolve));
			const starts: Extract<AgentSessionEvent, { type: "provider_retry_wait_start" }>[] = [];
			let signalWait!: () => void;
			const waitObserved = new Promise<void>(resolve => (signalWait = resolve));
			session.subscribe(event => {
				if (event.type === "agent_end") signalFirstAgentEnd();
				if (event.type !== "provider_retry_wait_start") return;
				starts.push(event);
				signalWait();
			});

			await session.prompt("finish the first turn");
			await firstAgentEnded;
			await captureFetchStarted;
			const activeMain = session.prompt("keep the next real turn active");
			// Gate on the held second main stream, not a microtask poll of
			// `isStreaming`: the prompt reaches streaming only after a macrotask, so
			// a `Promise.resolve()` loop starves the event loop and hangs the whole
			// run past the per-test timeout.
			await secondMainStreamStarted;
			releaseCaptureFetch();
			try {
				await waitObserved;

				expect(session.agent.state.isStreaming).toBe(true);
				// The 529 came from the capture agent's own provider request.
				expect(captureRequestUrls[0]).toBe(`${captureBaseUrl}/v1/messages`);
				expect(starts).toHaveLength(1);
				expect(starts[0]).toMatchObject({ type: "provider_retry_wait_start", role: "side", waitId: 1 });
			} finally {
				releaseMain();
				await activeMain;
			}
		} finally {
			releaseCaptureFetch();
			await regressionSession?.dispose();
			authStorage.keys.removeRuntime("anthropic");
		}
	});
});
