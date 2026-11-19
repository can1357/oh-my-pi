import { afterEach, describe, expect, it, vi } from "bun:test";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

/**
 * Minimal callback flow we can drive without a real authorization server.
 * `generateAuthUrl` is never expected to run in the strict-port tests —
 * `#startCallbackServer` must throw before `login()` can reach it — so a stray
 * invocation surfaces as a counter bump the test asserts on.
 */
class TestCallbackFlow extends OAuthCallbackFlow {
	authUrlCalls = 0;
	lastRedirectUri?: string;

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string }> {
		this.authUrlCalls += 1;
		this.lastRedirectUri = redirectUri;
		return { url: `${redirectUri}?started=1` };
	}

	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

/**
 * Bind a real loopback port so the next `Bun.serve({ port })` against the
 * same port fails with EADDRINUSE. Occupies `127.0.0.1` explicitly — the
 * interface callback flows bind for `localhost` — because macOS lets a
 * specific-address bind coexist with a wildcard one. Returns the bound port
 * plus a `release` callback for teardown.
 */
function occupyLoopbackPort(): { port: number; release: () => void } {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("blocker") });
	const port = server.port;
	if (typeof port !== "number") {
		server.stop(true);
		throw new Error("Bun.serve({ port: 0 }) did not assign a numeric port");
	}
	return { port, release: () => server.stop(true) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow port fallback policy", () => {
	it("falls back to a random port by default so historical AI-provider flows keep working", async () => {
		const blocker = occupyLoopbackPort();
		const progress: string[] = [];
		const controller = new AbortController();
		const flow = new TestCallbackFlow(
			{
				onAuth: () => controller.abort(new Error("redirect URI observed")),
				onProgress: msg => progress.push(msg),
				signal: controller.signal,
			},
			{ preferredPort: blocker.port },
		);

		try {
			await expect(flow.login()).rejects.toThrow(); // aborted while waiting for the browser callback
			const fallbackNotice = progress.find(msg => msg.startsWith(`Preferred port ${blocker.port} unavailable`));
			expect(fallbackNotice).toBeDefined();
			// Notice carries a different (random) port, never the blocked one.
			expect(fallbackNotice).not.toContain(`using port ${blocker.port}`);
			// generateAuthUrl ran with the random-port redirect URI — that's the
			// silent fallback behavior that MCP flows now opt out of.
			expect(flow.authUrlCalls).toBe(1);
			expect(flow.lastRedirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
			expect(flow.lastRedirectUri).not.toContain(`:${blocker.port}/`);
		} finally {
			blocker.release();
		}
	});

	it("throws a ConfigurationError when allowPortFallback is false", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("EADDRINUSE");
		});

		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				signal: AbortSignal.timeout(1_000),
			},
			{ preferredPort: 14581, allowPortFallback: false },
		);

		await expect(flow.login()).rejects.toThrow(ConfigurationError);
		await expect(flow.login()).rejects.toThrow(
			/OAuth callback port 14581 is in use\. The OAuth provider validates redirect URIs/,
		);
		// Fallback to port 0 must never be attempted: every serve call uses the preferred port.
		const portArgs = serveSpy.mock.calls.map(([opts]) => opts.port);
		expect(portArgs.every(port => port === 14581)).toBe(true);
		// generateAuthUrl never runs: the error fires before login() opens the browser.
		expect(flow.authUrlCalls).toBe(0);
	});

	it("preserves redirectUri-strict behavior with the updated error message", async () => {
		vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("EADDRINUSE");
		});

		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				signal: AbortSignal.timeout(1_000),
			},
			{
				preferredPort: 14582,
				redirectUri: "http://localhost:14582/callback",
			},
		);

		// redirectUri takes precedence over allowPortFallback in the error
		// message so users learn exactly which configuration knob is forcing
		// the strict port match.
		await expect(flow.login()).rejects.toThrow(
			/oauth\.redirectUri \(http:\/\/localhost:14582\/callback\) requires this exact port/,
		);
	});
});
