import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "../../src/config/model-registry";
import { roleCandidatePool } from "../../src/config/model-roles";
import { Settings } from "../../src/config/settings";

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

	describe("models.yml image runner models", () => {
		/** One keyless ComfyUI model, one keyless openai-images model, one ordinary chat model. */
		const modelsYml = [
			"providers:",
			"  comfy-local:",
			"    baseUrl: http://127.0.0.1:8188",
			"    auth: none",
			// Declared at the provider level: models inherit it (see images-local
			// below for the per-model form).
			"    api: comfyui",
			"    models:",
			"      - id: flux-dev",
			"        kind: image",
			"        comfyui:",
			"          generation:",
			"            path: ./workflows/flux.json",
			"            prompt:",
			'              - nodeId: "6"',
			"                input: text",
			"            width:",
			'              - nodeId: "5"',
			"                input: width",
			"            height:",
			'              - nodeId: "5"',
			"                input: height",
			'            outputNode: "9"',
			"          edit:",
			'            path: "~/comfy/flux-edit.json"',
			"            prompt:",
			'              - nodeId: "6"',
			"                input: text",
			"            images:",
			'              - nodeId: "7"',
			"                input: image",
			'            outputNode: "9"',
			"          timeoutMs: 600000",
			"  images-local:",
			"    baseUrl: http://127.0.0.1:9000/v1",
			"    auth: none",
			"    models:",
			"      - id: acme-image",
			"        kind: image",
			"        api: openai-images",
			"  chat-local:",
			"    baseUrl: http://127.0.0.1:9100/v1",
			"    auth: none",
			"    models:",
			"      - id: acme-chat",
			"        name: Acme Chat",
			"        api: openai-completions",
			"",
		].join("\n");

		function configuredRegistry(): { registry: ModelRegistry; settings: Settings } {
			const modelsPath = path.join(tmpDir, "models.yml");
			fs.writeFileSync(modelsPath, modelsYml);
			const settings = Settings.isolated();
			return { registry: new ModelRegistry(authStorage, modelsPath, { settings }), settings };
		}

		test("admits a keyless comfyui model to the image role with workflow paths anchored outside the cwd", () => {
			const { registry, settings } = configuredRegistry();

			const flux = roleCandidatePool("image", settings, registry).find(model => model.id === "flux-dev");
			expect(flux).toMatchObject({ provider: "comfy-local", kind: "image", api: "comfyui" });
			// A relative workflow path belongs to the models.yml that declared it, and
			// `~` to the home directory — never to the cwd a session happens to run in.
			expect(flux?.comfyui?.generation.path).toBe(path.join(tmpDir, "workflows", "flux.json"));
			expect(flux?.comfyui?.edit?.path).toBe(path.join(os.homedir(), "comfy", "flux-edit.json"));
			expect(flux?.comfyui?.timeoutMs).toBe(600000);
		});

		test("admits a keyless openai-images model to the image role", () => {
			const { registry, settings } = configuredRegistry();

			expect(roleCandidatePool("image", settings, registry)).toContainEqual(
				expect.objectContaining({ provider: "images-local", id: "acme-image", kind: "image" }),
			);
		});

		test("keeps image runners out of the chat catalog and leaves ordinary chat models unchanged", () => {
			const { registry, settings } = configuredRegistry();
			const isImageRunner = (model: Model) => model.id === "flux-dev" || model.id === "acme-image";

			expect(registry.getAll().some(isImageRunner)).toBe(false);
			expect(registry.getAvailable().some(isImageRunner)).toBe(false);
			expect(roleCandidatePool("image", settings, registry).some(model => model.id === "acme-chat")).toBe(false);
			const chat = registry.getAll().find(model => model.id === "acme-chat");
			expect(chat).toMatchObject({ provider: "chat-local", api: "openai-completions" });
			expect(chat?.kind).toBeUndefined();
			expect(chat?.comfyui).toBeUndefined();
		});
	});
});
