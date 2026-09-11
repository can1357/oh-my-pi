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
function deadlineEdgeFetchMock(): FetchImpl {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("models.json.zstd")) {
			// Prefetch burns nearly its whole 10s transport bound before
			// failing, so the pipeline starts the rich phase ~9s into the
			// outer budget.
			await Bun.sleep(9_000);
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
			await Bun.sleep(9_000);
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
		// ~9s prefetch + 30s rich abort + ~9s fallback ≈ 48s of wall clock
		// (load-bearing: outer and phase budgets are real AbortSignal
		// timers, as the mocks above document). Past the 44s the pressured
		// test covers and comfortable inside the 55s stretched outer — but
		// only ~1s inside an exact-sum 50s outer, with no room left for the
		// outer timer's start offset or per-phase handoff jitter (measured
		// 48.9s against the exact sum locally). The explicit headroom is
		// what makes this edge robust rather than luck. This is the
		// observable outcome that replaces the old internal
		// discoveryBudgetMs literal assertion.
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
