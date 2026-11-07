/**
 * What a running session picks up from a models.yml edit without restarting, and what it must not.
 * The registry re-reads the file before every provider request (`settingsAwareStreamFn`) and before
 * a generated title, so a model resolved from the catalog at request time — here the `tiny` role a
 * title uses — is built from the edited file. A model object an SDK caller built itself keeps its
 * own endpoint, headers and compat across the same edit: `rebindModelAfterDiscovery` defaults to
 * false for a caller-supplied model, and no reload may replace caller-owned routing.
 *
 * The session's own already-selected model object is not re-resolved per request; see
 * `docs/design/request-binding-contract.md` for the question that work has to answer first.
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
	start: (model: Model, configure?: (settings: Settings) => void) => Promise<AgentSession>;
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
		start: async (model, configure) => {
			const settings = Settings.isolated({ "compaction.enabled": false, "providers.cacheRetention": "long" });
			configure?.(settings);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry: registry,
				settings,
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

const allShort = (ttls: Array<string | undefined>) => ttls.length > 0 && ttls.every(ttl => ttl === undefined);

describe("a running session re-reads models.yml before its next request", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends a model object an SDK caller built as given, even after an edit to its provider", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-external-");
		const h = await harness(tempDir);
		try {
			// The caller owns this object's endpoint, headers and compat (sdk.ts `model`): no reload may replace them.
			const external: Model = {
				...gatewayModel(h.registry),
				baseUrl: "https://sdk.example.test",
				headers: { "x-sdk": "caller-owned" },
			};
			const session = await h.start(external);
			await session.prompt("first");
			addFlagWithNewMtime(h.modelsPath);
			await session.prompt("second");
		} finally {
			await h.close();
		}
		const requests = h.messagesRequests();
		expect(requests.map(request => new URL(request.url).host)).toEqual(["sdk.example.test", "sdk.example.test"]);
		expect(requests.map(request => request.headers["x-sdk"])).toEqual(["caller-owned", "caller-owned"]);
		// The provider gained the 1-hour flag, but this object keeps its own compat.
		expect(h.requests().every(allShort)).toBe(true);
	});

	it("picks title models from an edited models.yml", async () => {
		using tempDir = TempDir.createSync("@pi-models-config-reload-title-");
		const h = await harness(tempDir, { probeHeader: "!echo old" });
		try {
			const session = await h.start(gatewayModel(h.registry), settings =>
				settings.setModelRole("tiny", "claude-gateway/claude-gateway-model"),
			);
			rewrite(h.modelsPath, { probeHeader: "!echo new" });
			await session.generateTitle("Implement reliable model registry reload");
		} finally {
			await h.close();
		}
		expect(h.messagesRequests().map(request => request.headers["x-config-probe"])).toEqual(["new"]);
	});
});
