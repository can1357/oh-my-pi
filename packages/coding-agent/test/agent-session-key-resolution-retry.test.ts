/**
 * A provider key that cannot be resolved for a moment, on the production key
 * path: a real `AgentSession` whose requests resolve keys through
 * `ModelRegistry.turnResolver()` over a real credential store (an auth broker's
 * SQLite store behind its HTTP client, or a local SQLite store), with a
 * scripted provider stream. Also the failures that must stay final: a key the
 * user removed, a turn that failed otherwise, and a pooled session whose
 * provider takes a models.yml apiKey.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	resolveCredentialIdentityKey,
	streamSimple,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockCall, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { invalidateAllCommandConfigs } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isolateDaemonForSmokeTest, probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, isPidAlive, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { restoreEnvValue } from "./helpers/settings-test-state";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MOCK_API_SOURCE = "agent-session-key-resolution-retry-test";
const PROVIDER_SESSION_ID = "key-resolution-retry-session";
const BASE_DELAY_MS = 40;
/** Disable Bun's transpiler cache for the worker this test starts: it must not populate the TempDir or the network. */
const BUN_RUNTIME_TRANSPILER_CACHE_PATH = "/dev/null";
const FINAL_ANSWER = "finished after the broker answered again";
const BROKER_TOKEN = "key-resolution-retry-broker-bearer";
/** Lifetime of the login's access token; the probe tool outlasts it. */
const ACCESS_TOKEN_LIFETIME_MS = 2 * 60_000;
/** Key lookups of the turn that fail while the broker is down; the next one reaches it. */
const BROKER_DOWN_LOOKUPS = 2;
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const WORKER_NAME = "KeyedWorker";
const NOTES_FILE = "notes.txt";
const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};
const ANTHROPIC_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
const COPILOT_MODEL = { provider: "github-copilot", id: "gpt-4o" };
/** A models.yml provider whose apiKey is a `!command`. */
const COMMAND_PROVIDER = "custom-proxy";
/** What `omp auth-broker logout` records. */
const LOGGED_OUT_BY_USER = "logged out by user";

const probeSchema = type({ value: "string" });

const ENV_KEYS = [
	"HOME",
	"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-key-resolution-retry-");
	// Project discovery stops at the isolated os.homedir().
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	// Keep omp state and its daemon runtime isolated. Bun's worker daemon compiles workspace TypeScript, so
	// disabling Bun's runtime transpiler cache prevents .pile writes under this case's HOME.
	vi.spyOn(os, "homedir").mockReturnValue(home);
	restoreEnvValue("BUN_RUNTIME_TRANSPILER_CACHE_PATH", BUN_RUNTIME_TRANSPILER_CACHE_PATH);
	setAgentDir(path.join(home, ".omp", "agent"));
	cleanups.push(await isolateDaemonForSmokeTest());
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	const failures: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await AgentLifecycleManager.global().dispose();
	} catch (error) {
		failures.push(error);
	}
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// Subagent sessions opened agent.db and models.db under the isolated HOME.
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
	if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
});

function oauthLogin(account: string, expires = Date.now() + 3_600_000) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires,
		accountId: account,
		email: `${account}@example.com`,
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message;
}

/** An origin that refuses connections, as a broker host whose broker process is down does. */
async function refusedOrigin(): Promise<string> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
	const origin = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	return origin;
}

/** What a failed refresh records: every anthropic login of the store is disabled. */
async function disableLoginsAfterFailedRefresh(authStorage: AuthStorage): Promise<void> {
	for (const account of authStorage.oauth.accounts("anthropic")) {
		await authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
	}
}

/** The text of the first `toolName` result among `messages`, if any. */
function toolResultText(messages: readonly Message[], toolName: string): string | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	return result?.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** The details of the parent's first `task` result. */
function taskDetails(messages: readonly AgentMessage[]): TaskToolDetails | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "task",
	);
	return result?.details as TaskToolDetails | undefined;
}

/** Requests that offered `toolName`: the turns of a session, not its label or title requests. */
function turnsOffering(model: MockModel, toolName: string): MockCall[] {
	return model.calls.filter(call => (call.context.tools ?? []).some(tool => tool.name === toolName));
}

/**
 * A parent session on the production SDK path whose model spawns `WORKER` as a
 * task subagent and, when `async`, waits for it. The worker's model is on
 * anthropic, keyed by the store's only OAuth login; once its first request has
 * gone out, a failed refresh disables that login, so no later key lookup of
 * the worker resolves. Settings give the worker a retry budget of two, each
 * retry after `retryDelayMs` (default `BASE_DELAY_MS`).
 */
async function openParentWithKeyedWorker(options: { async: boolean; retryDelayMs?: number }) {
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("testauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));

	const parentWaiting = Promise.withResolvers<void>();
	const parentModel = createMockModel({
		id: "parent-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "task")) return { content: ["label"] };
			const answered = context.messages.flatMap(message =>
				message.role === "toolResult" ? [message.toolName] : [],
			);
			if (!answered.includes("task")) {
				return {
					content: [
						{
							type: "toolCall",
							id: "call_task",
							name: "task",
							arguments: { agent: WORKER.name, name: WORKER_NAME, task: `Read ${NOTES_FILE} and report it.` },
						},
					],
					stopReason: "toolUse",
				};
			}
			if (options.async && !answered.includes("wait")) {
				parentWaiting.resolve();
				return {
					content: [{ type: "toolCall", id: "call_wait", name: "wait", arguments: {} }],
					stopReason: "toolUse",
				};
			}
			return { content: ["The worker could not read the notes."], stopReason: "stop" };
		},
	});
	// Run as a job, the worker starts its turn once the parent waits on it.
	const workerMayStart = options.async ? parentWaiting.promise : Promise.resolve();
	const workerModel = createMockModel({
		provider: "anthropic",
		id: "mock-claude",
		handler: async context => {
			if (!(context.tools ?? []).some(tool => tool.name === "read")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				await workerMayStart;
				await disableLoginsAfterFailedRefresh(authStorage);
				return {
					content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: NOTES_FILE } }],
					stopReason: "toolUse",
				};
			}
			return (context.tools ?? []).some(tool => tool.name === "yield")
				? {
						content: [
							{
								type: "toolCall",
								id: "call_yield",
								name: "yield",
								arguments: { type: "result", data: "the notes" },
							},
						],
					}
				: { content: ["the notes"] };
		},
	});
	// Only the scripted models are available, so no label or title request leaves the process.
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, workerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });

	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("sessions")),
		settings: Settings.isolated({
			"async.enabled": options.async,
			"task.batch": false,
			"task.enableLsp": false,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": options.retryDelayMs ?? BASE_DELAY_MS,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
		}),
		toolNames: options.async ? ["task", "wait"] : ["task"],
		spawns: "*",
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	cleanups.push(async () => {
		await Promise.allSettled(session.asyncJobManager?.getAllJobs().map(job => job.promise) ?? []);
		await session.dispose();
	});
	return { parent: session, parentModel, workerModel };
}

/** Makes the anthropic key unreadable (`start`) and readable again (`end`). */
interface KeyOutage {
	start(): Promise<void>;
	end(): Promise<void>;
}

/** One test's credential store and model registry; `afterEach` closes the store. */
interface KeyResolutionContext {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/**
 * Each way a stored anthropic credential can exist yet serve no request for a
 * while, driven through the real credential store:
 * - `credential-disabled`: a failed refresh disabled the only OAuth login; a new
 *   login (here or in another session sharing the store) brings one back.
 * - `refresh-unavailable`: the login expired and its refresh fails with a
 *   network error the error text does not name as transient; a refresh succeeds.
 * - `active-row-no-key`: the login stays stored and active, but its lookup
 *   yields no key; a later lookup yields one.
 */
const OUTAGE_MODES = ["credential-disabled", "refresh-unavailable", "active-row-no-key"] as const;
type OutageMode = (typeof OUTAGE_MODES)[number];

function bundledModel(ref: { provider: string; id: string }): Model<Api> {
	const model = getBundledModel(ref.provider, ref.id);
	if (!model) throw new Error(`Expected bundled test model ${ref.provider}/${ref.id} to exist`);
	return model;
}

/**
 * The test's credential store, holding one anthropic OAuth login, and its model
 * registry over `models` (written as the registry's models.yml) when given.
 */
async function setUp(models?: object): Promise<KeyResolutionContext> {
	const modelsPath = root.join("models.yml");
	if (models) await Bun.write(modelsPath, JSON.stringify(models));
	const authStorage = await AuthStorage.create(root.join("testauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	const modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	return { authStorage, modelRegistry };
}

/**
 * The outage `mode` describes, on the test's own credential store. `refresh-unavailable`
 * and `active-row-no-key` spy on shared modules, which `afterEach` restores.
 */
function keyOutage(ctx: KeyResolutionContext, mode: OutageMode): KeyOutage {
	const { authStorage } = ctx;
	switch (mode) {
		case "credential-disabled":
			return {
				start: () => disableLoginsAfterFailedRefresh(authStorage),
				end: async () => {
					if (!authStorage.credentials.has("anthropic")) {
						await authStorage.credentials.set("anthropic", [oauthLogin("acc-relogin")]);
					}
				},
			};
		case "refresh-unavailable": {
			let refreshing = false;
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
				if (!refreshing) throw new Error("ECONNRESET");
				return { access: "access-refreshed", refresh: "refresh-refreshed", expires: Date.now() + 3_600_000 };
			});
			return {
				start: async () => {
					refreshing = false;
					await authStorage.credentials.set("anthropic", [oauthLogin("acc-live", Date.now() - 60_000)]);
				},
				end: async () => {
					refreshing = true;
				},
			};
		}
		case "active-row-no-key": {
			let readable = true;
			const readKey = authStorage.keys.get.bind(authStorage.keys);
			const readKeyWithCredential = authStorage.keys.getWithCredential.bind(authStorage.keys);
			vi.spyOn(authStorage.keys, "get").mockImplementation(async (provider, sessionId, options) =>
				readable ? readKey(provider, sessionId, options) : undefined,
			);
			vi.spyOn(authStorage.keys, "getWithCredential").mockImplementation(async (provider, sessionId, options) =>
				readable ? readKeyWithCredential(provider, sessionId, options) : undefined,
			);
			return {
				start: async () => {
					readable = false;
				},
				end: async () => {
					readable = true;
				},
			};
		}
	}
}

/**
 * A session on the production key path (`ModelRegistry.turnResolver`, as
 * sdk.ts wires it) whose model calls `probe` once and then answers. With
 * `outage`, the key goes away while `probe` runs (`startOn: "probe"`) or
 * before the prompt (`startOn: "prompt"`, the caller starts it), and comes
 * back after `resolvesWhileDown` of the turn's key resolutions have failed.
 * `extensionRunner` runs extension handlers on the session's events.
 */
async function openSession(
	ctx: KeyResolutionContext,
	options: {
		maxRetries: number;
		sessionManager: SessionManager;
		model?: Model<Api>;
		outage?: { keys: KeyOutage; startOn: "probe" | "prompt"; resolvesWhileDown: number };
		extensionRunner?: ExtensionRunner;
	},
) {
	const { modelRegistry } = ctx;
	const model = options.model ?? bundledModel(ANTHROPIC_MODEL);
	const outage = options.outage;
	let down = outage?.startOn === "prompt";
	let failedResolves = 0;
	const probeRuns: string[] = [];
	const probe: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			probeRuns.push(params.value);
			if (outage?.startOn === "probe" && probeRuns.length === 1) {
				await outage.keys.start();
				down = true;
			}
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	const mock = createMockModel({
		id: model.id,
		provider: model.provider,
		handler: context =>
			context.messages.some(message => message.role === "toolResult")
				? { content: [FINAL_ANSWER], stopReason: "stop" }
				: {
						content: [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { value: "x" } }],
						stopReason: "toolUse",
					},
	});
	const agent = new Agent({
		getApiKey: async requestModel => {
			if (outage && down) {
				if (failedResolves === outage.resolvesWhileDown) {
					await outage.keys.end();
					down = false;
				} else {
					failedResolves++;
				}
			}
			return modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID);
		},
		sessionId: PROVIDER_SESSION_ID,
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [probe as AgentTool],
			messages: options.sessionManager.buildSessionContext().messages,
		},
		streamFn: (_requestModel, context, streamOptions) => streamSimple(mock.model, context, streamOptions),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": BASE_DELAY_MS,
		"retry.maxRetries": options.maxRetries,
		"retry.modelFallback": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: options.sessionManager,
		settings,
		modelRegistry,
		providerSessionId: PROVIDER_SESSION_ID,
		extensionRunner: options.extensionRunner,
	});
	cleanups.push(() => session.dispose());

	const retryStarts: AutoRetryStartEvent[] = [];
	const retryEnds: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retryStarts.push(event);
		if (event.type === "auto_retry_end") retryEnds.push(event);
	});
	return { session, mock, probeRuns, retryStarts, retryEnds };
}

/** A `!command` apiKey that prints `file`'s text, and prints nothing (exit 1) while it reads `FAIL`. */
function keyFileCommand(file: string): string {
	if (process.platform !== "win32") {
		return `IFS= read -r key < '${file.replaceAll("'", "'\\''")}'; [ "$key" = FAIL ] && exit 1; printf %s "$key"`;
	}
	const script = `const key=require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8").trim();if(key==="FAIL")process.exit(1);process.stdout.write(key);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** A turn on a real `Agent` whose one request ends as `streamFn` makes it end: the failed message. */
async function storedFailedTurn(streamFn: StreamFn): Promise<AssistantMessage> {
	const agent = new Agent({
		getApiKey: async () => "test-key",
		initialState: { model: bundledModel(ANTHROPIC_MODEL), systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn,
	});
	await agent.prompt("work");
	const failed = agent.state.messages.at(-1);
	if (failed?.role !== "assistant") throw new Error("Expected the turn to end on an assistant message");
	return failed;
}

describe("AgentSession: a provider key that cannot be resolved for a moment", () => {
	for (const mode of OUTAGE_MODES) {
		it(`retries a turn whose key went away mid-turn and finishes once it is back (${mode})`, async () => {
			// If this regresses, the turn ends at once on the failed lookup, with no retry.
			const ctx = await setUp();
			const { session, mock, probeRuns, retryStarts, retryEnds } = await openSession(ctx, {
				maxRetries: 5,
				sessionManager: SessionManager.inMemory(),
				outage: { keys: keyOutage(ctx, mode), startOn: "probe", resolvesWhileDown: 2 },
			});
			const waits = mockSchedulerWaitWithClock();

			await session.prompt("run the probe");
			await session.waitForIdle();

			const last = lastAssistant(session);
			expect({ stopReason: last.stopReason, errorMessage: last.errorMessage }).toEqual({
				stopReason: "stop",
				errorMessage: undefined,
			});
			expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			// Two failed resolutions, two backoff retries, then success.
			expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
			// Exponential backoff from retry.baseDelayMs: each wait is at most the doubled
			// base. Only the upper bound is checked, since a release that classifies a failed
			// network refresh as a connection error jitters its wait down to near zero.
			const delays = retryStarts.map(event => event.delayMs);
			expect(delays[0]).toBeGreaterThan(0);
			expect(delays[0]).toBeLessThanOrEqual(BASE_DELAY_MS);
			expect(delays[1]).toBeGreaterThan(0);
			expect(delays[1]).toBeLessThanOrEqual(BASE_DELAY_MS * 2);
			// The session slept out each backoff, in order, among its other waits (the 1 ms
			// waits that schedule the continuations, and the sleeps of a failing OAuth refresh
			// between its own attempts). No floor is put on the waits read: a jittered backoff
			// can itself be under 1 ms.
			const slept = waits.mock.calls.map(call => call[0]);
			let backoffsSlept = 0;
			for (const delayMs of slept) {
				if (backoffsSlept < delays.length && Math.abs(delayMs - delays[backoffsSlept]!) < 0.5) backoffsSlept++;
			}
			expect(backoffsSlept).toBe(delays.length);
			// No request went out without a key, and the tool did not run again.
			expect(mock.calls).toHaveLength(2);
			expect(probeRuns).toEqual(["x"]);
		});
	}

	for (const mode of OUTAGE_MODES) {
		it(`starts a prompt sent while the key is away and finishes it once the key is back (${mode})`, async () => {
			// If this regresses, `prompt()` refuses with `No API key found for anthropic` before any turn starts.
			const ctx = await setUp();
			const keys = keyOutage(ctx, mode);
			await keys.start();
			const { session, mock, probeRuns, retryStarts, retryEnds } = await openSession(ctx, {
				maxRetries: 5,
				sessionManager: SessionManager.inMemory(),
				outage: { keys, startOn: "prompt", resolvesWhileDown: 2 },
			});
			mockSchedulerWaitWithClock();

			await session.prompt("run the probe");
			await session.waitForIdle();

			const last = lastAssistant(session);
			expect(last.stopReason).toBe("stop");
			expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
			expect(mock.calls).toHaveLength(2);
			expect(probeRuns).toEqual(["x"]);
		});
	}

	for (const mode of OUTAGE_MODES) {
		it(`ends the turn past the bound on an error marked credentialUnavailable (${mode})`, async () => {
			// If this regresses, the turn ends at once, or ends unmarked, as though a provider had refused it.
			const ctx = await setUp();
			const keys = keyOutage(ctx, mode);
			const worker = await openSession(ctx, {
				maxRetries: 2,
				sessionManager: SessionManager.inMemory(),
				outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
			});
			mockSchedulerWaitWithClock();

			await worker.session.prompt("run the probe");
			await worker.session.waitForIdle();

			// The key never came back: the bound is spent and the turn ends on the error,
			// marked as a key that could not be resolved. Nothing reached the provider.
			const failed = lastAssistant(worker.session);
			expect({
				stopReason: failed.stopReason,
				credentialUnavailable: failed.credentialUnavailable,
				errorStatus: failed.errorStatus,
			}).toEqual({ stopReason: "error", credentialUnavailable: true, errorStatus: undefined });
			expect(failed.errorMessage).toStartWith("Retry budget exhausted after 2 retries: ");
			expect(worker.retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(worker.retryEnds).toEqual([expect.objectContaining({ success: false, attempt: 2 })]);
			expect(worker.mock.calls).toHaveLength(1);
		});
	}

	it("past the bound, says the stored credentials could not be read when their lookup fails, for a provider with none stored", async () => {
		// If this regresses, the final error says the provider's stored credentials are disabled while none
		// is stored: the store could not be read, and the user looks for a disabled login that does not exist.
		const authStorage = await AuthStorage.create(root.join("empty-auth.db"), {
			usageProviderResolver: () => undefined,
		});
		cleanups.push(() => authStorage.close());
		const ctx = { authStorage, modelRegistry: new ModelRegistry(authStorage, root.join("models.yml")) };
		vi.spyOn(authStorage.credentials, "listDisabled").mockRejectedValue(new Error("auth broker unreachable"));
		const { session, mock, retryStarts } = await openSession(ctx, {
			maxRetries: 2,
			sessionManager: SessionManager.inMemory(),
		});
		mockSchedulerWaitWithClock();

		await session.prompt("run the probe");
		await session.waitForIdle();

		const failed = lastAssistant(session);
		expect({
			stopReason: failed.stopReason,
			credentialUnavailable: failed.credentialUnavailable,
			retryAttempts: retryStarts.map(event => event.attempt),
		}).toEqual({ stopReason: "error", credentialUnavailable: true, retryAttempts: [1, 2] });
		expect(failed.errorMessage).toContain(
			"No API key for provider: anthropic (its stored credentials could not be read)",
		);
		expect(mock.calls).toHaveLength(0);
	});

	it("a `!command` key that printed nothing ends the turn after the command's own cap of 3 retries", async () => {
		// If this regresses, the turn spends all of retry.maxRetries on a command that keeps failing.
		const keyFile = root.join("key.txt");
		await Bun.write(keyFile, "FAIL");
		const ctx = await setUp({
			providers: {
				[COMMAND_PROVIDER]: {
					baseUrl: "https://custom-proxy.example.com/v1",
					api: "openai-completions",
					apiKey: `!${keyFileCommand(keyFile)}`,
					models: [{ id: "custom-model", name: "Custom Model" }],
				},
			},
		});
		// Command results and failure windows are process-wide.
		cleanups.push(() => invalidateAllCommandConfigs());
		const model = ctx.modelRegistry.find(COMMAND_PROVIDER, "custom-model");
		if (!model) throw new Error("Expected the command-keyed test model");
		const worker = await openSession(ctx, {
			maxRetries: 10,
			sessionManager: SessionManager.inMemory(),
			model,
		});
		mockSchedulerWaitWithClock();

		await worker.session.prompt("run the probe");
		await worker.session.waitForIdle();

		// The command's own cap of 3 retries ends the turn before retry.maxRetries does,
		// and the turn is marked as a key that could not be resolved.
		const failed = lastAssistant(worker.session);
		expect({
			stopReason: failed.stopReason,
			credentialUnavailable: failed.credentialUnavailable,
			retryAttempts: worker.retryStarts.map(event => event.attempt),
		}).toEqual({ stopReason: "error", credentialUnavailable: true, retryAttempts: [1, 2, 3] });
		expect(failed.errorMessage).toContain(`The apiKey command for provider ${COMMAND_PROVIDER} produced no key`);
		expect(worker.mock.calls).toHaveLength(0);
	});

	it("retries a turn whose auth broker cannot be reached while a tool runs, and finishes once it answers", async () => {
		// The wall clock follows the virtual backoff clock, plus the time the probe tool takes.
		const wallStart = Date.now();
		const monotonicStart = performance.now();
		let toolTimeMs = 0;
		vi.spyOn(Date, "now").mockImplementation(() =>
			Math.floor(wallStart + performance.now() - monotonicStart + toolTimeMs),
		);
		mockSchedulerWaitWithClock();

		// The broker: its own SQLite store holds the login; it mints a fresh access token on refresh.
		const brokerStorage = await AuthStorage.create(root.join("broker.db"), {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: async () => ({
				access: "access-from-broker",
				refresh: "refresh-from-broker",
				expires: Date.now() + 3_600_000,
			}),
		});
		cleanups.push(() => brokerStorage.close());
		await brokerStorage.credentials.set("anthropic", [oauthLogin("acc-live", Date.now() + ACCESS_TOKEN_LIFETIME_MS)]);
		const broker = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [BROKER_TOKEN],
			disableRefresher: true,
		});
		cleanups.push(() => broker.close());

		// The session's store mirrors the broker over HTTP. While the broker is down,
		// every request to it meets a refused connection.
		const downOrigin = await refusedOrigin();
		let brokerDown = false;
		let refusedRefreshes = 0;
		let refreshesAfterOutage = 0;
		const brokerFetch = asGlobalFetch((input, init) => {
			const url = String(input);
			const refresh = url.includes("/refresh");
			if (!brokerDown) {
				if (refresh && refusedRefreshes > 0) refreshesAfterOutage++;
				return fetch(input, init);
			}
			if (refresh) refusedRefreshes++;
			return fetch(url.replace(broker.url, downOrigin), init);
		});
		const client = new AuthBrokerClient({ url: broker.url, token: BROKER_TOKEN, fetchImpl: brokerFetch });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("Expected the broker's snapshot");
		const remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		const authStorage = new AuthStorage(remote, { usageProviderResolver: () => undefined });
		cleanups.push(() => {
			authStorage.close();
			remote.close();
		});
		await authStorage.credentials.reload();
		const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
		const probeRuns: string[] = [];
		const probe: AgentTool<typeof probeSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, params) {
				probeRuns.push(params.value);
				// The tool outlasts the access token, and the broker goes down meanwhile.
				toolTimeMs += ACCESS_TOKEN_LIFETIME_MS;
				brokerDown = true;
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: context =>
				context.messages.some(message => message.role === "toolResult")
					? { content: [FINAL_ANSWER], stopReason: "stop" }
					: {
							content: [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { value: "x" } }],
							stopReason: "toolUse",
						},
		});
		let failedLookups = 0;
		const agent = new Agent({
			getApiKey: async requestModel => {
				if (brokerDown) {
					if (failedLookups === BROKER_DOWN_LOOKUPS) brokerDown = false;
					else failedLookups++;
				}
				return modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID);
			},
			sessionId: PROVIDER_SESSION_ID,
			initialState: { model, systemPrompt: ["Test"], tools: [probe as AgentTool], messages: [] },
			streamFn: (_requestModel, context, streamOptions) => streamSimple(mock.model, context, streamOptions),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": BASE_DELAY_MS,
			"retry.maxRetries": 5,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId: PROVIDER_SESSION_ID,
		});
		cleanups.push(() => session.dispose());
		const retryStarts: AutoRetryStartEvent[] = [];
		const retryEnds: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		await session.prompt("run the probe");
		await session.waitForIdle();

		const last = lastAssistant(session);
		// One report: how the turn ended, its retries, and whether its key lookups met
		// the refused broker and asked it again once it was back.
		expect({
			stopReason: last.stopReason,
			errorMessage: last.errorMessage,
			retryAttempts: retryStarts.map(event => event.attempt),
			lookupsMetRefusedBroker: refusedRefreshes > 0,
			lookupsAskedBrokerAgain: refreshesAfterOutage > 0,
		}).toEqual({
			stopReason: "stop",
			errorMessage: undefined,
			// Two failed lookups, two backoff retries, then the broker answered.
			retryAttempts: [1, 2],
			lookupsMetRefusedBroker: true,
			lookupsAskedBrokerAgain: true,
		});
		expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
		expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
		// One request after the tool, with the token the broker minted; the tool did not run again.
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[1]?.options?.apiKey).toBe("access-from-broker");
		expect(probeRuns).toEqual(["x"]);
	}, 30_000);

	it("a sync task subagent whose key cannot be resolved returns its failed result to the parent at once", async () => {
		const { parent, parentModel, workerModel } = await openParentWithKeyedWorker({ async: false });

		await parent.prompt("Delegate reading the notes.");
		await parent.waitForIdle();

		// The worker's first request went out; after its login went away, none did.
		expect(turnsOffering(workerModel, "read")).toHaveLength(1);
		const worker = taskDetails(parent.agent.state.messages)?.results[0];
		expect(worker?.exitCode).toBe(1);
		expect(worker?.error).toContain("No API key for provider: anthropic");
		// The parent's next request carries the failed result.
		const next = parentModel.calls.find(call => toolResultText(call.context.messages, "task") !== undefined);
		const carried = next ? toolResultText(next.context.messages, "task") : undefined;
		expect(carried).toContain('status="failed (exit 1)"');
		expect(carried).toContain("No API key for provider: anthropic");
	}, 30_000);

	it("an async task subagent whose key cannot be resolved hands its failed result to the parent's wait at once", async () => {
		const { parent, parentModel, workerModel } = await openParentWithKeyedWorker({ async: true });

		await parent.prompt("Delegate reading the notes, then wait for the result.");
		await parent.waitForIdle();

		expect(turnsOffering(workerModel, "read")).toHaveLength(1);
		// The parent's request after its wait carries the failed job's result.
		const next = parentModel.calls.find(call => toolResultText(call.context.messages, "wait") !== undefined);
		const waited = next ? toolResultText(next.context.messages, "wait") : undefined;
		expect(waited).toMatch(/\[task\] — failed/);
		expect(waited).toContain('status="failed (exit 1)"');
		expect(waited).toContain("No API key for provider: anthropic");
		// The wait ended on the job, not on its window.
		expect(waited).not.toContain("No job finished");
	}, 30_000);

	/** Ways the user ends a provider's credentials; each must end a turn at once, never retry it. */
	const USER_REMOVALS: Record<string, (authStorage: AuthStorage) => Promise<void>> = {
		"removed the credential": authStorage => authStorage.credentials.remove("anthropic"),
		"logged out on the auth broker": async authStorage => {
			for (const account of authStorage.oauth.accounts("anthropic")) {
				await authStorage.credentials.disable(account.credentialId, LOGGED_OUT_BY_USER);
			}
		},
		"removed it after a failure disabled it": async authStorage => {
			await disableLoginsAfterFailedRefresh(authStorage);
			await authStorage.credentials.remove("anthropic");
		},
	};

	for (const [removal, remove] of Object.entries(USER_REMOVALS)) {
		it(`ends the turn at once, and refuses the next prompt, when the user ${removal}`, async () => {
			// If this regresses, the turn waits out the retry budget for a key the user removed, or the next
			// prompt starts another such turn.
			const ctx = await setUp();
			const keys: KeyOutage = { start: () => remove(ctx.authStorage), end: async () => {} };
			const { session, mock, retryStarts } = await openSession(ctx, {
				maxRetries: 5,
				sessionManager: SessionManager.create(root.path(), root.join("sessions")),
				outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
			});
			mockSchedulerWaitWithClock();

			await session.prompt("run the probe");
			await session.waitForIdle();

			const failed = lastAssistant(session);
			expect(failed.stopReason).toBe("error");
			expect(failed.errorMessage).toContain("No API key for provider: anthropic");
			expect(failed.credentialUnavailable).toBeUndefined();
			expect(retryStarts).toEqual([]);
			expect(mock.calls).toHaveLength(1);
			// The refused prompt goes back to the user.
			const dropped: string[] = [];
			session.setPromptDropped(prompt => dropped.push(prompt.text));
			await expect(session.prompt("again")).rejects.toThrow("No API key found for anthropic");
			expect(dropped).toEqual(["again"]);
		});
	}

	it("ends the wait for a failure-disabled login once another login of the provider is removed", async () => {
		// If this regresses, a provider the user has since removed a login of keeps a turn waiting for a key.
		// A tombstone does not say which account it held, so any later removal of the provider ends the wait.
		const ctx = await setUp();
		const { authStorage } = ctx;
		await authStorage.credentials.set("anthropic", [oauthLogin("acc-a"), oauthLogin("acc-b")]);
		const [a, b] = authStorage.oauth.accounts("anthropic");
		await authStorage.credentials.disable(a!.credentialId, LOGIN_DISABLED_CAUSE);
		// B is still stored, so a missing key may come back.
		expect(await ctx.modelRegistry.missingKeyMayRecover("anthropic")).toBe(true);
		await authStorage.credentials.removeById("anthropic", b!.credentialId);
		expect(await ctx.modelRegistry.missingKeyMayRecover("anthropic")).toBe(false);
		const { session, mock } = await openSession(ctx, { maxRetries: 1, sessionManager: SessionManager.inMemory() });

		await expect(session.prompt("run the probe")).rejects.toThrow("No API key found for anthropic");
		expect(mock.calls).toHaveLength(0);
	});

	it("keeps a stored GitHub Copilot credential whose lookup yields nothing, so the retry can use it", async () => {
		// If this regresses, the failed lookup reads as a rejected token and the stored credential is removed.
		const ctx = await setUp();
		const { authStorage } = ctx;
		await authStorage.credentials.set("github-copilot", [{ type: "api_key", key: "ghu_test_token" }]);
		let readable = true;
		const readKey = authStorage.keys.getWithCredential.bind(authStorage.keys);
		vi.spyOn(authStorage.keys, "getWithCredential").mockImplementation(async (provider, sessionId, options) =>
			readable ? readKey(provider, sessionId, options) : undefined,
		);
		const keys: KeyOutage = {
			start: async () => {
				readable = false;
			},
			end: async () => {
				readable = true;
			},
		};
		const { session, mock, retryStarts } = await openSession(ctx, {
			maxRetries: 5,
			sessionManager: SessionManager.inMemory(),
			model: bundledModel(COPILOT_MODEL),
			outage: { keys, startOn: "probe", resolvesWhileDown: 2 },
		});
		mockSchedulerWaitWithClock();

		await session.prompt("run the probe");
		await session.waitForIdle();

		const last = lastAssistant(session);
		expect({ stopReason: last.stopReason, errorMessage: last.errorMessage }).toEqual({
			stopReason: "stop",
			errorMessage: undefined,
		});
		expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
		expect(mock.calls).toHaveLength(2);
		expect(authStorage.credentials.has("github-copilot")).toBe(true);
	});

	it("a thrown error that is no CredentialUnavailableError leaves an unmarked turn", async () => {
		// If this regresses, a turn that failed for good reads as one whose key could not be resolved.
		// The text names a missing key, but the error is no CredentialUnavailableError: only that class marks a turn.
		const failed = await storedFailedTurn(() => {
			throw new Error("No API key for provider: anthropic");
		});
		expect({ stopReason: failed.stopReason, credentialUnavailable: failed.credentialUnavailable }).toEqual({
			stopReason: "error",
			credentialUnavailable: undefined,
		});
	});

	it("a streamed provider error with status 529 leaves an unmarked turn", async () => {
		// If this regresses, a turn the provider answered reads as one whose key could not be resolved.
		const failed = await storedFailedTurn(model => {
			const stream = new AssistantMessageEventStream();
			const overloaded: AssistantMessage = {
				...createAssistantMessage(""),
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "error",
				errorMessage: "529 overloaded_error: Overloaded",
				errorStatus: 529,
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: overloaded });
				stream.push({ type: "error", reason: "error", error: overloaded });
			});
			return stream;
		});
		expect(failed.errorStatus).toBe(529);
		expect({ stopReason: failed.stopReason, credentialUnavailable: failed.credentialUnavailable }).toEqual({
			stopReason: "error",
			credentialUnavailable: undefined,
		});
	});

	it("leaves a pooled session's missing key final, as before", async () => {
		// If this regresses, a pooled session waits for an OAuth key the pool never serves, or for one it
		// may never send past a configured apiKey. Retrying a pool is not part of this change.
		const ctx = await setUp();
		const model = bundledModel(ANTHROPIC_MODEL);
		ctx.authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, [
			resolveCredentialIdentityKey("anthropic", oauthLogin("acc-live"))!,
		]);
		await disableLoginsAfterFailedRefresh(ctx.authStorage);
		const disabled = await resolveApiKeyOnce(ctx.modelRegistry.turnResolver(model, PROVIDER_SESSION_ID)).catch(
			(failure: unknown) => failure,
		);
		expect(disabled).toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(disabled))).toBe(false);

		await ctx.authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
		ctx.authStorage.keys.setConfig("anthropic", "config-key");
		const configured = await resolveApiKeyOnce(ctx.modelRegistry.turnResolver(model, PROVIDER_SESSION_ID)).catch(
			(failure: unknown) => failure,
		);
		expect(configured).toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(configured))).toBe(false);
	});
	describe("cleanup hook: the worker daemon does not outlive the test's TempDir removal", () => {
		it("shuts down the daemon before root.removeSync, so no daemon files remain", async () => {
			const { parent } = await openParentWithKeyedWorker({ async: true });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await parent.prompt("Delegate reading the notes.");
			await parent.waitForIdle();
			const probe = await probeDaemon();
			expect(probe).toBeDefined();
			const daemonPid = probe!.welcome.daemon.pid;
			probe!.close();
			expect(isPidAlive(daemonPid)).toBe(true);
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
			await AgentLifecycleManager.global().dispose();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			unregisterCustomApis(MOCK_API_SOURCE);
			vi.restoreAllMocks();
			for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
			__resetDirsFromEnvForTests();
			AgentStorage.close();
			closeModelCache();
			expect(isPidAlive(daemonPid)).toBe(false);
			root.removeSync();
			await expect(fs.access(root.path())).rejects.toThrow();
		}, 60_000);
	});
});
