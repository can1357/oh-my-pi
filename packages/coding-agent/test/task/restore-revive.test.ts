/**
 * `omp --restore` end to end for a subagent: a transcript a crash cut off mid tool
 * call is revived from disk, its cut-off call runs again, the agent answers, and the
 * parent receives the answer as the subagent's job.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { localSession } from "../helpers/local-session";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Restored";
const MOCK_API_SOURCE = "test/restore-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

const SPAWN_MODEL = "mock-model";
const HANDOFF_MODEL = "mock-handoff";

/** The mock carries no effort ladder; without one every configured effort clamps away. */
const thinking = { mode: "effort", efforts: [Effort.Medium, Effort.High] } as const;

/**
 * Writes a main session whose subagent died inside its `read` call (no tool result, no
 * exit record), restores the session, and returns the answer the parent received with
 * the `read` results and efforts each model saw when the cut-off call ran again.
 * `handoff` records a prewalk handoff to `high` effort before the cut-off call;
 * `fallback` follows that handoff with a retry fallback hop back to the spawn model.
 */
async function restoreInterruptedChild(
	options: {
		transcript?: "handoff" | "fallback";
		structured?: boolean;
		beforeRestoredResponse?: () => Promise<void>;
		onParentInput?: (messages: string) => void;
		afterDelivery?: (parent: AgentSession) => Promise<void>;
	} = {},
) {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const notes = path.join(cwd, "notes.txt");
	await Bun.write(notes, "the answer is 42\n");

	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
	main.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Waiting for the child." }],
		api: "mock",
		provider: "mock",
		model: SPAWN_MODEL,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	await main.close();
	const child = await SessionManager.open(
		path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`),
		undefined,
		undefined,
		{
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		},
	);
	child.appendSessionInit({
		systemPrompt: ["test"],
		task: "report what notes.txt says",
		tools: options.structured ? ["read", "yield"] : ["read"],
		agent: "task",
		resolvedModel: `mock/${SPAWN_MODEL}`,
	});
	child.appendMessage({ role: "user", content: "report what notes.txt says", timestamp: Date.now() });
	if (options.transcript) {
		child.appendModelChange(`mock/${HANDOFF_MODEL}`, "prewalk");
		child.appendThinkingLevelChange(Effort.High, Effort.High);
	}
	if (options.transcript === "fallback") child.appendModelChange(`mock/${SPAWN_MODEL}`, "fallback");
	const servingModel = options.transcript === "handoff" ? HANDOFF_MODEL : SPAWN_MODEL;
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: notes } }],
		api: "mock",
		provider: "mock",
		model: servingModel,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await child.close();

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const readResults: Record<string, string[]> = { [SPAWN_MODEL]: [], [HANDOFF_MODEL]: [] };
	const readEfforts: Record<string, (string | undefined)[]> = { [SPAWN_MODEL]: [], [HANDOFF_MODEL]: [] };
	const mocks = [SPAWN_MODEL, HANDOFF_MODEL].map(id =>
		Object.assign(
			createMockModel({
				id,
				reasoning: true,
				handler: async (context, streamOptions) => {
					const last = context.messages.at(-1);
					if (last?.role !== "toolResult" || last.toolName !== "read") {
						const input = JSON.stringify(last);
						if (input.includes("INDEPENDENT_WAKE"))
							return options.structured
								? {
										content: [
											{
												type: "toolCall",
												name: "yield",
												arguments: { type: "result", data: "INDEPENDENT_REPLY" },
											},
										],
									}
								: { content: ["INDEPENDENT_REPLY"] };
						if (input.includes("OWNED_RESULT"))
							return options.structured
								? {
										content: [
											{
												type: "toolCall",
												name: "yield",
												arguments: { type: "result", data: `restored: 42 (${id})` },
											},
										],
									}
								: { content: [`restored: 42 (${id})`] };
						return { content: ["label"] };
					}
					readResults[id]!.push(JSON.stringify(last.content));
					readEfforts[id]!.push(streamOptions?.reasoning);
					await options.beforeRestoredResponse?.();
					return options.structured
						? {
								content: [
									{
										type: "toolCall",
										name: "yield",
										arguments: { type: "result", data: `restored: 42 (${id})` },
									},
								],
							}
						: { content: [`restored: 42 (${id})`] };
				},
			}),
			{ thinking },
		),
	);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: `mock/${SPAWN_MODEL}` },
		defaultThinkingLevel: Effort.Medium,
	});
	const parentManager = await SessionManager.open(mainFile);
	const parentMock = createMockModel({
		handler: context => {
			options.onParentInput?.(JSON.stringify(context.messages));
			return { content: ["parent observed result"] };
		},
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: parentMock.model,
				systemPrompt: ["test"],
				tools: [],
				messages: parentManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: parentMock.stream,
		}),
		sessionManager: parentManager,
		asyncJobManager: manager,
		agentId: MAIN_AGENT_ID,
		settings,
		modelRegistry,
	});
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);

	try {
		const outcome = await restoreSession(session);
		expect(outcome.subagents).toEqual([AGENT_ID]);
		await manager.waitForOwnerJobs(MAIN_AGENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
		await session.waitForIdle();
		await options.afterDelivery?.(session);
		return { delivered: JSON.stringify(session.agent.state.messages), readResults, readEfforts };
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

it("delivers a restored driven child once without an autonomous duplicate", async () => {
	const providerEntered = Promise.withResolvers<void>();
	const releaseProvider = Promise.withResolvers<void>();
	const jobEntered = Promise.withResolvers<void>();
	const releaseJob = Promise.withResolvers<void>();
	const firstYield = Promise.withResolvers<void>();
	const independentDelivery = Promise.withResolvers<void>();
	let unsubscribeYield: (() => void) | undefined;
	const registered: string[] = [];
	const register = manager.register.bind(manager);
	vi.spyOn(manager, "register").mockImplementation((...args) => {
		const id = register(...args);
		registered.push(id);
		return id;
	});
	let run: Promise<unknown> | undefined;
	try {
		run = restoreInterruptedChild({
			structured: true,
			onParentInput: messages => {
				if (messages.includes("INDEPENDENT_REPLY")) independentDelivery.resolve();
			},
			beforeRestoredResponse: async () => {
				manager.register(
					"bash",
					"owned work",
					async () => {
						jobEntered.resolve();
						await releaseJob.promise;
						return "OWNED_RESULT";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
				providerEntered.resolve();
				await releaseProvider.promise;
			},
			afterDelivery: async parent => {
				const restoredJobs = manager.getAllJobs({ ownerId: MAIN_AGENT_ID }).filter(job => job.agentId === AGENT_ID);
				expect(restoredJobs).toHaveLength(1);
				const jobId = restoredJobs[0]!.id;
				expect(registered.filter(id => id === jobId)).toHaveLength(1);
				const resultMessages = parent.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === "async-result",
				);
				const restoredOccurrences = resultMessages.flatMap(message => {
					if (message.role !== "custom" || !message.details || typeof message.details !== "object") return [];
					const jobs = Reflect.get(message.details, "jobs");
					return Array.isArray(jobs)
						? jobs.filter(job => job && typeof job === "object" && Reflect.get(job, "jobId") === jobId)
						: [];
				});
				expect(restoredOccurrences).toHaveLength(1);
				expect(JSON.stringify(resultMessages)).toContain(`restored: 42 (${SPAWN_MODEL})`);
				const mainFile = parent.sessionManager.getSessionFile();
				if (!mainFile) throw new Error("Expected parent session file");
				expect(await Bun.file(path.join(mainFile.slice(0, -6), `${AGENT_ID}.md`)).text()).toContain(
					`restored: 42 (${SPAWN_MODEL})`,
				);
				const handle = AgentRegistry.global().get(AGENT_ID)?.session;
				if (!handle) throw new Error("Expected restored child session");
				const child = localSession(handle);
				await child.prompt("INDEPENDENT_WAKE");
				await independentDelivery.promise;
				await child.waitForIrcReplies();
				await manager.waitForOwnerJobs(MAIN_AGENT_ID);
				await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
				await parent.waitForIdle();
				const independent = parent.agent.state.messages.filter(
					message =>
						message.role === "custom" &&
						message.customType === "async-result" &&
						JSON.stringify(message).includes("INDEPENDENT_REPLY"),
				);
				expect(independent).toHaveLength(1);
			},
		});
		await providerEntered.promise;
		const handle = AgentRegistry.global().get(AGENT_ID)?.session;
		if (!handle) throw new Error("Expected restored child session");
		unsubscribeYield = localSession(handle).subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) firstYield.resolve();
		});
		await jobEntered.promise;
		releaseProvider.resolve();
		await firstYield.promise;
		releaseJob.resolve();
		await run;
	} finally {
		unsubscribeYield?.();
		releaseProvider.resolve();
		releaseJob.resolve();
		if (run) await Promise.allSettled([run]);
	}
}, 20_000);

it("revives a subagent a crash cut off mid tool call, runs the call again, and delivers its answer to the parent", async () => {
	const { delivered, readResults } = await restoreInterruptedChild();

	expect(delivered).toContain(`restored: 42 (${SPAWN_MODEL})`);
	expect(readResults[SPAWN_MODEL]).toHaveLength(1);
	expect(readResults[SPAWN_MODEL]![0]).toContain("the answer is 42");
}, 20_000);

it("revives a subagent on the model and effort a prewalk handoff switched it to, not its spawn model", async () => {
	const { delivered, readResults, readEfforts } = await restoreInterruptedChild({ transcript: "handoff" });

	expect(delivered).toContain(`restored: 42 (${HANDOFF_MODEL})`);
	expect(readResults[HANDOFF_MODEL]).toHaveLength(1);
	expect(readResults[SPAWN_MODEL]).toEqual([]);
	expect(readEfforts[HANDOFF_MODEL]).toEqual([Effort.High]);
}, 20_000);

it("revives a subagent whose handoff target failed over on the spawn model, not the failed target", async () => {
	const { delivered, readResults } = await restoreInterruptedChild({ transcript: "fallback" });

	expect(delivered).toContain(`restored: 42 (${SPAWN_MODEL})`);
	expect(readResults[SPAWN_MODEL]).toHaveLength(1);
	expect(readResults[HANDOFF_MODEL]).toEqual([]);
}, 20_000);
