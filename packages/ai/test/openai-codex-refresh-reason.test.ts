import { afterEach, describe, expect, it, vi } from "bun:test";
import type { OAuthRefreshReason } from "@oh-my-pi/pi-ai/auth/types";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

function fakeJwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

async function refreshAndCaptureForm(provider: string, reason?: OAuthRefreshReason): Promise<URLSearchParams> {
	let form: URLSearchParams | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				form ??= new URLSearchParams(String(init?.body));
				const access = fakeJwt({
					exp: Math.floor(Date.now() / 1000) + 3600,
					"https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
				});
				return new Response(JSON.stringify({ access_token: access, refresh_token: "rt_new", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		),
	);
	const refresh = getProviderDefinition(provider)?.refreshToken;
	if (!refresh) throw new Error(`${provider} refresh is unavailable`);
	await refresh({ access: "old", refresh: "rt_old", expires: 0 }, undefined, reason).catch(() => undefined);
	if (!form) throw new Error("expected a token request");
	return form;
}

describe("openai-codex refresh_reason", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const provider of ["openai-codex", "openai-codex-device"]) {
		it(`${provider} reports a near-expiry refresh as proactive_expiry`, async () => {
			const form = await refreshAndCaptureForm(provider);
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("refresh_token")).toBe("rt_old");
			expect(form.get("refresh_reason")).toBe("proactive_expiry");
		});

		it(`${provider} reports a 401 recovery as unauthorized_recovery`, async () => {
			const form = await refreshAndCaptureForm(provider, "auth-recovery");
			expect(form.get("refresh_reason")).toBe("unauthorized_recovery");
		});
	}

	it("leaves other providers' refresh bodies alone", async () => {
		let body = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					body = String(init?.body);
					return new Response("{}", { status: 500 });
				},
				{ preconnect: fetch.preconnect },
			),
		);
		await getProviderDefinition("anthropic")
			?.refreshToken?.({ access: "old", refresh: "rt_old", expires: 0 }, undefined, "auth-recovery")
			.catch(() => undefined);
		expect(body).not.toContain("refresh_reason");
	});
});
