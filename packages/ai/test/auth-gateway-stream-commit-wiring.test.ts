import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteRegistry, StreamCommitGate, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

async function boot(
	mock: ReturnType<typeof createMockModel>,
	opts: { resolveModel?: (id: string) => ReturnType<typeof createMockModel>["model"] | undefined; routeRegistry?: RouteRegistry } = {},
) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: opts.resolveModel ?? (() => mock.model),
		routeRegistry: opts.routeRegistry,
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

async function postResponses(url: string, model: string): Promise<Response> {
	return fetch(`${url}/v1/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
		body: JSON.stringify({ model, input: "hi", stream: true }),
	});
}

describe("auth-gateway StreamCommitGate wiring", () => {
	it("holds the Responses prelude and fails over without exposing the dead attempt", async () => {
		// The conductor owns retry policy on this branch: provider-transient
		// pre-commit terminals fail over through the route's fallback target.
		const primary = createMockModel({ provider: "openrouter", id: "mock/commit-primary" });
		primary.push({ throw: new Error("upstream exploded") });
		const backup = createMockModel({ provider: "openrouter", id: "mock/commit-backup" });
		backup.push({ content: ["recovered"] });
		const registry = new RouteRegistry(
			id => (id === "mock/commit-primary" ? primary.model : id === "mock/commit-backup" ? backup.model : undefined),
		);
		registry.register({
			id: "mock/route",
			root: {
				type: "fallback",
				on: ["provider_transient"],
				children: [
					{ type: "target", model: "mock/commit-primary" },
					{ type: "target", model: "mock/commit-backup" },
				],
			},
		});
		const gw = await boot(primary, {
			resolveModel: id =>
				id === "mock/commit-primary" ? primary.model : id === "mock/commit-backup" ? backup.model : undefined,
			routeRegistry: registry,
		});
		try {
			const res = await postResponses(gw.url, "mock/route");
			expect(res.status).toBe(200);
			const body = await res.text();
			// The failover is transparent: the client sees only the surviving
			// attempt — one prelude, the recovery content, and no failed frame
			// or error text from the discarded first attempt.
			expect(primary.calls.length).toBe(1);
			expect(backup.calls.length).toBe(1);
			expect(body).toContain("recovered");
			expect(body).not.toContain("upstream exploded");
			expect(body.match(/event: response\.created/g)?.length).toBe(1);
			expect(body).not.toContain("event: response.failed");
			expect(body).toContain("event: response.completed");
		} finally {
			await gw.close();
		}
	});

	it("forwards the surviving attempt unchanged once output commits", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-responses" });
		mock.push({ content: ["hello"] });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-responses");
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("hello");
			expect(mock.calls.length).toBe(1);
		} finally {
			await gw.close();
		}
	});

	it("echoes the upstream response id so previous_response_id can resolve", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-respid" });
		mock.push({ content: ["ok"], responseId: "resp_upstream_123" });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-respid");
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
