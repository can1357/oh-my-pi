import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { type GatewayHooks, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

type ErrorBody = { error?: string };

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

describe("auth-gateway protocol routes over HTTP", () => {
	it("routes canonical parameterized Gemini paths with per-endpoint response mode", async () => {
		await withProtocolGateway(async ({ url }) => {
			const json = await fetch(`${url}/v1beta/models/known-model:generateContent`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
			});
			expect(json.status).toBe(200);
			expect(json.headers.get("content-type")).toContain("application/json");

			const stream = await fetch(`${url}/v1beta/models/known-model:streamGenerateContent`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
			});
			expect(stream.status).toBe(200);
			expect(stream.headers.get("content-type")).toContain("text/event-stream");
			await stream.body?.cancel();
		});
	});

	it("dispatches alias paths onto working format modules", async () => {
		await withProtocolGateway(async ({ url }) => {
			const chatBody = JSON.stringify({
				model: "known-model",
				messages: [{ role: "user", content: "hi" }],
				stream: false,
			});
			for (const pathName of ["/v1/grok/chat/completions"]) {
				const res = await fetch(`${url}${pathName}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
					body: chatBody,
				});
				expect(res.status).toBe(200);
			}
			const responsesBody = JSON.stringify({ model: "known-model", input: "hi" });
			for (const pathName of ["/v1/responses", "/backend-api/codex/responses", "/backend-api/responses"]) {
				const res = await fetch(`${url}${pathName}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
					body: responsesBody,
				});
				expect(res.status).toBe(200);
			}
		});
	});

	it("returns 404 for unknown paths (negative)", async () => {
		await withProtocolGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/no-such-route`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(404);
		});
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

for (const operation of ["generateContent", "streamGenerateContent"]) {
	it(`accepts Gemini ${operation} with its model only in the URL`, async () => {
		await withProtocolGateway(async ({ url }) => {
			const response = await fetch(`${url}/v1beta/models/known-model:${operation}`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")?.includes("text/event-stream")).toBe(
				operation === "streamGenerateContent",
			);
			const output = await response.text();
			expect(output).toContain('"text":"ok"');
		});
	});
}
