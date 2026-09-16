import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { invalidateAllCommandConfigs, resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/model-config-values";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function stdoutCommand(value: string): string {
	if (process.platform !== "win32") return `printf %s ${shellQuote(value)}`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

function trackedTokenCommand(tokenFile: string, counterFile: string): string {
	if (process.platform !== "win32") {
		return `IFS= read -r token < ${shellQuote(tokenFile)}; printf 1 >> ${shellQuote(counterFile)}; [ "$token" = FAIL ] && exit 1; printf %s "$token"`;
	}
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const token=fs.readFileSync(${JSON.stringify(tokenFile)}, "utf8").trim();if(token==="FAIL")process.exit(1);process.stdout.write(token);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function failedTrackingCommand(counterFile: string): string {
	if (process.platform !== "win32") return `printf 1 >> ${shellQuote(counterFile)}; exit 1`;
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");process.exit(1);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Command that prints the *current* trimmed contents of `file` on each run. */
function stdoutFileCommand(file: string): string {
	if (process.platform !== "win32") return `IFS= read -r t < ${shellQuote(file)}; printf %s "$t"`;
	const script = `const fs=require("node:fs");process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, "utf8").trim());`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Minimal successful chat-completions SSE stream for the openai-completions provider. */
function okChatCompletionStream(): Response {
	const chunks = [
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
		"[DONE]",
	];
	return new Response(chunks.map(c => `data: ${c}\n\n`).join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/**
 * Fetch that records each request's credential headers, 401s until BOTH the
 * bearer and the tenant header carry their refreshed values, then streams a
 * successful completion.
 */
function refreshGateFetch(seen: Array<{ auth?: string; tenant?: string }>): FetchImpl {
	return async (_url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const auth = headers.Authorization;
		const tenant = headers["x-tenant-token"];
		seen.push({ auth, tenant });
		if (auth !== "Bearer fresh-bearer" || tenant !== "fresh-tenant") {
			return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		return okChatCompletionStream();
	};
}

describe("ModelRegistry command-resolved models.yml values", () => {
	test("does not run a command-backed value outside an enterable project", () => {
		const enterable = spyOn(piUtils, "directoryIsEnterableSync").mockReturnValue(false);
		try {
			expect(resolveConfigValue("!printf %s home-secret")).toBeUndefined();
		} finally {
			enterable.mockRestore();
		}
	});

	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-values-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("provider apiKey and headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						headers: { "X-Api-Key": `!${stdoutCommand("cmd-header")}` },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.hasCommandBackedApiKey("anthropic")).toBe(true);
		expect(registry.hasCommandBackedApiKey("openai")).toBe(false);
		const models = registry.getAll().filter(model => model.provider === "anthropic");

		expect(models.length).toBeGreaterThan(1);
		for (const model of models) {
			expect(model.headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(model.headers?.["X-Api-Key"]).toBe("cmd-header");
		}
		expect(await registry.getApiKey(models[0])).toBe("cmd-api-key");
	});

	test("modelOverrides headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "X-Model-Key": `!${stdoutCommand("cmd-model-header")}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");

		expect(model).toBeDefined();
		expect(model?.headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(model?.headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("401 reruns a command-backed API key and updates live auth headers", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "stale-key");
		fs.writeFileSync(counterFile, "");
		const command = trackedTokenCommand(tokenFile, counterFile);

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${command}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		fs.writeFileSync(tokenFile, "fresh-key");

		const attemptedKeys: string[] = [];
		const result = await withAuth(registry.resolver(model), async key => {
			attemptedKeys.push(key);
			if (key === "stale-key") {
				throw Object.assign(new Error("401 authentication_error"), { status: 401 });
			}
			if (key === "fresh-key") return "ok";
			throw new Error(`Unexpected API key: ${key}`);
		});

		expect(result).toBe("ok");
		expect(attemptedKeys).toEqual(["stale-key", "fresh-key"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
		expect(model.headers?.Authorization).toBe("Bearer fresh-key");
	});

	test("failed 401 refresh discards the rejected command-backed key", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "stale-key");
		fs.writeFileSync(counterFile, "");
		const command = trackedTokenCommand(tokenFile, counterFile);

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${command}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		fs.writeFileSync(tokenFile, "FAIL");

		const refreshed = await registry.resolver(model)({
			lastChance: false,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: "stale-key",
		});

		expect(refreshed).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(model.headers?.Authorization).toBeUndefined();
	});

	test("resolveCommandConfig caches failed executions so they do not retry", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");

		// Command increments a counter and then fails (exit 1).
		const trackingCommand = failedTrackingCommand(counterFile);

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Init triggers the first command resolution.
		const registry = new ModelRegistry(authStorage, modelsPath);

		const dummyModel: Model<Api> = buildModel({
			id: "foo",
			name: "foo",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "a",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});

		// Trigger the fallback resolver which also calls resolveConfigValue.
		await registry.getApiKey(dummyModel);

		// Another call to ensure it hits cache multiple times.
		await registry.getApiKey(dummyModel);

		// The command should have only run once.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("401 refreshes a command-backed provider header and retries with the fresh value", async () => {
		const bearerFile = path.join(tempDir, "bearer.txt");
		const tenantFile = path.join(tempDir, "tenant.txt");
		fs.writeFileSync(bearerFile, "stale-bearer");
		fs.writeFileSync(tenantFile, "stale-tenant");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutFileCommand(bearerFile)}`,
						headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` },
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		// Reading the header proxy caches the stale value, as the first live
		// request would. The rotation below is only observed on the retry if the
		// 401 path actually invalidates the command cache and re-runs it.
		expect(model.headers?.["x-tenant-token"]).toBe("stale-tenant");
		// The credential backend rotates both tokens out-of-band.
		fs.writeFileSync(bearerFile, "fresh-bearer");
		fs.writeFileSync(tenantFile, "fresh-tenant");

		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: refreshGateFetch(seen),
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual([
			{ auth: "Bearer stale-bearer", tenant: "stale-tenant" },
			{ auth: "Bearer fresh-bearer", tenant: "fresh-tenant" },
		]);
	});

	test("401 refreshes a command-backed custom model header and retries with the fresh value", async () => {
		const bearerFile = path.join(tempDir, "bearer.txt");
		const tenantFile = path.join(tempDir, "tenant.txt");
		fs.writeFileSync(bearerFile, "stale-bearer");
		fs.writeFileSync(tenantFile, "stale-tenant");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutFileCommand(bearerFile)}`,
						models: [
							{
								id: "custom-model",
								name: "Custom Model",
								headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` },
							},
						],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(model.headers?.["x-tenant-token"]).toBe("stale-tenant");
		fs.writeFileSync(bearerFile, "fresh-bearer");
		fs.writeFileSync(tenantFile, "fresh-tenant");

		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: refreshGateFetch(seen),
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual([
			{ auth: "Bearer stale-bearer", tenant: "stale-tenant" },
			{ auth: "Bearer fresh-bearer", tenant: "fresh-tenant" },
		]);
	});

	test("401 refreshes a command-backed modelOverrides header and retries with the fresh value", async () => {
		const bearerFile = path.join(tempDir, "bearer.txt");
		const tenantFile = path.join(tempDir, "tenant.txt");
		fs.writeFileSync(bearerFile, "stale-bearer");
		fs.writeFileSync(tenantFile, "stale-tenant");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutFileCommand(bearerFile)}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(model.headers?.["x-tenant-token"]).toBe("stale-tenant");
		fs.writeFileSync(bearerFile, "fresh-bearer");
		fs.writeFileSync(tenantFile, "fresh-tenant");

		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: refreshGateFetch(seen),
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual([
			{ auth: "Bearer stale-bearer", tenant: "stale-tenant" },
			{ auth: "Bearer fresh-bearer", tenant: "fresh-tenant" },
		]);
	});

	test("invalidateAllCommandConfigs drops cached stdout so the next resolve re-runs", () => {
		const tokenFile = path.join(tempDir, "token.txt");
		fs.writeFileSync(tokenFile, "initial");
		const config = `!${stdoutFileCommand(tokenFile)}`;

		expect(resolveConfigValue(config)).toBe("initial");
		fs.writeFileSync(tokenFile, "rotated");
		expect(resolveConfigValue(config)).toBe("initial");

		invalidateAllCommandConfigs();
		expect(resolveConfigValue(config)).toBe("rotated");
	});

	test("refresh('online') re-runs a command-backed API key after the backend rotates", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "stale-key");
		fs.writeFileSync(counterFile, "");
		const command = trackedTokenCommand(tokenFile, counterFile);

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${command}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(await registry.getApiKey(model)).toBe("stale-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		fs.writeFileSync(tokenFile, "fresh-key");
		// Background / policy reloads must not spawn credential helpers.
		await registry.refresh("online-if-uncached");
		await registry.refresh("offline");
		// Passive online discovery (unscoped /models hub open) must not either.
		await registry.refresh("online");
		expect(await registry.getApiKey(model)).toBe("stale-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// User-facing recovery: `omp models refresh`, TUI F5.
		await registry.refresh("online", { refreshCommandCredentials: true });
		expect(await registry.getApiKey(model)).toBe("fresh-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
		expect(registry.find("custom-proxy", "custom-model")?.headers?.Authorization).toBe("Bearer fresh-key");
	});

	test("refresh('online') retries a command that was negative-cached after a failure", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "FAIL");
		fs.writeFileSync(counterFile, "");
		const command = trackedTokenCommand(tokenFile, counterFile);

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${command}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// Helper is healthy again, but the 30s failure backoff would still block
		// getApiKey until process restart — unless online refresh clears it.
		fs.writeFileSync(tokenFile, "recovered-key");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		await registry.refresh("online", { refreshCommandCredentials: true });
		expect(await registry.getApiKey(model)).toBe("recovered-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});

	test("refreshProvider('online') without refreshCommandCredentials leaves command cache intact", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "stale-key");
		fs.writeFileSync(counterFile, "");

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackedTokenCommand(tokenFile, counterFile)}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.getApiKeyForProvider("custom-proxy")).toBe("stale-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		fs.writeFileSync(tokenFile, "fresh-key");
		// Hover / auto-refresh: live catalog, same cached credential.
		await registry.refreshProvider("custom-proxy", "online");
		expect(await registry.getApiKeyForProvider("custom-proxy")).toBe("stale-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("refreshProvider('online') invalidates only that provider's command cache", async () => {
		const tokenA = path.join(tempDir, "token-a.txt");
		const tokenB = path.join(tempDir, "token-b.txt");
		const counterA = path.join(tempDir, "counter-a.txt");
		const counterB = path.join(tempDir, "counter-b.txt");
		fs.writeFileSync(tokenA, "a-stale");
		fs.writeFileSync(tokenB, "b-stale");
		fs.writeFileSync(counterA, "");
		fs.writeFileSync(counterB, "");

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"proxy-a": {
						baseUrl: "https://a.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackedTokenCommand(tokenA, counterA)}`,
						models: [{ id: "model-a", name: "A" }],
					},
					"proxy-b": {
						baseUrl: "https://b.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackedTokenCommand(tokenB, counterB)}`,
						models: [{ id: "model-b", name: "B" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.getApiKeyForProvider("proxy-a")).toBe("a-stale");
		expect(await registry.getApiKeyForProvider("proxy-b")).toBe("b-stale");
		expect(fs.readFileSync(counterA, "utf8")).toBe("1");
		expect(fs.readFileSync(counterB, "utf8")).toBe("1");

		fs.writeFileSync(tokenA, "a-fresh");
		fs.writeFileSync(tokenB, "b-fresh");
		await registry.refreshProvider("proxy-a", "online", { refreshCommandCredentials: true });

		expect(await registry.getApiKeyForProvider("proxy-a")).toBe("a-fresh");
		expect(await registry.getApiKeyForProvider("proxy-b")).toBe("b-stale");
		expect(fs.readFileSync(counterA, "utf8")).toBe("11");
		expect(fs.readFileSync(counterB, "utf8")).toBe("1");
	});

	test("refreshProvider('online') re-runs extension-registered command-backed headers", async () => {
		const providerHeaderFile = path.join(tempDir, "provider-header.txt");
		const modelHeaderFile = path.join(tempDir, "model-header.txt");
		const providerCounter = path.join(tempDir, "provider-counter.txt");
		const modelCounter = path.join(tempDir, "model-counter.txt");
		fs.writeFileSync(providerHeaderFile, "stale-provider");
		fs.writeFileSync(modelHeaderFile, "stale-model");
		fs.writeFileSync(providerCounter, "");
		fs.writeFileSync(modelCounter, "");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

		const registry = new ModelRegistry(authStorage, modelsPath);
		registry.registerProvider("ext-proxy", {
			baseUrl: "https://ext.example.com/v1",
			api: "openai-completions",
			apiKey: "literal-key",
			headers: { "x-tenant-token": `!${trackedTokenCommand(providerHeaderFile, providerCounter)}` },
			models: [
				{
					id: "ext-model",
					name: "Ext",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
					headers: { "x-model-token": `!${trackedTokenCommand(modelHeaderFile, modelCounter)}` },
				},
			],
		});

		const model = registry.find("ext-proxy", "ext-model");
		if (!model) throw new Error("Expected extension model");
		expect(model.headers?.["x-tenant-token"]).toBe("stale-provider");
		expect(model.headers?.["x-model-token"]).toBe("stale-model");
		expect(fs.readFileSync(providerCounter, "utf8")).toBe("1");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		fs.writeFileSync(providerHeaderFile, "fresh-provider");
		fs.writeFileSync(modelHeaderFile, "fresh-model");
		await registry.refreshProvider("ext-proxy", "online", { refreshCommandCredentials: true });

		const refreshed = registry.find("ext-proxy", "ext-model");
		expect(refreshed?.headers?.["x-tenant-token"]).toBe("fresh-provider");
		expect(refreshed?.headers?.["x-model-token"]).toBe("fresh-model");
		expect(fs.readFileSync(providerCounter, "utf8")).toBe("11");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("11");
	});

	test("refreshProvider re-runs fetchDynamicModels header commands after explicit credential refresh", async () => {
		const modelHeaderFile = path.join(tempDir, "dynamic-header.txt");
		const modelCounter = path.join(tempDir, "dynamic-counter.txt");
		fs.writeFileSync(modelHeaderFile, "stale-dynamic");
		fs.writeFileSync(modelCounter, "");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

		const registry = new ModelRegistry(authStorage, modelsPath);
		registry.registerProvider("dyn-proxy", {
			baseUrl: "https://dyn.example.com/v1",
			api: "openai-completions",
			apiKey: "literal-key",
			fetchDynamicModels: async () => [
				{
					id: "dyn-model",
					name: "Dyn",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
					headers: { "x-model-token": `!${trackedTokenCommand(modelHeaderFile, modelCounter)}` },
				},
			],
		});

		await registry.refreshProvider("dyn-proxy", "online");
		const model = registry.find("dyn-proxy", "dyn-model");
		if (!model) throw new Error("Expected dynamic model");
		expect(model.headers?.["x-model-token"]).toBe("stale-dynamic");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		fs.writeFileSync(modelHeaderFile, "fresh-dynamic");
		await registry.refreshProvider("dyn-proxy", "online");
		expect(registry.find("dyn-proxy", "dyn-model")?.headers?.["x-model-token"]).toBe("stale-dynamic");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		await registry.refreshProvider("dyn-proxy", "online", { refreshCommandCredentials: true });
		expect(registry.find("dyn-proxy", "dyn-model")?.headers?.["x-model-token"]).toBe("fresh-dynamic");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("11");
	});

	test("401 refreshes a fetchDynamicModels command-backed header", async () => {
		const bearerFile = path.join(tempDir, "bearer.txt");
		const tenantFile = path.join(tempDir, "tenant.txt");
		fs.writeFileSync(bearerFile, "stale-bearer");
		fs.writeFileSync(tenantFile, "stale-tenant");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

		const registry = new ModelRegistry(authStorage, modelsPath);
		registry.registerProvider("dyn-proxy", {
			baseUrl: "https://dyn.example.com/v1",
			api: "openai-completions",
			apiKey: `!${stdoutFileCommand(bearerFile)}`,
			authHeader: true,
			fetchDynamicModels: async () => [
				{
					id: "dyn-model",
					name: "Dyn",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
					headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` },
				},
			],
		});

		await registry.refreshProvider("dyn-proxy", "online");
		const model = registry.find("dyn-proxy", "dyn-model");
		if (!model) throw new Error("Expected dynamic model");
		expect(model.headers?.["x-tenant-token"]).toBe("stale-tenant");
		fs.writeFileSync(bearerFile, "fresh-bearer");
		fs.writeFileSync(tenantFile, "fresh-tenant");

		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: refreshGateFetch(seen),
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual([
			{ auth: "Bearer stale-bearer", tenant: "stale-tenant" },
			{ auth: "Bearer fresh-bearer", tenant: "fresh-tenant" },
		]);
	});
});
