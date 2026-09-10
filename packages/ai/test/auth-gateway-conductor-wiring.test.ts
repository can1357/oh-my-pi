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
