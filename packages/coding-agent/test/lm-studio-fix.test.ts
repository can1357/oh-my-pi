import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry LM Studio Fixes", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-lm-studio-fixes-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("auto-discovers both ollama and lm-studio models independently", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url.includes(":11434/api/tags")) {
				return Promise.resolve(
					new Response(JSON.stringify({ models: [{ name: "ollama-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url.includes(":1234/v1/models")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "lm-studio-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const allModels = registry.getAll();
		expect(allModels.some(m => m.provider === "ollama" && m.id === "ollama-model")).toBe(true);
		expect(allModels.some(m => m.provider === "lm-studio" && m.id === "lm-studio-model")).toBe(true);

		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "ollama")).toBe(true);
		expect(available.some(m => m.provider === "lm-studio")).toBe(true);
	});

	test("marks LM Studio native VLM models as image-capable", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "qwen/qwen3.6-27b",
									type: "vlm",
									capabilities: ["tool_use"],
									max_context_length: 262144,
								},
								{ id: "plain-llm", type: "llm" },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{ id: "qwen/qwen3.6-27b", object: "model" },
								{ id: "plain-llm", object: "model" },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const vision = registry.find("lm-studio", "qwen/qwen3.6-27b");
		const text = registry.find("lm-studio", "plain-llm");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(262144);
		expect(text?.input).toEqual(["text"]);
	});

	test("LM_STUDIO_BASE_URL can target any local OpenAI-compatible /v1 server", async () => {
		const originalBaseUrl = Bun.env.LM_STUDIO_BASE_URL;
		Bun.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:11434/v1";
		let requestedUrl = "";
		try {
			const fetchMock: FetchImpl = input => {
				const url = String(input);
				if (url.includes(":11434/v1/models")) {
					requestedUrl = url;
					return Promise.resolve(
						new Response(JSON.stringify({ data: [{ id: "omlx-model" }] }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return Promise.resolve(new Response(null, { status: 404 }));
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh();

			expect(requestedUrl).toBe("http://127.0.0.1:11434/v1/models");
			// Implicit discovery is still registered under the built-in lm-studio provider even when the base URL points to oMLX.
			expect(registry.getAll().some(m => m.provider === "lm-studio" && m.id === "omlx-model")).toBe(true);
		} finally {
			if (originalBaseUrl === undefined) {
				delete Bun.env.LM_STUDIO_BASE_URL;
			} else {
				Bun.env.LM_STUDIO_BASE_URL = originalBaseUrl;
			}
		}
	});

	test("refreshSelectedModelMetadata tracks the LM Studio JIT-load lifecycle", async () => {
		let state: "not-loaded" | "loaded" = "not-loaded";
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "big-model",
									type: "llm",
									state,
									max_context_length: 262144,
									loaded_context_length: state === "loaded" ? 81920 : null,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "big-model", object: "model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		// Discovery while unloaded records the architectural ceiling.
		const discovered = registry.find("lm-studio", "big-model");
		expect(discovered?.contextWindow).toBe(262144);

		// JIT load: refreshing the selected model adopts the loaded window.
		state = "loaded";
		const loaded = await registry.refreshSelectedModelMetadata(discovered!);
		expect(loaded.contextWindow).toBe(81920);
		expect(registry.find("lm-studio", "big-model")?.contextWindow).toBe(81920);

		// Unload: the runtime-derived window is not retained; it falls back to max.
		state = "not-loaded";
		const unloaded = await registry.refreshSelectedModelMetadata(loaded);
		expect(unloaded.contextWindow).toBe(262144);
		expect(registry.find("lm-studio", "big-model")?.contextWindow).toBe(262144);
	});

	test("first successful inference refreshes the live session context window", async () => {
		let loaded = false;
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: "big-model",
									type: "llm",
									state: loaded ? "loaded" : "not-loaded",
									max_context_length: 262144,
									loaded_context_length: loaded ? 81920 : null,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: "big-model", object: "model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		};

		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await modelRegistry.refresh();
		expect(modelRegistry.find("lm-studio", "big-model")?.contextWindow).toBe(262144);

		// Model registered while unloaded, then JIT-loaded on the first request.
		loaded = true;

		// A MockModel carrying the LM Studio provider/id/baseUrl drives the agent
		// loop and fires onResponse (via responseHeaders) with a 200, exactly like
		// a real provider returning after the JIT load completes.
		const mockModel = createMockModel({
			provider: "lm-studio",
			id: "big-model",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 262144,
			responses: [{ content: ["ok"], responseHeaders: {} }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mockModel, systemPrompt: ["Test"], tools: [] },
			streamFn: mockModel.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		try {
			expect(session.model?.contextWindow).toBe(262144);
			await session.prompt("hi");
			await session.waitForIdle();
			// The first successful inference re-probed the runtime window and folded
			// it into the live session model without a manual refresh.
			expect(session.model?.contextWindow).toBe(81920);
		} finally {
			await session.dispose();
		}
	});
});

/**
 * lm-studio's optional-key login stores the `empty-fallback` placeholder
 * (`lm-studio-local`) when the user just presses Enter. That placeholder must
 * never count as a real credential, while a real key must reach the wire.
 * Runs real AuthStorage + ModelRegistry against an in-process Bun.serve
 * emulating LM Studio:
 *
 *   1. A real login key is sent as `Bearer <key>` on every discovery request
 *      (OpenAI list AND native probe).
 *   2. An empty-paste placeholder is never presented as authenticated, and an
 *      auth-required 401 surfaces as an "unauthenticated" discovery state.
 *   3. Keyless setups discover without Authorization, with and without a
 *      stored placeholder, and the models stay selectable.
 *   4. A placeholder-only vllm (same `empty-fallback` pattern, no implicit
 *      keyless mark) stays available and resolves request auth to kNoAuth.
 */
describe("empty-fallback login placeholder vs. wire auth", () => {
	const LM_KEY = "sk-lm-test-key";
	const LM_MODEL = { id: "qwen3-8b", object: "model", owned_by: "local" };
	const VLLM_DEFAULT_MODELS_URL = "http://127.0.0.1:8000/v1/models";

	/** Every /models request that reached the emulated server, in order. */
	const wire: Array<{ path: string; auth: string | undefined }> = [];
	/** Authorization headers seen by the synthetic built-in vllm probe. */
	const vllmProbeAuth: Array<string | undefined> = [];
	let authRequired = true;

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			const auth = req.headers.get("authorization") ?? undefined;
			if (url.pathname.endsWith("/models")) wire.push({ path: url.pathname, auth });
			const authorized = !authRequired || auth === `Bearer ${LM_KEY}`;
			if (url.pathname === "/v1/models") {
				return authorized
					? Response.json({ data: [LM_MODEL] })
					: Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
			}
			if (url.pathname === "/api/v0/models") {
				return authorized
					? Response.json({
							data: [
								{
									id: LM_MODEL.id,
									type: "llm",
									capabilities: [],
									state: "not-loaded",
									max_context_length: 32768,
								},
							],
						})
					: Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
			}
			return new Response(null, { status: 404 });
		},
	});
	const serverOrigin = `http://127.0.0.1:${server.port}`;

	/**
	 * Routes requests for the emulated LM Studio to the real in-process server and
	 * answers everything else (models.dev catalog fallbacks, sibling local probes,
	 * the fixed-port built-in vllm probe) locally, so the suite is hermetic and
	 * never depends on ambient network or services.
	 */
	const hermeticFetch: FetchImpl = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith(`${serverOrigin}/`)) {
			return fetch(url, init);
		}
		if (url === VLLM_DEFAULT_MODELS_URL) {
			const headers = init?.headers;
			const auth =
				headers instanceof Headers
					? (headers.get("Authorization") ?? undefined)
					: (headers as Record<string, string> | undefined)?.Authorization;
			vllmProbeAuth.push(auth);
			return Promise.resolve(Response.json({ data: [{ id: "qwen3-8b", max_model_len: 32768 }] }));
		}
		return Promise.resolve(new Response(null, { status: 404 }));
	};

	const MANAGED_ENV_KEYS = [
		"LM_STUDIO_BASE_URL",
		"LM_STUDIO_API_KEY",
		"OLLAMA_BASE_URL",
		"OLLAMA_HOST",
		"OLLAMA_API_KEY",
		"LLAMA_CPP_BASE_URL",
		"LLAMA_CPP_API_KEY",
		"VLLM_BASE_URL",
		"VLLM_API_KEY",
	] as const;
	const savedEnv = new Map<string, string | undefined>();

	beforeAll(() => {
		for (const key of MANAGED_ENV_KEYS) savedEnv.set(key, Bun.env[key]);
		Bun.env.LM_STUDIO_BASE_URL = `${serverOrigin}/v1`;
		// Point sibling implicit providers at a dead port so their probes fail fast
		// and never touch a real local service.
		Bun.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
		Bun.env.LLAMA_CPP_BASE_URL = "http://127.0.0.1:1";
		for (const key of ["LM_STUDIO_API_KEY", "OLLAMA_API_KEY", "LLAMA_CPP_API_KEY", "VLLM_API_KEY"] as const) {
			delete Bun.env[key];
		}
	});

	afterAll(() => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		server.stop(true);
	});

	let tempDir = "";

	beforeEach(() => {
		wire.length = 0;
		vllmProbeAuth.length = 0;
		authRequired = true;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lm-studio-placeholder-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	async function bootStorage(name: string): Promise<AuthStorage> {
		return await AuthStorage.create(path.join(tempDir, `${name}.db`));
	}

	function bootRegistry(storage: AuthStorage): ModelRegistry {
		return new ModelRegistry(storage, path.join(tempDir, "models.yml"), {
			cacheDbPath: path.join(tempDir, "models.db"),
			fetch: hermeticFetch,
		});
	}

	/**
	 * Refresh only lm-studio discovery. A full `refresh("online")` also rebuilds
	 * every built-in catalog and its SQLite cache synchronously on this event loop,
	 * which delays the in-process server's reply; on a loaded CI runner that
	 * pushed the 10s discovery timeout ahead of the 401 this suite asserts on.
	 */
	const refreshLmStudio = (registry: ModelRegistry): Promise<void> =>
		registry.refreshDiscoverableProviders(["lm-studio"], "online");

	const lmModels = (registry: ModelRegistry): string[] =>
		registry
			.getAll()
			.filter(model => model.provider === "lm-studio")
			.map(model => model.id);

	test("a real login key is attached as a Bearer token to every lm-studio discovery request", async () => {
		// Failure mode: with a genuine stored credential, discovery requests
		// leave without Authorization, the server rejects them, and the model
		// list silently empties even though the UI shows the provider as signed in.
		const storage = await bootStorage("realkey");
		await storage.oauth.login("lm-studio", { onAuth: () => {}, onPrompt: async () => LM_KEY });

		const registry = bootRegistry(storage);
		await refreshLmStudio(registry);

		const requests = wire.filter(w => w.path === "/v1/models" || w.path === "/api/v0/models");
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.auth).toBe(`Bearer ${LM_KEY}`);
		}
		expect(lmModels(registry)).toContain("qwen3-8b");
		expect(registry.getProviderDiscoveryState("lm-studio")?.status).toBe("ok");
		storage.close();
	}, 30_000);

	test("an empty-paste placeholder never presents lm-studio as authenticated while discovery 401s surface as an auth error", async () => {
		// Failure mode: Enter at the optional-key prompt stores
		// "lm-studio-local"; the UI reported hasAuth=true (hub unlocked,
		// /login "logged in (api key)") while every request went out bare
		// and the 401 was swallowed as generic "unavailable" — models
		// silently gone with no auth-specific error.
		const storage = await bootStorage("placeholder");
		await storage.oauth.login("lm-studio", { onAuth: () => {}, onPrompt: async () => "" });

		// The placeholder itself stays stored (so /logout can remove it) —
		// what must change is the auth *status* derived from it. Violations
		// are aggregated so one failing run reports every broken leg.
		expect(await storage.keys.peek("lm-studio")).toBe("lm-studio-local");
		const violations: string[] = [];
		if (storage.keys.source("lm-studio") !== undefined) {
			violations.push("hasAuth=true — UI claims authenticated while every wire request goes bare");
		}
		const origin = storage.keys.source("lm-studio");
		if (origin !== undefined) {
			violations.push(`getCredentialOrigin=${JSON.stringify(origin)} — /login would show "logged in"`);
		}
		const source = storage.keys.describe("lm-studio");
		if (source !== undefined) {
			violations.push(`describeCredentialSource=${JSON.stringify(source)} — /session would show an auth source`);
		}

		const registry = bootRegistry(storage);
		await refreshLmStudio(registry);

		// Against an auth-required server the keyless assumption fails: the
		// bare requests are rejected and the rejection must surface as an
		// auth-specific state, not a silent empty list.
		const state = registry.getProviderDiscoveryState("lm-studio");
		if (state?.status !== "unauthenticated") {
			violations.push(
				`discovery status=${state?.status} error=${JSON.stringify(state?.error)} — 401 swallowed as a generic outage`,
			);
		}
		if (lmModels(registry).length !== 0) {
			violations.push(`models=${JSON.stringify(lmModels(registry))} — expected none against a 401ing server`);
		}
		storage.close();
		expect(violations).toEqual([]);
	}, 30_000);

	test("keyless lm-studio keeps discovering without an Authorization header, with and without a stored placeholder", async () => {
		// Failure mode (overcorrection): if placeholder handling started
		// attaching a fake bearer, refused to probe, or hid the provider
		// from the available list, keyless LM Studio setups — which must
		// keep working exactly as before — would break with 401s or an
		// empty model picker.
		authRequired = false;

		// Fresh setup: no login ever performed.
		const fresh = await bootStorage("keyless-fresh");
		const freshRegistry = bootRegistry(fresh);
		await refreshLmStudio(freshRegistry);

		const freshRequests = wire.filter(w => w.path === "/v1/models" || w.path === "/api/v0/models");
		expect(freshRequests.length).toBeGreaterThan(0);
		for (const request of freshRequests) {
			expect(request.auth).toBeUndefined();
		}
		expect(lmModels(freshRegistry)).toContain("qwen3-8b");
		expect(
			freshRegistry.getAvailable().some(model => model.provider === "lm-studio" && model.id === "qwen3-8b"),
		).toBe(true);
		fresh.close();

		// Placeholder-only setup: empty paste against a keyless server.
		wire.length = 0;
		const placeholder = await bootStorage("keyless-placeholder");
		await placeholder.oauth.login("lm-studio", { onAuth: () => {}, onPrompt: async () => "" });
		const placeholderRegistry = bootRegistry(placeholder);
		await refreshLmStudio(placeholderRegistry);

		const placeholderRequests = wire.filter(w => w.path === "/v1/models" || w.path === "/api/v0/models");
		expect(placeholderRequests.length).toBeGreaterThan(0);
		for (const request of placeholderRequests) {
			expect(request.auth).toBeUndefined();
		}
		expect(lmModels(placeholderRegistry)).toContain("qwen3-8b");
		expect(
			placeholderRegistry.getAvailable().some(model => model.provider === "lm-studio" && model.id === "qwen3-8b"),
		).toBe(true);
		placeholder.close();
	}, 30_000);

	test("a placeholder-only vllm login keeps discovered models requestable without bearer auth", async () => {
		// Failure mode: vllm shares the empty-fallback pattern but receives no
		// implicit keyless mark. Availability recognizes the stored placeholder
		// as keyless, while request credential resolution dropped it and
		// returned undefined, so AgentSession rejected the prompt before any
		// request reached the local server.
		const storage = await bootStorage("vllm-placeholder");
		await storage.oauth.login("vllm", { onAuth: () => {}, onPrompt: async () => "" });
		expect(await storage.keys.peek("vllm")).toBe("vllm-local");

		const registry = bootRegistry(storage);
		await registry.refresh("online");

		expect(vllmProbeAuth.length).toBeGreaterThan(0);
		for (const auth of vllmProbeAuth) {
			expect(auth).toBeUndefined();
		}
		const model = registry.find("vllm", "qwen3-8b");
		expect(model).toBeDefined();
		if (!model) throw new Error("Expected discovered vllm model");
		expect(await registry.getApiKey(model)).toBe(kNoAuth);
		// Explicit selection (`--model`, /model, setModel) gates on these.
		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(registry.hasConcreteAuth("vllm")).toBe(true);
		expect(registry.getAll().some(entry => entry.provider === "vllm" && entry.id === "qwen3-8b")).toBe(true);
		expect(registry.getAvailable().some(entry => entry.provider === "vllm" && entry.id === "qwen3-8b")).toBe(true);
		storage.close();
	}, 30_000);
});
