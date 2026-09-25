import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { StreamCommitGate, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

async function boot(idOrMock: string | MockModel) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const mock =
		typeof idOrMock === "string" ? createMockModel({ provider: "openrouter", id: idOrMock }) : idOrMock;
	if (typeof idOrMock === "string") mock.push({ content: ["hello"] });
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


async function postResponses(url: string, model: string): Promise<Response> {
	return fetch(`${url}/v1/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
		body: JSON.stringify({ model, input: "hi", stream: true }),
	});
}

describe("auth-gateway StreamCommitGate wiring", () => {
	it("observes encoded Responses SSE through StreamCommitGate", async () => {
		const classify = spyOn(StreamCommitGate.prototype, "classifyAndObserve");
		const gw = await boot("mock/commit-responses");
		try {
			const res = await fetch(`${gw.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/commit-responses",
					input: "hi",
					stream: true,
				}),
			});
			expect(res.status).toBe(200);
			await res.text();
			expect(classify.mock.calls.length).toBeGreaterThan(0);
		} finally {
			classify.mockRestore();
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
