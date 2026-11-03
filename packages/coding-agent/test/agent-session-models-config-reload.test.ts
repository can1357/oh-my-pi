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
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { anthropicChunks, type CapturedRequest, captureFetch } from "../../ai/test/helpers/factory-droid";
import { asGlobalFetch } from "./helpers/fetch-mock";

function modelsYaml(withLongRetentionFlag: boolean): string {
	return [
		"providers:",
		"  claude-gateway:",
		"    baseUrl: https://gateway.example.test",
		"    apiKey: TEST_GATEWAY_KEY",
		"    api: anthropic-messages",
		...(withLongRetentionFlag ? ["    compat:", "      supportsLongCacheRetention: true"] : []),
		"    models:",
		"      - id: claude-gateway-model",
		"        name: Claude Gateway Model",
		"        reasoning: false",
		"        input: [text]",
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
	start: (model: Model) => Promise<AgentSession>;
	close: () => Promise<void>;
}

async function harness(tempDir: TempDir): Promise<Harness> {
	const modelsPath = tempDir.join("models.yml");
	fs.writeFileSync(modelsPath, modelsYaml(false));
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

function addFlagKeepingTimes(modelsPath: string): void {
	const before = fs.statSync(modelsPath);
	fs.writeFileSync(modelsPath, modelsYaml(true));
	fs.utimesSync(modelsPath, before.atime, before.mtime);
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
});
