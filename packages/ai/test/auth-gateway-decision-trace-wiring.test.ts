import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteDecisionTraceLog, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway decision-trace wiring", () => {
	it("records dispatched when a credential is available", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-trace-wire-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/trace-wire" });
		mock.push({ content: ["ok"] });
		const traces = new RouteDecisionTraceLog();
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			decisionTraces: traces,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/trace-wire",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			const recorded = traces.list().filter(t => t.routeId === "mock/trace-wire");
			expect(recorded.some(t => t.disposition === "dispatched")).toBe(true);
			expect(recorded.every(t => t.reason === undefined)).toBe(true);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("serves a recorded trace over GET /v1/executions/:id", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-trace-exec-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/trace-exec" });
		mock.push({ content: ["ok"] });
		const traces = new RouteDecisionTraceLog();
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			decisionTraces: traces,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/trace-exec",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			await res.text();
			const recorded = traces.list().filter(tr => tr.routeId === "mock/trace-exec");
			expect(recorded.length).toBeGreaterThan(0);
			const id = recorded[0]!.requestId;
			const got = await fetch(`${handle.url}/v1/executions/${id}`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(got.status).toBe(200);
			expect(await got.json()).toEqual(expect.objectContaining({ requestId: id, routeId: "mock/trace-exec" }));
			const missing = await fetch(`${handle.url}/v1/executions/does-not-exist`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(missing.status).toBe(404);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("records skipped credential_unavailable when no key exists (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-trace-skip-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const mock = createMockModel({ provider: "openrouter", id: "mock/trace-skip" });
		const traces = new RouteDecisionTraceLog();
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			decisionTraces: traces,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/trace-skip",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(res.status).toBe(401);
			const recorded = traces.list().filter(t => t.routeId === "mock/trace-skip");
			const requestId = res.headers.get("x-request-id");
			expect(requestId).toBeTruthy();
			expect(res.headers.get("request-id")).toBe(requestId);
			expect(recorded).toHaveLength(1);
			expect(requestId).toBe(recorded[0]!.requestId);
			expect(recorded).toEqual([
				expect.objectContaining({
					disposition: "skipped",
					reason: "credential_unavailable",
					selectedTarget: "mock/trace-skip",
				}),
			]);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns the traced request ID when pi-native credential lookup fails", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-trace-lookup-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const mock = createMockModel({ provider: "openrouter", id: "mock/trace-lookup" });
		vi.spyOn(storage, "getApiKey").mockRejectedValue(new Error("credential broker unavailable"));
		const traces = new RouteDecisionTraceLog();
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			decisionTraces: traces,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					modelId: "mock/trace-lookup",
					context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
					stream: false,
				}),
			});
			expect(res.status).toBe(502);
			const recorded = traces.list().filter(t => t.routeId === "mock/trace-lookup");
			const requestId = res.headers.get("x-request-id");
			expect(requestId).toBeTruthy();
			expect(res.headers.get("request-id")).toBe(requestId);
			expect(recorded).toHaveLength(1);
			expect(requestId).toBe(recorded[0]!.requestId);
			expect(recorded[0]?.reason).toBe("credential_lookup_failed");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
