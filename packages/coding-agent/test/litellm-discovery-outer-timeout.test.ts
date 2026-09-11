// #11576 follow-up (Codex P1): the runtime outer guard must accommodate a
// configured inner discovery budget larger than its 15s default. A rich
// /model/info response arriving after 15s must still yield models instead of
// an empty registry result.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
	resolveModelDiscoveryTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const RICH_DELAY_MS = 16_000;

function slowRichFetchMock(): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/model_group/info")) {
			// Load-bearing wall clock: the outer guard and the inner rich
			// budget are real setTimeout/AbortSignal timers around a real
			// fetch pipeline, so fake timers cannot drive this path.
			await Bun.sleep(RICH_DELAY_MS);
			if (init?.signal?.aborted) throw new Error("rich fetch aborted");
			return Response.json({ data: [{ model_group: "slow-reasoner", supports_reasoning: true }] });
		}
		if (url.endsWith("/v1/models")) {
			return Response.json({ data: [{ id: "openai/gpt-5" }] });
		}
		return new Response("", { status: 404 });
	}) as FetchImpl;
}
function pressuredFetchMock(): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("models.json.zstd")) {
			// A struggling catalog mirror: burns part of the outer budget
			// before the transport deadline would fire.
			await Bun.sleep(5_000);
			return new Response("", { status: 404 });
		}
		if (url.endsWith("/model_group/info")) {
			// Never answers: the inner rich budget aborts this at 30s, and
			// discovery must still reach the fallback inside the outer.
			const { promise, reject } = Promise.withResolvers<never>();
			init?.signal?.addEventListener("abort", () => reject(new Error("rich fetch aborted")), { once: true });
			await promise;
		}
		if (url.endsWith("/v1/models")) {
			await Bun.sleep(9_000);
			if (init?.signal?.aborted) throw new Error("fallback fetch aborted");
			return Response.json({ data: [{ id: "openai/gpt-5" }] });
		}
		return new Response("", { status: 404 });
	}) as FetchImpl;
}
function shortTimeoutFetchMock(): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("models.json.zstd")) {
			// Prefetch burns nearly its whole 10s transport bound before
			// failing, so the pipeline starts the rich phase ~9s in.
			// Load-bearing wall clock like the mocks above: the outer
			// guard and phase budgets are real AbortSignal timers.
			await Bun.sleep(9_000);
			return new Response("", { status: 404 });
		}
		if (url.endsWith("/model_group/info")) {
			// Never answers: the 5s inner budget aborts this, and the
			// fallback must still fit inside the short-branch outer.
			const { promise, reject } = Promise.withResolvers<never>();
			init?.signal?.addEventListener("abort", () => reject(new Error("rich fetch aborted")), { once: true });
			await promise;
		}
		if (url.endsWith("/v1/models")) {
			await Bun.sleep(9_000);
			if (init?.signal?.aborted) throw new Error("fallback fetch aborted");
			return Response.json({ data: [{ id: "openai/gpt-5" }] });
		}
		return new Response("", { status: 404 });
	}) as FetchImpl;
}

function deadlineEdgeFetchMock(): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("models.json.zstd")) {
			// Prefetch burns nearly its whole 10s transport bound before
			// failing, so the pipeline starts the rich phase ~10s into the
			// outer budget. 9.9s (not 10s) keeps clear of the bound itself.
			await Bun.sleep(9_900);
			return new Response("", { status: 404 });
		}
		if (url.endsWith("/model_group/info")) {
			// Never answers: the inner 30s budget aborts this, and the
			// fallback must still fit inside the stretched outer.
			const { promise, reject } = Promise.withResolvers<never>();
			init?.signal?.addEventListener("abort", () => reject(new Error("rich fetch aborted")), { once: true });
			await promise;
		}
		if (url.endsWith("/v1/models")) {
			// 9.9s (not 10s) keeps clear of the default phase bound itself.
			await Bun.sleep(9_900);
			if (init?.signal?.aborted) throw new Error("fallback fetch aborted");
			return Response.json({ data: [{ id: "openai/gpt-5" }] });
		}
		return new Response("", { status: 404 });
	}) as FetchImpl;
}

describe("litellm discovery outer timeout (#11576)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let originalApiKey: string | undefined;
	let originalEnvTimeout: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalEnvTimeout = Bun.env.LITELLM_DISCOVERY_TIMEOUT_MS;
		Bun.env.LITELLM_DISCOVERY_TIMEOUT_MS = "30000";
		originalApiKey = Bun.env.LITELLM_API_KEY;
		Bun.env.LITELLM_API_KEY = "sk-test";
		tempDir = path.join(os.tmpdir(), `pi-test-litellm-outer-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }));
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		if (originalEnvTimeout === undefined) {
			delete Bun.env.LITELLM_DISCOVERY_TIMEOUT_MS;
		} else {
			Bun.env.LITELLM_DISCOVERY_TIMEOUT_MS = originalEnvTimeout;
		}
		if (originalApiKey === undefined) {
			delete Bun.env.LITELLM_API_KEY;
		} else {
			Bun.env.LITELLM_API_KEY = originalApiKey;
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("a rich response slower than the default outer still yields models", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: slowRichFetchMock() });
		await registry.refreshDiscoverableProviders(["litellm"], "online");
		expect(registry.find("litellm", "slow-reasoner")).toBeDefined();
	}, 120_000);

	test("a pressured prefetch plus rich abort still reaches the fallback", async () => {
		// ~5s prefetch + 30s rich abort + ~9s fallback ≈ 44s: inside the
		// 50s budget, past the 40s the old arithmetic allowed.
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: pressuredFetchMock() });
		await registry.refreshDiscoverableProviders(["litellm"], "online");
		expect(registry.find("litellm", "openai/gpt-5")).toBeDefined();
	}, 120_000);
	test("a deadline-edge pipeline still reaches the fallback", async () => {
		// ~9.9s prefetch + 30s rich abort + ~9.9s fallback ≈ 49.8s nominal,
		// the most any completable pipeline can schedule: prefetch and
		// fallback are hard-capped at the 10s shared default and rich
		// aborts at its 30s inner, so the caps sum to exactly the old
		// exact-sum 50s arithmetic. Measured against a zeroed headroom,
		// this pipeline still completes (~50.7s wall, models found) —
		// the old budget absorbs the worst case within ordinary
		// handoff variance, so an outcome test that fails without the
		// headroom is unconstructible without racing sub-0.2s timer
		// margins (Codex P1 3986541327). The headroom margin itself is
		// pinned deterministically by the margin unit in
		// litellm-provider.test.ts (stretched budget must clear the exact
		// phase sum — fails without headroom); this test pins end-to-end
		// delivery at the nearest constructible edge, inside the 55s
		// stretched outer.
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: deadlineEdgeFetchMock() });
		await registry.refreshDiscoverableProviders(["litellm"], "online");
		expect(registry.find("litellm", "openai/gpt-5")).toBeDefined();
	}, 120_000);

	test("a short configured budget still reaches the fallback after a slow prefetch", async () => {
		// ~9s prefetch + 5s rich abort + ~9s fallback ≈ 23s: inside the
		// 30s short-branch outer (5s rich + 2x10s phase bounds + 5s
		// headroom), past the 15s default guard the undeclared branch
		// resolves to (Codex P1 3986054005).
		Bun.env.LITELLM_DISCOVERY_TIMEOUT_MS = "5000";
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: shortTimeoutFetchMock() });
		await registry.refreshDiscoverableProviders(["litellm"], "online");
		expect(registry.find("litellm", "openai/gpt-5")).toBeDefined();
	}, 120_000);
});

describe("resolveModelDiscoveryTimeoutMs", () => {
	test("keeps the default guard when no inner budget is declared", () => {
		expect(resolveModelDiscoveryTimeoutMs({})).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
		expect(resolveModelDiscoveryTimeoutMs({ discoveryBudgetMs: undefined })).toBe(
			RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
		);
	});

	test("never shrinks the guard below its default", () => {
		expect(resolveModelDiscoveryTimeoutMs({ discoveryBudgetMs: 5_000 })).toBe(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
	});

	test("stretches past the default for a larger declared budget", () => {
		expect(resolveModelDiscoveryTimeoutMs({ discoveryBudgetMs: 40_000 })).toBe(40_000);
	});

	test("falls back to the default guard on a non-finite budget", () => {
		expect(resolveModelDiscoveryTimeoutMs({ discoveryBudgetMs: Number.NaN })).toBe(
			RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
		);
	});
});
