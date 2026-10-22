import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginXiaomi } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import * as authRules from "@oh-my-pi/pi-catalog/compat/auth";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("xiaomi oauth validation", () => {
	it("uses the regional auth probe URLs and models independently of catalog defaults", async () => {
		const probes: Record<string, { baseUrl: string; model: string }> = {
			"xiaomi-token-plan-sgp": { baseUrl: "https://sgp-probe.invalid/v1", model: "sgp-plan-validation" },
			"xiaomi-token-plan-ams": { baseUrl: "https://ams-probe.invalid/v1", model: "ams-plan-validation" },
			"xiaomi-token-plan-cn": { baseUrl: "https://cn-probe.invalid/v1", model: "cn-plan-validation" },
		};
		const originalAuthPolicyFor = authRules.authPolicyFor;
		vi.spyOn(authRules, "authPolicyFor").mockImplementation(provider => {
			const policy = originalAuthPolicyFor(provider);
			const probe = probes[provider];
			if (!probe || policy?.login?.kind !== "api-key" || policy.login.validate?.kind !== "chat-completions") {
				return policy;
			}
			return {
				...policy,
				login: { ...policy.login, validate: { ...policy.login.validate, ...probe } },
			};
		});

		const seen: { url: string; model: string }[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			seen.push({ url, model: JSON.parse(String(init?.body)).model });
			return new Response("{}", { status: url === "https://cn-probe.invalid/v1/chat/completions" ? 200 : 401 });
		};

		await loginXiaomi({ onPrompt: async () => "tp-test-key", fetch: fetchMock });

		expect(seen).toEqual([
			{ url: "https://sgp-probe.invalid/v1/chat/completions", model: "sgp-plan-validation" },
			{ url: "https://ams-probe.invalid/v1/chat/completions", model: "ams-plan-validation" },
			{ url: "https://cn-probe.invalid/v1/chat/completions", model: "cn-plan-validation" },
		]);
	});

	it("uses a fresh AbortSignal per endpoint so SGP timeout doesn't abort AMS fallback", async () => {
		const capturedSignals: (AbortSignal | undefined)[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			capturedSignals.push(init?.signal ?? undefined);
			if (capturedSignals.length === 1) {
				// Simulate SGP timing out: throw an AbortError as AbortSignal.timeout would.
				throw new DOMException("The operation was aborted due to timeout.", "AbortError");
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await loginXiaomi({
			onPrompt: async () => "tp-test-key",
			onAuth: () => {},
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
		expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
		// Two distinct signals — proves a fresh timeout was created for AMS.
		expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
		// And the AMS signal is not aborted (would be if the timeout signal were shared).
		expect(capturedSignals[1]?.aborted).toBe(false);
	});

	it("validates standard sk- keys after the MiMo V2.5 retirement with Bearer auth", async () => {
		const capturedHeaders: Record<string, string>[] = [];
		const capturedUrls: string[] = [];
		const capturedBodies: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			capturedUrls.push(typeof input === "string" ? input : input.toString());
			capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
			capturedBodies.push(String(init?.body));
			if (JSON.parse(String(init?.body)).model !== "mimo-v2.6-flash") {
				return Response.json({ error: { code: "400", message: "Unsupported model mimo-v2.5" } }, { status: 400 });
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await loginXiaomi({
			onPrompt: async () => "sk-test-key",
			onAuth: () => {},
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capturedUrls[0]).toBe("https://api.xiaomimimo.com/v1/chat/completions");
		expect(JSON.parse(capturedBodies[0]).model).toBe("mimo-v2.6-flash");
		const headers = capturedHeaders[0];
		expect(headers.Authorization).toBe("Bearer sk-test-key");
		expect(headers["x-api-key"]).toBeUndefined();
	});
});
