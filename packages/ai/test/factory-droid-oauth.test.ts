import { describe, expect, it } from "bun:test";
import { loginFactoryDroid, refreshFactoryDroidToken } from "../src/registry/oauth/factory-droid";
import type { OAuthController } from "../src/registry/oauth/types";
import type { FetchImpl } from "../src/types";

function makeJwt(claims: Record<string, unknown>): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DEVICE_AUTH = {
	device_code: "device-1",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.factory.ai/device",
	verification_uri_complete: "https://auth.factory.ai/device?user_code=ABCD-EFGH",
	expires_in: 300,
	interval: 0.05,
};

describe("Factory Droid OAuth", () => {
	it("runs the device flow: authorize/device, user code surfacing, poll, credential mapping", async () => {
		const access = makeJwt({
			sub: "user_123",
			email: "dev@example.com",
			external_org_id: "org-ext-1",
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const calls: Array<{ url: string; body: string }> = [];
		const fetchImpl: FetchImpl = async (url, init) => {
			calls.push({ url: String(url), body: String(init?.body ?? "") });
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, { region: "eu" });
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};
		const auths: Array<{ url: string; instructions?: string }> = [];
		const ctrl: OAuthController = {
			fetch: fetchImpl,
			onAuth: info => auths.push({ url: info.url, instructions: info.instructions }),
		};

		const credentials = await loginFactoryDroid(ctrl);

		expect(calls[0].url).toBe("https://api.workos.com/user_management/authorize/device");
		expect(calls[0].body).toContain("client_id=client_01HNM792M5G5G1A2THWPXKFMXB");
		expect(auths).toEqual([
			{ url: "https://auth.factory.ai/device?user_code=ABCD-EFGH", instructions: "Enter code: ABCD-EFGH" },
		]);
		const pollBody = calls[1].body;
		expect(pollBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
		expect(pollBody).toContain("device_code=device-1");
		expect(credentials.refresh).toBe("refresh-1");
		expect(credentials.access).toBe(access);
		expect(credentials.email).toBe("dev@example.com");
		expect(credentials.accountId).toBe("user_123");
		expect(credentials.orgId).toBe("org-ext-1");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		// whoami runs against the default host with the fresh access token and
		// captures the account residency region.
		expect(calls[2].url).toBe("https://api.factory.ai/api/cli/whoami");
		expect(credentials.region).toBe("eu");
	});

	it("keeps polling through authorization_pending and slow_down", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		let polls = 0;
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, {});
			polls += 1;
			if (polls === 1) return jsonResponse(400, { error: "authorization_pending" });
			if (polls === 2) return jsonResponse(400, { error: "slow_down" });
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-2" });
		};

		const credentials = await loginFactoryDroid({ fetch: fetchImpl });
		expect(polls).toBe(3);
		expect(credentials.refresh).toBe("refresh-2");
		// The shared poller enforces a 1s floor and +5s after slow_down.
	}, 10_000);

	it("fails cleanly when the user denies the device code", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			return jsonResponse(400, { error: "access_denied" });
		};
		await expect(loginFactoryDroid({ fetch: fetchImpl })).rejects.toThrow(/denied/);
	});

	it("fails with the expiry message when the device code expires mid-poll", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			return jsonResponse(400, { error: "expired_token" });
		};
		// expired_token maps to the dedicated "login expired" message, not the
		// generic failed-poll text.
		await expect(loginFactoryDroid({ fetch: fetchImpl })).rejects.toThrow("Factory device login expired");
	});

	it("refreshes via the WorkOS refresh_token grant and maps the user payload", async () => {
		const access = makeJwt({ sub: "user_9", exp: Math.floor(Date.now() / 1000) + 7200 });
		const calls: Array<{ url: string; body: string; authorization?: string }> = [];
		const fetchImpl: FetchImpl = async (url, init) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(url), body: String(init?.body ?? ""), authorization: headers.get("authorization") ?? undefined });
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, { region: "eu" });
			return jsonResponse(200, {
				access_token: access,
				refresh_token: "refresh-rotated",
				user: { id: "user_9", email: "rotated@example.com" },
				organization_id: "org-9",
			});
		};

		const credentials = await refreshFactoryDroidToken("refresh-old", fetchImpl);
		expect(calls[0].url).toBe("https://api.workos.com/user_management/authenticate");
		expect(calls[0].body).toContain("grant_type=refresh_token");
		expect(calls[0].body).toContain("refresh_token=refresh-old");
		expect(credentials.refresh).toBe("refresh-rotated");
		expect(credentials.email).toBe("rotated@example.com");
		expect(credentials.orgId).toBe("org-9");
		// Refresh re-reads whoami with the rotated access token (mirrors the CLI).
		expect(calls[1].url).toBe("https://api.factory.ai/api/cli/whoami");
		expect(calls[1].authorization).toBe(`Bearer ${access}`);
		expect(credentials.region).toBe("eu");
	});

	it("treats a whoami failure as region unknown, not a login failure", async () => {
		const access = makeJwt({ sub: "user_2", exp: Math.floor(Date.now() / 1000) + 3600 });
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(500, {});
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-3" });
		};

		const credentials = await loginFactoryDroid({ fetch: fetchImpl });
		expect(credentials.refresh).toBe("refresh-3");
		expect(credentials.region).toBeUndefined();
	});

	it("surfaces refresh failures with the provider error", async () => {
		const fetchImpl: FetchImpl = async () => jsonResponse(401, { error: "invalid_grant" });
		await expect(refreshFactoryDroidToken("dead", fetchImpl)).rejects.toThrow(/invalid_grant/);
	});
});
