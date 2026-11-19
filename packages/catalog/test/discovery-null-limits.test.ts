import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetExtraCaCache } from "@oh-my-pi/pi-utils";
import { fetchOpenAICompatibleModels } from "../src/discovery/openai-compatible";

describe("discovery null limits", () => {
	it("emits null for contextWindow and maxTokens when limits are unknown", async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "some-model",
							name: "Some Model",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const models = await fetchOpenAICompatibleModels({
			provider: "custom",
			api: "openai-completions",
			baseUrl: "https://api.example.com/v1",
			fetch: mockFetch,
		});

		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].contextWindow).toBeNull();
		expect(models![0].maxTokens).toBeNull();
	});
});

describe("discovery extra-CA fallback fetch", () => {
	const SAMPLE_PEM =
		"-----BEGIN CERTIFICATE-----\nMIIBkTCCATegAwIBAgIUF/sample/extra/ca/for/discovery/123=\n-----END CERTIFICATE-----\n";
	const MODELS_BODY = JSON.stringify({ data: [{ id: "some-model" }] });

	let tmpDir: string;
	let originalEnv: string | undefined;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(async () => {
		__resetExtraCaCache();
		originalEnv = Bun.env.NODE_EXTRA_CA_CERTS;
		originalFetch = globalThis.fetch;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-ca-"));
	});

	afterEach(async () => {
		__resetExtraCaCache();
		globalThis.fetch = originalFetch;
		if (originalEnv === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
		else Bun.env.NODE_EXTRA_CA_CERTS = originalEnv;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("carries the NODE_EXTRA_CA_CERTS bundle on the fallback fetch", async () => {
		const caPath = path.join(tmpDir, "corp.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const inits: (RequestInit & { tls?: { ca?: string | string[] } })[] = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push((init ?? {}) as (typeof inits)[number]);
			return new Response(MODELS_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof globalThis.fetch;

		// No `fetch` injected — the wrapped globalThis.fetch fallback must be used.
		const models = await fetchOpenAICompatibleModels({
			provider: "custom",
			api: "openai-completions",
			baseUrl: "https://gateway.corp.example/v1",
		});

		expect(models).not.toBeNull();
		expect(models!.length).toBe(1);
		expect(inits).toHaveLength(1);
		expect(inits[0].tls?.ca).toContain(SAMPLE_PEM);
	});

	it("leaves a caller-injected fetch untouched", async () => {
		const caPath = path.join(tmpDir, "corp.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const inits: (RequestInit & { tls?: { ca?: string | string[] } })[] = [];
		const injectedFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push((init ?? {}) as (typeof inits)[number]);
			return new Response(MODELS_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const models = await fetchOpenAICompatibleModels({
			provider: "custom",
			api: "openai-completions",
			baseUrl: "https://gateway.corp.example/v1",
			fetch: injectedFetch,
		});

		expect(models).not.toBeNull();
		expect(inits).toHaveLength(1);
		expect(inits[0].tls).toBeUndefined();
	});
});
