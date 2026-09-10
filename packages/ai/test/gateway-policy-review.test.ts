import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { create, Flag } from "../src/error/flags";
import * as streaming from "../src/stream";
import type { AssistantMessage } from "../src/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

afterEach(() => vi.restoreAllMocks());
it("retains structured policy rejections on both gateway paths instead of falling back", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-policy-review-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const model = buildModel({
		id: "primary",
		name: "fixture",
		provider: "fixture",
		api: "openai-responses",
		baseUrl: "https://fixture.example/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	storage.setRuntimeApiKey(model.provider, "fixture");
	const resolve = (id: string) => (id === "primary" ? model : id === "backup" ? { ...model, id } : undefined);
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
	vi.spyOn(streaming, "completeSimple").mockImplementation(async selected => {
		calls.push(selected.id);
		const message: AssistantMessage = {
			role: "assistant",
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
			content: [],
			stopReason: "error",
			timestamp: 0,
			errorMessage: "opaque rejection",
			errorStatus: 400,
			errorId: create(Flag.ContentBlocked),
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
		bearerTokens: ["fixture"],
		storage,
		resolveModel: resolve,
		routeRegistry: registry,
		version: "test",
	});
	try {
		for (const native of [false, true]) {
			calls.length = 0;
			const messages = [{ role: "user", content: "fixture", timestamp: 0 }];
			const response = await fetch(gateway.url + (native ? "/v1/pi/stream" : "/v1/chat/completions"), {
				method: "POST",
				headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
				body: JSON.stringify(
					native
						? { modelId: "route", context: { messages }, stream: false }
						: { model: "route", messages, stream: false },
				),
			});
			expect(response.status).toBe(400);
			expect(calls).toEqual(["primary"]);
		}
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
