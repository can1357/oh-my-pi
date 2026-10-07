import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { runModelsListing } from "../../src/cli/models-cli";
import { ModelRegistry } from "../../src/config/model-registry";

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
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reg-"));
		authStorage = await AuthStorage.create(":memory:");
		// Construct with an explicit modelsPath inside the temp dir so the
		// constructor's #loadModels read returns "not-found" rather than
		// touching the host's ~/.omp/agent/models.yaml. isBunTestRuntime()
		// auto-stubs #fetch in the constructor.
		registry = new ModelRegistry(authStorage, path.join(tmpDir, "models.yaml"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function listModels(): Promise<{ stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += String(chunk);
			return true;
		});
		const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr += String(chunk);
			return true;
		});
		try {
			await runModelsListing({ modelRegistry: registry, cwd: tmpDir, json: true, disableExtensionDiscovery: true });
		} finally {
			out.mockRestore();
			err.mockRestore();
		}
		return { stdout, stderr };
	}

	test("warns once for unknown compat keys without disabling models or corrupting JSON output", async () => {
		const modelsPath = path.join(tmpDir, "models.yaml");
		const content = `providers:
  custom:
    baseUrl: https://example.test/v1
    auth: none
    api: openai-completions
    compat:
      supportsStroe: false
      supportsStore: false
    models:
      - id: custom-model
        compat:
          supportsStroe: false
          supportsStore: false
    modelOverrides:
      custom-model:
        compat:
          supportsStroe: false
          supportsStore: false
`;
		await Bun.write(modelsPath, content);
		await registry.refresh("offline");
		const listing = await listModels();
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("custom", "custom-model")?.compatConfig).toMatchObject({
			supportsStore: false,
			supportsStroe: false,
		});
		expect(JSON.parse(listing.stdout).models).toContainEqual(expect.objectContaining({ id: "custom-model" }));
		expect(listing.stderr.trim().split("\n")).toEqual(
			["compat", "models.0.compat", "modelOverrides.custom-model.compat"].map(
				location =>
					`Warning: Unknown compat key in ${modelsPath}: providers.custom.${location}.supportsStroe (configuration still loaded).`,
			),
		);

		await registry.refresh("offline");
		await registry.refresh("offline", { refreshCommandCredentials: true });
		// A file-watch reload can change mtime without changing any diagnostics.
		await Bun.write(modelsPath, content);
		const later = new Date(Date.now() + 1000);
		fs.utimesSync(modelsPath, later, later);
		await registry.refresh("offline");
		expect((await listModels()).stderr).toBe("");

		await Bun.write(modelsPath, content.replace("supportsStroe", "supportsStorre"));
		await registry.refresh("offline", { refreshCommandCredentials: true });
		expect((await listModels()).stderr).toBe(
			`Warning: Unknown compat key in ${modelsPath}: providers.custom.compat.supportsStorre (configuration still loaded).\n`,
		);
	});

	test("warns for nested fixed-field compat keys but accepts open extraBody payloads", async () => {
		await Bun.write(
			path.join(tmpDir, "models.yaml"),
			JSON.stringify({
				providers: {
					custom: {
						compat: {
							supportsStore: false,
							promptCacheMode: "explicit",
							openRouterRouting: { only: ["example"], onyl: ["example"] },
							vercelGatewayRouting: { order: ["example"], oder: [] },
							reasoningEffortMap: { high: "high", hgh: "high" },
							whenThinking: {
								supportsStroe: false,
								extraBody: { arbitrary: { nested: true } },
								whenThinking: { supportsStore: false },
							},
							extraBody: { supportsStroe: false, arbitrary: { nested: true } },
							defaultLevel: "high",
							contextWindowFloor: 131072,
						},
					},
				},
			}),
		);
		await registry.refresh("offline");
		expect(registry.getError()).toBeUndefined();
		const listing = await listModels();
		expect(listing.stderr.trim().split("\n")).toEqual(
			[
				"openRouterRouting.onyl",
				"vercelGatewayRouting.oder",
				"reasoningEffortMap.hgh",
				"whenThinking.supportsStroe",
				"whenThinking.whenThinking",
				"defaultLevel",
				"contextWindowFloor",
			].map(
				key =>
					`Warning: Unknown compat key in ${path.join(tmpDir, "models.yaml")}: providers.custom.compat.${key} (configuration still loaded).`,
			),
		);
	});

	test("does not warn for declared compat keys or runtime extension compatibility fields", async () => {
		await Bun.write(
			path.join(tmpDir, "models.yaml"),
			JSON.stringify({
				providers: {
					custom: {
						compat: {
							supportsStore: false,
							promptCacheMode: "explicit",
							extraBody: { custom: { nested: true } },
							supportsSamplingParams: false,
							streamFirstEventTimeoutMs: 0,
							supportsContextManagement: false,
							whenThinking: {
								omitReasoningEffort: false,
								reasoningDisableMode: "none",
								supportsSamplingParams: false,
							},
						},
					},
				},
			}),
		);
		await registry.refresh("offline");
		const compat = { supportsStore: false, extensionSpecific: true };
		registry.registerProvider("extension", { compat, api: "extension-api" });
		expect(registry.getError()).toBeUndefined();
		expect((await listModels()).stderr).toBe("");
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
		vi.spyOn(registry, "getProviderHeaders").mockResolvedValue({ "x-test": "value" });

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
