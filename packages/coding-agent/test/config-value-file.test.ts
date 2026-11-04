import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ApiKeyResolver, AUTH_RETRY_MAX_ATTEMPTS, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { fileConfigValue, normalizeFileConfigPath } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/** Models config for one custom provider whose apiKey (and one header) come from files. */
function modelsYaml(keyFile: string, headerFile?: string): string {
	return [
		"providers:",
		"  file-proxy:",
		"    baseUrl: https://file-proxy.example.com/v1",
		"    api: openai-completions",
		"    authHeader: true",
		`    apiKey: { file: ${JSON.stringify(keyFile)} }`,
		...(headerFile ? ["    headers:", `      X-Tenant: { file: ${JSON.stringify(headerFile)} }`] : []),
		"    models:",
		"      - id: file-model",
		"        name: File Model",
		"",
	].join("\n");
}

function reject401(registry: ModelRegistry, model: Model<Api>, lastChance = false) {
	return registry.resolver(model)({
		lastChance,
		error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
		previousKey: "rejected-key",
	});
}

/** Settle a resolver call to its value or its error, whichever it produces. */
function settle(run: () => unknown): Promise<unknown> {
	return Promise.resolve()
		.then(run)
		.then(
			value => value,
			(error: unknown) => error,
		);
}

describe("{ file } config values", () => {
	let tempDir = "";
	let modelsPath = "";
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-config-value-file-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function loadModel(registry: ModelRegistry): Model<Api> {
		const model = registry.find("file-proxy", "file-model");
		if (!model) throw new Error(`file-proxy/file-model did not load: ${registry.getError() ?? "no error"}`);
		return model;
	}

	test("an apiKey and a header read from files in-process, without spawning a process", async () => {
		const keyFile = path.join(tempDir, "key");
		const headerFile = path.join(tempDir, "tenant");
		fs.writeFileSync(keyFile, "file-key\n");
		fs.writeFileSync(headerFile, "tenant-a\n");
		fs.writeFileSync(modelsPath, modelsYaml(keyFile, headerFile));
		const spawn = spyOn(Bun, "spawn");
		const spawnSync = spyOn(Bun, "spawnSync");
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = loadModel(registry);
			expect(await registry.getApiKey(model)).toBe("file-key");
			const headers = await registry.resolveModelHeaders(model);
			expect(headers?.Authorization).toBe("Bearer file-key");
			expect(headers?.["X-Tenant"]).toBe("tenant-a");
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});

	test("an unchanged file is served from cache; a changed mtime is picked up", async () => {
		const keyFile = path.join(tempDir, "key");
		fs.writeFileSync(keyFile, "key-one");
		fs.writeFileSync(modelsPath, modelsYaml(keyFile));
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		const readFile = spyOn(fsp, "readFile");
		try {
			expect(await registry.getApiKey(model)).toBe("key-one");
			expect(await registry.getApiKey(model)).toBe("key-one");
			expect(readFile.mock.calls.filter(([file]) => file === keyFile)).toHaveLength(1);

			// Same size, new content, and an mtime moved forward: the next resolution re-reads.
			fs.writeFileSync(keyFile, "key-two");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(keyFile, future, future);
			expect(await registry.getApiKey(model)).toBe("key-two");
			expect(readFile.mock.calls.filter(([file]) => file === keyFile)).toHaveLength(2);
		} finally {
			readFile.mockRestore();
		}
	});

	test("a 401 re-reads the file even when it did not change", async () => {
		const keyFile = path.join(tempDir, "key");
		const headerFile = path.join(tempDir, "tenant");
		fs.writeFileSync(keyFile, "stable-key");
		fs.writeFileSync(headerFile, "stable-tenant");
		fs.writeFileSync(modelsPath, modelsYaml(keyFile, headerFile));
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		expect(await registry.getApiKey(model)).toBe("stable-key");
		expect((await registry.resolveModelHeaders(model))?.["X-Tenant"]).toBe("stable-tenant");
		const readFile = spyOn(fsp, "readFile");
		try {
			expect(await reject401(registry, model)).toMatchObject({ apiKey: "stable-key" });
			expect((await registry.resolveModelHeaders(model))?.["X-Tenant"]).toBe("stable-tenant");
			const reads = readFile.mock.calls.map(([file]) => file);
			expect(reads.filter(file => file === keyFile).length).toBeGreaterThanOrEqual(1);
			expect(reads.filter(file => file === headerFile)).toHaveLength(1);
		} finally {
			readFile.mockRestore();
		}
	});

	/**
	 * One real turn request through `streamSimple` against a stub endpoint whose first
	 * response is a 401, after `onFirstRequest` ran; later requests stream "ok".
	 */
	async function turnAfter401(
		model: Model<Api>,
		apiKey: ApiKeyResolver,
		onFirstRequest: () => Promise<void> | void,
	): Promise<{ outcome: unknown; requests: number }> {
		let requests = 0;
		const fetch: FetchImpl = async () => {
			requests++;
			if (requests === 1) {
				await onFirstRequest();
				return new Response(
					JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }),
					{
						status: 401,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			return new Response(
				`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		};
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const stream = streamSimple(model, context, { apiKey, fetch, maxTokens: 16 });
		const outcome = await settle(async () => {
			for await (const _event of stream) {
				// drain
			}
			return await stream.result();
		});
		return { outcome, requests };
	}

	for (const form of ["model", "provider"] as const) {
		test(`a header file that vanished during a 401 ends the turn with the file error (${form}-form resolver)`, async () => {
			const keyFile = path.join(tempDir, "key");
			const headerFile = path.join(tempDir, "tenant");
			fs.writeFileSync(keyFile, "stable-key");
			fs.writeFileSync(headerFile, "stable-tenant");
			fs.writeFileSync(modelsPath, modelsYaml(keyFile, headerFile));
			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = loadModel(registry);
			// The bearer does not change, so the auth retry sends nothing more; the request's
			// own header file must still be checked before the 401 becomes the turn's error.
			const resolver = form === "model" ? registry.resolver(model) : registry.resolver(model.provider);
			const { outcome, requests } = await turnAfter401(model, resolver, () => fs.rmSync(headerFile));
			expect(outcome).toBeInstanceOf(AIError.ConfigurationError);
			expect((outcome as Error).message).toContain(`${headerFile} could not be read (ENOENT)`);
			expect(requests).toBe(1);
		});
	}

	test("a key file that vanished on a usage-limit answer with no sibling credential ends the turn with the file error", async () => {
		const keyFile = path.join(tempDir, "key");
		fs.writeFileSync(keyFile, "only-key");
		// No `authHeader`: only the key path can see the key file. No sibling credential,
		// so quota rotation finds nothing and reads no key.
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  file-proxy:",
				"    baseUrl: https://file-proxy.example.com/v1",
				"    api: openai-completions",
				`    apiKey: { file: ${JSON.stringify(keyFile)} }`,
				"    models:",
				"      - id: file-model",
				"        name: File Model",
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		let requests = 0;
		const fetch: FetchImpl = async () => {
			requests++;
			fs.rmSync(keyFile, { force: true });
			return new Response(
				JSON.stringify({
					error: { message: "You have hit your usage limit. Try again in ~158 min.", type: "rate_limit_error" },
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			);
		};
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const stream = streamSimple(model, context, { apiKey: registry.resolver(model), fetch, maxTokens: 16 });
		const outcome = await settle(async () => {
			for await (const _event of stream) {
				// drain
			}
			return await stream.result();
		});
		expect(requests).toBe(1);
		expect(outcome).toBeInstanceOf(AIError.ConfigurationError);
		expect((outcome as Error).message).toContain(`${keyFile} could not be read (ENOENT)`);
	});

	test("a key file that vanished when the auth retry reaches its attempt limit ends the turn with the file error", async () => {
		const keyFile = path.join(tempDir, "key");
		fs.writeFileSync(keyFile, "key-0");
		// No `authHeader`: only the key path can see the key file.
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  file-proxy:",
				"    baseUrl: https://file-proxy.example.com/v1",
				"    api: openai-completions",
				`    apiKey: { file: ${JSON.stringify(keyFile)} }`,
				"    models:",
				"      - id: file-model",
				"        name: File Model",
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		let requests = 0;
		// Every answer is a 401; the key rotates after each one, so every retry has a new
		// bearer, until the last allowed attempt, whose answer also removes the key file.
		const fetch: FetchImpl = async () => {
			requests++;
			if (requests >= AUTH_RETRY_MAX_ATTEMPTS) fs.rmSync(keyFile, { force: true });
			else fs.writeFileSync(keyFile, `key-${requests}`);
			return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		};
		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const stream = streamSimple(model, context, { apiKey: registry.resolver(model), fetch, maxTokens: 16 });
		const outcome = await settle(async () => {
			for await (const _event of stream) {
				// drain
			}
			return await stream.result();
		});
		expect(requests).toBe(AUTH_RETRY_MAX_ATTEMPTS);
		expect(outcome).toBeInstanceOf(AIError.ConfigurationError);
		expect((outcome as Error).message).toContain(`${keyFile} could not be read (ENOENT)`);
	});

	test("the check reads the failed request's own headers even when models.yml reloads mid-request", async () => {
		const keyFile = path.join(tempDir, "key");
		const headerFile = path.join(tempDir, "tenant");
		fs.writeFileSync(keyFile, "stable-key");
		fs.writeFileSync(headerFile, "stable-tenant");
		fs.writeFileSync(modelsPath, modelsYaml(keyFile, headerFile));
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		const { outcome } = await turnAfter401(model, registry.resolver(model), async () => {
			// The roster entry is replaced (renamed, new header file) while the request is in flight.
			const replacement = path.join(tempDir, "tenant-new");
			fs.writeFileSync(replacement, "new-tenant");
			fs.writeFileSync(modelsPath, modelsYaml(keyFile, replacement).replace("id: file-model", "id: renamed-model"));
			await registry.refresh("offline");
			fs.rmSync(headerFile);
		});
		expect(outcome).toBeInstanceOf(AIError.ConfigurationError);
		expect((outcome as Error).message).toContain(`${headerFile} could not be read (ENOENT)`);
	});

	test("a runtime-registered provider's header file that vanished during a 401 ends the turn with the file error", async () => {
		const headerFile = path.join(tempDir, "runtime-tenant");
		fs.writeFileSync(headerFile, "runtime-tenant");
		fs.writeFileSync(modelsPath, "providers: {}\n");
		const registry = new ModelRegistry(authStorage, modelsPath);
		registry.registerProvider("runtime-proxy", {
			baseUrl: "https://runtime-proxy.example.com/v1",
			api: "openai-completions",
			apiKey: "constant-bearer",
			headers: { "X-Tenant": fileConfigValue(headerFile) },
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
				},
			],
		});
		const model = registry.find("runtime-proxy", "runtime-model");
		if (!model) throw new Error("runtime-proxy/runtime-model did not register");
		const { outcome } = await turnAfter401(model, registry.resolver(model), () => fs.rmSync(headerFile));
		expect(outcome).toBeInstanceOf(AIError.ConfigurationError);
		expect((outcome as Error).message).toContain(`${headerFile} could not be read (ENOENT)`);
	});

	test("a 401 retry reads only the requesting model's header files, not another model's", async () => {
		const keyFile = path.join(tempDir, "key");
		fs.writeFileSync(keyFile, "key-v1");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  file-proxy:",
				"    baseUrl: https://file-proxy.example.com/v1",
				"    api: openai-completions",
				`    apiKey: { file: ${JSON.stringify(keyFile)} }`,
				"    models:",
				"      - id: file-model",
				"        name: File Model",
				"      - id: other-model",
				"        name: Other Model",
				`        headers: { X-Other: { file: ${JSON.stringify(path.join(tempDir, "absent-other"))} } }`,
				"    modelOverrides:",
				`      other-model: { headers: { X-Override: { file: ${JSON.stringify(path.join(tempDir, "absent-override"))} } } }`,
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		expect(await registry.getApiKey(model)).toBe("key-v1");
		fs.writeFileSync(keyFile, "key-v2");
		for (const lastChance of [false, true]) {
			expect(await settle(() => reject401(registry, model, lastChance))).toMatchObject({ apiKey: "key-v2" });
		}
	});

	test("a 401 retry does not read a key file that a runtime key shadows", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  file-proxy:",
				"    baseUrl: https://file-proxy.example.com/v1",
				"    api: openai-completions",
				`    apiKey: { file: ${JSON.stringify(path.join(tempDir, "absent-key"))} }`,
				"    models:",
				"      - id: file-model",
				"        name: File Model",
				"",
			].join("\n"),
		);
		authStorage.keys.setRuntime("file-proxy", "cli-override-key");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);
		expect(await registry.getApiKey(model)).toBe("cli-override-key");
		for (const lastChance of [false, true]) {
			expect(await settle(() => reject401(registry, model, lastChance))).toMatchObject({
				apiKey: "cli-override-key",
			});
		}
	});

	test("a missing or empty file is a non-retryable configuration error naming the path", async () => {
		const keyFile = path.join(tempDir, "absent-key");
		fs.writeFileSync(modelsPath, modelsYaml(keyFile));
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = loadModel(registry);

		const missing = await registry.getApiKey(model).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(missing).toBeInstanceOf(AIError.ConfigurationError);
		expect((missing as Error).message).toContain(keyFile);
		expect((missing as Error).message).toContain("ENOENT");
		expect(AIError.isProviderRetryableError(missing)).toBe(false);
		expect(AIError.is(AIError.classify(missing), AIError.Flag.Transient)).toBe(false);

		fs.writeFileSync(keyFile, "  \n");
		const empty = await registry.getApiKey(model).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(empty).toBeInstanceOf(AIError.ConfigurationError);
		expect((empty as Error).message).toContain(`${keyFile} is empty`);
	});

	test("discovery marks a provider with a missing key file unauthenticated instead of failing", async () => {
		const keyFile = path.join(tempDir, "absent-key");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  disc-proxy:",
				"    baseUrl: http://127.0.0.1:9/v1",
				"    api: openai-completions",
				`    apiKey: { file: ${JSON.stringify(keyFile)} }`,
				"    discovery: { type: openai-models-list }",
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refresh("online");
		expect(registry.getProviderDiscoveryState("disc-proxy")?.status).toBe("unauthenticated");
	});

	test("models.yml rejects a relative path, a bare ~ or an unknown key in a { file } value", () => {
		const schema = getModelsConfigSchema();
		for (const file of ["keys/gateway", "~"]) {
			expect(String(schema({ providers: { p: { apiKey: { file } } } }))).toContain(
				"providers.p.apiKey must be a { file } value whose path is absolute or starts with ~/",
			);
		}
		expect(String(schema({ providers: { p: { apiKey: { file: "/k", mode: "x" } } } }))).toContain(
			"providers.p.apiKey.mode must be removed",
		);
		const parsed = schema({ providers: { p: { apiKey: { file: "~/gateway-key" } } } });
		expect(parsed).toMatchObject({
			providers: { p: { apiKey: `\u0000file:${path.join(os.homedir(), "gateway-key")}` } },
		});
	});

	test("a Windows { file } path must be fully qualified, not drive-relative", () => {
		expect(normalizeFileConfigPath("\\secret", "win32")).toBeUndefined();
		expect(normalizeFileConfigPath("C:secret", "win32")).toBeUndefined();
		expect(normalizeFileConfigPath("C:\\keys\\gateway", "win32")).toBe("C:\\keys\\gateway");
		expect(normalizeFileConfigPath("\\\\server\\share\\gateway", "win32")).toBe("\\\\server\\share\\gateway");
	});
});
