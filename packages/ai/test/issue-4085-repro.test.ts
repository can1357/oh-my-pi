import { describe, expect, it, spyOn } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { POLL_MAX_ATTEMPTS, pollOperation } from "@oh-my-pi/pi-ai/registry/oauth/google-gemini-cli";
import { oauthFetch } from "@oh-my-pi/pi-ai/registry/oauth/google-oauth-shared";

/**
 * A loopback server whose handler never resolves — models a stalled Cloud Code
 * Assist endpoint (network change / proxy stall / API incident). `idleTimeout: 0`
 * keeps the request open instead of letting Bun close it, so the only escape is
 * the caller's own signal/timeout.
 */
function stallingServer() {
	return Bun.serve({ port: 0, idleTimeout: 0, fetch: () => Promise.withResolvers<Response>().promise });
}

describe("issue #4085 — Google OAuth provisioning honors cancel/timeout", () => {
	it("oauthFetch surfaces an already-cancelled signal as LoginCancelledError", async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error("user pressed ESC"));
		await expect(
			oauthFetch("http://127.0.0.1:1/never", {}, { provider: "google-gemini-cli", signal: ctrl.signal }),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("oauthFetch aborts an in-flight request when the signal fires mid-fetch", async () => {
		const server = stallingServer();
		try {
			const ctrl = new AbortController();
			const pending = oauthFetch(
				`http://127.0.0.1:${server.port}/`,
				{},
				{ provider: "google-gemini-cli", signal: ctrl.signal },
			);
			// Yield one microtask so oauthFetch reaches its awaited `fetch`, then
			// abort the in-flight request — no wall-clock timer. Without the signal
			// wired into fetch this would hang until the 30s default timeout and
			// blow the test deadline instead of rejecting fast.
			await Promise.resolve();
			ctrl.abort(new Error("cancelled"));
			await expect(pending).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		} finally {
			server.stop(true);
		}
	});

	it("oauthFetch surfaces a stalled endpoint as an OAuthError timeout", async () => {
		const server = stallingServer();
		try {
			const err = await oauthFetch(
				`http://127.0.0.1:${server.port}/`,
				{},
				{ provider: "google-gemini-cli", timeoutMs: 50 },
			).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AIError.OAuthError);
			expect((err as AIError.OAuthError).kind).toBe("timeout");
		} finally {
			server.stop(true);
		}
	});

	it("pollOperation is bounded: a never-done operation fails after POLL_MAX_ATTEMPTS", async () => {
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation((() => Promise.resolve()) as typeof Bun.sleep);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(JSON.stringify({ done: false }), { status: 200 })) as unknown as typeof globalThis.fetch,
		);
		try {
			const err = await pollOperation("operations/abc", {}, undefined).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AIError.OAuthError);
			expect((err as AIError.OAuthError).kind).toBe("timeout");
			expect(fetchSpy).toHaveBeenCalledTimes(POLL_MAX_ATTEMPTS);
		} finally {
			fetchSpy.mockRestore();
			sleepSpy.mockRestore();
		}
	});

	it("pollOperation aborts before polling when the signal is already cancelled", async () => {
		const fetchSpy = spyOn(globalThis, "fetch");
		try {
			const ctrl = new AbortController();
			ctrl.abort(new Error("cancelled"));
			await expect(pollOperation("operations/abc", {}, ctrl.signal)).rejects.toBeInstanceOf(
				AIError.LoginCancelledError,
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
