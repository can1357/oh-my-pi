import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	resolveConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	failedTrackingCommand,
	failOnceCommand,
	okChatCompletionStream,
	refreshGateFetch,
	stdoutCommand,
	stdoutFileCommand,
	trackedTokenCommand,
} from "./helpers/command-config";

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

	/** Run one `AgentSession.prompt()` turn against `fetch`; returns the turn's last message. */
	async function promptOnce(
		registry: ModelRegistry,
		model: Model,
		fetch: FetchImpl,
	): Promise<AgentMessage | undefined> {
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
		session.agent.streamFn = (streamModel, context, options) =>
			streamSimple(streamModel, context, { ...options, fetch });
		try {
			await session.prompt("hi");
			return session.agent.state.messages.at(-1);
		} finally {
			await session.dispose();
		}
	}

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
		// The 401 left nothing servable, so the replacement mint gets two attempts.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("111");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect((await registry.resolveModelHeaders(model))?.Authorization).toBeUndefined();
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

	test.skipIf(process.platform === "win32")(
		"a key command diagnostic names the provider, field and failure, never any command text or stdout",
		async () => {
			// Shell forms that hand a bootstrap credential to a credential helper.
			const secretDir = path.join(tempDir, "SYNTH-PATH-SECRET dir");
			fs.mkdirSync(secretDir);
			const helper = path.join(secretDir, "helper");
			fs.writeFileSync(helper, "#!/bin/sh\nprintf %s synthetic-command-stdout\nexit 1\n");
			fs.chmodSync(helper, 0o755);
			const commands = [
				`AUTH="Bearer SYNTH-DQ-SECRET" printf %s synthetic-command-stdout; exit 1`,
				`AUTH='Bearer SYNTH-SQ-SECRET' printf %s synthetic-command-stdout; exit 1`,
				`sh -c 'printf %s synthetic-command-stdout; exit 1' --token=SYNTH-ARG-SECRET`,
				`'${helper}'`,
			];
			const warn = spyOn(piUtils.logger, "warn");
			let requests = 0;
			const fetch: FetchImpl = async () => {
				requests++;
				return okChatCompletionStream();
			};
			const withAuthErrors: unknown[] = [];
			const streamErrors: Array<string | undefined> = [];
			let loggedFields: unknown[] = [];
			let headerValue: string | undefined;
			try {
				for (const command of commands) {
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
					try {
						await withAuth(registry.resolver(model), async () => "unexpected");
					} catch (error) {
						withAuthErrors.push(error);
					}
					const context: Context = {
						systemPrompt: ["s"],
						messages: [{ role: "user", content: "hi", timestamp: 0 }],
					};
					const handle = streamSimple(model, context, { apiKey: registry.resolver(model), fetch, maxTokens: 16 });
					try {
						for await (const _event of handle) {
							// drain
						}
						streamErrors.push((await handle.result()).errorMessage);
					} catch (error) {
						streamErrors.push((error as Error).message);
					}
				}
				// A failing header command is omitted and logged by provider and header name.
				fs.writeFileSync(
					modelsPath,
					JSON.stringify({
						providers: {
							"header-proxy": {
								baseUrl: "https://header-proxy.example.com/v1",
								api: "openai-completions",
								apiKey: "static-api-key",
								headers: {
									"x-tenant-token": `!AUTH="Bearer SYNTH-HEADER-SECRET" printf %s synthetic-command-stdout; exit 1`,
								},
								models: [{ id: "custom-model", name: "Custom Model" }],
							},
						},
					}),
				);
				const headerModel = new ModelRegistry(authStorage, modelsPath).find("header-proxy", "custom-model");
				if (!headerModel) throw new Error("Expected header-proxy model");
				headerValue = (await headerModel.resolveHeaders?.())?.["x-tenant-token"];
			} finally {
				loggedFields = warn.mock.calls
					.filter(call => call[0] === "config: !command value resolution failed")
					.map(call => call[1]);
				warn.mockRestore();
			}

			const diagnostic = "custom-proxy apiKey command exited with status 1";
			expect(withAuthErrors).toHaveLength(commands.length);
			for (const error of withAuthErrors) {
				expect(error).toBeInstanceOf(MissingApiKeyError);
				expect((error as Error).message).toBe(diagnostic);
			}
			expect(streamErrors).toEqual(
				commands.map(() => `Failed to resolve API key for provider custom-proxy: ${diagnostic}`),
			);
			const failureLog = { failure: "exited with status 1", keptPreviousValue: false, freshRunRequired: false };
			expect(loggedFields).toEqual([
				...commands.map(() => ({ label: "custom-proxy apiKey", ...failureLog })),
				{ label: "header-proxy header x-tenant-token", ...failureLog },
			]);
			expect(headerValue).toBeUndefined();
			expect(requests).toBe(0);
		},
	);

	test("prompt() reports a key command that never mints as an assistant error and sends nothing", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!AUTH="Bearer SYNTH-PROMPT-SECRET" ${failedTrackingCommand(counterFile)}`,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		const requests: string[] = [];
		const recordingFetch: FetchImpl = async input => {
			requests.push(String(input));
			return okChatCompletionStream();
		};
		const last = await promptOnce(registry, model, recordingFetch);

		if (last?.role !== "assistant") throw new Error("Expected the turn to end with an assistant message");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toBe("custom-proxy apiKey command exited with status 1");
		expect(requests).toEqual([]);
		// Two bounded first-mint attempts at the request boundary, none before it.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	}, 20_000);

	test("a first mint that fails once succeeds on the request retry", async () => {
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
		const authorizations: Array<string | undefined> = [];
		const recordingFetch: FetchImpl = async (_url, init) => {
			authorizations.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
			return okChatCompletionStream();
		};
		const last = await promptOnce(registry, model, recordingFetch);

		// A helper that fails once under load no longer costs the turn.
		if (last?.role !== "assistant") throw new Error("Expected the turn to end with an assistant message");
		expect(last.stopReason).toBe("stop");
		expect(authorizations).toEqual(["Bearer minted-key-2"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	}, 20_000);

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

		// The refreshes below stay unscoped. Disabling every built-in provider (the
		// bundled and descriptor-backed catalogs plus the implicit llama.cpp and
		// apple discovery) keeps them from running catalog discovery for ~85
		// unrelated providers, which takes seconds; custom-proxy is the only
		// provider they can reach.
		const builtInProviders = new Set<string>([
			...getBundledProviders(),
			...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
			"llama.cpp",
			"apple",
		]);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			settings: Settings.isolated({ disabledProviders: [...builtInProviders] }),
		});
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
		// A first mint with no previous output gets two bounded attempts.
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");

		// Helper is healthy again, but the 30s failure backoff would still block
		// getApiKey until process restart — unless online refresh clears it.
		fs.writeFileSync(tokenFile, "recovered-key");
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");

		await registry.refresh("online", { refreshCommandCredentials: true });
		expect(await registry.getApiKey(model)).toBe("recovered-key");
		expect(fs.readFileSync(counterFile, "utf8")).toBe("111");
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
