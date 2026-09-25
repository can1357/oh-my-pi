import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteRegistry, StreamCommitGate, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

async function boot(mock: MockModel) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("auth-gateway StreamCommitGate wiring", () => {
	it("holds a dead attempt's prelude and fails over through the compiled route", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({ provider: "openrouter", id: "backup-id", handler: { content: ["ok"] } });
		const resolveModel = (id: string) =>
			id === "primary-id" ? primary.model : id === "backup-id" ? backup.model : undefined;
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-commit",
			root: {
				type: "fallback",
				on: ["provider_unavailable", "provider_transient"],
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
			const res = await fetch(`${handle.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({ model: "virtual-commit", input: "hi", stream: true }),
			});
			expect(res.status).toBe(200);
			const body = await res.text();
			// The contract: the client sees the surviving attempt complete, and none
			// of the dead attempt's failure frames leak — the gate held its prelude.
			expect(backup.calls.length).toBe(1);
			expect(body).toContain("response.completed");
			expect(body).not.toContain("response.failed");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("echoes the upstream response id so previous_response_id can resolve", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-respid" });
		mock.push({ content: ["ok"], responseId: "resp_upstream_123" });
		const gw = await boot(mock);
		try {
			const res = await fetch(`${gw.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({ model: "mock/commit-respid", input: "hi", stream: true }),
			});
			expect(res.status).toBe(200);
			const body = await res.text();
			// The emitted envelope must name the provider-stored id, not a
			// locally minted one — a client's next `previous_response_id` can
			// only resolve against what upstream actually persisted.
			const created = body.match(/event: response\.created\ndata: ([^\n]+)/);
			expect(created).not.toBeNull();
			const parsed = JSON.parse(created![1]!) as { response: { id: string } };
			expect(parsed.response.id).toBe("resp_upstream_123");
			const completed = body.match(/event: response\.completed\ndata: ([^\n]+)/);
			expect(JSON.parse(completed![1]!).response.id).toBe("resp_upstream_123");
		} finally {
			await gw.close();
		}
	});

	it("does not observe the gate when the model is unknown (negative)", async () => {
		const classify = spyOn(StreamCommitGate.prototype, "classifyAndObserve");
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-miss-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "no-such-model",
					input: "hi",
					stream: true,
				}),
			});
			expect(res.status).toBe(404);
			expect(classify.mock.calls.length).toBe(0);
		} finally {
			classify.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
