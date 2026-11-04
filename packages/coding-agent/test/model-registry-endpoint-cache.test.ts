import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, complete, type Model } from "@oh-my-pi/pi-ai";
import { getModelCacheWriteStats } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const GATEWAY = "http://gateway.invalid:4000";
const FAKE_KEY = "sk-ant-api03-not-a-real-key";
const GATEWAY_CONFIG = `providers:\n  anthropic:\n    baseUrl: ${GATEWAY}\n`;
const DIRECT_CONFIG = "providers:\n  anthropic:\n    compat:\n      replayUnsignedThinking: false\n";

/** Send one real request through the provider's transport and return the URL it reached. */
async function requestUrl(model: Model<Api>): Promise<string> {
	const urls: string[] = [];
	const stub = async (input: string | URL | Request) => {
		urls.push(input instanceof Request ? input.url : String(input));
		return Response.json(
			{ type: "error", error: { type: "authentication_error", message: "stub" } },
			{ status: 401 },
		);
	};
	await complete(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: FAKE_KEY, fetch: Object.assign(stub, { preconnect: fetch.preconnect }) },
	);
	expect(urls.length).toBeGreaterThan(0);
	return urls[0];
}

describe("model cache follows the configured endpoint", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-endpoint-cache-"));
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.credentials.set("anthropic", { type: "api_key", key: FAKE_KEY });
		// A previous process discovered the Anthropic roster through a gateway
		// configured as the built-in provider's baseUrl. The gateway lists a bundled
		// id and one only it serves.
		fs.writeFileSync(modelsPath, GATEWAY_CONFIG);
		const gatewayRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				const url = String(input);
				if (url === `${GATEWAY}/v1/models`) {
					return Response.json({
						data: [
							{ id: "claude-opus-5-5", type: "model" },
							{ id: "gateway-only-model", type: "model" },
						],
					});
				}
				throw new Error(`offline: ${url}`);
			},
		});
		await gatewayRegistry.refreshProvider("anthropic", "online");
		expect(gatewayRegistry.find("anthropic", "claude-opus-5-5")?.baseUrl).toBe(GATEWAY);
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test("removing the provider baseUrl sends the gateway-discovered model to the built-in endpoint", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const discovered = registry.find("anthropic", "claude-opus-5-5");
		const bundledOnly = registry.find("anthropic", "claude-opus-5");
		if (!discovered || !bundledOnly) throw new Error("expected both Anthropic models");
		// The gateway's roster is not the built-in endpoint's.
		expect(registry.find("anthropic", "gateway-only-model")).toBeUndefined();

		const url = await requestUrl(discovered);
		expect(new URL(url).host).not.toBe(new URL(GATEWAY).host);
		// Same endpoint as a model the gateway never listed: the built-in default.
		expect(new URL(url).origin).toBe(new URL(await requestUrl(bundledOnly)).origin);
	});

	test("a configured gateway still gets its cached roster after a restart", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const model = registry.find("anthropic", "gateway-only-model");
		if (!model) throw new Error("expected the gateway's cached model");
		expect(new URL(await requestUrl(model)).origin).toBe(GATEWAY);
	});

	test("a models.yml discovery provider moved to another endpoint does not list the old endpoint's roster", async () => {
		const config = (baseUrl: string) =>
			`providers:\n  probe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(modelsPath, config("http://endpoint-a.invalid/v1"));
		const before = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				if (String(input) === "http://endpoint-a.invalid/v1/models") {
					return Response.json({ data: [{ id: "endpoint-a-only-model" }] });
				}
				throw new Error(`offline: ${String(input)}`);
			},
		});
		await before.refreshProvider("probe", "online");
		expect(before.find("probe", "endpoint-a-only-model")).toBeDefined();

		fs.writeFileSync(modelsPath, config("http://endpoint-b.invalid/v1"));
		const after = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		await after.refresh("offline");
		expect(after.find("probe", "endpoint-a-only-model")).toBeUndefined();
	});

	test("a discovery still running when the baseUrl is removed does not restore the gateway roster", async () => {
		const gateway = deferredDiscovery(`${GATEWAY}/v1/models`, "late-gateway-model");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gateway.fetch });
		const inFlight = registry.refreshProvider("anthropic", "online");
		await gateway.started;
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		await registry.refreshProvider("anthropic", "offline");
		gateway.release();
		await inFlight;
		expect(registry.find("anthropic", "late-gateway-model")).toBeUndefined();
		expect(registry.find("anthropic", "gateway-only-model")).toBeUndefined();
		const model = registry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("expected the bundled model");
		expect(new URL(await requestUrl(model)).host).not.toBe(new URL(GATEWAY).host);
	});

	test("an extension's discovered roster for a built-in provider id is gone once the extension is", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const extensionHost = "http://extension.invalid:4000";
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		registry.registerProvider(
			"anthropic",
			{
				baseUrl: extensionHost,
				api: "anthropic-messages",
				fetchDynamicModels: async () => [extensionModel("extension-only-model")],
			},
			"test-extension",
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find("anthropic", "extension-only-model")).toBeDefined();
		registry.unregisterProvider("anthropic");

		const restarted = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(restarted.find("anthropic", "extension-only-model")).toBeUndefined();
	});

	test("a discovery that finishes after an equivalent spelling of its endpoint was configured is kept", async () => {
		const gateway = deferredDiscovery(`${GATEWAY}/v1/models`, "late-gateway-model");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gateway.fetch });
		const inFlight = registry.refreshProvider("anthropic", "online");
		await gateway.started;
		fs.writeFileSync(modelsPath, `providers:\n  anthropic:\n    baseUrl: ${GATEWAY}/\n`);
		await registry.refreshProvider("anthropic", "offline");
		gateway.release();
		await inFlight;
		expect(registry.find("anthropic", "late-gateway-model")).toBeDefined();
	});

	test("a discovery finished under another endpoint is published if its own is configured again by publication", async () => {
		// Kimi Code's cache is credential-scoped, so no reload restores it on the
		// side: only the discovery's own publication can list its model.
		const kimiEndpoint = "http://kimi-a.invalid/v1";
		fs.writeFileSync(modelsPath, `providers:\n  kimi-code:\n    baseUrl: ${kimiEndpoint}\n`);
		await authStorage.credentials.set("kimi-code", { type: "api_key", key: "not-a-real-kimi-key" });
		const kimi = deferredDiscovery(`${kimiEndpoint}/models`, "late-kimi-model");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: kimi.fetch });
		// A second, slower discovery keeps the pass open after Kimi's finishes.
		const slowStarted = Promise.withResolvers<void>();
		const slowRelease = Promise.withResolvers<void>();
		registry.registerProvider(
			"slow-extension",
			{
				baseUrl: "http://slow-extension.invalid:4000",
				api: "anthropic-messages",
				fetchDynamicModels: async () => {
					slowStarted.resolve();
					await slowRelease.promise;
					return [extensionModel("slow-model")];
				},
			},
			"slow-extension-source",
		);
		try {
			const inFlight = registry.refreshDiscoverableProviders(["kimi-code", "slow-extension"], "online");
			await Promise.all([kimi.started, slowStarted.promise]);
			registry.registerProvider("kimi-code", { baseUrl: "http://kimi-b.invalid/v1" }, "override-source");
			const writesBefore = getModelCacheWriteStats().payloadWrites;
			kimi.release();
			// Kimi's manager has finished once it wrote its roster. No event marks
			// that point, so the observable condition is polled.
			while (getModelCacheWriteStats().payloadWrites === writesBefore) await Bun.sleep(10);
			registry.unregisterProvider("kimi-code");
			slowRelease.resolve();
			await inFlight;
		} finally {
			kimi.release();
			slowRelease.resolve();
		}
		expect(registry.find("kimi-code", "late-kimi-model")?.baseUrl).toBe(kimiEndpoint);
	});

	test("a built-in discovery finishing after an extension took over the provider id does not replace it", async () => {
		const gateway = deferredDiscovery(`${GATEWAY}/v1/models`, "late-gateway-model");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gateway.fetch });
		const inFlight = registry.refreshProvider("anthropic", "online");
		await gateway.started;
		registry.registerProvider(
			"anthropic",
			{
				baseUrl: GATEWAY,
				api: "anthropic-messages",
				fetchDynamicModels: async () => [extensionModel("extension-model")],
			},
			"test-extension",
		);
		await registry.refreshRuntimeProviders("online");
		gateway.release();
		await inFlight;
		expect(registry.find("anthropic", "extension-model")).toBeDefined();
		expect(registry.find("anthropic", "late-gateway-model")).toBeUndefined();
	});

	test("a replaced extension registration cannot write the roster the live one reads", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		registry.registerProvider(
			"anthropic",
			{
				api: "anthropic-messages",
				fetchDynamicModels: async () => {
					started.resolve();
					await release.promise;
					return [{ ...extensionModel("old-model"), baseUrl: "http://old-extension.invalid:4000" }];
				},
			},
			"test-extension",
		);
		try {
			const inFlight = registry.refreshRuntimeProviders("online");
			await started.promise;
			registry.registerProvider(
				"anthropic",
				{
					api: "anthropic-messages",
					fetchDynamicModels: async () => [
						{ ...extensionModel("current-model"), baseUrl: "http://current-extension.invalid:4000" },
					],
				},
				"test-extension",
			);
			await registry.refreshRuntimeProviders("online");
			release.resolve();
			await inFlight;
		} finally {
			release.resolve();
		}
		await registry.refreshRuntimeProviders("offline");
		expect(registry.find("anthropic", "old-model")).toBeUndefined();
		expect(registry.find("anthropic", "current-model")?.baseUrl).toBe("http://current-extension.invalid:4000");
	});

	test.each([
		["another endpoint and key", "http://gateway-b.invalid:4000"],
		["a new key at the same endpoint", GATEWAY],
	])("a key resolved before models.yml moved to %s is never sent", async (_case, nextEndpoint) => {
		const keyStarted = Promise.withResolvers<void>();
		const keyRelease = Promise.withResolvers<void>();
		const oauthStorage = await AuthStorage.create(path.join(tempDir, "oauth-agent.db"), {
			refreshOAuthCredential: async (_provider, _id, credential) => {
				keyStarted.resolve();
				await keyRelease.promise;
				return { ...credential, access: "sk-ant-oat01-previous-config", expires: Date.now() + 3_600_000 };
			},
		});
		try {
			await oauthStorage.credentials.set("anthropic", {
				type: "oauth",
				access: "sk-ant-oat01-expired",
				refresh: "not-a-real-refresh-token",
				expires: Date.now() - 60_000,
			});
			const sent: Array<{ url: string; key: string | null }> = [];
			const registry = new ModelRegistry(oauthStorage, modelsPath, {
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers);
					sent.push({ url: String(input), key: headers.get("x-api-key") ?? headers.get("authorization") });
					throw new Error("offline");
				},
			});
			const inFlight = registry.refreshProvider("anthropic", "online");
			await keyStarted.promise;
			fs.writeFileSync(
				modelsPath,
				`providers:\n  anthropic:\n    baseUrl: ${nextEndpoint}\n    apiKey: ${FAKE_KEY}\n`,
			);
			await registry.refreshProvider("anthropic", "offline");
			keyRelease.resolve();
			await inFlight;
			expect(sent.filter(request => request.key?.includes("previous-config"))).toEqual([]);
		} finally {
			keyRelease.resolve();
			oauthStorage.close();
		}
	});

	test("a models.yml discovery provider never sends the new configuration's key to the endpoint it replaced", async () => {
		const gate = path.join(tempDir, "header-gate");
		const headerStarted = path.join(tempDir, "header-started");
		// A command-backed header holds the discovery between its start and its request.
		const header = `!sh -c 'touch ${headerStarted}; while [ ! -f ${gate} ]; do sleep 0.02; done; echo held'`;
		const config = (baseUrl: string, apiKey: string, headers: string) =>
			`providers:\n  probe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    apiKey: ${apiKey}\n${headers}    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(
			modelsPath,
			config("http://previous-config.invalid/v1", "fake-previous-key", `    headers:\n      x-held: "${header}"\n`),
		);
		const sent: Array<{ url: string; authorization: string | null }> = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) => {
				sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
				if (String(input).startsWith("http://current-config.invalid")) {
					return Response.json({ data: [{ id: "current-model" }] });
				}
				return Response.json({ data: [{ id: "previous-model" }] });
			},
		});
		const inFlight = registry.refreshProvider("probe", "online");
		while (!fs.existsSync(headerStarted)) await Bun.sleep(10);
		fs.writeFileSync(modelsPath, config("http://current-config.invalid/v1", "fake-current-key", ""));
		await registry.refreshProvider("probe", "online");
		fs.writeFileSync(gate, "");
		await inFlight;
		expect(sent.filter(request => request.url.startsWith("http://previous-config.invalid"))).toEqual([]);
		expect(registry.find("probe", "previous-model")).toBeUndefined();
		expect(registry.getProviderDiscoveryState("probe")?.models).toEqual(["current-model"]);
	});

	test("a runtime override moves a models.yml discovery provider's discovery endpoint and headers together", async () => {
		fs.writeFileSync(
			modelsPath,
			`providers:\n  probe:\n    baseUrl: http://models-yml.invalid/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    headers:\n      x-api-key: fake-models-yml-header\n    discovery:\n      type: openai-models-list\n`,
		);
		const sent: Array<{ url: string; header: string | null }> = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) => {
				sent.push({ url: String(input), header: new Headers(init?.headers).get("x-api-key") });
				return Response.json({ data: [{ id: "runtime-model" }] });
			},
		});
		registry.registerProvider(
			"probe",
			{ baseUrl: "http://runtime-override.invalid/v1", headers: { "x-api-key": "fake-runtime-header" } },
			"override-source",
		);
		await registry.refreshProvider("probe", "online");
		expect(sent).toEqual([{ url: "http://runtime-override.invalid/v1/models", header: "fake-runtime-header" }]);
	});

	test("a discovery whose configuration changed and changed back before its request sends nothing", async () => {
		const gate = path.join(tempDir, "header-gate");
		const headerStarted = path.join(tempDir, "header-started");
		const header = `!sh -c 'touch ${headerStarted}; while [ ! -f ${gate} ]; do sleep 0.02; done; echo held'`;
		fs.writeFileSync(
			modelsPath,
			`providers:\n  probe:\n    baseUrl: http://initial-a.invalid/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    headers:\n      x-held: "${header}"\n    discovery:\n      type: openai-models-list\n`,
		);
		const sent: string[] = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				sent.push(String(input));
				return Response.json({ data: [{ id: "probe-model" }] });
			},
		});
		const inFlight = registry.refreshProvider("probe", "online");
		while (!fs.existsSync(headerStarted)) await Bun.sleep(10);
		// A -> B -> A while the request is still being assembled.
		registry.registerProvider("probe", { baseUrl: "http://transient-b.invalid/v1" }, "override-source");
		registry.unregisterProvider("probe");
		fs.writeFileSync(gate, "");
		await inFlight;
		expect(sent).toEqual([]);
	});

	test("a discovery survives a reload that only reorders its headers", async () => {
		const config = (headers: string) =>
			`providers:\n  probe:\n    baseUrl: http://probe.invalid/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    headers:\n${headers}    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(modelsPath, config("      x-first: one\n      x-second: two\n"));
		const probe = deferredDiscovery("http://probe.invalid/v1/models", "probe-model");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: probe.fetch });
		const inFlight = registry.refreshProvider("probe", "online");
		await probe.started;
		fs.writeFileSync(modelsPath, config("      x-second: two\n      x-first: one\n"));
		await registry.refreshProvider("probe", "offline");
		probe.release();
		await inFlight;
		expect(registry.find("probe", "probe-model")).toBeDefined();
	});

	test("the refresh after a runtime override discovers the new endpoint instead of joining the old discovery", async () => {
		fs.writeFileSync(
			modelsPath,
			`providers:\n  probe:\n    baseUrl: http://endpoint-a.invalid/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    discovery:\n      type: openai-models-list\n`,
		);
		const endpointA = deferredDiscovery("http://endpoint-a.invalid/v1/models", "a-model");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) =>
				String(input) === "http://endpoint-b.invalid/v1/models"
					? Response.json({ data: [{ id: "b-model" }] })
					: endpointA.fetch(input),
		});
		const first = registry.refreshProvider("probe", "online");
		await endpointA.started;
		registry.registerProvider("probe", { baseUrl: "http://endpoint-b.invalid/v1" }, "override-source");
		const next = registry.refreshProvider("probe", "online");
		endpointA.release();
		await Promise.all([first, next]);
		expect(registry.find("probe", "b-model")).toBeDefined();
		expect(registry.find("probe", "a-model")).toBeUndefined();
	});

	test("an extension re-registered with another key never serves the roster discovered with the old one", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const register = (apiKey: string, model: string, host: string) =>
			registry.registerProvider(
				"anthropic",
				{
					api: "anthropic-messages",
					apiKey,
					fetchDynamicModels: async () => [{ ...extensionModel(model), baseUrl: host }],
				},
				"same-extension",
			);
		register("fake-old-extension-key", "old-model", "http://old-extension.invalid:4000");
		await registry.refreshRuntimeProviders("online");
		register("fake-current-extension-key", "current-model", "http://current-extension.invalid:4000");
		await registry.refreshRuntimeProviders("online-if-uncached");
		expect(registry.find("anthropic", "old-model")).toBeUndefined();
		expect(registry.find("anthropic", "current-model")?.baseUrl).toBe("http://current-extension.invalid:4000");
	});

	test("a discovery survives a reload that only reorders its discovery options", async () => {
		const held = heldCommand(tempDir, "held");
		// `type` before `timeoutMs` is not the canonical (sorted) order; the reload swaps it.
		const config = (discovery: string) =>
			`providers:\n  probe:\n    baseUrl: http://probe.invalid/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    headers:\n      x-held: "${held.command}"\n    discovery:\n${discovery}`;
		fs.writeFileSync(modelsPath, config("      type: openai-models-list\n      timeoutMs: 60000\n"));
		const sent: string[] = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				sent.push(String(input));
				return Response.json({ data: [{ id: "probe-model" }] });
			},
		});
		const inFlight = registry.refreshProvider("probe", "online");
		await held.started();
		writeWithNewMtime(modelsPath, config("      timeoutMs: 60000\n      type: openai-models-list\n"));
		await registry.refreshProvider("unrelated", "offline");
		held.release();
		await inFlight;
		expect(sent).toEqual(["http://probe.invalid/v1/models"]);
		expect(registry.find("probe", "probe-model")).toBeDefined();
	});

	test("a change of keyless mode while a discovery request is assembled refuses the send", async () => {
		const held = heldCommand(tempDir, "held");
		const config = (auth: string) =>
			`providers:\n  probe:\n    baseUrl: http://probe.invalid/v1\n    api: openai-completions\n    auth: ${auth}\n    apiKey: ${FAKE_KEY}\n    headers:\n      x-held: "${held.command}"\n    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(modelsPath, config("none"));
		const sent: string[] = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				sent.push(String(input));
				return Response.json({ data: [{ id: "probe-model" }] });
			},
		});
		const inFlight = registry.refreshDiscoverableProviders(["probe"], "online");
		await held.started();
		writeWithNewMtime(modelsPath, config("apiKey"));
		await registry.refreshProvider("unrelated", "offline");
		held.release();
		await inFlight;
		expect(sent).toEqual([]);
	});

	test("a change of a runtime key's precedence while its key resolves refuses the send", async () => {
		fs.writeFileSync(modelsPath, DIRECT_CONFIG);
		const held = heldCommand(tempDir, "fake-runtime-config-key");
		const sent: Array<string | null> = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (_input, init) => {
				sent.push(new Headers(init?.headers).get("x-api-key"));
				return Response.json({ data: [{ id: "probe-model", type: "model" }] });
			},
		});
		const config = { baseUrl: "http://runtime.invalid:4000", apiKey: held.command };
		registry.registerProvider("anthropic", config, "test-extension");
		const inFlight = registry.refreshProvider("anthropic", "online");
		await held.started();
		// The same key, now only a fallback behind the stored login.
		registry.registerProvider(
			"anthropic",
			{
				...config,
				oauth: {
					name: "Test OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refreshToken: async credential => credential,
					getApiKey: credential => credential.access,
				},
			},
			"test-extension",
		);
		held.release();
		await inFlight;
		expect(sent.filter(key => key === "fake-runtime-config-key")).toEqual([]);
	});

	test("a runtime key keeps its precedence over the models.yml key across repeated reloads", async () => {
		const config = `providers:\n  probe:\n    baseUrl: http://models-yml.invalid/v1\n    api: openai-completions\n    apiKey: fake-models-yml-key\n    discovery:\n      type: openai-models-list\n`;
		fs.writeFileSync(modelsPath, config);
		const sent: Array<{ url: string; authorization: string | null }> = [];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) => {
				sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
				return Response.json({ data: [{ id: "probe-model" }] });
			},
		});
		registry.registerProvider(
			"probe",
			{ baseUrl: "http://runtime.invalid/v1", apiKey: "fake-runtime-key" },
			"override-source",
		);
		for (let reload = 1; reload <= 3; reload++) {
			writeWithNewMtime(modelsPath, `${config}${"\n".repeat(reload)}`);
			await registry.refreshProvider("unrelated", "offline");
			expect(await registry.getApiKeyForProvider("probe")).toBe("fake-runtime-key");
		}
		await registry.refreshProvider("probe", "online");
		expect(sent).toEqual([{ url: "http://runtime.invalid/v1/models", authorization: "Bearer fake-runtime-key" }]);
	});
});

/**
 * A `!command` config value that prints `output` only once released, so a
 * test can change configuration while a discovery is resolving it.
 */
function heldCommand(dir: string, output: string) {
	const id = Bun.hash(`${dir}${output}${Math.random()}`).toString(36);
	const startedPath = path.join(dir, `${id}.started`);
	const gatePath = path.join(dir, `${id}.gate`);
	return {
		command: `!sh -c 'touch ${startedPath}; while [ ! -f ${gatePath} ]; do sleep 0.02; done; echo ${output}'`,
		started: async () => {
			while (!fs.existsSync(startedPath)) await Bun.sleep(10);
		},
		release: () => fs.writeFileSync(gatePath, ""),
	};
}

/** Rewrite a file with a modification time the registry's reload check cannot miss. */
function writeWithNewMtime(file: string, content: string) {
	const previous = fs.statSync(file).mtimeMs;
	fs.writeFileSync(file, content);
	const next = new Date(Math.max(Date.now(), previous + 2000));
	fs.utimesSync(file, next, next);
}

/** A discovery endpoint whose `/v1/models` answer is held until released. */
function deferredDiscovery(modelsUrl: string, modelId: string) {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => release.resolve(),
		fetch: async (input: string | URL | Request) => {
			if (String(input) === modelsUrl) {
				started.resolve();
				await release.promise;
				return Response.json({ data: [{ id: modelId, type: "model" }] });
			}
			throw new Error(`offline: ${String(input)}`);
		},
	};
}

function extensionModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}
