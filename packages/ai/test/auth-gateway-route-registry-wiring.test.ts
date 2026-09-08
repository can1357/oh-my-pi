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

describe("auth-gateway RouteRegistry wiring", () => {
	it("dispatches a registered virtual route to its compiled target", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const concrete = createMockModel({ provider: "openrouter", id: "concrete/route-wire" });
		concrete.push({ content: ["ok"] });
		const resolveModel = (id: string) => (id === "concrete/route-wire" ? concrete.model : undefined);
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual/route-wire",
			root: { type: "target", model: "concrete/route-wire" },
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
					model: "virtual/route-wire",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(concrete.calls.length).toBe(1);
			const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			expect(body.choices?.[0]?.message?.content).toBe("ok");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("404s when the virtual route id is not registered (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-miss-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const resolveModel = () => undefined;
		const registry = new RouteRegistry(resolveModel);
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
					model: "virtual/missing",
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(res.status).toBe(404);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
