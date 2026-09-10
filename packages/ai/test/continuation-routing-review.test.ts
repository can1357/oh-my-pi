import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { RouteRegistry } from "../src/auth-gateway/route-graph";
import { startAuthGateway } from "../src/auth-gateway/server";
import { AuthStorage } from "../src/auth-storage";
import * as streaming from "../src/stream";
import type { AssistantMessage } from "../src/types";
afterEach(() => vi.restoreAllMocks());
async function withGateway(
	run: (url: string, calls: string[], kinds: string[]) => Promise<void>,
	multiple = false,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuation-route-review-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const model = (id: string) =>
		buildModel({
			id,
			name: id,
			provider: `unit-continuation-${id}`,
			api: "openai-responses",
			baseUrl: `https://${id}.example/v1`,
			reasoning: false,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	const primary = model("primary");
	const backup = model("backup");
	if (multiple)
		await storage.set(primary.provider, [
			{ type: "api_key", key: "first" },
			{ type: "api_key", key: "second" },
		]);
	else storage.setRuntimeApiKey(primary.provider, "fixture-key");
	storage.setRuntimeApiKey(backup.provider, "backup-key");
	const resolve = (id: string) => (id === "primary" ? primary : id === "backup" ? backup : undefined);
	const registry = new RouteRegistry(resolve);
	registry.register({
		id: "route",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "primary" },
				{ type: "target", model: "backup" },
			],
		},
	});
	const calls: string[] = [];
	const kinds: string[] = [];
	vi.spyOn(streaming, "completeSimple").mockImplementation(async (selected, _context, options) => {
		calls.push(selected.id);
		kinds.push(typeof options?.apiKey);
		if (selected.id === "primary") throw Object.assign(new Error("Service unavailable"), { status: 503 });
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		return message;
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test"],
		storage,
		resolveModel: resolve,
		routeRegistry: registry,
		version: "test",
	});
	try {
		await run(gateway.url, calls, kinds);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}
it("keeps response continuations on one target and bearer while stateless calls still fail over", async () => {
	await withGateway(async (url, calls, kinds) => {
		const post = (body: unknown) =>
			fetch(`${url}/v1/responses`, {
				method: "POST",
				headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		expect(
			(await post({ model: "route", input: "hi", previous_response_id: "resp_original", stream: false })).status,
		).toBe(503);
		expect(calls).toEqual(["primary"]);
		expect(kinds).toEqual(["string"]);
		calls.length = 0;
		kinds.length = 0;
		expect((await post({ model: "route", input: "hi", stream: false })).status).toBe(200);
		expect(calls).toEqual(["primary", "backup"]);
	});
});
it("rejects ambiguous multi-credential continuations before choosing an account", async () => {
	await withGateway(async (url, calls) => {
		const response = await fetch(`${url}/v1/responses`, {
			method: "POST",
			headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
			body: JSON.stringify({ model: "route", input: "hi", previous_response_id: "resp_original", stream: false }),
		});
		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	}, true);
});
