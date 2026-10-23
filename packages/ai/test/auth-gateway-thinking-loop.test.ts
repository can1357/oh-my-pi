import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { logger } from "@oh-my-pi/pi-utils";

/** A degenerate near-duplicate reasoning loop (the gemini-3.5-flash shape). */
function loopThinking(): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < 12; i++) out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	return out.join("\n\n\n");
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway non-streaming thinking-loop retries", () => {
	it("returns an error after three guarded looping attempts", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		for (let i = 0; i < 4; i++) {
			mock.push({ content: [{ type: "thinking", thinking: loopThinking() }, "Unreachable cooked answer."] });
		}
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer gw-test-token" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			const body = (await res.json()) as { error?: unknown };

			expect(res.status).toBe(502);
			expect(body.error).toBeDefined();
			expect(mock.calls).toHaveLength(3);
			expect(mock.calls.every(call => call.options?.loopGuard?.enabled !== false)).toBe(true);
		} finally {
			waitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("still surfaces a non-loop upstream error as a 502", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-err-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		mock.push({ throw: "upstream exploded" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer gw-test-token" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			// A genuine error is never a loop stall, so loop retry handling must not mask it.
			expect(res.status).toBe(502);
			expect(mock.calls).toHaveLength(1);
			expect(THINKING_LOOP_ERROR_MARKER.length).toBeGreaterThan(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("auth-gateway auth retry", () => {
	it("treats structured generic quota errors as usage-limit blocks before invalidating credentials", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-quota-rotation-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
		const storage = new AuthStorage(store);
		await storage.credentials.set("mock", [
			{ type: "api_key", key: "quota-key" },
			{ type: "api_key", key: "healthy-key" },
		]);
		const markUsageLimitSpy = spyOn(storage.limits, "markReached");
		const debugSpy = spyOn(logger, "debug");
		const invalidateSpy = spyOn(storage.limits, "invalidateMatching");
		let attempt = 0;
		const mock = createMockModel({
			provider: "mock",
			id: "gateway-quota-model",
			handler: (_context, options) => {
				attempt += 1;
				if (attempt === 1) {
					throw new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" });
				}
				return { content: [`ok:${options?.apiKey ?? "missing"}`] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer gw-test-token" },
				body: JSON.stringify({
					model: "gateway-quota-model",
					messages: [{ role: "user", content: "hi" }],
					prompt_cache_key: "gw-quota-rotation",
					stream: false,
				}),
			});
			const body = (await res.json()) as {
				choices?: Array<{ message?: { content?: string | null } }>;
			};
			const attemptedKeys = mock.calls.map(call => call.options?.apiKey);

			expect(res.status).toBe(200);
			expect(attemptedKeys).toHaveLength(2);
			const [failedKey, retriedKey] = attemptedKeys;
			if (typeof failedKey !== "string" || typeof retriedKey !== "string") {
				throw new Error("expected gateway retries to use static API keys");
			}
			expect(body.choices?.[0]?.message?.content).toBe(`ok:${retriedKey}`);
			expect(new Set([failedKey, retriedKey]).size).toBe(2);
			expect(markUsageLimitSpy.mock.calls).toHaveLength(1);
			const usageLimitCall = markUsageLimitSpy.mock.calls[0];
			if (!usageLimitCall) {
				throw new Error("expected usage-limit mark call");
			}
			const [usageLimitProvider, usageLimitSessionId, usageLimitOptions] = usageLimitCall;
			expect(usageLimitProvider).toBe("mock");
			expect(usageLimitSessionId).toBe("gw-quota-rotation");
			expect(usageLimitOptions?.apiKey).toBe(failedKey);
			expect(invalidateSpy.mock.calls).toHaveLength(0);
			const usageLimitLogs = debugSpy.mock.calls.filter(([logged]) => logged.includes("usage-limit block"));
			expect(usageLimitLogs).toHaveLength(1);
			expect(usageLimitLogs[0]?.[0]).toContain("retrying");
			expect(usageLimitLogs[0]?.[1]).toMatchObject({ switched: true });
			expect(store.listAuthCredentials("mock")).toHaveLength(2);
			expect(await storage.keys.get("mock", "gw-quota-rotation")).toBe(retriedKey);
		} finally {
			markUsageLimitSpy.mockRestore();
			invalidateSpy.mockRestore();
			debugSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not log a retry when a usage-limit block leaves no other credential", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-quota-no-sibling-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
		const storage = new AuthStorage(store);
		await storage.credentials.set("mock", [{ type: "api_key", key: "quota-key" }]);
		const debugSpy = spyOn(logger, "debug");
		const mock = createMockModel({
			provider: "mock",
			id: "gateway-quota-model",
			handler: () => {
				throw new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" });
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer gw-test-token" },
				body: JSON.stringify({
					model: "gateway-quota-model",
					messages: [{ role: "user", content: "hi" }],
					prompt_cache_key: "gw-quota-no-sibling",
					stream: false,
				}),
			});
			await res.body?.cancel();
			const usageLimitLogs = debugSpy.mock.calls.filter(([logged]) => logged.includes("usage-limit block"));

			expect(res.ok).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(usageLimitLogs).toHaveLength(1);
			const [logged, fields] = usageLimitLogs[0] ?? [];
			expect(logged).not.toContain("retrying");
			expect(fields).toMatchObject({ provider: "mock", switched: false });
		} finally {
			debugSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
