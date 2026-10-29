/**
 * Counts the requests that actually reach the wire when a connection dies,
 * driving the real provider loops under a real `AgentSession` against a local
 * TCP server — `anthropic-messages`, whose client retries ten times of its
 * own, and the fetch route (`openai-completions`), where `fetchWithRetry`
 * replays six times and the pre-output retry runs that cycle twice.
 *
 * The session-level retry tests script a mock stream, so they see one request
 * per turn attempt and cannot see the provider's own retry budget at all. That
 * blind spot is exactly what let a change multiply whole provider loops: the
 * Anthropic provider retries up to ten times on its own while nothing has
 * streamed, so a chain hold that fires on a contentless failure runs those ten
 * again. These tests pin the request counts on both sides of that line.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/** How the stub answers one request. */
type WireScript = "cutBeforeHeaders" | "cutAfterReasoning" | "ok";

function resolveKey(apiKey: ApiKey | undefined): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	const bearer =
		typeof resolved === "string" ? resolved : resolved && "apiKey" in resolved ? resolved.apiKey : undefined;
	if (typeof bearer !== "string") throw new Error("expected a resolved bearer token");
	return bearer;
}

function sse(event: Record<string, unknown>): string {
	return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function chunk(text: string): string {
	return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}

const MESSAGE_START = sse({
	type: "message_start",
	message: {
		id: "msg_wire",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-5",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 1 },
	},
});

const REASONING = [
	sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial plan" } }),
].join("");

const COMPLETE_TURN = [
	MESSAGE_START,
	sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered on primary" } }),
	sse({ type: "content_block_stop", index: 0 }),
	sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
	sse({ type: "message_stop" }),
].join("");

interface Conn {
	answered: boolean;
	buf: string;
}

function startWireStub(script: (requestIndex: number) => WireScript): {
	port: number;
	requests: () => number;
	stop: () => void;
} {
	let requests = 0;
	const server = Bun.listen<Conn>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { answered: false, buf: "" };
			},
			data(socket, data) {
				if (socket.data.answered) return;
				socket.data.buf += data.toString("utf8");
				const headerEnd = socket.data.buf.indexOf("\r\n\r\n");
				if (headerEnd < 0) return;
				const lengthMatch = /content-length:\s*(\d+)/i.exec(socket.data.buf.slice(0, headerEnd));
				const body = socket.data.buf.slice(headerEnd + 4);
				if (lengthMatch && Buffer.byteLength(body) < Number(lengthMatch[1])) return;
				socket.data.answered = true;
				const mode = script(requests++);
				if (mode === "cutBeforeHeaders") {
					socket.terminate();
					return;
				}
				if (mode === "ok") {
					socket.write(
						`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: ${Buffer.byteLength(COMPLETE_TURN)}\r\nconnection: close\r\n\r\n${COMPLETE_TURN}`,
					);
					socket.flush();
					socket.end();
					return;
				}
				socket.write(
					`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n${chunk(MESSAGE_START)}${chunk(REASONING)}`,
				);
				socket.flush();
				// Real delay on purpose: the cut has to reach the client *after* the
				// partial body, and only the kernel's own flush orders those two.
				setTimeout(() => socket.terminate(), 20);
			},
		},
	});
	return { port: server.port, requests: () => requests, stop: () => server.stop(true) };
}

describe("wire retries reaching the provider", () => {
	let fixtureDir: TempDir;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-wire-retry-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});
	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-wire-retry-");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});
	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	/**
	 * Runs one prompt on a real Anthropic stream pointed at the stub, with a
	 * mocked fallback model so the chain hop is observable without a second
	 * wire. Returns how many requests reached the stub before the fallback.
	 */
	async function run(script: (requestIndex: number) => WireScript): Promise<{
		requestsBeforeFallback: number | undefined;
		totalWireRequests: number;
		requestedModels: string[];
	}> {
		const stub = startWireStub(script);
		cleanups.push(() => stub.stop());
		// The catalog getter returns the wide union; this row's api is anthropic-messages.
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		let requestsBeforeFallback: number | undefined;
		const fallbackMock = createMockModel({
			responses: [{ content: ["recovered on fallback"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === "anthropic") {
					return streamAnthropic({ ...primaryModel, baseUrl: `http://127.0.0.1:${stub.port}` }, context, {
						...options,
						apiKey: resolveKey(options?.apiKey),
					});
				}
				requestsBeforeFallback ??= stub.requests();
				return fallbackMock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 10,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallback] },
		});
		settings.setModelRole("default", primary);
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanups.push(() => sessionManager.close());
		cleanups.push(() => session.dispose());
		mockSchedulerWaitWithClock();

		await session.prompt("count the wire requests");
		await session.waitForIdle();
		return { requestsBeforeFallback, totalWireRequests: stub.requests(), requestedModels };
	}

	it("does not re-run the provider's own retry budget for a reset before headers", async () => {
		// Nothing streams, so the provider loop owns the replay: eleven requests,
		// its ten retries plus the first. Turn recovery must then go to the chain
		// rather than hold, or those eleven happen again, and again.
		const { requestsBeforeFallback, requestedModels } = await run(() => "cutBeforeHeaders");

		expect(requestsBeforeFallback).toBe(11);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"]);
	}, 60_000);

	it("holds the chain for a cut after reasoning streamed, and only for two retries", async () => {
		// Reasoning streamed, so the provider loop declines to retry and the
		// request reaches turn recovery having been made once. Three requests on
		// the model in all, then the chain.
		const { requestsBeforeFallback, requestedModels } = await run(() => "cutAfterReasoning");

		expect(requestsBeforeFallback).toBe(3);
		expect(requestedModels).toEqual([
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5.5",
		]);
	}, 60_000);

	it("recovers on the same model when a held retry succeeds", async () => {
		const { totalWireRequests, requestedModels } = await run(index => (index === 0 ? "cutAfterReasoning" : "ok"));

		expect(totalWireRequests).toBe(2);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"]);
	}, 60_000);

	/**
	 * The same question on the fetch route. A reset before headers is replayed
	 * by `fetchWithRetry` (six attempts) and that whole cycle again by the
	 * pre-output provider retry, whatever the diagnostic says — the layer reads
	 * no text. A hold on top of those twelve would make it thirty-six.
	 */
	async function runFetchRoute(): Promise<{ requestsBeforeFallback: number | undefined; requestedModels: string[] }> {
		const stub = startWireStub(() => "cutBeforeHeaders");
		cleanups.push(() => stub.stop());
		// Its own credential store and registry: the runs above spend anthropic
		// and openai credentials on a dead wire, and a provider those runs left
		// cooling down would never be offered as this run's chain candidate.
		const routeStorage = await AuthStorage.create(path.join(tempDir.path(), "fetch-route-auth.db"));
		cleanups.push(() => routeStorage.close());
		const routeRegistry = new ModelRegistry(routeStorage, path.join(tempDir.path(), "fetch-route-models.yml"));
		const bundled = getBundledModel("openai", "gpt-4o") as Model;
		const primaryModel: Model<"openai-completions"> = {
			...bundled,
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${stub.port}/v1`,
		} as Model<"openai-completions">;
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		routeStorage.keys.setRuntime("openai", "openai-test-key");
		routeStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		let requestsBeforeFallback: number | undefined;
		const fallbackMock = createMockModel({
			responses: [{ content: ["recovered on fallback"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => routeRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === "openai") {
					return streamOpenAICompletions(primaryModel, context, {
						...options,
						apiKey: resolveKey(options?.apiKey),
					});
				}
				requestsBeforeFallback ??= stub.requests();
				return fallbackMock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 10,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallback] },
		});
		settings.setModelRole("default", primary);
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: routeRegistry });
		cleanups.push(() => sessionManager.close());
		cleanups.push(() => session.dispose());
		mockSchedulerWaitWithClock();

		await session.prompt("count the wire requests");
		await session.waitForIdle();
		return { requestsBeforeFallback, requestedModels };
	}

	it("does not re-run the fetch budget for a reset before headers", async () => {
		// Twelve: six `fetchWithRetry` attempts, the whole cycle again under the
		// pre-output provider retry, and then the chain. A hold here would make
		// it thirty-six.
		const { requestsBeforeFallback, requestedModels } = await runFetchRoute();

		expect(requestsBeforeFallback).toBe(12);
		expect(requestedModels).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
	}, 60_000);
});
