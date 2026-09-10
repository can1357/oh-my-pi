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
});
