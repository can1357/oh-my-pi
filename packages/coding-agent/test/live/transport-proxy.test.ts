/**
 * The live call's signaling request goes through the provider proxy configured for `openai-codex`
 * (`PI_PROXY_OPENAI_CODEX`, else `PI_PROXY`), as every other Codex request does. The request is
 * built directly on `fetch` so its cancellation is visible where it is sent; this pins that the
 * proxy still reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { CodexLiveTransport } from "@oh-my-pi/pi-coding-agent/live/transport";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PROXY = "http://proxy.test:8080";

describe("live signaling proxy", () => {
	let authStorage: AuthStorage;
	/** The `proxy` each signaling request was sent with. */
	let proxies: Array<string | undefined>;

	beforeEach(async () => {
		proxies = [];
		__resetProxyCache();
		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set("openai-codex", [
			{ type: "oauth", access: "live-access", refresh: "live-refresh", expires: Date.now() + 3_600_000 },
		]);
		// Answer without a call id: the transport stops after signaling, before any sideband socket.
		vi.spyOn(globalThis, "fetch").mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
			proxies.push((init as { proxy?: string } | undefined)?.proxy);
			return new Response("v=0 answer");
		}) as typeof fetch);
	});

	afterEach(() => {
		delete Bun.env.PI_PROXY_OPENAI_CODEX;
		__resetProxyCache();
		vi.restoreAllMocks();
		authStorage.close();
	});

	async function signal(): Promise<void> {
		const transport = new CodexLiveTransport({
			authStorage,
			sessionId: "session-a",
			instructions: "Instructions.",
			voice: "sol",
			sdpOffer: "v=0 offer",
			signal: new AbortController().signal,
			callbacks: { onEvent() {}, onOutputLevel() {} },
		});
		await expect(transport.connect()).rejects.toThrow("no valid call ID");
	}

	it("sends signaling through the provider's proxy", async () => {
		Bun.env.PI_PROXY_OPENAI_CODEX = PROXY;

		await signal();

		expect(proxies).toEqual([PROXY]);
	});

	it("sends signaling directly when no proxy is configured", async () => {
		await signal();

		expect(proxies).toEqual([undefined]);
	});
});
