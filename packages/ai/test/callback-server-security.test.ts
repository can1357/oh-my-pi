import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

class CallbackProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL("https://provider.example.com/authorize");
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

class IssuerGuardedFlow extends OAuthCallbackFlow {
	readonly expectedIssuer: string;

	constructor(expectedIssuer: string) {
		super({}, { preferredPort: 0 });
		this.expectedIssuer = expectedIssuer;
	}
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL(this.expectedIssuer);
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
	}

	override onAuthorizeRedirect(url: URL): void {
		// Mirrors MCPOAuthFlow: compare the RFC 9207 `iss` parameter against the
		// authorization-server issuer (origin + path); a legacy AS omits `iss`.
		const iss = url.searchParams.get("iss");
		if (iss === null) return;
		if (iss !== this.expectedIssuer) throw new Error("OAuth iss mismatch");
	}
}

/**
 * Whether this host can bind the IPv6 loopback at all. Probed with `Bun.serve`
 * rather than the flow's own `os.networkInterfaces()` check, so a broken
 * production probe fails loudly instead of skipping into a false green (same
 * guard as `callback-server-dual-stack.test.ts`).
 */
const ipv6Loopback = (() => {
	try {
		Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("probe") }).stop(true);
		return true;
	} catch {
		return false;
	}
})();

async function startFlow(): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<OAuthCredentials>;
}> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new CallbackProbeFlow(
		{
			onAuth: info => authFired.resolve(info),
			signal: abort.signal,
		},
		{ preferredPort: 0 },
	);
	const login = flow.login();
	void login.catch(() => undefined);
	const info = await authFired.promise;
	return { info, abort, login };
}

/** Record every hostname the flow hands to `Bun.serve` while still binding for real. */
function recordBoundHostnames(): (string | undefined)[] {
	const serve = Bun.serve;
	const hostnames: (string | undefined)[] = [];
	vi.spyOn(Bun, "serve").mockImplementation(options => {
		hostnames.push(options.hostname);
		return serve(options);
	});
	return hostnames;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow callback security", () => {
	it("keeps waiting after invalid callback requests and accepts the legitimate callback", async () => {
		const { info, abort, login } = await startFlow();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

		try {
			const invalidCallbacks = [
				`${redirectUri}?error=access_denied&error_description=Denied`,
				redirectUri,
				`${redirectUri}?code=attacker-code&state=wrong-state`,
			];
			for (const callback of invalidCallbacks) {
				const response = await fetch(callback);
				expect(response.status).toBe(500);
			}

			const response = await fetch(`${redirectUri}?code=legitimate-code&state=${encodeURIComponent(state)}`);
			expect(response.status).toBe(200);
			expect((await login).access).toBe("legitimate-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("surfaces provider denials that carry the expected state instead of waiting for the timeout", async () => {
		const { info, abort, login } = await startFlow();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

		try {
			const response = await fetch(
				`${redirectUri}?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(state)}`,
			);
			expect(response.status).toBe(500);
			await expect(login).rejects.toThrow("Authorization failed: User denied");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("binds localhost callback URLs to the loopback interfaces only", async () => {
		const hostnames = recordBoundHostnames();

		const { abort, login } = await startFlow();
		try {
			// `localhost` resolves to both loopback families, so the flow binds one
			// literal per family: IPv4 first (it resolves the port), then — on hosts
			// that have an IPv6 loopback — the `::1` companion. Never the
			// `localhost` name itself, and never a routable interface.
			expect(hostnames[0]).toBe("127.0.0.1");
			expect(hostnames.every(hostname => hostname === "127.0.0.1" || hostname === "::1")).toBe(true);
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it.skipIf(!ipv6Loopback)("binds the ::1 companion when the host has an IPv6 loopback", async () => {
		const hostnames = recordBoundHostnames();

		const { abort, login } = await startFlow();
		try {
			// The IPv6 companion keeps a wildcard-bound dev server (`next dev` on
			// `*:<port>`) from answering `localhost` traffic that the browser
			// resolved to `::1` (#8081).
			expect(hostnames).toContain("::1");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("serves IPv4 alone without attempting ::1 when the host has no IPv6 loopback", async () => {
		// Reproduce an IPv6-disabled kernel (ipv6.disable=1 / disable_ipv6=1): the
		// loopback interface exposes only 127.0.0.1 (#8814).
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			lo: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8",
				},
			],
		});
		const hostnames = recordBoundHostnames();

		const { abort, login } = await startFlow();
		try {
			// No `::1` attempt at all: a misleading Bun bind error can then never be
			// misread as a port collision and tear down the healthy IPv4 listener.
			expect(hostnames).toEqual(["127.0.0.1"]);
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("rejects a callback whose RFC 9207 issuer does not match the authorization server", async () => {
		const flow = new IssuerGuardedFlow("https://auth.example.com/tenant");
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		flow.ctrl = { onAuth: info => authFired.resolve(info), signal: abort.signal };
		const login = flow.login();
		void login.catch(() => undefined);
		const info = await authFired.promise;

		try {
			const authUrl = new URL(info.url);
			const redirectUri = authUrl.searchParams.get("redirect_uri");
			const state = authUrl.searchParams.get("state");
			if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

			const attacker = `${redirectUri}?code=stolen-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://attacker.example.com")}`;
			const attackerResponse = await fetch(attacker);
			expect(attackerResponse.status).toBe(500);
			const page = await attackerResponse.text();
			expect(page).toContain('"ok":false');
			expect(page).toContain("OAuth iss mismatch");
			await expect(login).rejects.toThrow("OAuth iss mismatch");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("accepts a callback whose RFC 9207 issuer matches the discovered authorization server", async () => {
		const flow = new IssuerGuardedFlow("https://auth.example.com/tenant");
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		flow.ctrl = { onAuth: info => authFired.resolve(info), signal: abort.signal };
		const login = flow.login();
		void login.catch(() => undefined);
		const info = await authFired.promise;

		try {
			const authUrl = new URL(info.url);
			const redirectUri = authUrl.searchParams.get("redirect_uri");
			const state = authUrl.searchParams.get("state");
			if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

			const legitimate = `${redirectUri}?code=legitimate-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://auth.example.com/tenant")}`;
			const response = await fetch(legitimate);
			expect(response.status).toBe(200);
			expect((await login).access).toBe("legitimate-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("accepts a legacy callback that omits the iss parameter", async () => {
		const flow = new IssuerGuardedFlow("https://auth.example.com/tenant");
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		flow.ctrl = { onAuth: info => authFired.resolve(info), signal: abort.signal };
		const login = flow.login();
		void login.catch(() => undefined);
		const info = await authFired.promise;

		try {
			const authUrl = new URL(info.url);
			const redirectUri = authUrl.searchParams.get("redirect_uri");
			const state = authUrl.searchParams.get("state");
			if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

			const response = await fetch(`${redirectUri}?code=legacy-code&state=${encodeURIComponent(state)}`);
			expect(response.status).toBe(200);
			expect((await login).access).toBe("legacy-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("rejects a pasted redirect whose RFC 9207 issuer does not match", async () => {
		const flow = new IssuerGuardedFlow("https://auth.example.com/tenant");
		const abort = new AbortController();
		flow.ctrl = {
			onAuth: () => {},
			onManualCodeInput: async () =>
				"https://localhost/callback?code=stolen-code&iss=https%3A%2F%2Fattacker.example.com",
			signal: abort.signal,
		};
		const login = flow.login();
		void login.catch(() => undefined);
		try {
			await expect(login).rejects.toThrow("OAuth iss mismatch");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("accepts a pasted redirect whose RFC 9207 issuer matches", async () => {
		const flow = new IssuerGuardedFlow("https://auth.example.com/tenant");
		const abort = new AbortController();
		flow.ctrl = {
			onAuth: () => {},
			onManualCodeInput: async () =>
				"https://localhost/callback?code=legitimate-code&iss=https%3A%2F%2Fauth.example.com%2Ftenant",
			signal: abort.signal,
		};
		const login = flow.login();
		void login.catch(() => undefined);
		try {
			expect((await login).access).toBe("legitimate-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});
});
