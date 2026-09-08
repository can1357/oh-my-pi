import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { FORMAT_ROUTES, type GatewayHooks, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

type ErrorBody = { error?: string };

const NEW_FORMAT_PATHS = [
	"/v1beta/models/generateContent",
	"/v1beta/models/streamGenerateContent",
	"/backend-api/codex/responses",
	"/backend-api/responses",
	"/v1/grok/chat/completions",
] as const;

async function withProtocolGateway(
	run: (ctx: { url: string }) => Promise<void>,
	opts?: { hooks?: GatewayHooks },
): Promise<void> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-proto-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const mock = createMockModel({
		provider: "openrouter",
		id: "known-model",
		handler: { content: ["ok"] },
	});
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: (id: string) => (id === "known-model" ? mock.model : undefined),
		listModels: () => [mock.model],
		hooks: opts?.hooks,
		version: "test",
	});
	try {
		await run({ url: handle.url });
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("auth-gateway protocol FORMAT_ROUTES", () => {
	it("includes Gemini, Codex, and xAI alias paths", () => {
		const keys = Object.keys(FORMAT_ROUTES);
		for (const pathName of NEW_FORMAT_PATHS) {
			expect(keys).toContain(pathName);
		}
		expect(keys).toContain("/v1/chat/completions");
		expect(keys).toContain("/v1/messages");
		expect(keys).toContain("/v1/responses");
	});

	it("does not register count_tokens as a format module (negative)", () => {
		expect(FORMAT_ROUTES["/v1/messages/count_tokens"]).toBeUndefined();
	});

	it("aliases Codex and xAI paths onto the existing format modules", () => {
		expect(FORMAT_ROUTES["/v1/grok/chat/completions"]?.module).toBe(FORMAT_ROUTES["/v1/chat/completions"]?.module);
		expect(FORMAT_ROUTES["/v1/grok/chat/completions"]?.label).toBe("openai-chat");
		expect(FORMAT_ROUTES["/backend-api/codex/responses"]?.module).toBe(FORMAT_ROUTES["/v1/responses"]?.module);
		expect(FORMAT_ROUTES["/backend-api/responses"]?.module).toBe(FORMAT_ROUTES["/v1/responses"]?.module);
		expect(FORMAT_ROUTES["/v1beta/models/generateContent"]?.module).toBe(
			FORMAT_ROUTES["/v1beta/models/streamGenerateContent"]?.module,
		);
		expect(FORMAT_ROUTES["/v1beta/models/generateContent"]?.label).toBe("gemini-v1beta");
	});
});

describe("auth-gateway protocol HTTP routes", () => {
	it("returns 401 without a bearer token on count_tokens (negative)", async () => {
		await withProtocolGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST" });
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("unauthorized");
		});
	});

	it("returns 404 for count_tokens with a bearer and unknown model (negative)", async () => {
		await withProtocolGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/messages/count_tokens`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "missing-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "Unknown model: missing-model" });
		});
	});

	it("dispatches Gemini and alias format paths instead of No route", async () => {
		await withProtocolGateway(async ({ url }) => {
			const paths = [
				"/v1beta/models/generateContent",
				"/v1/grok/chat/completions",
				"/backend-api/codex/responses",
				"/backend-api/responses",
			];
			for (const pathName of paths) {
				const res = await fetch(`${url}${pathName}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
					body: JSON.stringify({}),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error?: string | { message?: string } };
				const message = typeof body.error === "string" ? body.error : body.error?.message;
				expect(message).toContain("model");
			}
		});
	});

	it("runs beforeRequest and afterRequest on a successful format request", async () => {
		const seen: Array<{ hook: string; routeId: string; generation: number; ok?: boolean }> = [];
		const hooks: GatewayHooks = {
			beforeRequest: ctx => {
				seen.push({ hook: "beforeRequest", routeId: ctx.routeId, generation: ctx.generation });
			},
			afterRequest: ctx => {
				seen.push({
					hook: "afterRequest",
					routeId: ctx.routeId,
					generation: ctx.generation,
					ok: ctx.ok,
				});
			},
		};
		await withProtocolGateway(
			async ({ url }) => {
				const res = await fetch(`${url}/v1/chat/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
					body: JSON.stringify({
						model: "known-model",
						messages: [{ role: "user", content: "hi" }],
						stream: false,
					}),
				});
				expect(res.status).toBe(200);
				expect(seen.map(entry => entry.hook)).toEqual(["beforeRequest", "afterRequest"]);
				expect(seen[0]?.routeId).toBe("known-model");
				expect(seen[1]?.ok).toBe(true);
				expect(seen[1]?.generation).toBe(seen[0]?.generation);
			},
			{ hooks },
		);
	});
});
