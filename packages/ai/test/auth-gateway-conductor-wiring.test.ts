import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteRegistry, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway conductor wiring", () => {
	it("fails over from primary to backup on provider_unavailable", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(backup.calls.length).toBe(1);
			const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			expect(body.choices?.[0]?.message?.content).toBe("ok");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an error when primary fails and backup is not registered (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-neg-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const resolveModel = (id: string) => (id === "primary-id" ? primary.model : undefined);
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(502);
			expect(res.status).not.toBe(404);
			expect(primary.calls.length).toBe(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("fails over stream:true when primary is unavailable before any output", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-stream-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});
			expect(res.status).toBe(200);
			expect(backup.calls.length).toBe(1);
			expect(primary.calls.length).toBe(1);
			const text = await res.text();
			expect(text).toContain("ok");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not call backup after completeSimple usage then error (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-usage-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: {
				content: ["partial"],
				usage: { input: 10, output: 4 },
				stopReason: "error",
				errorMessage: "service unavailable",
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).not.toBe(200);
			expect(backup.calls.length).toBe(0);
			expect(primary.calls.length).toBe(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retries the same target once on credential_quota then falls back", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-quota-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(primary.calls.length).toBe(2);
			expect(backup.calls.length).toBe(1);
			const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			expect(body.choices?.[0]?.message?.content).toBe("ok");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not use a provider_unavailable backup for credential_quota after sibling retry (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-quota-neg-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).not.toBe(200);
			expect(primary.calls.length).toBe(2);
			expect(backup.calls.length).toBe(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("prefers the remembered prompt-cache model on the next matching request", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-cache-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		const post = async (promptCacheKey: string): Promise<Response> =>
			fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
					prompt_cache_key: promptCacheKey,
				}),
			});
		try {
			const first = await post("k");
			expect(first.status).toBe(200);
			expect(primary.calls.length).toBe(1);
			expect(backup.calls.length).toBe(1);

			const second = await post("k");
			expect(second.status).toBe(200);
			expect(primary.calls.length).toBe(1);
			expect(backup.calls.length).toBe(2);

			const other = await post("other");
			expect(other.status).toBe(200);
			expect(primary.calls.length).toBe(2);
			expect(primary.calls.length).not.toBe(1);
			expect(backup.calls.length).toBe(3);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("prefers remembered model when cache identity is only a header (negative if remember ignores headers)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-cache-hdr-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		const post = async (cacheKey: string): Promise<Response> =>
			fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer t",
					"x-prompt-cache-key": cacheKey,
				},
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
		try {
			const first = await post("k");
			expect(first.status).toBe(200);
			expect(primary.calls.length).toBe(1);
			expect(backup.calls.length).toBe(1);

			const second = await post("k");
			expect(second.status).toBe(200);
			expect(primary.calls.length).toBe(1);
			expect(backup.calls.length).toBe(2);

			const other = await post("other");
			expect(other.status).toBe(200);
			expect(primary.calls.length).toBe(2);
			expect(primary.calls.length).not.toBe(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("records each non-streaming provider failure once so two failovers do not open the circuit", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-health-once-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		const post = async (): Promise<Response> =>
			fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					prompt_cache_key: crypto.randomUUID(),
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
		try {
			expect((await post()).status).toBe(200);
			expect((await post()).status).toBe(200);
			// Two single-recorded failures leave the circuit degraded, so the third
			// request still attempts primary. Double-recording would have opened it.
			const third = await post();
			expect(third.status).toBe(200);
			expect(primary.calls.length).toBe(3);
			expect(backup.calls.length).toBe(3);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("opens the health circuit for repeated model_unavailable failures", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-model-health-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const err = Object.assign(new Error("model not found"), { status: 404 });
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw err;
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: { content: ["ok"] },
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["model_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		const post = async (): Promise<Response> =>
			fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					prompt_cache_key: crypto.randomUUID(),
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
		try {
			expect((await post()).status).toBe(200);
			expect((await post()).status).toBe(200);
			expect((await post()).status).toBe(200);
			expect(primary.calls.length).toBe(3);
			const fourth = await post();
			expect(fourth.status).toBe(200);
			// Circuit open: primary skipped, only backup runs.
			expect(primary.calls.length).toBe(3);
			expect(backup.calls.length).toBe(4);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("resets sibling exhaustion when falling back so the next target gets a sibling retry", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-sibling-reset-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.");
			},
		});
		const backup = createMockModel({
			provider: "openrouter",
			id: "backup-id",
			handler: () => {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.");
			},
		});
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-impl",
			root: {
				type: "fallback",
				on: ["credential_quota"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "backup-id" },
				],
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			routeRegistry: registry,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-impl",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).not.toBe(200);
			expect(primary.calls.length).toBe(2);
			// Without resetting siblingsExhausted, backup would only be attempted once.
			expect(backup.calls.length).toBe(2);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

it("uses normalized image content to select conditional targets across both gateway paths", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conditional-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const vision = createMockModel({ provider: "openrouter", id: "vision", handler: { content: ["vision"] } });
	vision.model.input.push("image");
	const text = createMockModel({ provider: "openrouter", id: "text", handler: { content: ["text"] } });
	const resolveModel = (id: string) => (id === "vision" ? vision.model : id === "text" ? text.model : undefined);
	const registry = new RouteRegistry(resolveModel);
	registry.register({
		id: "conditional",
		root: {
			type: "conditional",
			when: { vision: true },
			children: [
				{ type: "target", model: "vision" },
				{ type: "target", model: "text" },
			],
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel,
		routeRegistry: registry,
		version: "test",
	});
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
	const post = (pathname: string, body: unknown) =>
		fetch(`${gateway.url}${pathname}`, {
			method: "POST",
			headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		expect(
			(
				await post("/v1/chat/completions", {
					model: "conditional",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
					prompt_cache_key: "same",
				})
			).status,
		).toBe(200);
		expect(
			(
				await post("/v1/chat/completions", {
					model: "conditional",
					messages: [
						{
							role: "user",
							content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }],
						},
					],
					stream: false,
					prompt_cache_key: "same",
				})
			).status,
		).toBe(200);
		expect(
			(
				await post("/v1/pi/stream", {
					modelId: "conditional",
					context: {
						messages: [
							{ role: "user", content: [{ type: "image", data: image, mimeType: "image/png" }], timestamp: 0 },
						],
					},
					stream: false,
				})
			).status,
		).toBe(200);
		expect(text.calls).toHaveLength(1);
		expect(vision.calls).toHaveLength(2);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it("shares the round-robin cursor across chat and native HTTP requests", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-rr-http-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const seen: string[] = [];
	const models = ["a", "b", "c"].map(id =>
		createMockModel({
			provider: "openrouter",
			id,
			handler: () => {
				seen.push(id);
				return { content: [id] };
			},
		}),
	);
	const resolveModel = (id: string) => models.find(m => m.model.id === id)?.model;
	const registry = new RouteRegistry(resolveModel);
	registry.register({
		id: "rr",
		root: { type: "balance", strategy: "rr", children: models.map(m => ({ type: "target", model: m.model.id })) },
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel,
		routeRegistry: registry,
		version: "test",
	});
	try {
		for (let i = 0; i < 6; i++) {
			const native = i % 2 === 1;
			const body = native
				? {
						modelId: "rr",
						context: { messages: [{ role: "user", content: `request ${i}`, timestamp: 0 }] },
						stream: false,
					}
				: { model: "rr", messages: [{ role: "user", content: `request ${i}` }], stream: false };
			const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(seen).toEqual(["a", "b", "c", "a", "b", "c"]);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it("recovers the primary after a cached backup becomes unavailable", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-affinity-recovery-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	let primaryCalls = 0,
		backupCalls = 0;
	const primary = createMockModel({
		provider: "openrouter",
		id: "primary",
		handler: () => {
			if (++primaryCalls === 1) throw new Error("service unavailable");
			return { content: ["recovered"] };
		},
	});
	const backup = createMockModel({
		provider: "openrouter",
		id: "backup",
		handler: () => {
			if (++backupCalls > 1) throw new Error("service unavailable");
			return { content: ["backup"] };
		},
	});
	const resolveModel = (id: string) => (id === "primary" ? primary.model : id === "backup" ? backup.model : undefined);
	const registry = new RouteRegistry(resolveModel);
	registry.register({
		id: "route",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "primary" },
				{ type: "target", model: "backup" },
			],
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel,
		routeRegistry: registry,
		version: "test",
	});
	try {
		for (let i = 0; i < 2; i++) {
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "route",
					messages: [{ role: "user", content: "hello" }],
					stream: false,
					prompt_cache_key: "stable",
				}),
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(primaryCalls).toBe(2);
		expect(backupCalls).toBe(2);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
