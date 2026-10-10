/**
 * The local session of a hosted terminal (`createHostedLocalSession`), built through the real SDK. The host owns tools,
 * extensions, models, and providers, so this process may not run a client-local custom tool factory, pick a configured
 * default model, or reach a provider, either before or after the host's snapshot arrives. Each case has an ordinary
 * control: the same options without the passive guards do the work, so the silence is the guard.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { loadReplica } from "@oh-my-pi/pi-coding-agent/session/replica-view";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createHostedLocalSession } from "@oh-my-pi/pi-coding-agent/session-host/hosted-startup";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/** Tools only client-local discovery or a client-local memory backend could add to an empty tool list. */
const LOCAL_TOOLS = ["client_local_tool", "manage_skill", "learn", "recall", "retain", "reflect", "memory_edit"];
/** Clearing the passive guards the hosted builder sets gives the ordinary session of the same options. */
const ORDINARY: Partial<CreateAgentSessionOptions> = { restrictToolNames: undefined, passiveReplica: undefined };

interface HostedEnv {
	cwd: string;
	agentDir: string;
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/** The hosted terminal's session through the real SDK; `overrides` only ever clear the passive guards. */
function hostedSession(
	env: HostedEnv,
	overrides: Partial<CreateAgentSessionOptions> = {},
): Promise<{ session: AgentSession }> {
	return createHostedLocalSession({
		cwd: env.cwd,
		authStorage: env.authStorage,
		modelRegistry: env.modelRegistry,
		settings: env.settings,
		eventBus: new EventBus(),
		subagentEventBus: new EventBus(),
		createSession: options => createAgentSession({ ...options, agentDir: env.agentDir, ...overrides }),
	});
}

/**
 * The first host frame: a transcript naming the host's model replaces the empty local session. The replica keeps its
 * own model; the host's arrives with the snapshot's state.
 */
async function adoptSnapshot(session: AgentSession, dir: string, model: string): Promise<void> {
	const host = SessionManager.inMemory();
	host.appendModelChange(model);
	host.appendMessage({ role: "user", content: "from the host", timestamp: Date.now() });
	const { header, entries } = host.snapshotForReplication();
	await loadReplica(session, path.join(dir, "replica.jsonl"), header, entries);
}

function localTools(session: AgentSession): string[] {
	return session.getAllToolNames().filter(name => LOCAL_TOOLS.includes(name));
}

function jsonResponse(body: unknown): Promise<Response> {
	const headers = { "Content-Type": "application/json" };
	return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers }));
}

describe("createHostedLocalSession", () => {
	const tempDirs: string[] = [];
	const authStorages: AuthStorage[] = [];
	const stops: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		resetMemoryForTests();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const stop of stops.splice(0)) stop();
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	function makeTempDir(): string {
		const tempDir = path.join(os.tmpdir(), `pi-hosted-local-session-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	}

	function makeAuthStorage(): AuthStorage {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		return authStorage;
	}

	it("runs no client-local custom tool factory and admits no discovered or memory tool", async () => {
		vi.spyOn(os, "homedir").mockReturnValue(makeTempDir());
		const agentDir = makeTempDir();
		const project = makeTempDir();
		const marker = path.join(project, "factory-ran");
		fs.mkdirSync(path.join(project, ".git"));
		fs.mkdirSync(path.join(project, ".omp", "tools"), { recursive: true });
		// A factory that leaves `marker` behind, so an executed factory is observable.
		const toolSource = `import * as fs from "node:fs";
export default api => {
	fs.writeFileSync(${JSON.stringify(marker)}, "factory ran");
	return {
		name: "client_local_tool",
		description: "Must never exist in a hosted terminal",
		parameters: api.arktype({}),
		async execute() { return { content: [{ type: "text", text: "ran" }] }; },
	};
};`;
		fs.writeFileSync(path.join(project, ".omp", "tools", "client-local.ts"), toolSource);
		const authStorage = makeAuthStorage();
		const env: HostedEnv = {
			cwd: project,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
			// Memory and auto-learn tools join an explicit tool list unless the session is restricted.
			settings: Settings.isolated({
				"memory.backend": "mnemopi",
				"autolearn.enabled": true,
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
			}),
		};

		const { session } = await hostedSession(env);
		try {
			expect(fs.existsSync(marker)).toBe(false);
			expect(localTools(session)).toEqual([]);
			await adoptSnapshot(session, agentDir, "openai/gpt-4o-mini");
			expect(fs.existsSync(marker)).toBe(false);
			expect(localTools(session)).toEqual([]);
		} finally {
			await session.dispose();
		}
		expect(fs.existsSync(marker)).toBe(false);

		const model = getBundledModel("openai", "gpt-4o-mini");
		const { session: ordinary } = await hostedSession(env, { ...ORDINARY, model });
		try {
			expect(fs.existsSync(marker)).toBe(true);
		} finally {
			await ordinary.dispose();
		}
	}, 30_000);

	it("selects no Codex default and starts no Codex websocket prewarm", async () => {
		const agentDir = makeTempDir();
		// A local endpoint stands in for the Codex backend, so the ordinary control never leaves the machine.
		const upgraded = Promise.withResolvers<void>();
		const server = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, bunServer): Response | undefined {
				if (bunServer.upgrade(request, { data: undefined })) {
					upgraded.resolve();
					return undefined;
				}
				return new Response("websocket only", { status: 426 });
			},
			websocket: { message(): void {} },
		});
		stops.push(() => server.stop(true));
		const endpoint = `http://127.0.0.1:${server.port}`;
		const modelsYml = ["providers:", "  openai-codex:", `    baseUrl: ${endpoint}`, "    apiKey: codex-test-key"];
		fs.writeFileSync(path.join(agentDir, "models.yml"), modelsYml.join("\n"));
		const authStorage = makeAuthStorage();
		authStorage.keys.setRuntime("openai-codex", "codex-oauth-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		const env: HostedEnv = {
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				modelRoles: { default: "openai-codex/gpt-5.6-sol" },
				"providers.openaiWebsockets": "on",
			}),
		};
		const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
		const codexLookups = (): number =>
			getApiKey.mock.calls.filter(([model]) => model.provider === "openai-codex").length;

		const { session } = await hostedSession(env);
		try {
			expect(session.model).toBeUndefined();
			expect(codexLookups()).toBe(0);
			await adoptSnapshot(session, agentDir, "openai-codex/gpt-5.6-sol");
			// The replica keeps its model (the host's arrives with the snapshot's state), so nothing resolves it here.
			expect(session.model).toBeUndefined();
			expect(codexLookups()).toBe(0);
		} finally {
			await session.dispose();
		}

		const { session: ordinary } = await hostedSession(env, ORDINARY);
		try {
			expect(ordinary.model?.provider).toBe("openai-codex");
			expect(codexLookups()).toBeGreaterThan(0);
			await upgraded.promise;
		} finally {
			await ordinary.dispose();
		}
	}, 30_000);

	it("probes no local LM Studio backend for a cached default", async () => {
		const agentDir = makeTempDir();
		const requests: string[] = [];
		const fetchImpl: FetchImpl = input => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/api/v0/models")) {
				const model = { id: "big-model", type: "llm", state: "loaded" };
				return jsonResponse({ data: [{ ...model, max_context_length: 262144, loaded_context_length: 81920 }] });
			}
			if (url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "big-model", object: "model" }] });
			return Promise.resolve(new Response(null, { status: 404 }));
		};
		const authStorage = makeAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { fetch: fetchImpl });
		// A previous run's discovery: the model is cached, so the next start has it without asking the backend.
		await modelRegistry.refresh();
		requests.length = 0;
		const env: HostedEnv = {
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ modelRoles: { default: "lm-studio/big-model" } }),
		};

		const { session } = await hostedSession(env);
		try {
			expect(session.model).toBeUndefined();
			expect(requests).toEqual([]);
			await adoptSnapshot(session, agentDir, "lm-studio/big-model");
			expect(session.model).toBeUndefined();
			expect(requests).toEqual([]);
		} finally {
			await session.dispose();
		}

		const { session: ordinary } = await hostedSession(env, ORDINARY);
		try {
			expect(ordinary.model?.id).toBe("big-model");
			expect(requests.some(url => url.endsWith("/api/v0/models"))).toBe(true);
		} finally {
			await ordinary.dispose();
		}
	}, 30_000);
});
