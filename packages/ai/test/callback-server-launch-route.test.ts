import { afterEach, describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";

/**
 * Regression harness for #4418 — the `/launch` route the callback server hosts
 * so UIs can advertise a short (~30-char) copy target that survives TUI viewport
 * truncation. Without it, the full authorize URL (~260+ chars on Linear/GitHub/…)
 * gets silently truncated mid-parameter and downgrades the flow to plain PKCE.
 */
class LaunchProbeFlow extends OAuthCallbackFlow {
	authUrls: string[] = [];
	// Long enough that a 270-col TUI would clip `code_challenge_method=S256`.
	static readonly PADDING = "x".repeat(200);

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url =
			"https://mcp.example.com/authorize?" +
			new URLSearchParams({
				response_type: "code",
				client_id: "test-client",
				redirect_uri: redirectUri,
				state,
				scope: LaunchProbeFlow.PADDING,
				code_challenge: "test-challenge",
				code_challenge_method: "S256",
			}).toString();
		this.authUrls.push(url);
		return { url };
	}

	async exchangeToken(): Promise<OAuthCredentials> {
		return { access: "unused", refresh: "unused", expires: Date.now() + 60_000 };
	}
}

/**
 * Start a flow and resolve once `onAuth` fires — that's the exact instant
 * `/launch` becomes live, so tests can hit it without a wall-clock sleep.
 * Returns the captured auth info, the abort controller (so tests can shut the
 * flow down), and the pending `login` promise (so tests can await teardown).
 */
async function startFlowAndWaitForAuth(): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<void>;
}> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new LaunchProbeFlow(
		{
			onAuth: info => {
				authFired.resolve(info);
			},
			signal: abort.signal,
		},
		{ preferredPort: 0, allowPortFallback: true },
	);
	// Kick off login in the background; tests own its lifetime via `abort`.
	const login = flow.login().catch(() => undefined) as Promise<void>;
	const info = await authFired.promise;
	return { info, abort, login };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow /launch route", () => {
	it("advertises a short launch URL and 302s it to the pending authorization URL", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();

		// Contract 1 — launch URL is short and shaped like a loopback URL. A
		// terminal that truncates below ~40 columns is degenerate; anything above
		// that keeps the launch URL intact regardless of the full URL length.
		expect(info.launchUrl).toBeDefined();
		expect(info.launchUrl!.length).toBeLessThan(40);
		expect(info.launchUrl).toMatch(/^http:\/\/localhost:\d+\/launch$/);

		// Contract 2 — GET /launch returns 302 pointing at the pending authorize URL,
		// byte-for-byte (the whole point: no truncation surface between UI and provider).
		const response = await fetch(info.launchUrl!, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(info.url);

		abort.abort("test done");
		await login;
	});

	it("stops answering /launch once the flow completes so no stale URL is redirected", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();
		expect(info.launchUrl).toBeDefined();

		abort.abort("test done");
		await login;

		// Server has stopped and `#pendingAuthUrl` was cleared — the correct
		// end-state is that the stale authorize URL is NEVER served again.
		// Usually the loopback socket is gone and `fetch` rejects, but a parallel
		// test may have reclaimed the freed ephemeral port, so tolerate any
		// answer that is not our stale redirect.
		const answer = await fetch(info.launchUrl!, { redirect: "manual" }).catch(() => null);
		expect(answer?.headers.get("location") ?? null).not.toBe(info.url);
	});

	it("routes `/callback` and `/launch` on the same server without interfering", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();
		expect(info.launchUrl).toBeDefined();

		// A GET at an unrelated path still 404s — `/launch` is additive, not a
		// blanket catch-all.
		const origin = new URL(info.launchUrl!).origin;
		const stray = await fetch(`${origin}/nope`);
		expect(stray.status).toBe(404);

		abort.abort("test done");
		await login;
	});

	it("shows manual-close guidance when the browser refuses to close the success tab", async () => {
		const { info, login } = await startFlowAndWaitForAuth();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
		const state = authUrl.searchParams.get("state") ?? "";

		const callbackResponse = await fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`);
		expect(callbackResponse.status).toBe(200);
		const html = await callbackResponse.text();
		await login;

		vi.useFakeTimers();
		const { document, window } = parseHTML(html);
		const closeWindow = vi.fn();
		Object.defineProperty(window, "close", { value: closeWindow, configurable: true });
		const pageScript = document.querySelector("script:not([type])");
		if (!pageScript?.textContent) throw new Error("OAuth callback page is missing its executable script");

		const context = vm.createContext({
			window,
			document,
			URLSearchParams,
			setTimeout,
			clearTimeout,
		});
		vm.runInContext(pageScript.textContent, context);

		expect(closeWindow).toHaveBeenCalledTimes(1);
		expect(document.querySelector(".btn")).not.toBeNull();
		expect(document.getElementById("message")?.textContent).toBe("You have successfully logged in.");

		vi.advanceTimersByTime(299);
		expect(document.querySelector(".btn")).not.toBeNull();
		vi.advanceTimersByTime(1);

		expect(document.querySelector(".btn")).toBeNull();
		expect(document.getElementById("message")?.textContent).toBe(
			"You have successfully logged in.Please close this tab manually.",
		);
	});

	it("suppresses launchUrl and routes /launch to the callback handler when callbackPath is /launch", async () => {
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new LaunchProbeFlow(
			{
				onAuth: info => {
					authFired.resolve(info);
				},
				signal: abort.signal,
			},
			// Caller pins the provider redirect at `/launch` — an OMP config
			// setting `oauth.callbackPath: "/launch"` or a matching
			// `oauth.redirectUri`. Callback resolution MUST win the route
			// collision, and no self-redirecting launchUrl should be advertised.
			{ preferredPort: 0, allowPortFallback: true, callbackPath: "/launch" },
		);
		const login = flow.login().catch(() => undefined) as Promise<void>;
		const info = await authFired.promise;

		// Contract — no launchUrl surfaced when it would collide.
		expect(info.launchUrl).toBeUndefined();

		// Contract — a provider redirect to `/launch?code=…&state=…` resolves the
		// real callback rather than self-redirecting to the authorize URL.
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/launch$/);
		const state = authUrl.searchParams.get("state") ?? "";
		const callbackResponse = await fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`, {
			redirect: "manual",
		});
		// Callback handler responds with the templated HTML page (200), never a 302.
		expect(callbackResponse.status).toBe(200);
		expect(callbackResponse.headers.get("content-type")).toContain("text/html");

		abort.abort("test done");
		await login;
	});

	it("suppresses launchUrl even when only redirectUri (not callbackPath) resolves to /launch", async () => {
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new LaunchProbeFlow(
			{
				onAuth: info => {
					authFired.resolve(info);
				},
				signal: abort.signal,
			},
			{
				preferredPort: 0,
				allowPortFallback: true,
				// Base-class caller: `redirectUri` pinned at `/launch` while
				// `callbackPath` stays at the default. `MCPOAuthFlow` normally
				// derives `callbackPath` from `redirectUri.pathname`, but the
				// base class doesn't, and the launchUrl guard must still catch
				// the collision defensively.
				redirectUri: "http://localhost:14599/launch",
			},
		);
		const login = flow.login().catch(() => undefined) as Promise<void>;
		const info = await authFired.promise;

		expect(info.launchUrl).toBeUndefined();

		abort.abort("test done");
		await login;
	});

	it("suppresses launchUrl for custom-scheme redirects that never return to the loopback server", async () => {
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new LaunchProbeFlow(
			{
				onAuth: info => {
					authFired.resolve(info);
				},
				signal: abort.signal,
			},
			{
				preferredPort: 0,
				allowPortFallback: true,
				// GitLab Duo shape: `new URL` parses this happily (pathname
				// `/authentication`), so the guard must check scheme/host, not
				// rely on a parse failure. A localhost /launch copy target for
				// this flow would misrepresent the callback endpoint and point
				// remote users at a URL that resolves nowhere.
				redirectUri: "vscode://gitlab.gitlab-workflow/authentication",
			},
		);
		const login = flow.login().catch(() => undefined) as Promise<void>;
		const info = await authFired.promise;

		expect(info.launchUrl).toBeUndefined();

		abort.abort("test done");
		await login;
	});

	it("suppresses launchUrl for fixed non-loopback HTTP redirects", async () => {
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new LaunchProbeFlow(
			{
				onAuth: info => {
					authFired.resolve(info);
				},
				signal: abort.signal,
			},
			{
				preferredPort: 0,
				allowPortFallback: true,
				// The provider redirects to a hosted endpoint; this machine's
				// callback server never sees the redirect, so no launch URL.
				redirectUri: "https://auth.example.com/oauth/callback",
			},
		);
		const login = flow.login().catch(() => undefined) as Promise<void>;
		const info = await authFired.promise;

		expect(info.launchUrl).toBeUndefined();

		abort.abort("test done");
		await login;
	});
});
