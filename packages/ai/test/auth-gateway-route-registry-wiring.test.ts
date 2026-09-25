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

async function postChat(url: string, model: string | undefined): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
		body: JSON.stringify({
			...(model === undefined ? {} : { model }),
			messages: [{ role: "user", content: "hi" }],
			stream: false,
		}),
	});
}

describe("auth-gateway RouteRegistry wiring", () => {
	it("dispatches the compiled route target for a registered virtual route id", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/route-wire" });
		mock.push({ content: ["ok"] });
		const registry = new RouteRegistry(id => (id === "mock/route-wire" ? mock.model : undefined));
		registry.register({
			id: "virtual/route",
			root: { type: "target", model: "mock/route-wire" },
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: id => (id === "mock/route-wire" ? mock.model : undefined),
			routeRegistry: registry,
			version: "test",
		});
		try {
			// The virtual id is meaningless to resolveModel: a 200 can only come
			// from the registry resolving it to the compiled mock target.
			const res = await postChat(handle.url, "virtual/route");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
			expect(body.choices?.[0]?.message?.content).toBe("ok");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unregistered route id that resolveModel cannot resolve", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-wire-miss-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			version: "test",
		});
		try {
			const res = await postChat(handle.url, "unregistered/route");
			expect(res.status).toBeGreaterThanOrEqual(400);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
