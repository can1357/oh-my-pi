import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { CredentialSourceError } from "@oh-my-pi/pi-ai/error";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	clearConfigValueCache,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	resolveConfigValue,
	resolveCredentialConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/session/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import * as piUtils from "@oh-my-pi/pi-utils";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

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
	test("does not run a command-backed value outside an enterable project", async () => {
		const enterable = spyOn(piUtils, "directoryIsEnterable").mockResolvedValue(false);
		try {
			expect(await resolveConfigValue("!printf %s home-secret")).toBeUndefined();
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
			const headers = await registry.resolveModelHeaders(model);
			expect(headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(headers?.["X-Api-Key"]).toBe("cmd-header");
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
		const headers = await registry.resolveModelHeaders(model!);
		expect(headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("runtime API keys win without executing configured credential commands", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "configured-key");
		fs.writeFileSync(counterFile, "");
		await Bun.write(
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
		authStorage.keys.setRuntime("custom-proxy", "runtime-key");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		expect(await registry.getApiKey(model)).toBe("runtime-key");
		expect(await registry.getApiKeyForProvider("custom-proxy")).toBe("runtime-key");
		expect(await Bun.file(counterFile).text()).toBe("");
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
		expect(await registry.getApiKey(model)).toBe("stale-key");
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
		expect((await registry.resolveModelHeaders(model))?.Authorization).toBe("Bearer fresh-key");
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
		expect(await registry.getApiKey(model)).toBe("stale-key");
		fs.writeFileSync(tokenFile, "FAIL");

		// The request-path resolver reports the source's own failure; the driver
		// records it and keeps retrying (see `resolveRetryKey`).
		await expect(
			registry.resolver(model)({
				lastChance: false,
				error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
				previousKey: "stale-key",
			}),
		).rejects.toBeInstanceOf(CredentialSourceError);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect((await registry.resolveModelHeaders(model))?.Authorization).toBeUndefined();
	});

	test("command resolution backs off after failed executions", async () => {
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

		// Catalog construction records the command without executing it.
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("");

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
		// Materializing the request headers caches the stale command result, as
		// the first live request would. The rotation below is only observed on
		// retry if the 401 path invalidates the command cache and re-runs it.
		expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("stale-tenant");
		expect(await registry.getApiKey(model)).toBe("stale-bearer");
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
		expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("stale-tenant");
		expect(await registry.getApiKey(model)).toBe("stale-bearer");
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
		expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("stale-tenant");
		expect(await registry.getApiKey(model)).toBe("stale-bearer");
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

	test("invalidateAllCommandConfigs drops cached stdout so the next resolve re-runs", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		fs.writeFileSync(tokenFile, "initial");
		const config = `!${stdoutFileCommand(tokenFile)}`;

		expect(await resolveConfigValue(config)).toBe("initial");
		fs.writeFileSync(tokenFile, "rotated");
		expect(await resolveConfigValue(config)).toBe("initial");

		invalidateAllCommandConfigs("refresh");
		expect(await resolveConfigValue(config)).toBe("rotated");
	});

	test("deduplicates concurrent resolution of the same command", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "shared-key");
		fs.writeFileSync(counterFile, "");
		const config = `!${trackedTokenCommand(tokenFile, counterFile)}`;

		const values = await Promise.all([
			resolveConfigValue(config),
			resolveConfigValue(config),
			resolveConfigValue(config),
		]);

		expect(values).toEqual(["shared-key", "shared-key", "shared-key"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
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
		const refreshed = registry.find("custom-proxy", "custom-model");
		expect(refreshed && (await registry.resolveModelHeaders(refreshed))?.Authorization).toBe("Bearer fresh-key");
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
		const initialHeaders = await registry.resolveModelHeaders(model);
		expect(initialHeaders?.["x-tenant-token"]).toBe("stale-provider");
		expect(initialHeaders?.["x-model-token"]).toBe("stale-model");
		expect(fs.readFileSync(providerCounter, "utf8")).toBe("1");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		fs.writeFileSync(providerHeaderFile, "fresh-provider");
		fs.writeFileSync(modelHeaderFile, "fresh-model");
		await registry.refreshProvider("ext-proxy", "online", { refreshCommandCredentials: true });

		const refreshed = registry.find("ext-proxy", "ext-model");
		const refreshedHeaders = refreshed ? await registry.resolveModelHeaders(refreshed) : undefined;
		expect(refreshedHeaders?.["x-tenant-token"]).toBe("fresh-provider");
		expect(refreshedHeaders?.["x-model-token"]).toBe("fresh-model");
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
		expect((await registry.resolveModelHeaders(model))?.["x-model-token"]).toBe("stale-dynamic");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		fs.writeFileSync(modelHeaderFile, "fresh-dynamic");
		await registry.refreshProvider("dyn-proxy", "online");
		const cached = registry.find("dyn-proxy", "dyn-model");
		expect(cached && (await registry.resolveModelHeaders(cached))?.["x-model-token"]).toBe("stale-dynamic");
		expect(fs.readFileSync(modelCounter, "utf8")).toBe("1");

		await registry.refreshProvider("dyn-proxy", "online", { refreshCommandCredentials: true });
		const refreshed = registry.find("dyn-proxy", "dyn-model");
		expect(refreshed && (await registry.resolveModelHeaders(refreshed))?.["x-model-token"]).toBe("fresh-dynamic");
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
		expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("stale-tenant");
		expect(await registry.getApiKey(model)).toBe("stale-bearer");
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

	test("a failed re-run serves the last good key, warns, and retries in the background", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "good-key");
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
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(await registry.getApiKey(model)).toBe("good-key");

		// An explicit refresh re-runs the helper, which now fails (as a timeout under load does).
		fs.writeFileSync(tokenFile, "FAIL");
		const warn = spyOn(piUtils.logger, "warn");
		const realNow = Date.now;
		let clockOffsetMs = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
		try {
			await registry.refresh("online", { refreshCommandCredentials: true });
			expect(await registry.getApiKey(model)).toBe("good-key");
			expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
			const failures = warn.mock.calls.filter(([message]) => message === "config: !command value resolution failed");
			expect(failures).toHaveLength(1);
			expect(failures[0]?.[1]).toMatchObject({ reason: "exit", servingLastGoodValue: true });
			expect(JSON.stringify(failures[0])).not.toContain(tokenFile);

			// Within the failure backoff the last good key serves without re-running the helper.
			expect(await registry.getApiKey(model)).toBe("good-key");
			expect(fs.readFileSync(counterFile, "utf8")).toBe("11");

			// After the backoff, resolution answers at once from the last good key and
			// re-runs the helper in the background; its next success replaces the key.
			fs.writeFileSync(tokenFile, "rotated-key");
			clockOffsetMs = 31_000;
			expect(await registry.getApiKey(model)).toBe("good-key");
			// The background retry is a real helper process and resolution exposes no
			// promise for it, so wait on its observable effect with a bounded poll.
			const deadline = realNow() + 10_000;
			let key = await registry.getApiKey(model);
			while (key !== "rotated-key" && realNow() < deadline) {
				await Bun.sleep(20);
				key = await registry.getApiKey(model);
			}
			expect(key).toBe("rotated-key");
			expect(fs.readFileSync(counterFile, "utf8")).toBe("111");
		} finally {
			clock.mockRestore();
			warn.mockRestore();
		}
	});

	test("invalidateCommandConfigs keeps the last good key on a refresh and drops it on a rejection", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "good-key");
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
		// The owner registry: a worker thread's mirror forwards its invalidations to this method.
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(await registry.getApiKey(model)).toBe("good-key");

		fs.writeFileSync(tokenFile, "FAIL");
		registry.invalidateCommandConfigs("custom-proxy", "refresh");
		expect(await registry.getApiKey(model)).toBe("good-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");

		registry.invalidateCommandConfigs(undefined, "rejected");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("111");
	});

	test.skipIf(process.platform === "win32")(
		"a waiter whose run a 401 invalidated gets the fresh key, not the rejected one",
		async () => {
			const tokenFile = path.join(tempDir, "token.txt");
			const readMarker = path.join(tempDir, "read");
			fs.writeFileSync(tokenFile, "rejected-key");
			// The helper reads the token first, signals that it did, then sleeps before printing it,
			// so a run started before the rotation keeps printing the old value.
			const config = `!IFS= read -r token < ${shellQuote(tokenFile)}; : > ${shellQuote(readMarker)}; sleep 1; printf %s "$token"`;
			const waiter = resolveConfigValue(config);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(readMarker) && Date.now() < deadline) await Bun.sleep(10);
			expect(fs.existsSync(readMarker)).toBe(true);

			// A 401 rejects the key while the waiter's run is still in flight, and the key rotates.
			fs.writeFileSync(tokenFile, "fresh-key");
			invalidateCommandConfig(config, "rejected");

			expect(await waiter).toBe("fresh-key");
			expect(await resolveConfigValue(config)).toBe("fresh-key");
		},
	);

	test("a command that never succeeded still resolves to no key", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		const config = `!${failedTrackingCommand(counterFile)}`;
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test.skipIf(process.platform === "win32")("providers.commandTimeoutSeconds bounds each command run", async () => {
		const warn = spyOn(piUtils.logger, "warn");
		const unbind = bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 0.5 }));
		try {
			const marker = path.join(tempDir, "slow");
			const started = performance.now();
			expect(await resolveConfigValue(`!sleep 3; printf %s ${shellQuote(marker)}`)).toBeUndefined();
			expect(performance.now() - started).toBeLessThan(2_500);
			const failure = warn.mock.calls.find(([message]) => message === "config: !command value resolution failed");
			expect(failure?.[1]).toMatchObject({ reason: "timeout", timeoutMs: 500 });
		} finally {
			unbind();
			warn.mockRestore();
		}
		// A longer limit lets the same kind of slow helper finish.
		const unbindLong = bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 30 }));
		try {
			const marker = path.join(tempDir, "finishes");
			expect(await resolveConfigValue(`!sleep 1; printf %s ${shellQuote(marker)}`)).toBe(marker);
		} finally {
			unbindLong();
			// Re-apply the default (10 s) to the process-wide limit.
			bindEffects(Settings.isolated({}))();
		}
	});

	/**
	 * A source that produced nothing must say which source and what it did. The
	 * request path refuses with that message; availability probes still resolve
	 * `undefined` so a model picker does not throw at a broken credential.
	 */
	describe.skipIf(process.platform === "win32")("a credential source that produced nothing", () => {
		/** models.json with one openai-completions provider whose `apiKey` is `config`. */
		function providerWithApiKey(config: string): ModelRegistry {
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"custom-proxy": {
							baseUrl: "https://custom-proxy.example.com/v1",
							api: "openai-completions",
							apiKey: config,
							authHeader: true,
							models: [{ id: "custom-model", name: "Custom Model" }],
						},
					},
				}),
			);
			return new ModelRegistry(authStorage, modelsPath);
		}

		/** The error the request path rejects with, or a failure if it resolved. */
		async function requestRefusal(registry: ModelRegistry): Promise<Error> {
			try {
				const resolved = await registry.getApiKeyWithCredentialForProvider("custom-proxy");
				throw new Error(`Expected a refusal, resolved ${JSON.stringify(resolved)}`);
			} catch (error) {
				if (error instanceof CredentialSourceError) return error;
				throw error;
			}
		}

		test("a command that prints nothing refuses by name instead of reporting no key", async () => {
			const registry = providerWithApiKey("!true");
			expect((await requestRefusal(registry)).message).toBe(
				"No API key for provider custom-proxy: the command `true` exited 0 but printed nothing",
			);
			// Probes keep their old contract: no key, no throw.
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			expect(await registry.getApiKey(model)).toBeUndefined();
			expect(await registry.getApiKeyForProvider("custom-proxy")).toBeUndefined();
			expect((await registry.resolveModelHeaders(model))?.Authorization).toBeUndefined();
		});

		test("a non-zero exit reads differently from a run that printed nothing", async () => {
			expect((await requestRefusal(providerWithApiKey("!false"))).message).toBe(
				"No API key for provider custom-proxy: the command `false` exited with status 1",
			);
		});

		test("a run past the time limit reads as a timeout, not as an empty run", async () => {
			const unbind = bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 0.5 }));
			try {
				const started = performance.now();
				expect((await requestRefusal(providerWithApiKey("!sleep 5; printf %s late"))).message).toBe(
					"No API key for provider custom-proxy: the command `sleep …` timed out after 0.5 s, the providers.commandTimeoutSeconds limit",
				);
				expect(performance.now() - started).toBeLessThan(4_000);
			} finally {
				unbind();
				bindEffects(Settings.isolated({}))();
			}
		});

		test("an environment variable set to the empty string is refused as a credential only", async () => {
			const name = `OMP_TEST_EMPTY_KEY_${Snowflake.next()}`;
			process.env[name] = "";
			try {
				// The credential path refuses: without this, the literal fallback makes the
				// variable's own name the bearer and the user gets the provider's 401.
				expect((await requestRefusal(providerWithApiKey(name))).message).toBe(
					`No API key for provider custom-proxy: environment variable ${name} is set but empty`,
				);
				// Every other config value keeps the documented literal fallback. Changing
				// this resolver for all of them silently turned a configured auth broker
				// into the local store instead of failing, so the stricter rule is the
				// credential resolver's alone.
				expect(await resolveConfigValue(name)).toBe(name);
				expect(await resolveCredentialConfigValue(`${name}_UNSET_LITERAL`)).toBe(`${name}_UNSET_LITERAL`);
			} finally {
				delete process.env[name];
			}
			// An unset variable keeps the literal fallback on the credential path too.
			expect(await resolveConfigValue(name)).toBe(name);
		});

		test("the failure a resolution produced survives a concurrent invalidation", async () => {
			// The reason used to be read from a shared map only after the value came
			// back undefined, and an invalidation landing in that window restored the
			// unhelpful "no key". It now travels with the resolution that produced it.
			// The window is one await boundary wide, so this drives it exactly: start
			// the resolution, then invalidate before its continuation runs.
			const config = "!false";
			clearConfigValueCache();
			expect(await resolveConfigValue(config)).toBeUndefined();
			const credential = resolveCredentialConfigValue(config).then(
				value => value,
				(error: unknown) => error,
			);
			invalidateAllCommandConfigs("refresh");
			const failure = await credential;
			expect(failure).toBeInstanceOf(CredentialSourceError);
			expect((failure as Error).message).toBe("the command `false` exited with status 1");
		});

		test("a derived bearer header follows the credential rule, not the literal fallback", async () => {
			// `authHeader: true` derives Authorization from the apiKey config. Resolving
			// it generically sent the variable's own name and overwrote a valid runtime
			// key; it must add no header instead.
			const name = `OMP_TEST_EMPTY_HDR_${Snowflake.next()}`;
			process.env[name] = "";
			try {
				const registry = providerWithApiKey(name);
				const model = registry.find("custom-proxy", "custom-model");
				if (!model) throw new Error("Expected custom model");
				expect((await registry.resolveModelHeaders(model))?.Authorization).toBeUndefined();
			} finally {
				delete process.env[name];
			}
		});

		test("the pool-scoped request facade reports the source too", async () => {
			// The scope replaces getApiKeyAndHeaders with its own session-scoped copy,
			// and every session started with oauthAccountPools gets it. A second copy
			// of the facade is how one of them ended up back on the availability probe.
			const registry = providerWithApiKey("!false");
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			// The pool covers a different provider: a pooled session that also configures
			// a models.yml apiKey for the SAME provider is refused by the restriction
			// before the credential command ever runs, so such a fixture cannot reach
			// the facade it claims to test. The scope's facade still serves every other
			// provider, which is the path that was on the availability probe.
			const scope = new SessionAccountPoolScope(
				authStorage,
				{ "pooled-elsewhere": ["pool-identity"] },
				"pool-session",
			);
			try {
				expect(await scope.registry(registry).getApiKeyAndHeaders(model)).toEqual({
					ok: false,
					error: "No API key for provider custom-proxy: the command `false` exited with status 1",
				});
			} finally {
				scope.release();
			}
		});

		test("the historical request facade reports the source, not a generic missing key", async () => {
			// getApiKeyAndHeaders is a request path: it must not read the availability
			// probe, or the fix stops at the edge of the new API.
			const registry = providerWithApiKey("!false");
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			expect(await registry.getApiKeyAndHeaders(model)).toEqual({
				ok: false,
				error: "No API key for provider custom-proxy: the command `false` exited with status 1",
			});
		});

		test("the label names the program only: no argument, no assignment value, no home path", async () => {
			// A leading `NAME=value` is as much a secret as an argument, and the message
			// also reaches ~/.omp/logs, which users paste into bug reports.
			expect((await requestRefusal(providerWithApiKey("!SECRET_TOKEN=hunter2 false"))).message).toBe(
				"No API key for provider custom-proxy: the command `SECRET_TOKEN=… false` exited with status 1",
			);
			// A quoted program path keeps its spaces, or an operator cannot match the
			// message against their config (and every `C:\Program Files\…` hits this).
			const spaced = path.join(tempDir, "my scripts");
			fs.mkdirSync(spaced, { recursive: true });
			const script = path.join(spaced, "mint.sh");
			fs.writeFileSync(script, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			expect((await requestRefusal(providerWithApiKey(`!${shellQuote(script)}`))).message).toBe(
				`No API key for provider custom-proxy: the command \`${script}\` exited with status 1`,
			);
			// A substitution is not parsed, and the scan desynchronises inside it, so
			// nothing after it is printed. Showing the text there put the secret in
			// the error and in ~/.omp/logs.
			const subst = await requestRefusal(providerWithApiKey("!SECRET=$(echo 'sk-live-not-a-real-key') false"));
			expect(subst.message).toBe(
				"No API key for provider custom-proxy: the command `SECRET=… …` exited with status 1",
			);
			expect(subst.message).not.toContain("sk-live-not-a-real-key");
			// The home directory is shortened out, like every other path we show. The
			// home is a stub pointing at tempDir: a fixture must never write, or even
			// name, a path under the real home.
			const homed = spyOn(os, "homedir").mockReturnValue(fs.realpathSync(tempDir));
			try {
				// Positive, and after symlinks: the fixture must live under the temp root,
				// whatever the path we were handed resolves to.
				const root = fs.realpathSync(tempDir);
				const underHome = path.join(root, "home-mint.sh");
				expect(path.resolve(underHome).startsWith(`${root}${path.sep}`)).toBe(true);
				fs.writeFileSync(underHome, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
				expect((await requestRefusal(providerWithApiKey(`!${underHome}`))).message).toBe(
					"No API key for provider custom-proxy: the command `~/home-mint.sh` exited with status 1",
				);
			} finally {
				homed.mockRestore();
			}
		});

		test("the label stops at a quote it cannot close, and at an escaped quote inside one", async () => {
			// `\"` inside double quotes is a literal quote, not the closing one. Reading
			// it as the close desynchronised the scan and printed the rest of the
			// assignment's value as the program name, into the message and ~/.omp/logs.
			const escaped = await requestRefusal(providerWithApiKey('!LABEL="x\\" sk-live-escaped-not-a-real-key" false'));
			expect(escaped.message).toBe(
				"No API key for provider custom-proxy: the command `LABEL=… false` exited with status 1",
			);
			expect(escaped.message).not.toContain("sk-live-escaped-not-a-real-key");
			// A word that ends while a quote is still open is not a word the shell would
			// have ended either: fail closed rather than print the remaining text.
			for (const open of ['"', "'"]) {
				const unterminated = await requestRefusal(
					providerWithApiKey(`!${open}false sk-live-unterminated-not-a-real-key`),
				);
				// The shell reports its own syntax error here, so the status is the
				// shell's and not worth pinning; the label is the contract.
				expect(unterminated.message).toStartWith(
					"No API key for provider custom-proxy: the command `…` exited with status",
				);
				expect(unterminated.message).not.toContain("sk-live-unterminated-not-a-real-key");
			}
		});

		// The six inputs a review arm leaked through the real CLI at round 5, each
		// confirmed in that run's own ~/.omp/logs. They are fixtures rather than a
		// re-survey: a 46-input survey of the label helper in isolation reported zero
		// leaks in the same round, because none of these was among its inputs.
		test.each([
			// Characters JavaScript calls whitespace and /bin/sh does not. The shell sees
			// ONE assignment followed by `false`; splitting inside the value printed the
			// value as the program name.
			["a nonbreaking space inside an assignment value", "LABEL=x\u00a0sk-live-nbsp false"],
			["an em space inside an assignment value", "LABEL=x\u2003sk-live-em false"],
			["a carriage return inside an assignment value", "LABEL=x\rsk-live-cr false"],
			// Executable words that only LOOK like assignments once quotes and escapes are
			// removed. The shell runs `LABEL=x` as a program; its argument is not ours to print.
			["a quoted word that decodes to NAME=value", "'LABEL=x' sk-live-quoted"],
			["an escaped = in a word that decodes to NAME=value", "LABEL\\=x sk-live-escaped-eq"],
			["a partly quoted name that decodes to NAME=value", "LA'BEL'=x sk-live-split-name"],
		])("the label leaks nothing for %s", async (_name, apiKeyConfig) => {
			const refusal = await requestRefusal(providerWithApiKey(`!${apiKeyConfig}`));
			expect(refusal.message).not.toContain("sk-live-");
		});

		test("a 401 whose re-resolution yields nothing reports the source, not the rejection", async () => {
			const tokenFile = path.join(tempDir, "remint-token.txt");
			fs.writeFileSync(tokenFile, "stale-key");
			const script = path.join(tempDir, "mint.sh");
			fs.writeFileSync(
				script,
				`#!/bin/sh\nt=$(cat ${shellQuote(tokenFile)})\n[ "$t" = FAIL ] && exit 1\nprintf %s "$t"\n`,
				{ mode: 0o755 },
			);

			const registry = providerWithApiKey(`!${script}`);
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			expect(await registry.getApiKey(model)).toBe("stale-key");
			fs.writeFileSync(tokenFile, "FAIL");

			const attempted: string[] = [];
			const failure = await withAuth(registry.resolver(model), async key => {
				attempted.push(key);
				throw Object.assign(new Error("401 authentication_error"), { status: 401 });
			}).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(attempted).toEqual(["stale-key"]);
			expect(failure).toBeInstanceOf(CredentialSourceError);
			// The label shortens $HOME, so build the expectation the same way rather
			// than assuming the OS temp dir sits outside it.
			const label = script.startsWith(`${os.homedir()}/`) ? `~${script.slice(os.homedir().length)}` : script;
			expect((failure as Error).message).toBe(
				`No API key for provider custom-proxy: the command \`${label}\` exited with status 1. ` +
					"It was re-resolved because the provider rejected the previous key: 401 authentication_error",
			);
			expect((failure as Error).cause).toBeInstanceOf(Error);
		});
	});

	/** Config dir whose config.yml sets `commandTimeoutSeconds` (and optionally more YAML). */
	function scopeWithTimeout(name: string, seconds: number, extraYaml = ""): string {
		const agentDir = path.join(tempDir, name);
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			`providers:\n  commandTimeoutSeconds: ${seconds}\n${extraYaml}`,
		);
		return agentDir;
	}

	/** Hides and restores the broker environment a discovery would otherwise pick up. */
	function withoutBrokerEnv(): () => void {
		const previousAgentDir = getAgentDir();
		const previousEnv = Object.fromEntries(
			["PI_CODING_AGENT_DIR", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"].map(key => [key, process.env[key]]),
		);
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		return () => {
			setAgentDir(previousAgentDir);
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
	}

	// Each case starts from a 0.5 s process limit left by an earlier owner, shorter than its 1 s helper,
	// so only the limit the case's own scope names lets the helper finish. Every case drives the consumer
	// a user reaches — a discovered credential store, `omp auth-broker`'s config resolution — never the
	// resolver on its own, because the defect these guard was invisible one level in.
	describe.skipIf(process.platform === "win32")("each scope's own command time limit", () => {
		beforeEach(() => {
			expect(Settings.current).toBeNull();
			bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 0.5 }))();
		});
		afterEach(() => {
			bindEffects(Settings.isolated({}))();
			clearConfigValueCache();
		});

		test("a discovered credential store runs a !command key under its own scope's limit", async () => {
			const restoreEnv = withoutBrokerEnv();
			const agentDir = scopeWithTimeout("store-agent", 30);
			const settings = await Settings.loadReadOnly({ cwd: tempDir, agentDir });
			const storage = await discoverAuthStorage(agentDir, { settings });
			try {
				const marker = path.join(tempDir, "store-scope");
				storage.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote(marker)}`);
				expect(await storage.keys.get("scope-probe")).toBe(marker);
			} finally {
				storage.close();
				restoreEnv();
			}
		});

		// Building a ModelRegistry over a discovered store used to replace that store's
		// resolver with the unscoped one, so the scope survived discovery and died one
		// layer out. `omp token` and `omp usage` both build this registry; a review arm
		// measured a 1 s helper succeeding under a 0.2 s scope, and an 11 s helper killed
		// at 10 s under a 15 s one.
		//
		// The scope must be LONGER than the limit this describe leaves on the process, or
		// the test passes against the broken tree by luck: losing the scope then falls back
		// to a residue that happens to refuse the same helper. A first draft did exactly
		// that and passed at the defective head.
		test("building a ModelRegistry over a discovered store keeps that store's limit", async () => {
			const restoreEnv = withoutBrokerEnv();
			const agentDir = scopeWithTimeout("registry-agent", 30);
			const settings = await Settings.loadReadOnly({ cwd: tempDir, agentDir });
			const storage = await discoverAuthStorage(agentDir, { settings });
			try {
				const modelsPath = path.join(agentDir, "models.yml");
				fs.writeFileSync(modelsPath, "providers: {}\n");
				// The registry is the consumer; constructing it is what used to break the store.
				new ModelRegistry(storage, modelsPath);
				const marker = path.join(tempDir, "registry-scope");
				storage.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote(marker)}`);
				expect(await storage.keys.get("scope-probe")).toBe(marker);
			} finally {
				storage.close();
				restoreEnv();
			}
		}, 30_000);

		test("discovering a store for another scope does not change an open store's limit", async () => {
			const restoreEnv = withoutBrokerEnv();
			const shortDir = scopeWithTimeout("pair-short", 0.5);
			const longDir = scopeWithTimeout("pair-long", 30);
			const shortSettings = await Settings.loadReadOnly({ cwd: tempDir, agentDir: shortDir });
			const longSettings = await Settings.loadReadOnly({ cwd: tempDir, agentDir: longDir });
			const shortStore = await discoverAuthStorage(shortDir, { settings: shortSettings });
			let longStore: AuthStorage | undefined;
			try {
				// The short scope's own limit kills its 1 s helper, before any other scope exists.
				shortStore.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote("before")}`);
				expect(await shortStore.keys.get("scope-probe")).toBeUndefined();
				longStore = await discoverAuthStorage(longDir, { settings: longSettings });
				// Opening the 30 s scope must not relax the 0.5 s one: a different command, so no cache hit.
				shortStore.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote("after")}`);
				expect(await shortStore.keys.get("scope-probe")).toBeUndefined();
				// And the long scope still gets its own 30 s limit, so this is not "everything is short now".
				longStore.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote("long")}`);
				expect(await longStore.keys.get("scope-probe")).toBe("long");
			} finally {
				longStore?.close();
				shortStore.close();
				restoreEnv();
			}
		}, 30_000);

		test("a !command broker token runs under its own agent dir's limit, after a shorter scope resolved", async () => {
			const shortDir = scopeWithTimeout(
				"broker-short",
				0.5,
				`auth:\n  broker:\n    url: http://127.0.0.1:9\n    token: short-literal-token\n`,
			);
			const longDir = scopeWithTimeout(
				"broker-long",
				30,
				`auth:\n  broker:\n    url: http://127.0.0.1:9\n    token: ${JSON.stringify("!sleep 1; printf broker-token")}\n`,
			);
			const restoreEnv = withoutBrokerEnv();
			try {
				setAgentDir(shortDir);
				expect(await resolveAuthBrokerConfig()).toEqual({
					url: "http://127.0.0.1:9",
					token: "short-literal-token",
				});
				setAgentDir(longDir);
				expect(await resolveAuthBrokerConfig()).toEqual({ url: "http://127.0.0.1:9", token: "broker-token" });
			} finally {
				restoreEnv();
			}
		}, 30_000);

		// A configured `auth.broker.token` that nothing was going to read must not run,
		// and must not fail the process: making the token a credential source turned a
		// leftover entry into a hard error for users whose broker comes from the
		// environment, and for users with no broker at all.
		test("a configured broker token the environment outranks is never run", async () => {
			const agentDir = scopeWithTimeout(
				"broker-env-wins",
				30,
				`auth:\n  broker:\n    url: http://127.0.0.1:9\n    token: ${JSON.stringify("!false")}\n`,
			);
			const previousAgentDir = getAgentDir();
			const previousEnv = Object.fromEntries(
				["PI_CODING_AGENT_DIR", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"].map(key => [key, process.env[key]]),
			);
			delete process.env.OMP_AUTH_BROKER_URL;
			process.env.OMP_AUTH_BROKER_TOKEN = "environment-broker-token";
			setAgentDir(agentDir);
			try {
				expect(await resolveAuthBrokerConfig()).toEqual({
					url: "http://127.0.0.1:9",
					token: "environment-broker-token",
				});
			} finally {
				setAgentDir(previousAgentDir);
				for (const [key, value] of Object.entries(previousEnv)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		test("a leftover broker token with no broker URL leaves the local store alone", async () => {
			const agentDir = scopeWithTimeout(
				"broker-no-url",
				30,
				`auth:\n  broker:\n    token: ${JSON.stringify("!false")}\n`,
			);
			const previousAgentDir = getAgentDir();
			const previousEnv = Object.fromEntries(
				["PI_CODING_AGENT_DIR", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"].map(key => [key, process.env[key]]),
			);
			delete process.env.OMP_AUTH_BROKER_URL;
			delete process.env.OMP_AUTH_BROKER_TOKEN;
			setAgentDir(agentDir);
			try {
				expect(await resolveAuthBrokerConfig()).toBeNull();
			} finally {
				setAgentDir(previousAgentDir);
				for (const [key, value] of Object.entries(previousEnv)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		test("settings that drive effects keep their limit when another scope opens a store", async () => {
			const restoreEnv = withoutBrokerEnv();
			const releaseOwner = bindEffects(Settings.isolated({ "providers.commandTimeoutSeconds": 30 }));
			const agentDir = scopeWithTimeout("owned-scope", 0.5);
			const settings = await Settings.loadReadOnly({ cwd: tempDir, agentDir });
			const storage = await discoverAuthStorage(agentDir, { settings });
			try {
				const marker = path.join(tempDir, "owned");
				storage.keys.setConfig("scope-probe", `!sleep 1; printf %s ${shellQuote(marker)}`);
				expect(await storage.keys.get("scope-probe")).toBe(marker);
			} finally {
				storage.close();
				releaseOwner();
				restoreEnv();
			}
		}, 30_000);
	});
});
