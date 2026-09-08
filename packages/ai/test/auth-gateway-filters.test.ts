import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { candidateAllowed, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

type ErrorBody = { error?: string };

async function withFilterGateway(run: (ctx: { url: string }) => Promise<void>): Promise<void> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-filters-"));
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

describe("auth-gateway filter routes", () => {
	it("returns 501 for POST /v1/realtime with a bearer", async () => {
		await withFilterGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/realtime`, {
				method: "POST",
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(501);
			expect(await res.json()).toEqual({ error: "not available on this gateway" });
		});
	});

	it("returns 501 for POST /v1/audio/speech with a bearer", async () => {
		await withFilterGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/audio/speech`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({ model: "tts-1", input: "hi", voice: "alloy" }),
			});
			expect(res.status).toBe(501);
			expect(await res.json()).toEqual({ error: "not available on this gateway" });
		});
	});

	it("returns 401 for POST /v1/realtime without a bearer (negative)", async () => {
		await withFilterGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/realtime`, { method: "POST" });
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("unauthorized");
		});
	});

	it("returns 400 for POST /v1/images/generations when prompt is missing", async () => {
		await withFilterGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/images/generations`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-image-1" }),
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Missing prompt" });
		});
	});

	it("returns 401 for POST /v1/images/generations without a bearer (negative)", async () => {
		await withFilterGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/images/generations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "a cube" }),
			});
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("unauthorized");
		});
	});
});

describe("auth-gateway portability skip gate", () => {
	it("rejects a required provider mismatch (negative)", () => {
		expect(
			candidateAllowed(
				{ scope: "provider", origin: "anthropic" },
				{ id: "openai-1", provider: "openai" },
				"required",
			),
		).toBe(false);
	});

	it("allows a required provider match", () => {
		expect(
			candidateAllowed(
				{ scope: "provider", origin: "anthropic" },
				{ id: "claude-1", provider: "anthropic" },
				"required",
			),
		).toBe(true);
	});
});
