import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
	it("dispatches the compiled route target instead of re-resolving the requested id", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		// The catalog resolves the bare id to a provider-qualified model;
		// dispatch must serve the compiled target end to end.
		const mock = createMockModel({ provider: "openrouter", id: "mock/concrete-target" });
		mock.push({ content: ["ok"] });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: id => (id === "concrete-target" || id === "mock/concrete-target" ? mock.model : undefined),
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "concrete-target",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			expect(body.choices?.[0]?.message?.content).toContain("ok");
			expect(mock.calls.length).toBe(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not resolve when the model field is missing (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-miss-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const resolve = spyOn(RouteRegistry.prototype, "resolve");
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(res.status).toBe(400);
			expect(resolve.mock.calls.length).toBe(0);
		} finally {
			resolve.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
