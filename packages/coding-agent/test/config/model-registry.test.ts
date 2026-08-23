import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../../src/config/model-registry";

/** Stub auth storage for registry lifecycle and missing-credential coverage. */
function createStubAuthStorage(): AuthStorage {
	const stub = {
		setFallbackResolver: () => {},
		clearConfigApiKeys: () => {},
		hasAuth: () => false,
		getRuntimeApiKey: () => undefined,
		getApiKey: async () => undefined,
	};
	return stub as unknown as AuthStorage;
}

const testModel = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
});

describe("ModelRegistry", () => {
	let tmpDir: string;
	let registry: ModelRegistry;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "omp-reg-"));
		// Construct with an explicit modelsPath inside the temp dir so the
		// constructor's #loadModels read returns "not-found" rather than
		// touching the host's ~/.omp/agent/models.yaml. isBunTestRuntime()
		// auto-stubs #fetch in the constructor.
		registry = new ModelRegistry(createStubAuthStorage(), path.join(tmpDir, "models.yaml"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("resolves immediately when no background refresh is in flight", async () => {
		// No refreshInBackground() called → #backgroundRefresh is undefined.
		// The awaiter must settle within a single microtask, never hanging.
		let settled = false;
		const p = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});
		await Promise.resolve();
		await p;
		expect(settled).toBe(true);
	});

	test("blocks until the in-flight background refresh resolves, then resolves", async () => {
		// Drive refreshInBackground with a controlled refresh() return value so
		// #backgroundRefresh is captured but not yet settled.
		const { promise, resolve } = Promise.withResolvers<void>();
		const refreshSpy = vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		let settled = false;
		const awaitPromise = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});

		// Yield to the microtask queue: the awaiter must still be pending.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(settled).toBe(false);

		resolve();

		await awaitPromise;
		expect(settled).toBe(true);
	});

	test("resolves even when the underlying refresh rejects (refreshInBackground swallows)", async () => {
		// refreshInBackground wraps refresh() in .catch(...) so discovery errors
		// never reach awaitBackgroundRefresh callers. The awaiter must resolve,
		// not propagate the rejection.
		const { promise, reject } = Promise.withResolvers<void>();
		vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();

		let settled = false;
		const awaitPromise = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});

		reject(new Error("synthetic discovery failure"));

		await awaitPromise;
		expect(settled).toBe(true);
	});

	test("awaiter is a no-op after the in-flight refresh settles and clears #backgroundRefresh", async () => {
		// Once refreshInBackground's promise resolves, #backgroundRefresh is
		// cleared in the .finally. A subsequent awaitBackgroundRefresh must be
		// an immediate no-op (microtask), not hang waiting for a stale promise
		// or a second refresh that was never started.
		const { promise, resolve } = Promise.withResolvers<void>();
		vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		resolve();
		await registry.awaitBackgroundRefresh();

		// Now #backgroundRefresh is cleared. A fresh await must resolve in a
		// single microtask — measure by asserting it settles before a second
		// microtask tick.
		let settled = false;
		const p = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		await p;
	});

	test("refreshInBackground deduplicates: a second call while in-flight starts no new refresh", async () => {
		// The guard `if (this.#backgroundRefresh) return` at the top of
		// refreshInBackground prevents concurrent refreshes. A second call
		// while the first is still pending must not invoke refresh() again.
		const { promise, resolve } = Promise.withResolvers<void>();
		const refreshSpy = vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		registry.refreshInBackground();
		registry.refreshInBackground();

		expect(refreshSpy).toHaveBeenCalledTimes(1);

		resolve();
		await registry.awaitBackgroundRefresh();

		// After settle, #backgroundRefresh is cleared — a new call DOES start
		// a fresh refresh.
		const { promise: secondPromise, resolve: secondResolve } = Promise.withResolvers<void>();
		refreshSpy.mockReturnValue(secondPromise);
		registry.refreshInBackground();
		expect(refreshSpy).toHaveBeenCalledTimes(2);

		secondResolve();
		await registry.awaitBackgroundRefresh();
	});
	test("resolves API keys and provider headers for legacy extensions", async () => {
		const model = testModel;
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(registry, "getProviderHeaders").mockReturnValue({ "x-test": "value" });

		expect(await registry.getApiKeyAndHeaders(model)).toEqual({
			ok: true,
			apiKey: "test-key",
			headers: { "x-test": "value" },
		});
	});

	test("returns an error when authentication resolves without a credential", async () => {
		expect(await registry.getApiKeyAndHeaders(testModel)).toEqual({
			ok: false,
			error: 'No API key found for "test"',
		});
	});

	test("maps legacy extension auth failures into the result contract", async () => {
		const model = testModel;
		vi.spyOn(registry, "getApiKey").mockRejectedValue(new Error("auth failed"));

		expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: false, error: "auth failed" });
	});
});
