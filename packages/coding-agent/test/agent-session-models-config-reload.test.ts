/**
 * A running session folds a models.yml edit into its next model request: the
 * registry re-reads the file when it changed on disk, and the session re-binds
 * its model to the rebuilt entry. Here a gateway provider gains
 * `compat.supportsLongCacheRetention`, so the next request carries the 1-hour
 * cache marker without restarting the session — on the main loop, on a side
 * request, after an edit that keeps the file's mtime, and for a model object
 * handed in from an older catalog.
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { TempDir } from "@oh-my-pi/pi-utils";
import { anthropicChunks, type CapturedRequest, captureFetch } from "../../ai/test/helpers/factory-droid";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface GatewayConfig {
	longRetentionFlag?: boolean;
	maxTokens?: number;
	/** Value of an `x-config-probe` header; a `!command` value resolves through the provider's header resolver. */
	probeHeader?: string;
}

function modelsYaml(config: boolean | GatewayConfig): string {
	const { longRetentionFlag, maxTokens, probeHeader } =
		typeof config === "boolean" ? { longRetentionFlag: config } : config;
	return [
		"providers:",
		"  claude-gateway:",
		"    baseUrl: https://gateway.example.test",
		"    apiKey: TEST_GATEWAY_KEY",
		"    api: anthropic-messages",
		...(longRetentionFlag ? ["    compat:", "      supportsLongCacheRetention: true"] : []),
		...(probeHeader ? ["    headers:", `      x-config-probe: ${JSON.stringify(probeHeader)}`] : []),
		"    models:",
		"      - id: claude-gateway-model",
		"        name: Claude Gateway Model",
		"        reasoning: false",
		"        input: [text]",
		...(maxTokens ? ["        contextWindow: 200000", `        maxTokens: ${maxTokens}`] : []),
		"",
	].join("\n");
}

/** Every `cache_control.ttl` in a request body. */
function breakpointTtls(body: unknown): Array<string | undefined> {
	const ttls: Array<string | undefined> = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const cacheControl = record.cache_control as { ttl?: string } | undefined;
		if (cacheControl) ttls.push(cacheControl.ttl);
		for (const child of Object.values(record)) walk(child);
	};
	walk(body);
	return ttls;
}

interface Harness {
	modelsPath: string;
	registry: ModelRegistry;
	requests: () => Array<Array<string | undefined>>;
	/** The provider requests themselves, in order. */
	messagesRequests: () => CapturedRequest[];
	start: (model: Model) => Promise<AgentSession>;
	close: () => Promise<void>;
}

async function harness(tempDir: TempDir, initial: boolean | GatewayConfig = false): Promise<Harness> {
	const modelsPath = tempDir.join("models.yml");
	fs.writeFileSync(modelsPath, modelsYaml(initial));
	const captured: CapturedRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(captureFetch(captured, anthropicChunks("OK"))));
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath);
	const sessions: AgentSession[] = [];
	return {
		modelsPath,
		registry,
		requests: () =>
			captured
				.filter(request => new URL(request.url).pathname.endsWith("/v1/messages"))
				.map(request => breakpointTtls(request.body)),
		messagesRequests: () => captured.filter(request => new URL(request.url).pathname.endsWith("/v1/messages")),
		start: async model => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry: registry,
				settings: Settings.isolated({ "compaction.enabled": false, "providers.cacheRetention": "long" }),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			sessions.push(session);
			return session;
		},
		close: async () => {
			for (const session of sessions) await session.dispose();
			authStorage.close();
		},
	};
}

function gatewayModel(registry: ModelRegistry): Model {
	const model = registry.find("claude-gateway", "claude-gateway-model");
	if (!model) throw new Error("gateway model missing from the registry");
	return model;
}

/** Both file times at a whole second, so a later write can restore them exactly. */
const PINNED_TIME = new Date(1_700_000_000_000);
function pinTimes(modelsPath: string): void {
	fs.utimesSync(modelsPath, PINNED_TIME, PINNED_TIME);
}

function addFlagKeepingTimes(modelsPath: string): void {
	fs.writeFileSync(modelsPath, modelsYaml(true));
	pinTimes(modelsPath);
}

function rewrite(modelsPath: string, config: GatewayConfig): void {
	const next = new Date(fs.statSync(modelsPath).mtimeMs + 1_000);
	fs.writeFileSync(modelsPath, modelsYaml(config));
	fs.utimesSync(modelsPath, next, next);
}

function addFlagWithNewMtime(modelsPath: string): void {
	const next = new Date(fs.statSync(modelsPath).mtimeMs + 1_000);
	fs.writeFileSync(modelsPath, modelsYaml(true));
	fs.utimesSync(modelsPath, next, next);
}

const allLong = (ttls: Array<string | undefined>) => ttls.length > 0 && ttls.every(ttl => ttl === "1h");
const allShort = (ttls: Array<string | undefined>) => ttls.length > 0 && ttls.every(ttl => ttl === undefined);

describe("a running session re-reads models.yml before its next request", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends the 1-hour cache marker on the next main-loop request once the compat flag is added on disk", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-");
		const h = await harness(tempDir);
		try {
			const session = await h.start(gatewayModel(h.registry));
			await session.prompt("first");
			addFlagWithNewMtime(h.modelsPath);
			await session.prompt("second");
		} finally {
			await h.close();
		}
		const [first, second] = h.requests();
		// A proxy address gets no 1-hour marker until the provider declares it.
		expect(allShort(first!)).toBe(true);
		expect(allLong(second!)).toBe(true);
	});

	it("applies an edit that keeps the file's mtime to the next side request", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-side-");
		const h = await harness(tempDir);
		try {
			pinTimes(h.modelsPath);
			const session = await h.start(gatewayModel(h.registry));
			await session.prompt("first");
			addFlagKeepingTimes(h.modelsPath);
			await session.runEphemeralTurn({ promptText: "side question", tools: false });
		} finally {
			await h.close();
		}
		const [first, side] = h.requests();
		expect(allShort(first!)).toBe(true);
		expect(allLong(side!)).toBe(true);
	});

	it("re-binds a model object handed in from an older catalog at the first request", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-stale-");
		const h = await harness(tempDir);
		try {
			const stale = gatewayModel(h.registry);
			addFlagWithNewMtime(h.modelsPath);
			expect(await h.registry.reloadIfConfigChanged()).toBe(true);
			const session = await h.start(stale);
			await session.prompt("first");
		} finally {
			await h.close();
		}
		const [first] = h.requests();
		expect(allLong(first!)).toBe(true);
	});

	it("applies an edited output limit to the next request", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-limits-");
		const h = await harness(tempDir, { maxTokens: 16384 });
		try {
			const session = await h.start(gatewayModel(h.registry));
			await session.prompt("first");
			rewrite(h.modelsPath, { maxTokens: 8192 });
			await session.prompt("second");
		} finally {
			await h.close();
		}
		expect(h.messagesRequests().map(request => request.body.max_tokens)).toEqual([16384, 8192]);
	});

	it("applies an edited `!command` header to the next main-loop and side request", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-headers-");
		const h = await harness(tempDir, { probeHeader: "!echo old" });
		try {
			const session = await h.start(gatewayModel(h.registry));
			await session.prompt("first");
			rewrite(h.modelsPath, { probeHeader: "!echo new" });
			await session.prompt("second");
			await session.runEphemeralTurn({ promptText: "side question", tools: false });
		} finally {
			await h.close();
		}
		expect(h.messagesRequests().map(request => request.headers["x-config-probe"])).toEqual(["old", "new", "new"]);
	});

	it("applies a limit edit to a model object taken from the catalog before the edit", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-stale-limits-");
		const h = await harness(tempDir, { maxTokens: 16384 });
		try {
			// A fallback candidate, a temporary model or a caller's selection: taken before the edit.
			const stale = gatewayModel(h.registry);
			rewrite(h.modelsPath, { maxTokens: 8192 });
			expect(await h.registry.reloadIfConfigChanged()).toBe(true);
			const session = await h.start(stale);
			await session.prompt("first");
		} finally {
			await h.close();
		}
		expect(h.messagesRequests().map(request => request.body.max_tokens)).toEqual([8192]);
	});

	it("sends a model rebuilt outside the registry with the configuration current at request time", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-external-");
		const h = await harness(tempDir, { probeHeader: "!echo old", maxTokens: 16384 });
		try {
			// An SDK caller (or another registry) holds its own copy of the model from before the edit.
			const external = buildModel(toModelSpec(gatewayModel(h.registry)));
			rewrite(h.modelsPath, { probeHeader: "!echo new", maxTokens: 8192 });
			const session = await h.start(external);
			await session.prompt("first");
			await session.runEphemeralTurn({ promptText: "side question", tools: false });
		} finally {
			await h.close();
		}
		const requests = h.messagesRequests();
		expect(requests.map(request => request.headers["x-config-probe"])).toEqual(["new", "new"]);
		expect(requests.map(request => request.body.max_tokens)).toEqual([8192, 8192]);
	});
});

describe("a locally probed context window across a models.yml edit", () => {
	it("survives an edit to another provider and a key-order-only rewrite of its own", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-probe-");
		const caps: number[] = [];
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "cold-preset", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		using server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/models") return Response.json({ data: [{ id: "cold-preset", meta: { n_ctx: 16384 } }] });
				if (pathname === "/props") {
					return Response.json({
						default_generation_settings: { n_ctx: 16384, params: { max_tokens: -1, n_predict: -1 } },
					});
				}
				const body = (await request.json()) as { max_tokens?: number; max_completion_tokens?: number };
				caps.push(body.max_tokens ?? body.max_completion_tokens ?? -1);
				return new Response(
					`${chunk({ role: "assistant", content: "OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});
		const url = `http://127.0.0.1:${server.port}`;
		const modelsPath = tempDir.join("models.yml");
		const config = (unused: string, reversed = false) => {
			const llama: Record<string, unknown> = {
				baseUrl: url,
				api: "openai-completions",
				apiKey: "test",
				discovery: { type: "llama.cpp" },
			};
			return JSON.stringify({
				providers: {
					"llama.cpp": reversed ? Object.fromEntries(Object.entries(llama).reverse()) : llama,
					gateway: {
						baseUrl: "http://127.0.0.1:9991",
						api: "anthropic-messages",
						apiKey: "test",
						models: [{ id: unused, reasoning: false, input: ["text"] }],
					},
				},
			});
		};
		fs.writeFileSync(modelsPath, config("unused-1"));
		// The catalog row a llama.cpp model starts from before the server reports what it loaded.
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "cold-preset",
					name: "cold-preset",
					provider: "llama.cpp",
					api: "openai-completions",
					baseUrl: `${url}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			tempDir.join("models.db"),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: globalThis.fetch });
		let session: AgentSession | undefined;
		try {
			const probed = await registry.refreshSelectedModelMetadata(registry.find("llama.cpp", "cold-preset")!);
			expect(probed.maxTokens).toBe(16384);
			({ session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry: registry,
				settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
				model: probed,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			}));
			await session.prompt("first");
			const touch = () => {
				const next = new Date(fs.statSync(modelsPath).mtimeMs + 1_000);
				fs.utimesSync(modelsPath, next, next);
			};
			fs.writeFileSync(modelsPath, config("unused-2"));
			touch();
			await session.prompt("second");
			fs.writeFileSync(modelsPath, config("unused-2", true));
			touch();
			await session.prompt("third");
			expect([session.model?.contextWindow, session.model?.maxTokens]).toEqual([16384, 16384]);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
		// Both requests size their output to the probed 16384-token window, never the cached 128000/32768 row.
		expect(caps).toHaveLength(3);
		for (const cap of caps) expect(cap).toBeLessThanOrEqual(16384);
	});
});
