/**
 * A live voice call belongs to its controller and to the session it delegates to: the controller's
 * `stop()` and the session's disposal both end it. The transport used to receive no signal, so a
 * credential lookup that finished after `stop()` (or after the session was disposed) still sent the
 * authenticated signaling POST, and a sideband retry that was waiting out its backoff opened another
 * socket after the call had stopped.
 *
 * Counted at a local endpoint that stands in for both the signaling URL and the sideband socket. The
 * controller runs with a caller-owned SDP offer, so no microphone or native peer is involved. The
 * credential lookup resolves the real stored OAuth row, then holds its result while the call stops,
 * the way a slow token refresh that ignores cancellation would.
 *
 * The endpoint speaks HTTPS on `localhost`, and the sideband socket `wss`, as production's
 * `https://chatgpt.com` and `wss://api.openai.com` do. The fixture takes production's branches: the
 * transport sends signaling through `globalThis.fetch` with the `Headers` it builds itself, and opens
 * the sideband through `globalThis.WebSocket` with its own options, with no proxy. One property
 * differs from production and cannot match it: both URLs are fixed, so the global fetch and the
 * global `WebSocket` the transport calls are stand-ins that send to the local endpoint instead, with
 * the same init and options.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "../helpers/loopback-tls";

const SIGNALING_ORIGIN = "https://chatgpt.com";
const SIGNALING_PATH = "/backend-api/codex/realtime/calls";
const SIDEBAND_HOST = "api.openai.com";

interface Recorded {
	/** Whether the controller's `stop()` had been called when the request arrived. */
	stopped: boolean;
	/** Whether the session had begun disposing when the request arrived. */
	disposing: boolean;
}

describe("a live call's requests after it stops", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let controller: LiveSessionController;
	let stopCalled: boolean;
	/** Whether signaling answers with a call id, which makes the transport open the sideband socket. */
	let answerWithCallId: boolean;
	let signaling: Recorded[];
	let sidebandAttempts: Recorded[];
	let sidebandAttempted: PromiseWithResolvers<void>;
	let sidebandRetried: PromiseWithResolvers<void>;
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;
	const RealWebSocket = globalThis.WebSocket;

	trustLoopbackTls();

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-live-dispose-");
		stopCalled = false;
		answerWithCallId = false;
		signaling = [];
		sidebandAttempts = [];
		sidebandAttempted = Promise.withResolvers<void>();
		sidebandRetried = Promise.withResolvers<void>();
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				const url = new URL(request.url);
				const recorded = { stopped: stopCalled, disposing: session.isDisposed };
				if (url.pathname.startsWith("/v1/live/")) {
					// Refuse the socket: the transport waits out its backoff and tries again.
					sidebandAttempts.push(recorded);
					sidebandAttempted.resolve();
					if (sidebandAttempts.length > 1) sidebandRetried.resolve();
					return new Response("unavailable", { status: 503 });
				}
				await request.json();
				signaling.push(recorded);
				return new Response("v=0 answer", {
					headers: answerWithCallId ? { Location: "/v1/realtime/calls/rtc_test" } : {},
				});
			},
		});
		// Signaling goes to the fixed ChatGPT URL and the sideband to the fixed OpenAI host; deliver both locally.
		const origin = loopbackOrigin(server);
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin !== SIGNALING_ORIGIN || url.pathname !== SIGNALING_PATH) {
				throw new Error(`Unexpected request to ${url}`);
			}
			return realFetch(new URL(`${url.pathname}${url.search}`, origin), init);
		}) as typeof fetch);
		const local = new URL(origin);
		globalThis.WebSocket = class extends RealWebSocket {
			constructor(url: string | URL, options?: Bun.WebSocketOptions) {
				const target = new URL(String(url));
				if (target.host !== SIDEBAND_HOST) throw new Error(`Unexpected socket to ${target}`);
				super(`wss://${local.host}${target.pathname}`, options);
			}
		} as typeof WebSocket;

		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set("openai-codex", [
			{ type: "oauth", access: "live-access", refresh: "live-refresh", expires: Date.now() + 3_600_000 },
		]);
		const access = authStorage.oauth.access.bind(authStorage.oauth);
		vi.spyOn(authStorage.oauth, "access").mockImplementation(async (...args) => {
			const resolution = await access(...args);
			credentialReached.resolve();
			await releaseCredential.promise;
			return resolution;
		});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
		});
		controller = new LiveSessionController({
			session,
			sdpOffer: "v=0 offer",
			extractAssistantText: () => "",
			callbacks: { onPhase() {}, onLevels() {}, onTranscript() {}, onTerminal() {} },
		});
	});

	afterEach(async () => {
		releaseCredential.resolve();
		await controller.stop();
		await session.dispose();
		globalThis.WebSocket = RealWebSocket;
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function stopController(): Promise<void> {
		stopCalled = true;
		await controller.stop();
	}

	it("sends the signaling request while the call is live", async () => {
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		releaseCredential.resolve();
		await started;

		expect(signaling).toEqual([{ stopped: false, disposing: false }]);
	});

	it("sends no signaling request once the controller has stopped", async () => {
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		await stopController();
		await session.dispose();
		releaseCredential.resolve();
		await started;

		expect(signaling).toEqual([]);
	});

	it("sends no signaling request once its session is disposed", async () => {
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		await session.dispose();
		releaseCredential.resolve();
		await started;

		expect(signaling).toEqual([]);
	});

	it("retries the sideband socket while the call is live", async () => {
		answerWithCallId = true;
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		releaseCredential.resolve();
		await sidebandRetried.promise;

		expect(signaling).toHaveLength(1);
		expect(sidebandAttempts.slice(0, 2)).toEqual([
			{ stopped: false, disposing: false },
			{ stopped: false, disposing: false },
		]);
		await stopController();
		await started;
	}, 15_000);

	it("opens no sideband socket once the controller has stopped", async () => {
		answerWithCallId = true;
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		releaseCredential.resolve();
		await sidebandAttempted.promise;
		await stopController();
		// `start()` settles only when the transport's connect does, so every retry it would make has been made.
		await started;

		expect(signaling).toHaveLength(1);
		expect(sidebandAttempts.filter(attempt => attempt.stopped)).toEqual([]);
	}, 15_000);

	it("opens no sideband socket once its session is disposed", async () => {
		answerWithCallId = true;
		const started = controller.start().catch(() => undefined);
		await credentialReached.promise;
		releaseCredential.resolve();
		await sidebandAttempted.promise;
		await session.dispose();
		// `start()` settles only when the transport's connect does, so every retry it would make has been made.
		await started;

		expect(signaling).toHaveLength(1);
		expect(sidebandAttempts.filter(attempt => attempt.disposing)).toEqual([]);
	}, 15_000);
});
