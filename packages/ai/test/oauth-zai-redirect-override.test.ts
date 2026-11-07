/**
 * PROPOSED TESTS — chưa chạy (môi trường phân tích không có `bun`).
 *
 * Vị trí đề xuất: packages/ai/test/oauth-zai-redirect-override.test.ts
 * Chạy:  bun test packages/ai/test/oauth-zai-redirect-override.test.ts
 *
 * Nếu `CompiledAuthValue` / `CompiledCallback` có field khác với giả định dưới
 * đây, chỉnh helper `callback()` cho khớp `packages/catalog/src/compat/types.ts:428`.
 */
import { describe, expect, it } from "bun:test";
import { resolveCallbackOptions } from "@oh-my-pi/pi-ai/registry/engine/oauth-code";
import { OAuthCallbackFlow, parseCallbackInput } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { CompiledCallback } from "@oh-my-pi/pi-catalog/compat/types";

const ZAI_CALLBACK = "zcode://zai-auth/callback";

function callback(overrides: Partial<CompiledCallback> = {}): CompiledCallback {
	return {
		port: 0,
		path: "/callback",
		hostname: "localhost",
		portFallback: false,
		manualOnly: true,
		nativeScheme: true,
		redirectUri: { value: ZAI_CALLBACK, env: ["ZAI_OAUTH_REDIRECT_URI"] },
		...overrides,
	} as CompiledCallback;
}

describe("resolveCallbackOptions redirect override", () => {
	it("keeps the rule's own custom-scheme redirect when no override is set", async () => {
		const options = await resolveCallbackOptions(callback(), "zai-coding-plan");
		expect(options.redirectUri).toBe(ZAI_CALLBACK);
		expect(options.nativeScheme).toBe(true);
		expect(options.manualInputOnly).toBe(true);
	});

	it("accepts a custom-scheme override and advertises it verbatim", async () => {
		process.env.ZAI_OAUTH_REDIRECT_URI = "zcode://oauth/callback";
		try {
			const options = await resolveCallbackOptions(callback(), "zai-coding-plan");
			expect(options.redirectUri).toBe("zcode://oauth/callback");
			// Delivery stays governed by the rule, not by the override's scheme.
			expect(options.nativeScheme).toBe(true);
			expect(options.manualInputOnly).toBe(true);
			expect(options.allowPortFallback).toBe(false);
		} finally {
			delete process.env.ZAI_OAUTH_REDIRECT_URI;
		}
	});

	it("accepts the first-party https bounce form without engaging the native scheme", async () => {
		const bounce = "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=1.0.0";
		process.env.ZAI_OAUTH_REDIRECT_URI = bounce;
		try {
			const options = await resolveCallbackOptions(callback(), "zai-coding-plan");
			expect(options.redirectUri).toBe(bounce);
			expect(options.allowPortFallback).toBe(false);
			// callback-server.ts:250-252 only creates a receiver for non-web schemes,
			// so an https redirect must not take over the OS handler.
			expect(new URL(options.redirectUri!).protocol).toBe("https:");
		} finally {
			delete process.env.ZAI_OAUTH_REDIRECT_URI;
		}
	});

	it("still rejects a malformed override", async () => {
		process.env.ZAI_OAUTH_REDIRECT_URI = "not a url";
		try {
			await expect(resolveCallbackOptions(callback(), "zai-coding-plan")).rejects.toThrow(
				/Invalid redirect URI override/,
			);
		} finally {
			delete process.env.ZAI_OAUTH_REDIRECT_URI;
		}
	});

	it("still requires http for loopback overrides", async () => {
		process.env.ZAI_OAUTH_REDIRECT_URI = "https://localhost:8443/callback";
		try {
			await expect(resolveCallbackOptions(callback(), "zai-coding-plan")).rejects.toThrow(
				/Loopback redirect URI overrides must use http/,
			);
		} finally {
			delete process.env.ZAI_OAUTH_REDIRECT_URI;
		}
	});
});

describe("parseCallbackInput parity with parseNativeCallback", () => {
	it("reads a query-shaped Z.AI callback", () => {
		const parsed = parseCallbackInput("zcode://oauth/callback?code=abc&state=s1");
		expect(parsed).toEqual({ code: "abc", state: "s1" });
	});

	it("accepts the authCode alias used by Z.AI/ZCode", () => {
		expect(parseCallbackInput("zcode://oauth/callback?authCode=abc&state=s1").code).toBe("abc");
	});

	it("accepts a fragment-shaped response", () => {
		expect(parseCallbackInput("https://example.test/callback#code=abc&state=s1").code).toBe("abc");
	});

	it("returns no code for the authorize URL users copy by mistake", () => {
		const authorize = "https://chat.z.ai/api/oauth/authorize?client_id=client_x&response_type=code&state=s1";
		expect(parseCallbackInput(authorize).code).toBeUndefined();
	});
});

class ProbeFlow extends OAuthCallbackFlow {
	/** Captured from the real flow so the paste can carry a matching `state`. */
	observedState = "";

	async generateAuthUrl(state: string, redirectUri: string) {
		this.observedState = state;
		return { url: `${redirectUri}?start=1` };
	}
	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "", expires: Date.now() + 60_000 };
	}
}

describe("manual paste diagnostics", () => {
	it("says why a paste was rejected instead of silently re-prompting", async () => {
		const progress: string[] = [];
		let prompts = 0;
		const flow = new ProbeFlow(
			{
				onAuth: () => {},
				onProgress: message => progress.push(message),
				onManualCodeInput: async () => {
					prompts += 1;
					switch (prompts) {
						case 1:
							// What users actually copy when the deep link fails: the
							// authorize URL, which carries `state` but no `code`.
							return "https://chat.z.ai/api/oauth/authorize?client_id=client_x&response_type=code";
						case 2:
							// A callback from a *previous* login attempt: state mismatch.
							return "zcode://oauth/callback?code=stale&state=not-this-attempt";
						default:
							return `zcode://oauth/callback?code=good&state=${flow.observedState}`;
					}
				},
				signal: AbortSignal.timeout(2_000),
			},
			{ preferredPort: 0, redirectUri: "zcode://oauth/callback", manualInputOnly: true },
		);

		const credentials = await flow.login();

		expect(credentials.access).toBe("access-good");
		expect(prompts).toBe(3);
		expect(progress.some(message => /No `code` in that input/.test(message))).toBe(true);
		expect(progress.some(message => /`state` is from another login attempt/.test(message))).toBe(true);
	});
});
