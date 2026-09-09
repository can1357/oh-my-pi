/**
 * End-to-end integration test for Xiaomi MiMo login with a token-plan (tp-) key.
 *
 * Exercises the full login flow (loginXiaomi) plus the runtime model-discovery
 * path (xiaomiModelManagerOptions) with a realistic tp- key, validating:
 *
 *   1. Login validation targets SGP, then AMS, then CN token-plan hosts
 *   2. Authorization header is Bearer (not x-api-key)
 *   3. Validation request body uses mimo-v2.5 (the token-plan validation model)
 *   4. SGP 401 → AMS → CN fallback; all three are tried
 *   5. All three returning 401 throws a descriptive error
 *   6. After login, model discovery hits token-plan hosts (SGP → AMS → CN)
 *   7. Model discovery stops at first successful token-plan host
 */

import { describe, expect, it } from "bun:test";
import { loginXiaomi } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { xiaomiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

// Realistic tp- key (same format as user's key, but a dummy value for testing)
const TP_KEY = "tp-ci1p8t1w4e1sbxgyc8v65tnrjbzro287igmvyf25van9mt76";

const TOKEN_PLAN_HOSTS = {
	sgp: "token-plan-sgp.xiaomimimo.com",
	ams: "token-plan-ams.xiaomimimo.com",
	cn: "token-plan-cn.xiaomimimo.com",
} as const;

const STANDARD_HOST = "api.xiaomimimo.com";

// ─── loginXiaomi: validation phase ─────────────────────────────────────────

describe("loginXiaomi with tp- key", () => {
	it("validates against SGP token-plan host with Bearer auth and mimo-v2.5 model", async () => {
		const seen: { url: string; headers: Record<string, string>; body: string }[] = [];

		const fetchMock: FetchImpl = async (input, init) => {
			seen.push({
				url: String(input),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: init?.body as string,
			});
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		await loginXiaomi({
			onPrompt: async () => TP_KEY,
			onAuth: () => {},
			onProgress: () => {},
			fetch: fetchMock,
		});

		expect(seen).toHaveLength(1);

		// 1. Hits SGP, not the standard host
		expect(seen[0]!.url).toBe(`https://${TOKEN_PLAN_HOSTS.sgp}/v1/chat/completions`);
		expect(seen[0]!.url).not.toContain(STANDARD_HOST);

		// 2. Uses Bearer auth, not x-api-key
		expect(seen[0]!.headers.Authorization).toBe(`Bearer ${TP_KEY}`);
		expect(seen[0]!.headers["x-api-key"]).toBeUndefined();

		// 3. Uses the token-plan validation model
		const body = JSON.parse(seen[0]!.body);
		expect(body.model).toBe("mimo-v2.5");
		expect(body.max_tokens).toBe(1);
		expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
	});

	it("falls back SGP → AMS → CN during validation", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			seen.push(url);
			if (url.includes(TOKEN_PLAN_HOSTS.sgp) || url.includes(TOKEN_PLAN_HOSTS.ams)) {
				return new Response("Invalid API Key", { status: 401 });
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		await loginXiaomi({
			onPrompt: async () => TP_KEY,
			onAuth: () => {},
			onProgress: () => {},
			fetch: fetchMock,
		});

		// Tried SGP → AMS → succeeded on CN
		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(seen[1]).toContain(TOKEN_PLAN_HOSTS.ams);
		expect(seen[2]).toContain(TOKEN_PLAN_HOSTS.cn);
	});

	it("throws when all three token-plan hosts return 401", async () => {
		const fetchMock: FetchImpl = async () => {
			return new Response("Invalid API Key", { status: 401 });
		};

		await expect(
			loginXiaomi({
				onPrompt: async () => TP_KEY,
				onAuth: () => {},
				onProgress: () => {},
				fetch: fetchMock,
			}),
		).rejects.toThrow("Xiaomi MiMo API key validation failed (401)");
	});

	it("falls back through timeouts: SGP timeout → AMS timeout → CN success", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			seen.push(url);
			if (url.includes(TOKEN_PLAN_HOSTS.sgp) || url.includes(TOKEN_PLAN_HOSTS.ams)) {
				// Simulate a regional timeout
				throw new DOMException("The operation was aborted due to timeout.", "AbortError");
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		await loginXiaomi({
			onPrompt: async () => TP_KEY,
			onAuth: () => {},
			onProgress: () => {},
			fetch: fetchMock,
		});

		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(seen[1]).toContain(TOKEN_PLAN_HOSTS.ams);
		expect(seen[2]).toContain(TOKEN_PLAN_HOSTS.cn);
	});

	it("does NOT hit the standard api.xiaomimimo.com for tp- keys", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		await loginXiaomi({
			onPrompt: async () => TP_KEY,
			onAuth: () => {},
			onProgress: () => {},
			fetch: fetchMock,
		});

		for (const url of seen) {
			expect(url).not.toContain(STANDARD_HOST);
		}
	});
});

// ─── xiaomiModelManagerOptions: runtime model discovery ────────────────────

describe("xiaomiModelManagerOptions with tp- key", () => {
	it("discovers models from SGP first", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY, fetch: fetchMock });
		const models = await opts.fetchDynamicModels?.();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(seen[0]).toContain("/v1/models");
		expect(models).not.toBeNull();
	});

	it("falls back SGP → AMS → CN during discovery", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			seen.push(url);

			// SGP and AMS fail, CN succeeds
			if (url.includes(TOKEN_PLAN_HOSTS.sgp) || url.includes(TOKEN_PLAN_HOSTS.ams)) {
				return new Response("error", { status: 500 });
			}
			return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY, fetch: fetchMock });
		const models = await opts.fetchDynamicModels?.();

		// All three token-plan hosts tried in order
		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(seen[1]).toContain(TOKEN_PLAN_HOSTS.ams);
		expect(seen[2]).toContain(TOKEN_PLAN_HOSTS.cn);
		expect(models).not.toBeNull();
	});

	it("returns null when all token-plan hosts fail", async () => {
		const fetchMock: FetchImpl = async () => {
			return new Response("error", { status: 500 });
		};

		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY, fetch: fetchMock });
		const models = await opts.fetchDynamicModels?.();

		expect(models).toBeNull();
	});

	it("does NOT use standard host for tp- key model discovery", async () => {
		const seen: string[] = [];

		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY, fetch: fetchMock });
		await opts.fetchDynamicModels?.();

		for (const url of seen) {
			expect(url).not.toContain(STANDARD_HOST);
		}
	});
});

// ─── Full round-trip: login → model discovery ──────────────────────────────

describe("Xiaomi tp- full round-trip", () => {
	it("login validation and model discovery both use token-plan hosts", async () => {
		// Phase 1: Login
		const loginUrls: string[] = [];

		const loginFetchMock: FetchImpl = async input => {
			loginUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const returnedKey = await loginXiaomi({
			onPrompt: async () => TP_KEY,
			onAuth: () => {},
			onProgress: () => {},
			fetch: loginFetchMock,
		});

		expect(returnedKey).toBe(TP_KEY);
		expect(loginUrls).toHaveLength(1);
		expect(loginUrls[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(loginUrls[0]).toContain("/v1/chat/completions");

		// Phase 2: Model discovery with the returned key
		const discoveryUrls: string[] = [];

		const discoveryFetchMock: FetchImpl = async input => {
			discoveryUrls.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: returnedKey, fetch: discoveryFetchMock });
		const models = await opts.fetchDynamicModels?.();

		expect(discoveryUrls).toHaveLength(1);
		expect(discoveryUrls[0]).toContain(TOKEN_PLAN_HOSTS.sgp);
		expect(discoveryUrls[0]).toContain("/v1/models");
		expect(models).not.toBeNull();
	});
});
