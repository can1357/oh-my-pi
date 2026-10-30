import { afterEach, describe, expect, test, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import * as connectionPrewarm from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import { prewarmOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import * as requestDebug from "@oh-my-pi/pi-ai/utils/request-debug";
import { resetDispatchOriginsForTesting, transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { codexPrewarmHold, prewarmUnlessPaused } from "@oh-my-pi/pi-coding-agent/session/connection-prewarm";
import { pauseHeldFetch } from "@oh-my-pi/pi-coding-agent/tools/pause-held-fetch";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	agentPauseGate.resume();
	globalThis.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
	connectionPrewarm.resetConnectionPrewarmForTesting();
	resetDispatchOriginsForTesting();
});

function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

async function untilSentOrIdle(sent: readonly unknown[], turns = 50): Promise<void> {
	for (let i = 0; i < turns && sent.length === 0; i++) await tick();
}

// Speech synthesis and image generation take a `fetch` but no
// `beforeDispatch`, so the `tts` and `generate_image` tools sent their
// requests while `/pause` was engaged.
describe("pauseHeldFetch", () => {
	test("holds a request until resume", async () => {
		const sent: boolean[] = [];
		const fetch = pauseHeldFetch(async () => {
			sent.push(agentPauseGate.paused);
			return new Response("ok");
		});

		agentPauseGate.pause();
		const pending = fetch("https://speech.example.test/v1/audio/speech", { method: "POST" });
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		expect(await (await pending).text()).toBe("ok");
		expect(sent).toEqual([false]);
	});

	test("a request's own abort ends the hold without sending", async () => {
		const sent: boolean[] = [];
		const fetch = pauseHeldFetch(async () => {
			sent.push(agentPauseGate.paused);
			return new Response("ok");
		});
		const abort = new AbortController();

		agentPauseGate.pause();
		const pending = fetch("https://speech.example.test/v1/audio/speech", { signal: abort.signal });
		await tick();
		abort.abort(new Error("tool cancelled"));
		await expect(pending).rejects.toThrow("tool cancelled");
		expect(sent).toEqual([]);
	});
});

// The session prewarmed its model connection — an HTTP `HEAD` and, for Codex,
// an authenticated websocket — while `/pause` was engaged.
describe("session prewarm under /pause", () => {
	test("the HTTP prewarm is skipped while paused", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const prewarm = vi.spyOn(connectionPrewarm, "prewarmModelConnection").mockResolvedValue(undefined);

		agentPauseGate.pause();
		prewarmUnlessPaused(model);
		expect(prewarm).not.toHaveBeenCalled();

		agentPauseGate.resume();
		prewarmUnlessPaused(model);
		expect(prewarm).toHaveBeenCalledTimes(1);
	});

	test("an HTTP prewarm paused while its request is prepared never reaches the wire", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled openai/gpt-4o-mini");
		// A warm-up goes only to an origin a real request has reached.
		await transportFetch(model, async () => new Response("{}"))("https://api.openai.com/v1/responses", {
			method: "POST",
		});
		const sent: Array<{ method: string | undefined; paused: boolean }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					sent.push({ method: init?.method, paused: agentPauseGate.paused });
					return new Response(null, { status: 204 });
				},
				{ preconnect() {} },
			),
		);
		const preparing = Promise.withResolvers<void>();
		const prepared = Promise.withResolvers<void>();
		vi.spyOn(requestDebug, "isRequestDebugEnabled").mockReturnValue(true);
		vi.spyOn(requestDebug, "createFetchRequestDebugSession").mockImplementation(async () => {
			preparing.resolve();
			await prepared.promise;
			return {
				id: 1,
				requestPath: "unused",
				responsePath: "unused",
				openResponseLog: async () => ({ write() {}, async close() {} }),
				wrapResponse: async (response: Response) => response,
			};
		});
		const prewarm = vi.spyOn(connectionPrewarm, "prewarmModelConnection");

		prewarmUnlessPaused(model);
		// The `PI_REQ_DEBUG` dump awaits the filesystem: `/pause` lands there,
		// after the entry check has passed.
		await preparing.promise;
		agentPauseGate.pause();
		prepared.resolve();
		await prewarm.mock.results[0]?.value;
		expect(sent).toEqual([]);

		// The abandoned warm-up holds no throttle slot, so the first one after
		// resume goes out.
		agentPauseGate.resume();
		prewarmUnlessPaused(model);
		await prewarm.mock.results[1]?.value;
		expect(sent).toEqual([{ method: "HEAD", paused: false }]);
	});

	test("a Codex prewarm paused after it began opens no socket", async () => {
		const sockets: boolean[] = [];
		class FakeWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 3;
			readyState = 0;
			onopen?: (event: Event) => void;
			onmessage?: (event: MessageEvent) => void;
			onclose?: (event: CloseEvent) => void;
			onerror?: (event: Event) => void;
			constructor() {
				sockets.push(agentPauseGate.paused);
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			close() {
				this.readyState = 3;
			}
			send() {}
		}
		// The fixture implements only the socket operations a prewarm uses.
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const codex = buildModel({
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-codex-responses",
			provider: "codex-proxy",
			baseUrl: "http://127.0.0.1:2455/backend-api/codex",
			preferWebsockets: true,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		const states = new Map<string, ProviderSessionState>();

		const pending = prewarmOpenAICodexResponses(codex, {
			apiKey: "fake",
			sessionId: "prewarm-pause",
			providerSessionState: states,
			beforeDispatch: codexPrewarmHold,
		});
		// The prewarm awaits its attestation before it connects: `/pause` lands there.
		agentPauseGate.pause();
		await pending.catch(() => undefined);
		for (const state of states.values()) state.close?.();
		expect(sockets).toEqual([]);
	});
});
