import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { completeSimple, type OneshotRetryInfo, retryTransientCompletion, streamSimple } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce, resolvedApiKeyBearer, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as awsCredentials from "@oh-my-pi/pi-ai/providers/aws-credentials";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { invalidateAllCommandConfigs, resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

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

/** Command that exits non-zero while carrying a credential-shaped argument. */
function failingCommandWithSecret(secret: string): string {
	if (process.platform !== "win32") return `false --token=${secret}`;
	return `${JSON.stringify(process.execPath)} -e "process.exit(1)" --token=${secret}`;
}

/** Command that prints the *current* trimmed contents of `file` on each run. */
function stdoutFileCommand(file: string): string {
	if (process.platform !== "win32") return `IFS= read -r t < ${shellQuote(file)}; printf %s "$t"`;
	const script = `const fs=require("node:fs");process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, "utf8").trim());`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Command that prints `value` after a one-second delay. */
function slowStdoutCommand(value: string): string {
	if (process.platform !== "win32") return `sleep 1; printf %s ${shellQuote(value)}`;
	const script = `setTimeout(() => process.stdout.write(${JSON.stringify(value)}), 1000)`;
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

		const refreshed = await registry.resolver(model)({
			lastChance: false,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: "stale-key",
		});

		expect(refreshed).toBeUndefined();
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

	test("a failing apiKey command fails a turn's request as retryable without naming the command", async () => {
		const secret = "sk-synthetic-command-secret";
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${failingCommandWithSecret(secret)}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const error = await streamSimple(model, context, { apiKey: registry.turnResolver(model) })
			.result()
			.then(
				() => undefined,
				(failure: unknown) => failure,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
		const message = (error as Error).message;
		expect(message).toContain("custom-proxy");
		expect(message).not.toContain(secret);
		expect(message).not.toContain("--token");
	});

	test("a oneshot completion whose apiKey command failed fails fast instead of waiting out the failure backoff", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: "!false",
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		// Title, commit-message, memory and auto-repair oneshots resolve keys through
		// `registry.resolver()`; a retry here would sleep out the 30 s backoff.
		const retries: OneshotRetryInfo[] = [];
		const stopRetrying = new AbortController();
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const outcome = await retryTransientCompletion(
			() => completeSimple(model, context, { apiKey: registry.resolver(model) }),
			{
				signal: stopRetrying.signal,
				onRetry: info => {
					retries.push(info);
					stopRetrying.abort();
				},
			},
		).then(
			message => message.errorMessage,
			(failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
		);

		expect(retries).toEqual([]);
		expect(outcome).toContain("No API key");
	});

	test("a provider with no apiKey configured still fails with the non-retryable missing-key error", async () => {
		const envKey = spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");

		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const error = await streamSimple(model, context, { apiKey: registry.resolver(model) })
			.result()
			.then(
				() => undefined,
				(failure: unknown) => failure,
			)
			.finally(() => envKey.mockRestore());

		expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(error))).toBe(false);
	});

	/**
	 * Prompt a real AgentSession whose provider key is a helper that fails on its
	 * first run; with `manualRetry`, `/retry` the failed turn once it settles.
	 */
	async function runCommandKeyedTurn(maxRetries: number, helperRecovers: boolean, manualRetry = false) {
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "FAIL");
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
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		const mock = createMockModel({ responses: [{ content: ["answered with the command key"], stopReason: "stop" }] });
		const sentKeys: Array<string | undefined> = [];
		const agent = new Agent({
			getApiKey: requestModel => registry.turnResolver(requestModel, agent.sessionId),
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestModel, streamContext, options) => {
				const seeded =
					typeof options?.apiKey === "function"
						? options.apiKey({ lastChance: false, error: undefined })
						: options?.apiKey;
				if (seeded instanceof Promise) throw new Error("Expected the agent loop to seed its resolved key");
				sentKeys.push(resolvedApiKeyBearer(seeded));
				return mock.stream(requestModel, streamContext, options);
			},
		});
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": maxRetries,
				"retry.baseDelayMs": 500,
				"retry.modelFallback": false,
				"features.unexpectedStopDetection": "none",
			}),
			modelRegistry: registry,
		});
		// Backoff sleeps advance a virtual clock instead of waiting; the wall
		// clock the command failure window reads follows that same clock.
		mockSchedulerWaitWithClock();
		const wallStart = Date.now();
		const monotonicStart = performance.now();
		vi.spyOn(Date, "now").mockImplementation(() => Math.floor(wallStart + performance.now() - monotonicStart));
		let retries = 0;
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retries += 1;
				// A recovering helper succeeds from here on; only its failure window delays the next run.
				if (helperRecovers) fs.writeFileSync(tokenFile, "recovered-key");
			}
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		try {
			await session.prompt("Use the command-keyed provider.");
			await session.waitForIdle();
			const firstRun = { retries, helperRuns: fs.readFileSync(counterFile, "utf8").length };
			if (manualRetry) {
				expect(await session.retry()).toBe(true);
				await session.waitForIdle();
			}
			const helperRuns = fs.readFileSync(counterFile, "utf8").length;
			return {
				lastMessage: agent.state.messages.at(-1),
				sentKeys,
				retries,
				retryEnds,
				helperRuns,
				elapsedMs: Date.now() - wallStart,
				manualRetry: { retries: retries - firstRun.retries, helperRuns: helperRuns - firstRun.helperRuns },
			};
		} finally {
			await session.dispose();
			await sessionManager.close();
			vi.restoreAllMocks();
		}
	}

	test.each([1, 10])(
		"a turn whose apiKey command failed retries once the failure window passes and completes (maxRetries %d)",
		async maxRetries => {
			const run = await runCommandKeyedTurn(maxRetries, true);

			expect(run.lastMessage).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "answered with the command key" }],
			});
			expect(run.sentKeys).toEqual(["recovered-key"]);
			expect(run.retryEnds).toEqual([expect.objectContaining({ success: true })]);
			// The retry waited out the helper's failure window, then re-ran it.
			expect(run.helperRuns).toBe(2);
			expect(run.helperRuns).toBe(run.retries + 1);
			expect(run.elapsedMs).toBeGreaterThanOrEqual(30_000);
		},
	);

	test("a createAgentSession turn whose apiKey command failed retries and completes once the command recovers", async () => {
		const mockSource = "test/model-registry-command-values/create-agent-session";
		registerMockApi(mockSource);
		const tokenFile = path.join(tempDir, "token.txt");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(tokenFile, "FAIL");
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
		const mock = createMockModel({
			provider: "custom-proxy",
			id: "mock-turn-model",
			responses: [{ content: ["answered with the command key"], stopReason: "stop" }],
		});
		// No `getApiKey`: the session's turns resolve keys through createAgentSession's default.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry: registry,
			model: mock,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": 10,
				"retry.baseDelayMs": 500,
				"retry.modelFallback": false,
				"features.unexpectedStopDetection": "none",
				"todo.enabled": false,
				"todo.reminders": false,
			}),
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
		mockSchedulerWaitWithClock();
		const wallStart = Date.now();
		const monotonicStart = performance.now();
		vi.spyOn(Date, "now").mockImplementation(() => Math.floor(wallStart + performance.now() - monotonicStart));
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") fs.writeFileSync(tokenFile, "recovered-key");
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		try {
			await session.prompt("Use the command-keyed provider.");
			await session.waitForIdle();

			const last = session.agent.state.messages.at(-1);
			expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(mock.calls).toHaveLength(1);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true })]);
			expect(fs.readFileSync(counterFile, "utf8").length).toBeGreaterThanOrEqual(2);
		} finally {
			await session.dispose();
			vi.restoreAllMocks();
			unregisterCustomApis(mockSource);
		}
	});

	test("a turn whose apiKey command never produces a key stops after 3 command retries without a request", async () => {
		// retry.maxRetries at its default of 10: the key-command cap ends the turn first.
		const run = await runCommandKeyedTurn(10, false);

		expect(run.sentKeys).toEqual([]);
		expect(run.retries).toBe(3);
		// The prompt's key check plus one run per retry, each after the 30 s failure window.
		expect(run.helperRuns).toBe(4);
		expect(run.elapsedMs).toBeGreaterThanOrEqual(90_000);
		expect(run.retryEnds).toEqual([expect.objectContaining({ success: false })]);
		expect(run.lastMessage).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("The apiKey command for provider custom-proxy produced no key"),
		});
	});

	test("/retry after a turn whose apiKey command used up retry.maxRetries gets a fresh key-command budget", async () => {
		const run = await runCommandKeyedTurn(2, false, true);

		expect(run.sentKeys).toEqual([]);
		// The retried turn gets its own 2 retries, and each runs the helper again.
		expect(run.manualRetry).toEqual({ retries: 2, helperRuns: 2 });
		expect(run.retryEnds).toEqual([
			expect.objectContaining({ success: false }),
			expect.objectContaining({ success: false }),
		]);
	});

	test("a provider that runs without a key still dispatches a turn keyless when its apiKey command fails", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { "bedrock-mantle": { apiKey: `!${failedTrackingCommand(counterFile)}` } } }),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.getAll().find(candidate => candidate.provider === "bedrock-mantle");
		if (!model) throw new Error("Expected a bundled bedrock-mantle model");
		// Keyless bedrock-mantle signs with the AWS credential chain.
		const credentials = spyOn(awsCredentials, "resolveAwsCredentials").mockResolvedValue({
			accessKeyId: "AKIDSYNTHETIC",
			secretAccessKey: "synthetic-secret",
		});
		const requests: string[] = [];
		const captureFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				requests.push(String(input instanceof Request ? input.url : input));
				return new Response("captured", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);

		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		await streamSimple(model, context, { apiKey: registry.turnResolver(model), fetch: captureFetch, maxTokens: 16 })
			.result()
			.catch(() => undefined)
			.finally(() => credentials.mockRestore());

		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
		expect(requests.length).toBeGreaterThan(0);
	});

	test("an abort while withAuth resolves a slow apiKey command reports the abort, not a missing key", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${slowStdoutCommand("slow-key")}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		const controller = new AbortController();
		const reason = new Error("synthetic user abort");
		let attempts = 0;

		const pending = withAuth(
			registry.resolver(model),
			async () => {
				attempts += 1;
				return "sent";
			},
			{ signal: controller.signal },
		);
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(attempts).toBe(0);
	});

	test("a registry restricted to OAuth account pools keeps the apiKey command turn retry and abort handling", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"failing-proxy": {
						baseUrl: "https://failing-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${failingCommandWithSecret("sk-synthetic-command-secret")}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
					"slow-proxy": {
						baseUrl: "https://slow-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${slowStdoutCommand("slow-key")}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new SessionAccountPoolScope(authStorage, { anthropic: [] }, "pooled-session").registry(
			new ModelRegistry(authStorage, modelsPath),
		);
		const failing = registry.find("failing-proxy", "custom-model");
		const slow = registry.find("slow-proxy", "custom-model");
		if (!failing || !slow) throw new Error("Expected custom models");

		const error = await resolveApiKeyOnce(registry.turnResolver(failing, "turn-session")).then(
			() => undefined,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(AIError.CredentialUnavailableError);

		const controller = new AbortController();
		const reason = new Error("synthetic user abort");
		let attempts = 0;
		const pending = withAuth(
			registry.resolver(slow),
			async () => {
				attempts += 1;
				return "sent";
			},
			{ signal: controller.signal },
		);
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(attempts).toBe(0);
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
});
