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

for (const endpoint of ["/v1/chat/completions", "/v1/pi/stream"]) {
	it(`dispatches the selected weighted target on ${endpoint}`, async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-weight-review-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const first = createMockModel({ provider: "openrouter", id: "light", handler: { content: ["wrong"] } });
		const selected = createMockModel({ provider: "openrouter", id: "heavy", handler: { content: ["selected"] } });
		const resolveModel = (id: string) => (id === "light" ? first.model : id === "heavy" ? selected.model : undefined);
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "weighted",
			root: {
				type: "balance",
				strategy: "weighted",
				children: [
					{ type: "target", model: "light", weight: 1 },
					{ type: "target", model: "heavy", weight: 10 },
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
			const body =
				endpoint === "/v1/pi/stream"
					? {
							modelId: "weighted",
							context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
							stream: false,
						}
					: { model: "weighted", messages: [{ role: "user", content: "hello" }], stream: false };
			const response = await fetch(`${handle.url}${endpoint}`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			await response.text();
			expect(selected.calls.length).toBe(1);
			expect(first.calls.length).toBe(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}

it("enforces deployment affinity using the resolved model endpoint on both gateway paths", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-deployment-review-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const model = createMockModel({ provider: "openrouter", id: "endpoint", handler: { content: ["ok"] } });
	const resolveModel = (id: string) => (id === "endpoint" ? model.model : undefined);
	const registry = new RouteRegistry(resolveModel);
	for (const matching of [true, false])
		registry.register({
			id: matching ? "matching" : "foreign",
			affinity: "required",
			portability: { scope: "deployment", origin: matching ? model.model.baseUrl : "https://foreign.example/v1" },
			root: { type: "target", model: "endpoint" },
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
		for (const native of [false, true])
			for (const matching of [true, false]) {
				const route = matching ? "matching" : "foreign";
				const body = native
					? {
							modelId: route,
							context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
							stream: false,
						}
					: { model: route, messages: [{ role: "user", content: "hello" }], stream: false };
				const response = await fetch(`${handle.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
					method: "POST",
					headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(response.status === 200).toBe(matching);
				await response.text();
			}
		expect(model.calls.length).toBe(2);
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
