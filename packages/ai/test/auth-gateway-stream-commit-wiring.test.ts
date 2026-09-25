import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { StreamCommitGate, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

async function boot(mock: ReturnType<typeof createMockModel>) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
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
	it("holds the Responses prelude and fails over without exposing the dead attempt", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-failover" });
		// Attempt 1 dies pre-commit with a retryable terminal; attempt 2 succeeds.
		mock.push({ throw: new Error("upstream exploded") });
		mock.push({ content: ["recovered"] });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-failover");
			expect(res.status).toBe(200);
			const body = await res.text();
			// The failover is transparent: the client sees only the surviving
			// attempt — one prelude, the recovery content, and no failed frame
			// or error text from the discarded first attempt.
			expect(mock.calls.length).toBe(2);
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
