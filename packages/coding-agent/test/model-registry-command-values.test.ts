import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import {
	getCommandHeaderCredentials,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	setCommandHeaderCredentials,
	type ApiKeyResolveContext,
	withAuth,
} from "@oh-my-pi/pi-ai/auth-retry";
import type { Context, FetchImpl, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	describeCommandConfigFailure,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	rejectCommandConfig,
	resolveConfigHeaders,
	resolveConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

/** Command whose first run exits 1 with no output; later runs print `<key>-<run number>`. */
function failOnceCommand(counterFile: string, key: string): string {
	if (process.platform !== "win32") {
		return `printf 1 >> ${shellQuote(counterFile)}; n=$(wc -c < ${shellQuote(counterFile)}); [ $n -le 1 ] && exit 1; printf %s ${shellQuote(key)}-$n`;
	}
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const n=fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length;if(n<=1)process.exit(1);process.stdout.write(${JSON.stringify(key)}+"-"+n);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Command that records every run, exits nonzero, and never prints stdout. */
function failedTrackingCommand(counterFile: string): string {
	if (process.platform !== "win32") return `printf 1 >> ${shellQuote(counterFile)}; exit 1`;
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");process.exit(1);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Integration gate: the child waits for a file the test creates; no elapsed-time assumption. */
function gatedTokenCommand(tokenFile: string, counterFile: string, startedFile: string, releaseFile: string): string {
	return `printf 1 >> ${shellQuote(counterFile)}; : > ${shellQuote(startedFile)}; until [ -f ${shellQuote(releaseFile)} ]; do sleep 0.01; done; IFS= read -r token < ${shellQuote(tokenFile)}; printf %s "$token"`;
}

async function waitForFile(file: string): Promise<void> {
	if (await Bun.file(file).exists()) return;
	const done = Promise.withResolvers<void>();
	const watcher = fs.watch(path.dirname(file), (_event, name) => {
		if (name === path.basename(file)) {
			watcher.close();
			done.resolve();
		}
	});
	await done.promise;
}

/** Command emits a file's synthetic stdout before failing; callers must never surface it. */
function noisyFailedCommand(stdoutFile: string): string {
	if (process.platform !== "win32") return `cat ${shellQuote(stdoutFile)}; exit 1`;
	const script = `const fs=require("node:fs");process.stdout.write(fs.readFileSync(${JSON.stringify(stdoutFile)}, "utf8"));process.exit(1);`;
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

	test("materialized command headers remain valid Fetch headers", async () => {
		const headers = await resolveConfigHeaders({ "x-command-token": `!${stdoutCommand("synthetic-header")}` });
		expect(new Headers(headers).get("x-command-token")).toBe("synthetic-header");
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

	test("a failed ordinary refresh keeps the previous key through its failure backoff", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "previous-key");
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
		expect(await registry.getApiKey(model)).toBe("previous-key");
		fs.writeFileSync(tokenFile, "");
		invalidateCommandConfig(`!${command}`);

		expect(await registry.getApiKey(model)).toBe("previous-key");
		expect((await registry.resolveModelHeaders(model))?.Authorization).toBe("Bearer previous-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});

	test("fails closed after the bounded rejected-digest ledger fills", async () => {
		const config = `!${stdoutCommand("would-be-accepted")}`;
		for (let index = 0; index <= 256; index++) {
			rejectCommandConfig(config, `rejected-${index}`);
		}
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(describeCommandConfigFailure(config)).toContain("rejected too many keys");
	});

	test("a first mint retries once, then shares its failure backoff across lookups", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		const config = `!${failedTrackingCommand(counterFile)}`;

		expect(
			await Promise.all([resolveConfigValue(config), resolveConfigValue(config), resolveConfigValue(config)]),
		).toEqual([undefined, undefined, undefined]);

		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});
	test("withAuth preserves a ModelRegistry command diagnostic without command stdout", async () => {
		const stdoutFile = path.join(tempDir, "command-stdout.txt");
		fs.writeFileSync(stdoutFile, "synthetic-command-stdout");
		const command = noisyFailedCommand(stdoutFile);
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

		let failure: unknown;
		try {
			await withAuth(registry.resolver(model), async () => "unexpected");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(command);
		expect((failure as Error).message).toContain("status 1");
		expect((failure as Error).message).not.toContain("synthetic-command-stdout");
	});

	test("a first mint that fails once succeeds on the request retry without a pre-send command run", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${failOnceCommand(counterFile, "minted-key")}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: registry,
			model,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});
		const preSendLookup = spyOn(registry, "getApiKey");
		const authorizations: Array<string | undefined> = [];
		const recordingFetch: FetchImpl = async (_url, init) => {
			authorizations.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
			return okChatCompletionStream();
		};
		session.agent.streamFn = (streamModel, context, options) =>
			streamSimple(streamModel, context, { ...options, fetch: recordingFetch });
		try {
			await session.prompt("hi");
		} finally {
			await session.dispose();
		}

		expect(preSendLookup).not.toHaveBeenCalled();
		expect(authorizations).toEqual(["Bearer minted-key-2"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	}, 20_000);

	test("a 401-rejected command key is never sent on the next turn when re-minting fails", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "rejected-key");
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
		expect(await registry.getApiKey(model)).toBe("rejected-key");
		fs.writeFileSync(tokenFile, "FAIL");
		const sent: string[] = [];
		const reject = async (key: string) => {
			sent.push(key);
			throw Object.assign(new Error("401 authentication_error"), { status: 401 });
		};

		await expect(withAuth(registry.resolver(model), reject)).rejects.toMatchObject({ status: 401 });
		let nextTurnFailure: unknown;
		try {
			await withAuth(registry.resolver(model), reject);
		} catch (error) {
			nextTurnFailure = error;
		}
		expect(nextTurnFailure).toBeInstanceOf(Error);
		expect((nextTurnFailure as Error).message).toContain(command);
		expect((nextTurnFailure as Error).message).toContain("status 1");
		expect(sent).toEqual(["rejected-key"]);
		expect(await registry.getApiKey(model)).toBeUndefined();
	});

	test("a replacement mint that repeats a 401-rejected key is never sent on the next turn", async () => {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "bad-key");
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
		expect(await registry.getApiKey(model)).toBe("bad-key");
		const sent: string[] = [];
		const reject = async (key: string) => {
			sent.push(key);
			throw Object.assign(new Error("401 authentication_error"), { status: 401 });
		};

		await expect(withAuth(registry.resolver(model), reject)).rejects.toMatchObject({ status: 401 });
		await expect(withAuth(registry.resolver(model), reject)).rejects.toThrow(command);
		expect(sent).toEqual(["bad-key"]);
	});

	test("a second 401 rejects the refreshed key before last-chance rotation", async () => {
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
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		expect(await registry.getApiKey(model)).toBe("stale-key");
		fs.writeFileSync(tokenFile, "fresh-1");
		const attempts: string[] = [];
		const result = await withAuth(registry.resolver(model), async key => {
			attempts.push(key);
			if (key === "stale-key") throw Object.assign(new Error("401 authentication_error"), { status: 401 });
			if (key === "fresh-1") {
				fs.writeFileSync(tokenFile, "fresh-2");
				throw Object.assign(new Error("401 authentication_error"), { status: 401 });
			}
			return key;
		});
		expect(result).toBe("fresh-2");
		const nextTurn = await withAuth(registry.resolver(model), async key => key);
		expect(nextTurn).toBe("fresh-2");
		expect(attempts).toEqual(["stale-key", "fresh-1", "fresh-2"]);
	});

	test("concurrent 401 recoveries share one replacement command run", async () => {
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
		const requests = await Promise.all(
			Array.from({ length: 5 }, () =>
				withAuth(registry.resolver(model), async key => {
					if (key === "stale-key") throw Object.assign(new Error("401 authentication_error"), { status: 401 });
					return key;
				}),
			),
		);
		expect(requests).toEqual(["fresh-key", "fresh-key", "fresh-key", "fresh-key", "fresh-key"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});

	test("a 401 only rejects command headers on the requested model", async () => {
		const tokenB = path.join(tempDir, "model-b-token.txt");
		const counterB = path.join(tempDir, "model-b-counter.txt");
		fs.writeFileSync(tokenB, "b-good");
		fs.writeFileSync(counterB, "");
		const commandB = trackedTokenCommand(tokenB, counterB);
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: "provider-key",
						models: [
							{ id: "model-a", name: "Model A" },
							{ id: "model-b", name: "Model B", headers: { "x-b-token": `!${commandB}` } },
						],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const modelA = registry.find("custom-proxy", "model-a");
		const modelB = registry.find("custom-proxy", "model-b");
		if (!modelA || !modelB) throw new Error("Expected custom models");
		expect((await registry.resolveModelHeaders(modelB))?.["x-b-token"]).toBe("b-good");
		fs.writeFileSync(tokenB, "FAIL");

		await registry.resolver(modelA)({
			lastChance: false,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
		});
		expect((await registry.resolveModelHeaders(modelB))?.["x-b-token"]).toBe("b-good");
		expect(fs.readFileSync(counterB, "utf8")).toBe("1");
	});

	test("a late 401 rejects the bearer it sent instead of a peer's fresh replacement", async () => {
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
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		const resolver = registry.resolver(model);
		expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "stale-key" });
		expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "stale-key" });
		fs.writeFileSync(tokenFile, "fresh-key");
		const firstRecovery = await resolver({
			lastChance: false,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: "stale-key",
			previousSentCredentials: {
				apiKey: "stale-key",
				commandCredentials: [{ config: `!${command}`, value: "stale-key" }],
			},
		});
		expect(firstRecovery).toMatchObject({ apiKey: "fresh-key" });
		const lateRecovery = await resolver({
			lastChance: false,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: "stale-key",
			previousSentCredentials: {
				apiKey: "stale-key",
				commandCredentials: [{ config: `!${command}`, value: "stale-key" }],
			},
		});
		expect(lateRecovery).toMatchObject({ apiKey: "fresh-key" });
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});

	test.skipIf(process.platform === "win32")(
		"a 401 arriving during a mint makes every waiter reject the stale bearer",
		async () => {
			const tokenFile = path.join(tempDir, "token.txt");
			const counterFile = path.join(tempDir, "counter.txt");
			const startedFile = path.join(tempDir, "mint-started");
			const releaseFile = path.join(tempDir, "mint-release");
			fs.writeFileSync(tokenFile, "bad-key");
			fs.writeFileSync(counterFile, "");
			fs.writeFileSync(releaseFile, "");
			const command = gatedTokenCommand(tokenFile, counterFile, startedFile, releaseFile);
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
			const resolver = registry.resolver(model);
			expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "bad-key" });
			fs.rmSync(startedFile);
			fs.rmSync(releaseFile);
			invalidateCommandConfig(`!${command}`);
			const waitingRequest = resolver({ lastChance: false, error: undefined });
			await waitForFile(startedFile);
			const recovery = resolver({
				lastChance: false,
				error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
				previousKey: "bad-key",
				previousSentCredentials: {
					apiKey: "bad-key",
					commandCredentials: [{ config: `!${command}`, value: "bad-key" }],
				},
			});
			fs.writeFileSync(releaseFile, "");
			await expect(waitingRequest).rejects.toThrow("returned a value rejected by a 401");
			expect(await recovery).toBeUndefined();
			expect(fs.readFileSync(counterFile, "utf8")).toBe("111");
		},
		20_000,
	);

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

	test("a 401 rejects the sent command-backed header instead of resending its last-good value", async () => {
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
		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const fetch: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push({ auth: headers.Authorization, tenant: headers["x-tenant-token"] });
			if (seen.length === 1) {
				fs.writeFileSync(bearerFile, "fresh-bearer");
				fs.writeFileSync(tenantFile, "");
			}
			return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
		};
		const streamHandle = streamSimple(
			model,
			{ systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: registry.resolver(model), fetch, maxTokens: 16 },
		);
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();
		expect(result.stopReason).toBe("error");
		expect(seen[0]).toEqual({ auth: "Bearer stale-bearer", tenant: "stale-tenant" });
		expect(seen.slice(1).every(request => request.tenant !== "stale-tenant")).toBe(true);
	});

	test("a caller header override does not reject the masked command header", async () => {
		const bearerFile = path.join(tempDir, "bearer.txt");
		const tenantFile = path.join(tempDir, "tenant.txt");
		const tenantCounter = path.join(tempDir, "tenant-counter.txt");
		fs.writeFileSync(bearerFile, "stale-bearer");
		fs.writeFileSync(tenantFile, "stale-tenant");
		fs.writeFileSync(tenantCounter, "");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutFileCommand(bearerFile)}`,
						headers: { "x-tenant-token": `!${trackedTokenCommand(tenantFile, tenantCounter)}` },
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		const seen: Array<{ auth?: string; tenant?: string }> = [];
		const fetch: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push({ auth: headers.Authorization, tenant: headers["x-tenant-token"] });
			if (seen.length === 1) {
				fs.writeFileSync(bearerFile, "fresh-bearer");
				fs.writeFileSync(tenantFile, "FAIL");
				return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
			}
			return okChatCompletionStream();
		};
		const streamHandle = streamSimple(
			model,
			{ systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: registry.resolver(model),
				fetch,
				headers: { "x-tenant-token": "caller-token" },
				maxTokens: 16,
			},
		);
		for await (const _event of streamHandle) {
			// drain
		}
		expect((await streamHandle.result()).stopReason).not.toBe("error");
		expect(seen).toEqual([
			{ auth: "Bearer stale-bearer", tenant: "caller-token" },
			{ auth: "Bearer fresh-bearer", tenant: "caller-token" },
		]);
		expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("stale-tenant");
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

		invalidateAllCommandConfigs();
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
	type MatrixCredentialType = "apiKey only" | "header only" | "both";
	type MatrixOutcome = "success" | "final failure";
	type MatrixRetryPath = "normal force-refresh" | "lastChance" | "sibling rotation";
	type MatrixRemint = "fresh value" | "reprint rejected value" | "failure";
	type MatrixEntryPoint = "streamSimple" | "withAuth" | "preflightThenSeed";

	interface MatrixCommandCredential {
		config: string;
		value: string;
	}

	interface MatrixSentCredentials {
		apiKey: string;
		commandCredentials: readonly MatrixCommandCredential[];
	}

	interface MatrixResolution {
		apiKey: string;
		commandCredentials: readonly MatrixCommandCredential[];
		afterSiblingWait?: boolean;
	}

	type MatrixResolveContext = ApiKeyResolveContext & {
		previousSentCredentials?: MatrixSentCredentials;
	};

	/**
	 * Synthetic command authority used by the retry matrix. Its received
	 * credential set is the transport's only source of command-backed values.
	 */
	class MatrixCommandAuthority {
		#stage = 0;
		#current: MatrixResolution | undefined;
		#lastDispatched: MatrixSentCredentials | undefined;
		#lastRejectedCredentials: string | undefined;
		#sent: MatrixSentCredentials[] = [];
		#rejected = new Set<string>();
		#contexts: Array<{ lastChance: boolean; hadError: boolean }> = [];
		#forcedLastChance = false;
		#usedSiblingRotation = false;
		#rejectionCount = 0;
		#turnCommandRuns = 0;
		#contractFailure: string | undefined;

		constructor(
			readonly credentialType: MatrixCredentialType,
			readonly consecutive401s: number,
			readonly outcome: MatrixOutcome,
			readonly retryPath: MatrixRetryPath,
			readonly remint: MatrixRemint,
		) {}

		#commands(): readonly ("apiKey" | "header")[] {
			if (this.credentialType === "apiKey only") return ["apiKey"];
			if (this.credentialType === "header only") return ["header"];
			return ["apiKey", "header"];
		}

		#commandValue(kind: "apiKey" | "header"): string | undefined {
			if (this.#stage > 0 && this.remint === "failure") return undefined;
			return this.remint === "fresh value" ? `${kind}-synthetic-${this.#stage}` : `${kind}-synthetic-0`;
		}

		#isRejected(credential: MatrixCommandCredential): boolean {
			return this.#rejected.has(`${credential.config}\u0000${credential.value}`);
		}

		#resolution(): MatrixResolution | undefined {
			this.#turnCommandRuns += this.#commands().length;
			const commandCredentials = this.#commands().flatMap(kind => {
				const value = this.#commandValue(kind);
				return value === undefined
					? []
					: [{ config: `!matrix-${kind}-command`, value } satisfies MatrixCommandCredential];
			});
			const apiKeyCredentials = commandCredentials.filter(
				credential => credential.config === "!matrix-apiKey-command",
			);
			if (apiKeyCredentials.some(credential => this.#isRejected(credential))) return undefined;
			return {
				apiKey: apiKeyCredentials[0]?.value ?? `carrier-${this.#stage}`,
				commandCredentials: apiKeyCredentials,
				...(this.retryPath === "sibling rotation" && this.#contexts.at(-1)?.lastChance
					? { afterSiblingWait: true }
					: {}),
			};
		}

		headers(): Record<string, string> | undefined {
			if (this.credentialType === "apiKey only") return undefined;
			const value = this.#commandValue("header");
			if (!value) return undefined;
			const credential = { header: "x-matrix-header", config: "!matrix-header-command", value };
			return this.#isRejected(credential)
				? undefined
				: setCommandHeaderCredentials({ "x-matrix-header": value }, [credential]);
		}

		beginTurn(): void {
			const maximumRuns = this.#commands().length * (this.consecutive401s * 2 + 1);
			if (this.#turnCommandRuns > maximumRuns) {
				this.#contractFailure ??= `command mint budget exceeded (${this.#turnCommandRuns} > ${maximumRuns})`;
			}
			this.#turnCommandRuns = 0;
		}

		async resolve(context: ApiKeyResolveContext): Promise<MatrixResolution | undefined> {
			this.#contexts.push({ lastChance: context.lastChance, hadError: context.error !== undefined });
			if (context.error !== undefined) {
				const previous = (context as MatrixResolveContext).previousSentCredentials;
				if (!previous) {
					this.#contractFailure ??= "the retry driver did not return the dispatched credential set";
					return undefined;
				}
				if (
					!this.#lastDispatched ||
					previous.apiKey !== this.#lastDispatched.apiKey ||
					JSON.stringify(previous.commandCredentials) !== JSON.stringify(this.#lastDispatched.commandCredentials)
				) {
					this.#contractFailure ??= "the retry driver returned credentials from a different attempt";
					return undefined;
				}
				const serializedCredentials = JSON.stringify(previous.commandCredentials);
				if (serializedCredentials !== this.#lastRejectedCredentials) {
					for (const credential of previous.commandCredentials) {
						this.#rejected.add(`${credential.config}\u0000${credential.value}`);
					}
					this.#lastRejectedCredentials = serializedCredentials;
					this.#rejectionCount += 1;
					this.#stage += 1;
				}
				if (context.lastChance && this.retryPath === "sibling rotation") this.#usedSiblingRotation = true;
				if (this.retryPath !== "normal force-refresh" && !context.lastChance && !this.#forcedLastChance) {
					this.#forcedLastChance = true;
					return { apiKey: previous.apiKey, commandCredentials: [] };
				}
				if (this.outcome === "final failure" && this.#stage >= this.consecutive401s) return undefined;
			}
			this.#current = this.#resolution();
			return this.#current;
		}

		dispatch(apiKey: string, headers?: Record<string, string> | Headers): MatrixSentCredentials {
			const current = this.#current;
			if (!current || current.apiKey !== apiKey) {
				throw new Error("the transport received a credential that was not materialized");
			}
			const provenanceHeaders = headers instanceof Headers ? this.headers() : headers;
			const sent = {
				apiKey,
				commandCredentials: [...current.commandCredentials, ...getCommandHeaderCredentials(provenanceHeaders)],
			};
			if (sent.commandCredentials.some(credential => this.#isRejected(credential))) {
				throw new Error("the transport received a command value previously rejected by a 401");
			}
			this.#lastDispatched = sent;
			this.#sent.push(sent);
			return sent;
		}

		assertInvariants(): void {
			this.beginTurn();
			if (this.#contractFailure) throw new Error(this.#contractFailure);
			const sentValues = new Set(
				this.#sent.flatMap(sent =>
					sent.commandCredentials.map(credential => `${credential.config}\u0000${credential.value}`),
				),
			);
			for (const rejected of this.#rejected) {
				if (!sentValues.has(rejected)) throw new Error("a credential not sent by the transport was rejected");
			}
			if (!this.#contexts[0] || this.#contexts[0].hadError || this.#contexts[0].lastChance) {
				throw new Error("the initial resolution did not use the normal retry context");
			}
			if (this.retryPath !== "normal force-refresh" && this.#rejectionCount > 0 && !this.#forcedLastChance) {
				throw new Error("the requested lastChance path was not exercised");
			}
			if (this.retryPath === "sibling rotation" && this.#rejectionCount > 0 && !this.#usedSiblingRotation) {
				throw new Error("the requested sibling rotation path was not exercised");
			}
			if (
				this.remint === "fresh value" &&
				this.outcome === "success" &&
				this.consecutive401s > 0 &&
				!this.#sent.some(sent => sent.commandCredentials.some(credential => credential.value.endsWith("-1")))
			) {
				throw new Error("a fresh non-rejected command value was not dispatched");
			}
		}
	}

	async function runMatrixOperation(
		entryPoint: MatrixEntryPoint,
		authority: MatrixCommandAuthority,
		remaining401s: number,
	): Promise<void> {
		let requests = 0;
		const rejectOrSucceed = (apiKey: string, headers?: Record<string, string> | Headers): Promise<"ok"> => {
			authority.dispatch(apiKey, headers);
			requests += 1;
			if (requests <= remaining401s) {
				return Promise.reject(Object.assign(new Error("synthetic 401"), { status: 401 }));
			}
			return Promise.resolve("ok");
		};
		authority.beginTurn();
		if (entryPoint === "withAuth" || entryPoint === "preflightThenSeed") {
			try {
				const resolver =
					entryPoint === "preflightThenSeed"
						? seedApiKeyResolver(
								await resolveApiKeyOnce(authority.resolve.bind(authority)),
								authority.resolve.bind(authority),
							)
						: authority.resolve.bind(authority);
				await withAuth(resolver, (apiKey, recordSentCredentials) => {
					const headers = authority.headers();
					recordSentCredentials?.(getCommandHeaderCredentials(headers));
					return rejectOrSucceed(apiKey, headers);
				});
			} catch {
				// The matrix intentionally includes final 401 and command-mint failures.
			}
			return;
		}

		const model = {
			...buildModel({
				id: "matrix-model",
				name: "Matrix model",
				api: "openai-completions",
				provider: "matrix-provider",
				baseUrl: "https://matrix.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 16,
			} satisfies ModelSpec<"openai-completions">),
			resolveHeaders: async () => authority.headers(),
		};
		const fetch: FetchImpl = async (_url, init) => {
			try {
				await rejectOrSucceed(
					new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "",
					new Headers(init?.headers),
				);
				return okChatCompletionStream();
			} catch {
				return new Response(JSON.stringify({ error: { message: "synthetic 401", type: "authentication_error" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
		};
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "matrix", timestamp: 0 }] },
			{
				apiKey: authority.resolve.bind(authority),
				fetch,
				maxTokens: 16,
			},
		);
		try {
			for await (const _event of stream) {
				// Drain the retrying public stream.
			}
			await stream.result();
		} catch {
			// The matrix intentionally includes final 401 and command-mint failures.
		}
	}

	test("never re-dispatches a 401-rejected command credential across the auth retry matrix", async () => {
		const credentialTypes: readonly MatrixCredentialType[] = ["apiKey only", "header only", "both"];
		const sequences = [1, 2, 3] as const;
		const outcomes: readonly MatrixOutcome[] = ["success", "final failure"];
		const retryPaths: readonly MatrixRetryPath[] = ["normal force-refresh", "lastChance", "sibling rotation"];
		const remints: readonly MatrixRemint[] = ["fresh value", "reprint rejected value", "failure"];
		const entryPoints: readonly MatrixEntryPoint[] = ["streamSimple", "withAuth", "preflightThenSeed"];
		const failures: string[] = [];
		let combinations = 0;

		for (const credentialType of credentialTypes) {
			for (const consecutive401s of sequences) {
				for (const outcome of outcomes) {
					for (const retryPath of retryPaths) {
						for (const remint of remints) {
							for (const entryPoint of entryPoints) {
								combinations += 1;
								const label = [
									`credentials=${credentialType}`,
									`401s=${consecutive401s}`,
									`outcome=${outcome}`,
									`path=${retryPath}`,
									`remint=${remint}`,
									`entry=${entryPoint}`,
								].join("; ");
								const authority = new MatrixCommandAuthority(
									credentialType,
									consecutive401s,
									outcome,
									retryPath,
									remint,
								);
								try {
									await runMatrixOperation(entryPoint, authority, consecutive401s);
									await runMatrixOperation(entryPoint, authority, 0);
									authority.assertInvariants();
								} catch (error) {
									failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
								}
							}
						}
					}
				}
			}
		}

		expect(combinations).toBe(486);
		if (failures.length > 0)
			throw new Error(`Failed ${failures.length} of ${combinations} matrix combinations:\n${failures.join("\n")}`);
	}, 60_000);
});
