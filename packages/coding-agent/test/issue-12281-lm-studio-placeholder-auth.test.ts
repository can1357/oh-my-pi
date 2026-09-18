/**
 * Regression #12281 (defect C): pressing Enter at lm-studio's "Optional: Paste
 * LM Studio API key" login prompt stores the KDL `empty-fallback` placeholder
 * (`lm-studio-local`). On base that placeholder counted as a real credential:
 * `hasAuth()` reported authenticated — the /models hub rendered the provider
 * unlocked and /login showed "logged in (api key)" — while the discovery bearer
 * gate stripped the placeholder, so every `/v1/models` and `/api/v0/models`
 * request went out WITHOUT an Authorization header. Against an auth-required
 * LM Studio the 401 was swallowed into a generic "unavailable" discovery state:
 * models silently vanished while the UI claimed the provider was signed in.
 *
 * Contracts (real AuthStorage + real ModelRegistry + in-process Bun.serve
 * emulating LM Studio — no module mocks):
 *
 *   1. A real login key reaches the wire: every discovery request (OpenAI list
 *      AND native probe) carries `Bearer <key>`.
 *   2. An empty-paste placeholder is never presented as authenticated
 *      (hasAuth / getCredentialOrigin), and the auth-required 401 surfaces as
 *      an "unauthenticated" discovery state instead of a silent empty list.
 *   3. Keyless setups keep working exactly as before: discovery goes out
 *      without Authorization and succeeds, with AND without a stored
 *      placeholder, and the models stay selectable.
 *   4. Sibling guard: a placeholder-only vllm (same `empty-fallback` pattern,
 *      but no implicit keyless mark) keeps its discovered models available.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const LM_KEY = "sk-lm-12281-test-key";
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
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-12281-"));
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

const lmModels = (registry: ModelRegistry): string[] =>
	registry
		.getAll()
		.filter(model => model.provider === "lm-studio")
		.map(model => model.id);

describe("issue #12281 — lm-studio empty-fallback placeholder vs. wire auth", () => {
	test("a real login key is attached as a Bearer token to every lm-studio discovery request", async () => {
		// Failure mode: with a genuine stored credential, discovery requests
		// leave without Authorization (the reporter's wireshark capture),
		// the server rejects them, and the model list silently empties even
		// though the UI shows the provider as signed in.
		const storage = await bootStorage("realkey");
		await storage.login("lm-studio", { onAuth: () => {}, onPrompt: async () => LM_KEY });

		const registry = bootRegistry(storage);
		await registry.refresh("online");

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
		// Failure mode (the defect): Enter at the optional-key prompt stores
		// "lm-studio-local"; the UI reported hasAuth=true (hub unlocked,
		// /login "logged in (api key)") while every request went out bare
		// and the 401 was swallowed as generic "unavailable" — models
		// silently gone with no auth-specific error.
		const storage = await bootStorage("placeholder");
		await storage.login("lm-studio", { onAuth: () => {}, onPrompt: async () => "" });

		// The placeholder itself stays stored (so /logout can remove it) —
		// what must change is the auth *status* derived from it. Violations
		// are aggregated so one failing run reports every broken leg.
		expect(await storage.peekApiKey("lm-studio")).toBe("lm-studio-local");
		const violations: string[] = [];
		if (storage.hasAuth("lm-studio")) {
			violations.push("hasAuth=true — UI claims authenticated while every wire request goes bare");
		}
		const origin = storage.getCredentialOrigin("lm-studio");
		if (origin !== undefined) {
			violations.push(`getCredentialOrigin=${JSON.stringify(origin)} — /login would show "logged in"`);
		}

		const registry = bootRegistry(storage);
		await registry.refresh("online");

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
		await freshRegistry.refresh("online");

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
		await placeholder.login("lm-studio", { onAuth: () => {}, onPrompt: async () => "" });
		const placeholderRegistry = bootRegistry(placeholder);
		await placeholderRegistry.refresh("online");

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

	test("a placeholder-only vllm login keeps its discovered models available and off the wire as a bearer", async () => {
		// Failure mode (sibling regression): vllm shares the empty-fallback
		// placeholder pattern but never receives an implicit keyless mark,
		// so filtering placeholders out of hasAuth without treating
		// placeholder-only providers as keyless would lock a working
		// keyless vllm server out of the model picker.
		const storage = await bootStorage("vllm-placeholder");
		await storage.login("vllm", { onAuth: () => {}, onPrompt: async () => "" });
		expect(await storage.peekApiKey("vllm")).toBe("vllm-local");

		const registry = bootRegistry(storage);
		await registry.refresh("online");

		expect(vllmProbeAuth.length).toBeGreaterThan(0);
		for (const auth of vllmProbeAuth) {
			expect(auth).toBeUndefined();
		}
		expect(registry.getAll().some(model => model.provider === "vllm" && model.id === "qwen3-8b")).toBe(true);
		expect(registry.getAvailable().some(model => model.provider === "vllm" && model.id === "qwen3-8b")).toBe(true);
		storage.close();
	}, 30_000);
});
