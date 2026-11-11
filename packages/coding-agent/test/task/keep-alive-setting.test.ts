import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockHandler, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	HistoryProtocolHandler,
	InternalUrlRouter,
	sessionResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resolveMarkdownLinkHrefs } from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import {
	artifactsDirsFromRegistry,
	registerArtifactsDir,
	registerRetainedSessionArtifactCleanup,
	releaseRetainedSessionArtifacts,
	resetRegisteredArtifactDirsForTests,
	retainTemporaryLeaseForSession,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { cfgTaskKeepAlive } from "@oh-my-pi/pi-coding-agent/task/settings";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MOCK_API_SOURCE = "test/keep-alive-setting";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
const managers: AsyncJobManager[] = [];
const inMemorySessionIds: string[] = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-keep-alive-setting-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 1_000 });
	}
	for (const sessionId of inMemorySessionIds.splice(0)) {
		await releaseRetainedSessionArtifacts(sessionId);
	}
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

interface HarnessOptions {
	inMemory?: boolean;
	restrictToolNames?: boolean;
	handler?: MockHandler;
	onModelCall?: (settings: Settings) => void;
}

interface Harness {
	cwd: string;
	modelId: string;
	session: ToolSession;
	manager: AsyncJobManager;
	releaseMock: () => void;
	close: () => void;
}

async function writeSpillTarget(cwd: string, marker: string): Promise<void> {
	const lines = Array.from({ length: 40 }, (_, idx) => `${marker}-line-${idx + 1}-${"z".repeat(60)}`);
	await Bun.write(path.join(cwd, "spill-target.txt"), `${lines.join("\n")}\n`);
}

async function createTaskHarness(
	settingsOverrides: Record<string, unknown>,
	answerText: string,
	options: HarnessOptions = {},
): Promise<Harness> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const inMemoryManager = options.inMemory ? SessionManager.inMemory(cwd) : undefined;
	if (inMemoryManager) inMemorySessionIds.push(inMemoryManager.getSessionId());
	const parentSessionFile = inMemoryManager ? null : path.join(root, "sessions", "parent.jsonl");
	if (parentSessionFile) {
		await Bun.write(parentSessionFile, "");
	}

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler:
			options.handler ??
			(context => {
				options.onModelCall?.(settings);
				return (context.tools ?? []).some(tool => tool.name === "yield")
					? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: answerText } }] }
					: { content: [answerText] };
			}),
	});
	const modelSpec = `mock/${mock.id}`;
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const findOrig = modelRegistry.find.bind(modelRegistry);
	const findSpy = vi
		.spyOn(modelRegistry, "find")
		.mockImplementation((provider, id) =>
			provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
		);

	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	const settings = Settings.isolated({
		"task.batch": false,
		"task.agentIdleTtlMs": 0,
		"task.workerThreads": 0,
		"async.enabled": true,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: modelSpec },
		...settingsOverrides,
	});
	const session = {
		cwd,
		hasUI: false,
		authStorage,
		modelRegistry,
		settings,
		asyncJobManager: manager,
		restrictToolNames: options.restrictToolNames ?? true,
		enableLsp: false,
		enableMCP: false,
		enableIrc: true,
		sessionManager: inMemoryManager,
		getSessionId: () => (inMemoryManager ? inMemoryManager.getSessionId() : "file-parent-session"),
		getSessionFile: () => (inMemoryManager ? (inMemoryManager.getSessionFile() ?? null) : parentSessionFile),
		getArtifactsDir: () =>
			inMemoryManager ? inMemoryManager.getArtifactsDir() : parentSessionFile!.slice(0, -".jsonl".length),
		getSessionSpawns: () => "*",
		getActiveModel: () => mock,
		getActiveModelString: () => modelSpec,
		getModelString: () => modelSpec,
	} as unknown as ToolSession;

	return {
		cwd,
		modelId: modelSpec,
		session,
		manager,
		releaseMock: () => {
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
		},
		close: () => authStorage.close(),
	};
}

describe("task.keepAlive setting", () => {
	it("disposes finished task subagents on completion when false and points only at history:// while keeping history:// and agent:// readable", async () => {
		const agentId = "EphemeralWorker";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness({ "task.keepAlive": false }, "ephemeral-answer-42", {
			onModelCall: settings => {
				cfgTaskKeepAlive.override(settings, true);
			},
		});
		try {
			const tool = await TaskTool.create(harness.session);
			const started = await tool.execute("tc-ephemeral", {
				agent: "task",
				name: agentId,
				task: "Compute the answer.",
			} as TaskParams);
			const job = harness.manager.getJob(started.details?.async?.jobId ?? "");
			expect(job).toBeDefined();
			await job!.promise;

			expect(job!.status).toBe("completed");
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(AgentRegistry.global().get(agentId)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(agentId)).toBe(false);
			expect(job!.resultText).toContain("ephemeral-answer-42");
			expect(job!.resultText).toContain(`history://${agentId}`);
			expect(job!.resultText).not.toContain(`agent://${agentId}`);

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			router.register(new AgentProtocolHandler());
			const resolveContext = sessionResolveContext(harness.session);
			const transcript = await router.resolve(`history://${agentId}`, resolveContext);
			expect(transcript.content).toContain("ephemeral-answer-42");
			const artifact = await router.resolve(`agent://${agentId}`, resolveContext);
			expect(artifact.content).toContain("ephemeral-answer-42");
		} finally {
			harness.releaseMock();
			harness.close();
		}
	});

	it("retains finished task subagents as idle and advertises both agent:// and history:// by default", async () => {
		const agentId = "RetainedWorker";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness({}, "retained-answer-7");
		try {
			const tool = await TaskTool.create(harness.session);
			const started = await tool.execute("tc-retained", {
				agent: "task",
				name: agentId,
				task: "Compute the retained answer.",
			} as TaskParams);
			const job = harness.manager.getJob(started.details?.async?.jobId ?? "");
			expect(job).toBeDefined();
			await job!.promise;

			expect(job!.status).toBe("completed");
			expect(disposeSpy).not.toHaveBeenCalled();
			const ref = AgentRegistry.global().get(agentId);
			expect(ref?.status).toBe("idle");
			expect(ref?.session).not.toBeNull();
			expect(AgentLifecycleManager.global().has(agentId)).toBe(true);
			expect(job!.resultText).toContain("retained-answer-7");
			expect(job!.resultText).toContain(`agent://${agentId}`);
			expect(job!.resultText).toContain(`history://${agentId}`);
		} finally {
			harness.releaseMock();
			harness.close();
		}
	});

	it("lets an explicit keepAlive: true request override task.keepAlive: false", async () => {
		const agentId = "ExplicitKeepAlive";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness({ "task.keepAlive": false }, "explicit-keepalive");
		try {
			const settled = await runStructuredSubagent({
				session: harness.session,
				invocationKind: "eval",
				assignment: "Stay alive for follow-up.",
				agent: "task",
				structured: false,
				identity: { id: agentId },
				keepAlive: true,
			});

			expect(settled.result.exitCode).toBe(0);
			expect(disposeSpy).not.toHaveBeenCalled();
			expect(AgentRegistry.global().get(agentId)?.status).toBe("idle");
			expect(AgentLifecycleManager.global().has(agentId)).toBe(true);
		} finally {
			harness.releaseMock();
			harness.close();
		}
	});

	it("preserves retained temporary seance transcripts on disk when task.keepAlive is false in an in-memory parent", async () => {
		const agentId = "EphemeralSeance";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness({ "task.keepAlive": false }, "seance-recalled-fact", { inMemory: true });
		const sourceFile = path.join(root, "saved-sessions", "source.jsonl");
		await Bun.write(
			sourceFile,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "saved-host-session",
					timestamp: "2026-10-01T00:00:00.000Z",
					cwd: harness.cwd,
				},
				{
					type: "model_change",
					id: "saved-model",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					model: harness.modelId,
					role: "default",
				},
				{
					type: "message",
					id: "saved-msg",
					parentId: "saved-model",
					timestamp: "2026-10-01T00:00:02.000Z",
					message: { role: "user", content: "Earlier context to recall.", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		let retainedCleanup: (() => Promise<void>) | undefined;
		let artifactsDir: string | undefined;
		try {
			const settled = await runStructuredSubagent({
				session: harness.session,
				invocationKind: "task",
				assignment: "Recall what happened in the saved session.",
				agent: "seance",
				sourceSession: sourceFile,
				model: harness.modelId,
				structured: false,
				identity: { id: agentId },
				onArtifactsRetained: cleanup => {
					retainedCleanup = cleanup;
				},
			});
			artifactsDir = settled.artifactsDir;

			expect(settled.result.exitCode).toBe(0);
			expect(settled.temporaryArtifacts).toBe(true);
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(AgentRegistry.global().get(agentId)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(agentId)).toBe(false);

			const childTranscriptPath = path.join(settled.artifactsDir, `${agentId}.jsonl`);
			expect(await Bun.file(childTranscriptPath).text()).toContain("seance-recalled-fact");

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			const transcript = await router.resolve(`history://${agentId}`, sessionResolveContext(harness.session));
			expect(transcript.content).toContain("seance-recalled-fact");
		} finally {
			if (retainedCleanup) {
				await retainedCleanup();
			} else if (artifactsDir) {
				await fs.rm(artifactsDir, { recursive: true, force: true });
			}
			harness.releaseMock();
			harness.close();
		}
	});

	it("retains temporary history:// and agent:// transcripts for inline synchronous TaskTool runs when task.keepAlive is false in an in-memory parent", async () => {
		const agentId = "InlineEphemeralWorker";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const longAnswer = [
			"inline-ephemeral-answer-99",
			...Array.from(
				{ length: 260 },
				(_, idx) => `finding-${idx}: verified checkpoint ${idx * 17 + 3} across module-${idx % 19}`,
			),
		].join("\n");
		const harness = await createTaskHarness({ "async.enabled": false, "task.keepAlive": false }, longAnswer, {
			inMemory: true,
		});
		let tempArtifactsDir: string | undefined;
		try {
			const tool = await TaskTool.create(harness.session);
			const completed = await tool.execute("tc-inline-ephemeral", {
				agent: "task",
				name: agentId,
				task: "Compute the inline answer.",
			} as TaskParams);
			const outputPath = completed.details?.outputPaths?.[0];
			if (outputPath) tempArtifactsDir = path.dirname(outputPath);

			const textPart = completed.content.find(part => part.type === "text");
			const resultText = textPart?.type === "text" ? textPart.text : "";
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(AgentRegistry.global().get(agentId)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(agentId)).toBe(false);
			expect(resultText).toContain("inline-ephemeral-answer-99");
			expect(resultText).toContain(`full-output="agent://${agentId}"`);
			expect(resultText).not.toContain(`write agent://${agentId}`);

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			router.register(new AgentProtocolHandler());
			const resolveContext = sessionResolveContext(harness.session);
			const transcript = await router.resolve(`history://${agentId}`, resolveContext);
			expect(transcript.content).toContain("inline-ephemeral-answer-99");
			const artifact = await router.resolve(`agent://${agentId}`, resolveContext);
			expect(artifact.content).toContain("inline-ephemeral-answer-99");
		} finally {
			if (tempArtifactsDir) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}
			harness.releaseMock();
			harness.close();
		}
	});

	it("preserves nested agent:// and history:// resolution after ephemeral parent and child dispose in an in-memory root session", async () => {
		const parentId = "Parent";
		const nestedId = "Parent.Child";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness(
			{ "task.keepAlive": false, "task.maxRecursionDepth": 2 },
			"unused-default",
			{
				inMemory: true,
				restrictToolNames: false,
				handler: context => {
					const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
					const userText = context.messages
						.filter(msg => msg.role === "user")
						.map(msg =>
							typeof msg.content === "string"
								? msg.content
								: msg.content
										.filter(part => part.type === "text")
										.map(part => part.text)
										.join("\n"),
						)
						.join("\n");
					if (userText.includes("Compute nested child report.")) {
						return hasYield
							? {
									content: [
										{
											type: "toolCall",
											name: "yield",
											arguments: { type: "result", data: "nested-child-output-77" },
										},
									],
								}
							: { content: ["nested-child-output-77"] };
					}
					const sawTaskResult = context.messages.some(msg => msg.role === "toolResult" && msg.toolName === "task");
					if (!sawTaskResult) {
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										agent: "task",
										name: "Child",
										task: "Compute nested child report.",
									},
								},
							],
						};
					}
					return hasYield
						? {
								content: [
									{
										type: "toolCall",
										name: "yield",
										arguments: { type: "result", data: "parent-summary-of-child-77" },
									},
								],
							}
						: { content: ["parent-summary-of-child-77"] };
				},
			},
		);
		try {
			const tool = await TaskTool.create(harness.session);
			const started = await tool.execute("tc-nested-ephemeral", {
				agent: "task",
				name: parentId,
				task: "Delegate to Child and summarize.",
			} as TaskParams);
			const job = harness.manager.getJob(started.details?.async?.jobId ?? "");
			expect(job).toBeDefined();
			await job!.promise;

			expect(job!.status).toBe("completed");
			expect(disposeSpy).toHaveBeenCalledTimes(2);
			expect(AgentRegistry.global().get(parentId)).toBeUndefined();
			expect(AgentRegistry.global().get(nestedId)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(parentId)).toBe(false);
			expect(AgentLifecycleManager.global().has(nestedId)).toBe(false);

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			router.register(new AgentProtocolHandler());
			const resolveContext = sessionResolveContext(harness.session);

			const nestedArtifact = await router.resolve(`agent://${nestedId}`, resolveContext);
			expect(nestedArtifact.content).toContain("nested-child-output-77");
			const nestedTarget = await router.target(`agent://${nestedId}`, resolveContext);
			expect(nestedTarget?.kind).toBe("file");

			const nestedTranscript = await router.resolve(`history://${nestedId}`, resolveContext);
			expect(nestedTranscript.content).toContain("nested-child-output-77");

			expect(artifactsDirsFromRegistry()).toHaveLength(1);
			const [outerArtifactsDir] = artifactsDirsFromRegistry();
			const originalCleanup = job!.retainedArtifactsCleanup;
			expect(originalCleanup).toBeDefined();
			const cleanupSettled = Promise.withResolvers<void>();
			job!.retainedArtifactsCleanup = async () => {
				try {
					await originalCleanup!();
				} finally {
					cleanupSettled.resolve();
				}
			};

			await harness.manager.dispose({ timeoutMs: 1_000 });
			await cleanupSettled.promise;
			expect(artifactsDirsFromRegistry()).toEqual([]);
			expect(await Bun.file(path.join(outerArtifactsDir!, "Parent", "Parent.Child.md")).exists()).toBe(false);
		} finally {
			harness.releaseMock();
			harness.close();
		}
	});

	it("resolves nested outputs and transcripts for a task named __advisor bumped to __advisor-2 while excluding advisor transcripts", async () => {
		const allocatedParentId = "__advisor-2";
		const nestedId = `${allocatedParentId}.Child`;
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness(
			{ "task.keepAlive": false, "task.maxRecursionDepth": 2 },
			"unused-default",
			{
				inMemory: true,
				restrictToolNames: false,
				handler: context => {
					const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
					const userText = context.messages
						.filter(msg => msg.role === "user")
						.map(msg =>
							typeof msg.content === "string"
								? msg.content
								: msg.content
										.filter(part => part.type === "text")
										.map(part => part.text)
										.join("\n"),
						)
						.join("\n");
					if (userText.includes("Compute advisor-bumped child report.")) {
						return hasYield
							? {
									content: [
										{
											type: "toolCall",
											name: "yield",
											arguments: { type: "result", data: "advisor-bumped-child-output-88" },
										},
									],
								}
							: { content: ["advisor-bumped-child-output-88"] };
					}
					const sawTaskResult = context.messages.some(msg => msg.role === "toolResult" && msg.toolName === "task");
					if (!sawTaskResult) {
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										agent: "task",
										name: "Child",
										task: "Compute advisor-bumped child report.",
									},
								},
							],
						};
					}
					return hasYield
						? {
								content: [
									{
										type: "toolCall",
										name: "yield",
										arguments: { type: "result", data: "advisor-bumped-parent-summary-88" },
									},
								],
							}
						: { content: ["advisor-bumped-parent-summary-88"] };
				},
			},
		);
		try {
			const tool = await TaskTool.create(harness.session);
			const started = await tool.execute("tc-advisor-bumped", {
				agent: "task",
				name: "__advisor",
				task: "Delegate to Child from an __advisor-named task.",
			} as TaskParams);
			const job = harness.manager.getJob(started.details?.async?.jobId ?? "");
			expect(job).toBeDefined();
			await job!.promise;

			expect(job!.status).toBe("completed");
			expect(disposeSpy).toHaveBeenCalledTimes(2);
			expect(AgentRegistry.global().get(allocatedParentId)).toBeUndefined();
			expect(AgentRegistry.global().get(nestedId)).toBeUndefined();

			const [outerArtifactsDir] = artifactsDirsFromRegistry();
			expect(outerArtifactsDir).toBeDefined();
			await Bun.write(path.join(outerArtifactsDir!, "__advisor.jsonl"), "{}\n");
			await Bun.write(path.join(outerArtifactsDir!, "__advisor.audit.jsonl"), "{}\n");
			await Bun.write(path.join(outerArtifactsDir!, "__advisor", "Hidden.md"), "must-not-descend");

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			router.register(new AgentProtocolHandler());
			const resolveContext = sessionResolveContext(harness.session);

			const nestedArtifact = await router.resolve(`agent://${nestedId}`, resolveContext);
			expect(nestedArtifact.content).toContain("advisor-bumped-child-output-88");
			const nestedTranscript = await router.resolve(`history://${nestedId}`, resolveContext);
			expect(nestedTranscript.content).toContain("advisor-bumped-child-output-88");
			const parentTranscript = await router.resolve(`history://${allocatedParentId}`, resolveContext);
			expect(parentTranscript.content).toContain("advisor-bumped-parent-summary-88");

			await expect(router.resolve("agent://Hidden", resolveContext)).rejects.toThrow("Not found: Hidden");
			await expect(router.resolve("history://__advisor", resolveContext)).rejects.toThrow(
				"Unknown agent: __advisor",
			);
			await expect(router.resolve("history://__advisor.audit", resolveContext)).rejects.toThrow(
				"Unknown agent: __advisor.audit",
			);
			const index = await router.resolve("history://", resolveContext);
			expect(index.content).toContain(allocatedParentId);
			expect(index.content).not.toContain("| __advisor |");
			expect(index.content).not.toContain("__advisor.audit");
		} finally {
			harness.releaseMock();
			harness.close();
		}
	});

	it("scopes retained inline temporary artifacts per in-memory parent session when both allocate Worker", async () => {
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harnessOne = await createTaskHarness(
			{ "async.enabled": false, "task.keepAlive": false },
			"session-one-worker-alpha",
			{ inMemory: true },
		);
		const harnessTwo = await createTaskHarness(
			{ "async.enabled": false, "task.keepAlive": false },
			"session-two-worker-bravo",
			{
				inMemory: true,
				restrictToolNames: false,
				handler: context => {
					const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
					const userText = context.messages
						.filter(msg => msg.role === "user")
						.map(msg =>
							typeof msg.content === "string"
								? msg.content
								: msg.content
										.filter(part => part.type === "text")
										.map(part => part.text)
										.join("\n"),
						)
						.join("\n");
					if (userText.includes("Read sibling Worker output.")) {
						const readResults = context.messages.filter(
							msg => msg.role === "toolResult" && msg.toolName === "read",
						);
						if (readResults.length === 0) {
							return {
								content: [
									{ type: "toolCall", name: "read", arguments: { path: "agent://Worker" } },
									{ type: "toolCall", name: "read", arguments: { path: "history://Worker" } },
								],
							};
						}
						const combined = readResults
							.flatMap(msg =>
								typeof msg.content === "string"
									? [msg.content]
									: msg.content.flatMap(part =>
											part.type === "text" && "text" in part && typeof part.text === "string"
												? [part.text]
												: [],
										),
							)
							.join("\n---\n");
						return hasYield
							? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: combined } }] }
							: { content: [combined] };
					}
					return hasYield
						? {
								content: [
									{
										type: "toolCall",
										name: "yield",
										arguments: { type: "result", data: "session-two-worker-bravo" },
									},
								],
							}
						: { content: ["session-two-worker-bravo"] };
				},
			},
		);
		try {
			const toolOne = await TaskTool.create(harnessOne.session);
			const completedOne = await toolOne.execute("tc-session-one-worker", {
				agent: "task",
				name: "Worker",
				task: "Run Worker in first in-memory session.",
			} as TaskParams);
			const extraOne = await toolOne.execute("tc-session-one-only", {
				agent: "task",
				name: "OnlyInOne",
				task: "Run OnlyInOne in first in-memory session.",
			} as TaskParams);

			expect(completedOne.details?.results[0]?.id).toBe("Worker");
			expect(extraOne.details?.results[0]?.id).toBe("OnlyInOne");
			expect(AgentRegistry.global().get("Worker")).toBeUndefined();
			expect(AgentRegistry.global().get("OnlyInOne")).toBeUndefined();

			const toolTwo = await TaskTool.create(harnessTwo.session);
			const completedTwo = await toolTwo.execute("tc-session-two-worker", {
				agent: "task",
				name: "Worker",
				task: "Run Worker in second in-memory session.",
			} as TaskParams);

			expect(completedTwo.details?.results[0]?.id).toBe("Worker");
			expect(AgentRegistry.global().get("Worker")).toBeUndefined();
			expect(disposeSpy).toHaveBeenCalledTimes(3);

			const router = new InternalUrlRouter();
			router.register(new HistoryProtocolHandler());
			router.register(new AgentProtocolHandler());
			const contextOne = sessionResolveContext(harnessOne.session);
			const contextTwo = sessionResolveContext(harnessTwo.session);

			const agentOne = await router.resolve("agent://Worker", contextOne);
			expect(agentOne.content).toContain("session-one-worker-alpha");
			expect(agentOne.content).not.toContain("session-two-worker-bravo");

			const historyOne = await router.resolve("history://Worker", contextOne);
			expect(historyOne.content).toContain("session-one-worker-alpha");
			expect(historyOne.content).not.toContain("session-two-worker-bravo");

			const agentTwo = await router.resolve("agent://Worker", contextTwo);
			expect(agentTwo.content).toContain("session-two-worker-bravo");
			expect(agentTwo.content).not.toContain("session-one-worker-alpha");

			const historyTwo = await router.resolve("history://Worker", contextTwo);
			expect(historyTwo.content).toContain("session-two-worker-bravo");
			expect(historyTwo.content).not.toContain("session-one-worker-alpha");

			const siblingReader = await toolTwo.execute("tc-session-two-reader", {
				agent: "task",
				name: "Reader",
				task: "Read sibling Worker output.",
			} as TaskParams);
			const readerOutput = siblingReader.details?.results[0]?.output ?? "";
			expect(readerOutput).toContain("session-two-worker-bravo");
			expect(readerOutput).not.toContain("session-one-worker-alpha");

			await expect(router.resolve("agent://OnlyInOne", contextTwo)).rejects.toThrow("Not found: OnlyInOne");
			await expect(router.resolve("history://OnlyInOne", contextTwo)).rejects.toThrow("Unknown agent: OnlyInOne");

			const outputOnePath = completedOne.details?.outputPaths?.[0];
			const outputTwoPath = completedTwo.details?.outputPaths?.[0];
			expect(outputOnePath).toBeDefined();
			expect(outputTwoPath).toBeDefined();
			const transcriptOnePath = outputOnePath!.replace(/\.md$/, ".jsonl");
			const transcriptTwoPath = outputTwoPath!.replace(/\.md$/, ".jsonl");

			expect(await router.locate("agent://Worker", contextOne)).toBe(outputOnePath!);
			expect(await router.locate("agent://Worker", contextTwo)).toBe(outputTwoPath!);
			expect(await router.locate("history://Worker", contextOne)).toBe(transcriptOnePath);
			expect(await router.locate("history://Worker", contextTwo)).toBe(transcriptTwoPath);
			expect(await router.locate("agent://OnlyInOne", contextTwo)).toBeNull();
			expect(await router.locate("history://OnlyInOne", contextTwo)).toBeNull();

			const sessionOneId = harnessOne.session.sessionManager?.getSessionId?.();
			const sessionTwoId = harnessTwo.session.sessionManager?.getSessionId?.();
			expect(sessionOneId).toBeDefined();
			expect(sessionTwoId).toBeDefined();

			await releaseRetainedSessionArtifacts(sessionOneId!);
			expect(await Bun.file(outputOnePath!).exists()).toBe(false);
			expect(await Bun.file(outputTwoPath!).exists()).toBe(true);
			expect((await router.resolve("agent://Worker", contextTwo)).content).toContain("session-two-worker-bravo");

			await releaseRetainedSessionArtifacts(sessionTwoId!);
			expect(await Bun.file(outputTwoPath!).exists()).toBe(false);
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			harnessOne.releaseMock();
			harnessOne.close();
			harnessTwo.releaseMock();
			harnessTwo.close();
		}
	});

	it("preserves artifact:// lookup roots for disposed children's spill artifacts in an in-memory parent", async () => {
		const agentId = "SpillWorker";
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
		const harness = await createTaskHarness({ "task.keepAlive": false }, "unused-default", {
			inMemory: true,
			restrictToolNames: false,
			handler: context => {
				const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
				const bashResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "bash");
				if (bashResults.length === 0) {
					return {
						content: [
							{
								type: "toolCall",
								name: "bash",
								arguments: { command: "cat large-log.txt" },
							},
						],
					};
				}
				const bashText = bashResults
					.flatMap(msg =>
						typeof msg.content === "string"
							? [msg.content]
							: msg.content.flatMap(part =>
									part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
								),
					)
					.join("\n");
				const spillLink = bashText.match(/artifact:\/\/\d+/)?.[0] ?? "missing-artifact-link";
				const summary = `spilled-summary (${spillLink})`;
				return hasYield
					? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: summary } }] }
					: { content: [summary] };
			},
		});
		const otherSessionManager = SessionManager.inMemory(harness.cwd);
		inMemorySessionIds.push(otherSessionManager.getSessionId());
		try {
			const largeLines = [
				`spill-sentinel-alpha-1 ${"x".repeat(90)}`,
				...Array.from({ length: 1_500 }, (_, idx) => `spill-body-row-${idx + 2} ${"x".repeat(90)}`),
				`spill-sentinel-omega-1502 ${"x".repeat(90)}`,
			].join("\n");
			await Bun.write(path.join(harness.cwd, "large-log.txt"), `${largeLines}\n`);

			const tool = await TaskTool.create(harness.session);
			const started = await tool.execute("tc-spill-worker", {
				agent: "task",
				name: agentId,
				task: "Read the large log via bash and return the recovery link.",
			} as TaskParams);
			const job = harness.manager.getJob(started.details?.async?.jobId ?? "");
			expect(job).toBeDefined();
			await job!.promise;

			expect(job!.status).toBe("completed");
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(AgentRegistry.global().get(agentId)).toBeUndefined();
			expect(AgentLifecycleManager.global().has(agentId)).toBe(false);

			const artifactUrl = job!.resultText?.match(/artifact:\/\/\d+/)?.[0];
			expect(artifactUrl).toBe("artifact://0");

			const router = new InternalUrlRouter();
			router.register(new ArtifactProtocolHandler());
			const callerContext = sessionResolveContext(harness.session);
			const spilled = await router.resolve(artifactUrl!, callerContext);
			expect(spilled.content).toContain("spill-sentinel-alpha-1");
			expect(spilled.content).toContain("spill-sentinel-omega-1502");

			const foreignContext = {
				cwd: harness.cwd,
				settings: harness.session.settings,
				sessionId: otherSessionManager.getSessionId(),
			};
			await expect(router.resolve(artifactUrl!, foreignContext)).rejects.toThrow(
				"No session - artifacts unavailable",
			);

			const originalCleanup = job!.retainedArtifactsCleanup;
			expect(originalCleanup).toBeDefined();
			const cleanupSettled = Promise.withResolvers<void>();
			job!.retainedArtifactsCleanup = async () => {
				try {
					await originalCleanup!();
				} finally {
					cleanupSettled.resolve();
				}
			};

			await harness.manager.dispose({ timeoutMs: 1_000 });
			await cleanupSettled.promise;
			expect(artifactsDirsFromRegistry()).toEqual([]);
			await expect(router.resolve(artifactUrl!, callerContext)).rejects.toThrow(
				"No session - artifacts unavailable",
			);
		} finally {
			await otherSessionManager.close();
			harness.releaseMock();
			harness.close();
		}
	});

	it("cleans up retained temporary artifacts when an in-memory AgentSession disposes while an inline ephemeral task is still unwinding", async () => {
		const cwd = path.join(root, "home", "work-unwind");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const childEnteredModel = Promise.withResolvers<void>();
		const allowChildExit = Promise.withResolvers<void>();

		const mock = createMockModel({
			handler: async (context, options) => {
				const userText = context.messages
					.filter(msg => msg.role === "user")
					.map(msg =>
						typeof msg.content === "string"
							? msg.content
							: msg.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n"),
					)
					.join("\n");
				if (userText.includes("Run inline while parent disposes.")) {
					childEnteredModel.resolve();
					const abortSignal = Promise.withResolvers<void>();
					if (options?.signal?.aborted) {
						abortSignal.resolve();
					} else {
						options?.signal?.addEventListener("abort", () => abortSignal.resolve(), { once: true });
					}
					await Promise.race([allowChildExit.promise, abortSignal.promise]);
					return { content: ["unwinding-child-payload"] };
				}
				const sawTaskResult = context.messages.some(msg => msg.role === "toolResult" && msg.toolName === "task");
				if (!sawTaskResult) {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "task",
									name: "UnwindingWorker",
									task: "Run inline while parent disposes.",
								},
							},
						],
					};
				}
				return { content: ["parent-done"] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const tmpBefore = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("omp-task-")));
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});
		const { session: parentSession } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			sessionManager: SessionManager.inMemory(cwd),
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		const parentSessionId = parentSession.sessionId;

		try {
			const promptPromise = parentSession.prompt("Start inline worker then dispose mid-turn.");
			await childEnteredModel.promise;
			expect(artifactsDirsFromRegistry({ sessionId: parentSessionId }).length).toBeGreaterThan(0);

			const disposePromise = parentSession.dispose();
			allowChildExit.resolve();
			await Promise.allSettled([promptPromise, disposePromise]);

			expect(artifactsDirsFromRegistry()).toEqual([]);
			const tmpAfter = (await fs.readdir(os.tmpdir())).filter(
				name => name.startsWith("omp-task-") && !tmpBefore.has(name),
			);
			expect(tmpAfter).toEqual([]);

			let lateCleanupCalled = false;
			registerRetainedSessionArtifactCleanup(parentSessionId, async () => {
				lateCleanupCalled = true;
			});
			const unregisterLate = registerArtifactsDir(path.join(root, "late-dir"), { sessionId: parentSessionId });
			await releaseRetainedSessionArtifacts(parentSessionId);
			unregisterLate();
			expect(lateCleanupCalled).toBe(true);
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("transfers retained temporary artifact ownership and lookup roots across AgentSession.fork(entryId) in an in-memory session", async () => {
		const cwd = path.join(root, "home", "work-fork");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const mock = createMockModel({
			handler: context => {
				const userText = context.messages
					.filter(msg => msg.role === "user")
					.map(msg =>
						typeof msg.content === "string"
							? msg.content
							: msg.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n"),
					)
					.join("\n");
				if (userText.includes("Produce payload before in-memory fork.")) {
					return { content: ["fork-retained-worker-payload-314"] };
				}
				if (userText.includes("Read ForkWorker after fork.")) {
					const readResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "read");
					if (readResults.length === 0) {
						return {
							content: [
								{ type: "toolCall", name: "read", arguments: { path: "agent://ForkWorker" } },
								{ type: "toolCall", name: "read", arguments: { path: "history://ForkWorker" } },
							],
						};
					}
					const combined = readResults
						.flatMap(msg =>
							typeof msg.content === "string"
								? [msg.content]
								: msg.content.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									),
						)
						.join("\n---\n");
					return { content: [`post-fork-read:${combined}`] };
				}
				const sawTaskResult = context.messages.some(msg => msg.role === "toolResult" && msg.toolName === "task");
				if (!sawTaskResult) {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "task",
									name: "ForkWorker",
									task: "Produce payload before in-memory fork.",
								},
							},
						],
					};
				}
				return { content: ["pre-fork-turn-complete"] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});
		const { session: parentSession } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			sessionManager: SessionManager.inMemory(cwd),
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		const unrelatedManager = SessionManager.inMemory(cwd);

		try {
			await parentSession.prompt("Run ForkWorker before forking.");
			const preForkSessionId = parentSession.sessionId;
			expect(AgentRegistry.global().get("ForkWorker")).toBeUndefined();

			const entries = parentSession.sessionManager.getEntries();
			const lastMessageEntry = [...entries].reverse().find(entry => entry.type === "message");
			expect(lastMessageEntry).toBeDefined();

			const router = new InternalUrlRouter();
			router.register(new AgentProtocolHandler());
			router.register(new HistoryProtocolHandler());
			const preForkTarget = await router.target("agent://ForkWorker", {
				cwd,
				settings,
				sessionId: preForkSessionId,
			});
			expect(preForkTarget?.kind).toBe("file");
			const outputPath = preForkTarget?.kind === "file" ? preForkTarget.path : undefined;
			expect(outputPath).toBeDefined();
			expect(await Bun.file(outputPath!).exists()).toBe(true);

			expect(await parentSession.fork(lastMessageEntry!.id)).toBe(true);
			const forkedSessionId = parentSession.sessionId;
			expect(forkedSessionId).not.toBe(preForkSessionId);

			const forkedContext = { cwd, settings, sessionId: forkedSessionId };
			expect((await router.resolve("agent://ForkWorker", forkedContext)).content).toContain(
				"fork-retained-worker-payload-314",
			);
			expect((await router.resolve("history://ForkWorker", forkedContext)).content).toContain(
				"fork-retained-worker-payload-314",
			);

			const unrelatedContext = { cwd, settings, sessionId: unrelatedManager.getSessionId() };
			await expect(router.resolve("agent://ForkWorker", unrelatedContext)).rejects.toThrow(
				"No session - agent outputs unavailable",
			);
			await expect(router.resolve("history://ForkWorker", unrelatedContext)).rejects.toThrow(
				"Unknown agent: ForkWorker",
			);

			await parentSession.prompt("Read ForkWorker after fork.");
			const lastAssistant = [...parentSession.messages].reverse().find(msg => msg.role === "assistant");
			const assistantText =
				lastAssistant && "content" in lastAssistant
					? lastAssistant.content
							.flatMap(part =>
								part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
							)
							.join("\n")
					: "";
			expect(assistantText).toContain("fork-retained-worker-payload-314");

			await parentSession.dispose();
			expect(await Bun.file(outputPath!).exists()).toBe(false);
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			await parentSession.dispose();
			await unrelatedManager.close();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("reactivates retained artifact ownership when a saved session is switched back to or reopened while isolating stale prior-epoch stragglers", async () => {
		const cwd = path.join(root, "home", "work-reopen-saved");
		await fs.mkdir(cwd, { recursive: true });
		const sourceSessionFile = path.join(root, "source-for-seance.jsonl");
		const sourceTimestamp = "2026-11-11T00:00:00.000Z";
		await Bun.write(
			sourceSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "source-session-reopen",
					timestamp: sourceTimestamp,
					cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "src-u1",
					parentId: null,
					timestamp: sourceTimestamp,
					message: { role: "user", content: [{ type: "text", text: "Record historical context." }], timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "src-a1",
					parentId: "src-u1",
					timestamp: sourceTimestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Historical context recorded." }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				}),
			].join("\n") + "\n",
		);

		let activeEpochMarker = "spill-epoch-one";
		let nextSeanceName = "SeanceOne";
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			handler: context => {
				const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
				const hasGrep = (context.tools ?? []).some(tool => tool.name === "grep");
				const isSeance = hasGrep && !(context.tools ?? []).some(tool => tool.name === "task");
				if (isSeance) {
					const grepResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "grep");
					if (grepResults.length === 0) {
						return {
							content: [
								{
									type: "toolCall",
									name: "grep",
									arguments: { pattern: activeEpochMarker, path: "spill-target.txt" },
								},
							],
						};
					}
					const grepText = grepResults
						.flatMap(msg =>
							typeof msg.content === "string"
								? [msg.content]
								: msg.content.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									),
						)
						.join("\n");
					const spillLink = grepText.match(/artifact:\/\/\d+/)?.[0] ?? "missing-seance-spill";
					const summary = `${nextSeanceName}:${spillLink}`;
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: summary } }] }
						: { content: [summary] };
				}
				const lastMessage = context.messages.at(-1);
				if (lastMessage?.role !== "toolResult") {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "seance",
									name: nextSeanceName,
									sourceSession: sourceSessionFile,
									task: `Consult source and grep ${activeEpochMarker}.`,
								},
							},
						],
					};
				}
				return { content: [`completed:${nextSeanceName}`] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 0,
			"tools.artifactTailBytes": 1,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});

		const sessionDir = path.join(root, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const consultManager = SessionManager.create(cwd, sessionDir);
		await consultManager.ensureOnDisk();
		const consultSessionFile = consultManager.getSessionFile()!;
		const savedSessionId = consultManager.getSessionId();
		const otherManager = SessionManager.create(cwd, sessionDir);
		await otherManager.ensureOnDisk();
		const otherSessionFile = otherManager.getSessionFile()!;
		await otherManager.close();

		const { session: consultSession } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			sessionManager: consultManager,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		let reopenedSession: AgentSession | undefined;

		try {
			const router = new InternalUrlRouter();
			router.register(new ArtifactProtocolHandler());
			router.register(new AgentProtocolHandler());
			router.register(new HistoryProtocolHandler());

			const epochOne = consultSession.sessionManager.getArtifactEpoch();
			await writeSpillTarget(cwd, activeEpochMarker);
			await consultSession.prompt("Run first seance.");
			const ctxEpochOne = {
				cwd,
				settings,
				sessionFile: consultSessionFile,
				sessionId: savedSessionId,
				localProtocolOptions: {
					getArtifactsDir: () => consultSession.sessionManager.getArtifactsDir(),
					getSessionId: () => consultSession.sessionManager.getSessionId(),
				},
			};
			expect((await router.resolve("artifact://0", ctxEpochOne)).content).toContain("spill-epoch-one-line-1");
			expect(await router.locate("artifact://0", ctxEpochOne)).toContain(path.join("SeanceOne", "0."));

			// Switch away: epoch 1 is released and late stragglers from epoch 1 are rejected.
			expect(await consultSession.switchSession(otherSessionFile)).toBe(true);
			expect(await router.locate("artifact://0", { cwd, settings, sessionId: savedSessionId })).toBeNull();

			// Switch back to the original saved session: ownership reactivates under a new epoch.
			expect(await consultSession.switchSession(consultSessionFile)).toBe(true);
			expect(consultSession.sessionId).toBe(savedSessionId);
			const epochTwo = consultSession.sessionManager.getArtifactEpoch();
			expect(epochTwo).toBeGreaterThan(epochOne);

			// A late straggler carrying the old epoch is still rejected/cleaned immediately without breaking epochTwo.
			let staleStragglerCleaned = false;
			registerRetainedSessionArtifactCleanup(
				savedSessionId,
				async () => {
					staleStragglerCleaned = true;
				},
				{ epoch: epochOne },
			);
			const unregisterStale = registerArtifactsDir(path.join(root, "stale-epoch-one-dir"), {
				sessionId: savedSessionId,
				epoch: epochOne,
			});
			await Bun.sleep(0);
			expect(staleStragglerCleaned).toBe(true);
			expect(artifactsDirsFromRegistry({ sessionId: savedSessionId })).not.toContain(
				path.join(root, "stale-epoch-one-dir"),
			);
			unregisterStale();

			activeEpochMarker = "spill-epoch-two";
			nextSeanceName = "SeanceTwo";
			await writeSpillTarget(cwd, activeEpochMarker);
			await consultSession.prompt("Run second seance after switching back.");
			expect((await router.resolve("artifact://0", ctxEpochOne)).content).toContain("spill-epoch-two-line-1");
			expect(await router.locate("artifact://0", ctxEpochOne)).toContain(path.join("SeanceTwo", "0."));

			// Dispose and reopen the same saved session file in-process via SessionManager.open.
			await consultSession.dispose();
			expect(await router.locate("artifact://0", { cwd, settings, sessionId: savedSessionId })).toBeNull();

			const reopenedManager = await SessionManager.open(consultSessionFile, sessionDir);
			expect(reopenedManager.getSessionId()).toBe(savedSessionId);
			expect(reopenedManager.getArtifactEpoch()).toBeGreaterThan(epochTwo);
			({ session: reopenedSession } = await createAgentSession({
				cwd,
				authStorage,
				modelRegistry,
				model: mock,
				settings,
				sessionManager: reopenedManager,
				toolNames: ["task", "read"],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				hasUI: false,
			}));

			activeEpochMarker = "spill-epoch-three";
			nextSeanceName = "SeanceThree";
			await writeSpillTarget(cwd, activeEpochMarker);
			await reopenedSession.prompt("Run third seance after reopening saved session.");
			const ctxReopened = {
				cwd,
				settings,
				sessionFile: consultSessionFile,
				sessionId: savedSessionId,
				localProtocolOptions: {
					getArtifactsDir: () => reopenedSession!.sessionManager.getArtifactsDir(),
					getSessionId: () => reopenedSession!.sessionManager.getSessionId(),
				},
			};
			expect((await router.resolve("artifact://0", ctxReopened)).content).toContain("spill-epoch-three-line-1");
			expect(await router.locate("artifact://0", ctxReopened)).toContain(path.join("SeanceThree", "0."));

			await reopenedSession.dispose();
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			await reopenedSession?.dispose();
			await consultSession.dispose();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("scopes session-ID forwarding to the transferred fork epoch so reopening a saved session while its fork stays active isolates both scopes", async () => {
		const cwd = path.join(root, "home", "work-fork-reopen-coexist");
		await fs.mkdir(cwd, { recursive: true });
		const sourceSessionFile = path.join(root, "source-for-fork-reopen.jsonl");
		const sourceTimestamp = "2026-11-11T00:00:00.000Z";
		await Bun.write(
			sourceSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "source-fork-reopen",
					timestamp: sourceTimestamp,
					cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "src-u1",
					parentId: null,
					timestamp: sourceTimestamp,
					message: { role: "user", content: [{ type: "text", text: "Seed source transcript." }], timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "src-a1",
					parentId: "src-u1",
					timestamp: sourceTimestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Seeded." }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				}),
			].join("\n") + "\n",
		);

		let activeSpillMarker = "prefork-spill-alpha";
		let nextSeanceName = "SeancePreFork";
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			handler: context => {
				const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
				const hasGrep = (context.tools ?? []).some(tool => tool.name === "grep");
				const isSeance = hasGrep && !(context.tools ?? []).some(tool => tool.name === "task");
				if (isSeance) {
					const grepResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "grep");
					if (grepResults.length === 0) {
						return {
							content: [
								{
									type: "toolCall",
									name: "grep",
									arguments: { pattern: activeSpillMarker, path: "spill-target.txt" },
								},
							],
						};
					}
					const grepText = grepResults
						.flatMap(msg =>
							typeof msg.content === "string"
								? [msg.content]
								: msg.content.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									),
						)
						.join("\n");
					const spillLink = grepText.match(/artifact:\/\/\d+/)?.[0] ?? "missing-seance-spill";
					const summary = `${nextSeanceName}:${spillLink}`;
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: summary } }] }
						: { content: [summary] };
				}
				const lastMessage = context.messages.at(-1);
				if (lastMessage?.role !== "toolResult") {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "seance",
									name: nextSeanceName,
									sourceSession: sourceSessionFile,
									task: `Consult source and grep ${activeSpillMarker}.`,
								},
							},
						],
					};
				}
				return { content: [`completed:${nextSeanceName}`] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 0,
			"tools.artifactTailBytes": 1,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});

		const sessionDir = path.join(root, "sessions-fork-reopen");
		await fs.mkdir(sessionDir, { recursive: true });
		const originalManager = SessionManager.create(cwd, sessionDir);
		await originalManager.ensureOnDisk();
		const savedSessionFile = originalManager.getSessionFile()!;
		const savedSessionId = originalManager.getSessionId();

		const { session: forkedSessionHost } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			sessionManager: originalManager,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		let reopenedSavedSession: AgentSession | undefined;

		try {
			const router = new InternalUrlRouter();
			router.register(new ArtifactProtocolHandler());

			const preForkEpoch = forkedSessionHost.sessionManager.getArtifactEpoch();
			await writeSpillTarget(cwd, activeSpillMarker);
			await forkedSessionHost.prompt("Run pre-fork seance in saved session A.");

			const preForkLeaseDir = path.join(root, "prefork-temp-lease");
			const preForkLeaseFile = path.join(preForkLeaseDir, "retained.txt");
			await Bun.write(preForkLeaseFile, "retained-for-fork-b\n");
			registerArtifactsDir(preForkLeaseDir, { sessionId: savedSessionId, epoch: preForkEpoch });
			retainTemporaryLeaseForSession(savedSessionId, preForkLeaseDir, { epoch: preForkEpoch });

			const entries = forkedSessionHost.sessionManager.getEntries();
			const lastMessageEntry = [...entries].reverse().find(entry => entry.type === "message");
			expect(lastMessageEntry).toBeDefined();

			// Fork saved session A into B (copyArtifacts: true): A's pre-fork registrations move to B.
			expect(await forkedSessionHost.fork(lastMessageEntry!.id)).toBe(true);
			const forkedSessionId = forkedSessionHost.sessionId;
			expect(forkedSessionId).not.toBe(savedSessionId);

			// Reopen saved session A while fork B remains active in the same process.
			const reopenedManager = await SessionManager.open(savedSessionFile, sessionDir);
			expect(reopenedManager.getSessionId()).toBe(savedSessionId);
			const reopenedEpoch = reopenedManager.getArtifactEpoch();
			expect(reopenedEpoch).toBeGreaterThan(preForkEpoch);

			({ session: reopenedSavedSession } = await createAgentSession({
				cwd,
				authStorage,
				modelRegistry,
				model: mock,
				settings,
				sessionManager: reopenedManager,
				toolNames: ["task", "read"],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				hasUI: false,
			}));

			// A late straggler carrying A's pre-fork epoch still forwards to fork B even after A reopened.
			const latePreForkDir = path.join(root, "late-prefork-straggler");
			registerArtifactsDir(latePreForkDir, { sessionId: savedSessionId, epoch: preForkEpoch });
			expect(artifactsDirsFromRegistry({ sessionId: forkedSessionId })).toContain(latePreForkDir);
			expect(artifactsDirsFromRegistry({ sessionId: savedSessionId })).not.toContain(latePreForkDir);

			// Run new ephemeral seances in both reopened A and active fork B.
			activeSpillMarker = "reopened-a-spill-bravo";
			nextSeanceName = "SeanceReopenedA";
			await writeSpillTarget(cwd, activeSpillMarker);
			await reopenedSavedSession.prompt("Run seance in reopened saved session A.");

			const reopenedLeaseDir = path.join(root, "reopened-a-temp-lease");
			const reopenedLeaseFile = path.join(reopenedLeaseDir, "retained-a.txt");
			await Bun.write(reopenedLeaseFile, "retained-for-reopened-a\n");
			registerArtifactsDir(reopenedLeaseDir, { sessionId: savedSessionId, epoch: reopenedEpoch });
			retainTemporaryLeaseForSession(savedSessionId, reopenedLeaseDir, { epoch: reopenedEpoch });

			activeSpillMarker = "postfork-b-spill-charlie";
			nextSeanceName = "SeancePostForkB";
			await writeSpillTarget(cwd, activeSpillMarker);
			await forkedSessionHost.prompt("Run seance in active fork B.");

			const dirsForA = artifactsDirsFromRegistry({ sessionId: savedSessionId });
			const dirsForB = artifactsDirsFromRegistry({ sessionId: forkedSessionId });
			expect(dirsForA.some(dir => dir.endsWith(path.join(path.sep, "SeanceReopenedA")))).toBe(true);
			expect(dirsForA.some(dir => dir.endsWith(path.join(path.sep, "SeancePreFork")))).toBe(false);
			expect(dirsForA.some(dir => dir.endsWith(path.join(path.sep, "SeancePostForkB")))).toBe(false);
			expect(dirsForA).toContain(reopenedLeaseDir);
			expect(dirsForA).not.toContain(preForkLeaseDir);

			expect(dirsForB.some(dir => dir.endsWith(path.join(path.sep, "SeancePreFork")))).toBe(true);
			expect(dirsForB.some(dir => dir.endsWith(path.join(path.sep, "SeancePostForkB")))).toBe(true);
			expect(dirsForB.some(dir => dir.endsWith(path.join(path.sep, "SeanceReopenedA")))).toBe(false);
			expect(dirsForB).toContain(preForkLeaseDir);
			expect(dirsForB).not.toContain(reopenedLeaseDir);

			const ctxReopenedA = {
				cwd,
				settings,
				sessionFile: savedSessionFile,
				sessionId: savedSessionId,
				localProtocolOptions: {
					getArtifactsDir: () => reopenedSavedSession!.sessionManager.getArtifactsDir(),
					getSessionId: () => reopenedSavedSession!.sessionManager.getSessionId(),
					getArtifactEpoch: () => reopenedSavedSession!.sessionManager.getArtifactEpoch(),
				},
			};
			const ctxForkB = {
				cwd,
				settings,
				sessionFile: forkedSessionHost.sessionFile ?? undefined,
				sessionId: forkedSessionId,
				localProtocolOptions: {
					getArtifactsDir: () => forkedSessionHost.sessionManager.getArtifactsDir(),
					getSessionId: () => forkedSessionHost.sessionManager.getSessionId(),
					getArtifactEpoch: () => forkedSessionHost.sessionManager.getArtifactEpoch(),
				},
			};
			expect((await router.resolve("artifact://0", ctxReopenedA)).content).toContain(
				"reopened-a-spill-bravo-line-1",
			);
			expect((await router.resolve("artifact://0", ctxForkB)).content).toContain("postfork-b-spill-charlie-line-1");

			// Disposing reopened A releases ONLY A's reopened epoch; fork B's spill roots and leases stay intact.
			await reopenedSavedSession.dispose();
			reopenedSavedSession = undefined;
			expect(await Bun.file(reopenedLeaseFile).exists()).toBe(false);
			expect(artifactsDirsFromRegistry({ sessionId: savedSessionId })).toEqual([]);
			expect(await Bun.file(preForkLeaseFile).exists()).toBe(true);
			expect((await router.resolve("artifact://0", ctxForkB)).content).toContain("postfork-b-spill-charlie-line-1");
			expect(artifactsDirsFromRegistry({ sessionId: forkedSessionId })).toContain(preForkLeaseDir);

			// Disposing fork B now cleans up B's retained pre-fork and post-fork artifacts.
			await forkedSessionHost.dispose();
			expect(await Bun.file(preForkLeaseFile).exists()).toBe(false);
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			await reopenedSavedSession?.dispose();
			await forkedSessionHost.dispose();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("carries root artifact ownership into cold-revived subagents so ephemeral child seance spills resolve from the root session", async () => {
		const cwd = path.join(root, "home", "work-cold-revive-spill");
		await fs.mkdir(cwd, { recursive: true });
		const sourceSessionFile = path.join(root, "source-for-cold-revive-seance.jsonl");
		const sourceTimestamp = "2026-11-11T00:00:00.000Z";
		await Bun.write(
			sourceSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "source-cold-revive-seance",
					timestamp: sourceTimestamp,
					cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "src-u1",
					parentId: null,
					timestamp: sourceTimestamp,
					message: { role: "user", content: [{ type: "text", text: "Historical consult seed." }], timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "src-a1",
					parentId: "src-u1",
					timestamp: sourceTimestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Seed recorded." }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				}),
			].join("\n") + "\n",
		);

		const spillMarker = "cold-revived-seance-spill-sentinel-777";
		await writeSpillTarget(cwd, spillMarker);

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			handler: context => {
				const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
				const hasTask = (context.tools ?? []).some(tool => tool.name === "task");
				const hasGrep = (context.tools ?? []).some(tool => tool.name === "grep");
				const isSeance = hasGrep && !hasTask;
				if (isSeance) {
					const grepResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "grep");
					if (grepResults.length === 0) {
						return {
							content: [
								{
									type: "toolCall",
									name: "grep",
									arguments: { pattern: spillMarker, path: "spill-target.txt" },
								},
							],
						};
					}
					const grepText = grepResults
						.flatMap(msg =>
							typeof msg.content === "string"
								? [msg.content]
								: msg.content.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									),
						)
						.join("\n");
					const spillLink = grepText.match(/artifact:\/\/\d+/)?.[0] ?? "missing-cold-seance-spill";
					const summary = `cold-seance-result:${spillLink}`;
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: summary } }] }
						: { content: [summary] };
				}

				const lastUserText = [...context.messages]
					.reverse()
					.filter(msg => msg.role === "user")
					.slice(0, 1)
					.flatMap(msg =>
						typeof msg.content === "string"
							? [msg.content]
							: msg.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
					)
					.join("\n");
				const lastMessage = context.messages.at(-1);

				if (lastUserText.includes("Spawn persisted Coordinator.")) {
					if (lastMessage?.role !== "toolResult") {
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										agent: "task",
										name: "Coordinator",
										task: "Initialize Coordinator for later cold revival.",
									},
								},
							],
						};
					}
					return { content: ["Coordinator initialized."] };
				}

				if (lastUserText.includes("Spawn ephemeral seance from cold-revived Coordinator.")) {
					if (lastMessage?.role !== "toolResult") {
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										agent: "seance",
										name: "ConsultCold",
										sourceSession: sourceSessionFile,
										task: "Grep spill-target.txt in ephemeral seance.",
									},
								},
							],
						};
					}
					const taskText =
						typeof lastMessage.content === "string"
							? lastMessage.content
							: lastMessage.content
									.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									)
									.join("\n");
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: taskText } }] }
						: { content: [taskText] };
				}

				return hasYield
					? {
							content: [
								{ type: "toolCall", name: "yield", arguments: { type: "result", data: "coordinator-ready" } },
							],
						}
					: { content: ["coordinator-ready"] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const baseSettings = {
			"async.enabled": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"task.maxRecursionDepth": 4,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 0,
			"tools.artifactTailBytes": 1,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		};
		const initialSettings = Settings.isolated({ ...baseSettings, "task.keepAlive": true });
		const coldReviveSettings = Settings.isolated({ ...baseSettings, "task.keepAlive": false });

		const sessionDir = path.join(root, "sessions-cold-revive");
		await fs.mkdir(sessionDir, { recursive: true });
		const rootManager = SessionManager.create(cwd, sessionDir);
		await rootManager.ensureOnDisk();
		const rootSessionFile = rootManager.getSessionFile()!;
		const unrelatedManager = SessionManager.inMemory(cwd);
		inMemorySessionIds.push(unrelatedManager.getSessionId());

		const { session: rootSession } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings: initialSettings,
			sessionManager: rootManager,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});

		try {
			await rootSession.prompt("Spawn persisted Coordinator.");
			expect(AgentRegistry.global().get("Coordinator")?.session).not.toBeNull();

			// Park Coordinator and reset warm lifecycle state so ensureLive performs a cold revival.
			await AgentLifecycleManager.global().park("Coordinator");
			expect(AgentRegistry.global().get("Coordinator")?.session).toBeNull();
			AgentLifecycleManager.resetGlobalForTests();

			const reviveFactory = createPersistedSubagentReviverFactory({
				session: rootSession,
				authStorage,
				modelRegistry,
				settings: coldReviveSettings,
				enableLsp: false,
			});
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(reviveFactory, () => 0);

			const revivedHandle = await lifecycle.ensureLive("Coordinator");
			expect(revivedHandle).toBeInstanceOf(AgentSession);
			const revivedCoordinator = revivedHandle as AgentSession;

			await revivedCoordinator.prompt("Spawn ephemeral seance from cold-revived Coordinator.");
			expect(AgentRegistry.global().get("Coordinator.ConsultCold")).toBeUndefined();

			const router = new InternalUrlRouter();
			router.register(new ArtifactProtocolHandler());
			const rootContext = {
				cwd,
				settings: coldReviveSettings,
				sessionFile: rootSessionFile,
				sessionId: rootSession.sessionId,
				localProtocolOptions: {
					getArtifactsDir: () => rootSession.sessionManager.getArtifactsDir(),
					getSessionId: () => rootSession.sessionManager.getSessionId(),
					getArtifactEpoch: () => rootSession.sessionManager.getArtifactEpoch(),
				},
			};
			const resolved = await router.resolve("artifact://0", rootContext);
			expect(resolved.content).toContain(`${spillMarker}-line-1`);
			expect(await router.locate("artifact://0", rootContext)).toContain(path.join("Coordinator.ConsultCold", "0."));

			const unrelatedContext = {
				cwd,
				settings: coldReviveSettings,
				sessionId: unrelatedManager.getSessionId(),
			};
			expect(await router.locate("artifact://0", unrelatedContext)).toBeNull();

			// Releasing the revived subagent must NOT drop root session R's ownership of the retained spill root.
			await lifecycle.release("Coordinator");
			expect((await router.resolve("artifact://0", rootContext)).content).toContain(`${spillMarker}-line-1`);

			// Disposing root session R releases its retained spill registration.
			await rootSession.dispose();
			expect(await router.locate("artifact://0", rootContext)).toBeNull();
			expect(artifactsDirsFromRegistry()).toEqual([]);
		} finally {
			await AgentLifecycleManager.global()
				.release("Coordinator")
				.catch(() => false);
			await rootSession.dispose();
			await unrelatedManager.close();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("prefers caller-owned retained history and output over another in-memory root's live running Worker", async () => {
		const cwd = path.join(root, "home", "work-live-overlap");
		await fs.mkdir(cwd, { recursive: true });

		const bWorkerStarted = Promise.withResolvers<void>();
		const bWorkerRelease = Promise.withResolvers<void>();
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			handler: async context => {
				const allUserText = context.messages
					.filter(msg => msg.role === "user")
					.flatMap(msg =>
						typeof msg.content === "string"
							? [msg.content]
							: msg.content.flatMap(part =>
									part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
								),
					)
					.join("\n");

				if (allUserText.includes("beta-live-worker-marker")) {
					bWorkerStarted.resolve();
					await bWorkerRelease.promise;
					return { content: ["beta-live-worker-902"] };
				}
				if (allUserText.includes("alpha-ephemeral-worker-marker")) {
					return { content: ["alpha-retained-worker-901"] };
				}

				const lastMessage = context.messages.at(-1);
				const lastUserText =
					lastMessage?.role === "user"
						? typeof lastMessage.content === "string"
							? lastMessage.content
							: lastMessage.content
									.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									)
									.join("\n")
						: "";
				if (lastMessage?.role !== "toolResult") {
					if (lastUserText.includes("Read Worker history in A")) {
						return {
							content: [{ type: "toolCall", name: "read", arguments: { path: "history://Worker" } }],
						};
					}
					const isParentB = lastUserText.includes("Parent B");
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "task",
									name: "Worker",
									task: isParentB
										? "Run beta-live-worker-marker while overlapping with A."
										: "Run alpha-ephemeral-worker-marker.",
								},
							},
						],
					};
				}

				const toolText =
					typeof lastMessage.content === "string"
						? lastMessage.content
						: lastMessage.content
								.flatMap(part =>
									part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
								)
								.join("\n");
				return { content: [`observed:${toolText}`] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});

		const managerA = SessionManager.inMemory(cwd);
		const managerB = SessionManager.inMemory(cwd);
		inMemorySessionIds.push(managerA.getSessionId(), managerB.getSessionId());

		const commonOptions = {
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		};
		const { session: parentA } = await createAgentSession({ ...commonOptions, sessionManager: managerA });
		const { session: parentB } = await createAgentSession({ ...commonOptions, sessionManager: managerB });

		try {
			await parentA.prompt("Parent A: finish ephemeral Worker.");
			expect(AgentRegistry.global().get("Worker")).toBeUndefined();

			const router = new InternalUrlRouter();
			router.register(new AgentProtocolHandler());
			router.register(new HistoryProtocolHandler());
			const ctxA = { cwd, settings, sessionId: parentA.sessionId };
			const ctxB = { cwd, settings, sessionId: parentB.sessionId };

			const retainedHistoryPathA = await router.locate("history://Worker", ctxA);
			const retainedOutputPathA = await router.locate("agent://Worker", ctxA);
			expect(retainedHistoryPathA).not.toBeNull();
			expect(retainedOutputPathA).not.toBeNull();

			// Start Parent B's Worker and hold it live in the global registry.
			const bPromptPromise = parentB.prompt("Parent B: start live Worker.");
			await bWorkerStarted.promise;

			const liveRefB = AgentRegistry.global().get("Worker");
			expect(liveRefB?.status).toBe("running");
			expect(liveRefB?.session).not.toBeNull();
			expect(liveRefB?.sessionFile).not.toBe(retainedHistoryPathA);

			// While B's Worker is actively running, A still resolves and locates its own retained Worker.
			const historyAWhileBRunning = await router.resolve("history://Worker", ctxA);
			expect(historyAWhileBRunning.content).toContain("alpha-retained-worker-901");
			expect(historyAWhileBRunning.content).not.toContain("beta-live-worker-marker");
			expect(historyAWhileBRunning.sourcePath).toBe(retainedHistoryPathA!);
			expect(historyAWhileBRunning.notes).toEqual(["Source: session file (read-only, unregistered)"]);
			expect(await router.locate("history://Worker", ctxA)).toBe(retainedHistoryPathA);

			const agentAWhileBRunning = await router.resolve("agent://Worker", ctxA);
			expect(agentAWhileBRunning.content).toContain("alpha-retained-worker-901");
			expect(agentAWhileBRunning.content).not.toContain("PREVIOUS run");
			expect(agentAWhileBRunning.notes ?? []).toEqual([]);
			expect(await router.locate("agent://Worker", ctxA)).toBe(retainedOutputPathA);

			const indexAWhileBRunning = await router.resolve("history://", ctxA);
			expect(indexAWhileBRunning.content).toContain("| Worker | on disk |");

			// Exercising ReadTool inside Parent A while B's Worker is streaming also reads A's retained transcript.
			await parentA.prompt("Read Worker history in A while B is running.");
			const lastAssistantA = [...parentA.messages].reverse().find(msg => msg.role === "assistant");
			const assistantTextA =
				lastAssistantA && "content" in lastAssistantA
					? lastAssistantA.content
							.flatMap(part =>
								part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
							)
							.join("\n")
					: "";
			expect(assistantTextA).toContain("alpha-retained-worker-901");
			expect(assistantTextA).not.toContain("beta-live-worker-marker");

			// Concurrently, Parent B resolves its own live Worker session and progress view.
			const historyBWhileRunning = await router.resolve("history://Worker", ctxB);
			expect(historyBWhileRunning.content).toContain("beta-live-worker-marker");
			expect(historyBWhileRunning.content).not.toContain("alpha-retained-worker-901");
			expect(historyBWhileRunning.notes).toEqual(["Source: live session"]);
			expect(await router.locate("history://Worker", ctxB)).toBe(liveRefB?.sessionFile ?? null);

			const agentBWhileRunning = await router.resolve("agent://Worker", ctxB);
			expect(agentBWhileRunning.notes?.[0]).toContain("No published output; progress from live session");

			bWorkerRelease.resolve();
			await bPromptPromise;

			expect((await router.resolve("history://Worker", ctxA)).content).toContain("alpha-retained-worker-901");
			expect((await router.resolve("history://Worker", ctxB)).content).toContain("beta-live-worker-902");
		} finally {
			bWorkerRelease.resolve();
			await parentA.dispose();
			await parentB.dispose();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});

	it("resolves retained nested seance spill links from a focused subagent context while isolating other roots", async () => {
		const cwd = path.join(root, "home", "work-focused-subagent-spill");
		await fs.mkdir(cwd, { recursive: true });
		const sourceSessionFile = path.join(root, "source-for-focused-seance.jsonl");
		const sourceTimestamp = "2026-11-11T00:00:00.000Z";
		await Bun.write(
			sourceSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "source-focused-seance",
					timestamp: sourceTimestamp,
					cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "src-u1",
					parentId: null,
					timestamp: sourceTimestamp,
					message: { role: "user", content: [{ type: "text", text: "Focused consult seed." }], timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "src-a1",
					parentId: "src-u1",
					timestamp: sourceTimestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Focused seed recorded." }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				}),
			].join("\n") + "\n",
		);

		const spillMarker = "focused-nested-seance-spill-sentinel-888";
		await writeSpillTarget(cwd, spillMarker);

		const coordinatorHolding = Promise.withResolvers<void>();
		const coordinatorRelease = Promise.withResolvers<void>();

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			handler: async context => {
				const hasYield = (context.tools ?? []).some(tool => tool.name === "yield");
				const hasTask = (context.tools ?? []).some(tool => tool.name === "task");
				const hasGrep = (context.tools ?? []).some(tool => tool.name === "grep");
				const isSeance = hasGrep && !hasTask;
				if (isSeance) {
					const grepResults = context.messages.filter(msg => msg.role === "toolResult" && msg.toolName === "grep");
					if (grepResults.length === 0) {
						return {
							content: [
								{
									type: "toolCall",
									name: "grep",
									arguments: { pattern: spillMarker, path: "spill-target.txt" },
								},
							],
						};
					}
					const grepText = grepResults
						.flatMap(msg =>
							typeof msg.content === "string"
								? [msg.content]
								: msg.content.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									),
						)
						.join("\n");
					const spillLink = grepText.match(/artifact:\/\/\d+/)?.[0] ?? "missing-focused-seance-spill";
					const summary = `focused-seance-result:${spillLink}`;
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: summary } }] }
						: { content: [summary] };
				}

				const allUserText = context.messages
					.filter(msg => msg.role === "user")
					.flatMap(msg =>
						typeof msg.content === "string"
							? [msg.content]
							: msg.content.flatMap(part =>
									part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
								),
					)
					.join("\n");
				const lastMessage = context.messages.at(-1);

				if (allUserText.includes("Coordinate nested ephemeral ConsultFocus seance.")) {
					if (lastMessage?.role !== "toolResult") {
						return {
							content: [
								{
									type: "toolCall",
									name: "task",
									arguments: {
										agent: "seance",
										name: "ConsultFocus",
										sourceSession: sourceSessionFile,
										task: "Grep spill-target.txt in nested ephemeral ConsultFocus.",
									},
								},
							],
						};
					}
					coordinatorHolding.resolve();
					await coordinatorRelease.promise;
					const taskText =
						typeof lastMessage.content === "string"
							? lastMessage.content
							: lastMessage.content
									.flatMap(part =>
										part.type === "text" && "text" in part && typeof part.text === "string"
											? [part.text]
											: [],
									)
									.join("\n");
					return hasYield
						? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: taskText } }] }
						: { content: [taskText] };
				}

				if (lastMessage?.role !== "toolResult") {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "task",
									name: "Coordinator",
									task: "Coordinate nested ephemeral ConsultFocus seance.",
								},
							},
						],
					};
				}

				return { content: ["Coordinator completed."] };
			},
		});
		const modelSpec = `mock/${mock.id}`;
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		const availableSpy = vi
			.spyOn(modelRegistry, "getAvailable")
			.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const findOrig = modelRegistry.find.bind(modelRegistry);
		const findSpy = vi
			.spyOn(modelRegistry, "find")
			.mockImplementation((provider, id) =>
				provider === mock.provider && id === mock.id ? mock : findOrig(provider, id),
			);

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.keepAlive": false,
			"task.batch": false,
			"task.agentIdleTtlMs": 0,
			"task.workerThreads": 0,
			"task.enableLsp": false,
			"task.maxRecursionDepth": 4,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 0,
			"tools.artifactTailBytes": 1,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: modelSpec },
		});

		const sessionDir = path.join(root, "sessions-focused-subagent");
		await fs.mkdir(sessionDir, { recursive: true });
		const rootManager = SessionManager.create(cwd, sessionDir);
		await rootManager.ensureOnDisk();
		const unrelatedManager = SessionManager.inMemory(cwd);
		inMemorySessionIds.push(unrelatedManager.getSessionId());

		const { session: rootSession } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: mock,
			settings,
			sessionManager: rootManager,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});

		const rootPromptPromise = rootSession.prompt("Run Coordinator and inspect focused nested seance spill.");
		try {
			await coordinatorHolding.promise;

			// Nested ephemeral ConsultFocus already disposed and unregistered, while Coordinator is live & focusable.
			expect(AgentRegistry.global().get("Coordinator.ConsultFocus")).toBeUndefined();
			const coordinatorRef = AgentRegistry.global().get("Coordinator");
			expect(coordinatorRef?.session).toBeInstanceOf(AgentSession);
			const coordinator = coordinatorRef!.session as AgentSession;
			const coordinatorSessionId = coordinator.sessionManager.getSessionId();
			const coordinatorArtifactsDir = coordinator.sessionManager.getArtifactsDir();
			const coordinatorSessionFile = coordinator.sessionFile;
			expect(coordinatorSessionId).not.toBe(rootSession.sessionId);
			expect(coordinatorRef!.sessionId).toBe(coordinatorSessionId);

			// 1. Direct child-session ResolveContext (passing child's own sessionId via localProtocolOptions).
			const focusedChildIdContext = {
				cwd: coordinator.sessionManager.getCwd(),
				sessionFile: coordinatorSessionFile,
				settings: coordinator.settings,
				localProtocolOptions: {
					getArtifactsDir: () => coordinatorArtifactsDir,
					getSessionId: () => coordinatorSessionId,
				},
			};

			// 2. InteractiveMode.#linkResolveContext() shape for a focused non-seance subagent view.
			const focusedRootOwnerContext = {
				cwd: coordinator.sessionManager.getCwd(),
				sessionFile: coordinatorSessionFile,
				sessionId: rootSession.sessionManager.getSessionId(),
				seanceSourceArtifactsDir: coordinator.sessionManager.getSeanceSourceArtifactsDir() ?? undefined,
				settings: coordinator.settings,
				localProtocolOptions: {
					getArtifactsDir: () => coordinatorArtifactsDir,
					getSessionId: () => rootSession.sessionManager.getSessionId(),
					getArtifactEpoch: () => rootSession.sessionManager.getArtifactEpoch(),
				},
			};

			// 3. Main root view context and an unrelated root session context.
			const mainViewContext = {
				cwd: rootSession.sessionManager.getCwd(),
				sessionFile: rootSession.sessionFile,
				sessionId: rootSession.sessionManager.getSessionId(),
				settings: rootSession.settings,
				localProtocolOptions: {
					getArtifactsDir: () => rootSession.sessionManager.getArtifactsDir(),
					getSessionId: () => rootSession.sessionManager.getSessionId(),
					getArtifactEpoch: () => rootSession.sessionManager.getArtifactEpoch(),
				},
			};
			const unrelatedContext = {
				cwd,
				settings,
				sessionId: unrelatedManager.getSessionId(),
			};

			const router = InternalUrlRouter.instance();
			const childLinkTargets = await resolveMarkdownLinkHrefs(["artifact://0"], focusedChildIdContext);
			const focusedViewTargets = await resolveMarkdownLinkHrefs(["artifact://0"], focusedRootOwnerContext);
			const mainViewTargets = await resolveMarkdownLinkHrefs(["artifact://0"], mainViewContext);
			const unrelatedTargets = await resolveMarkdownLinkHrefs(["artifact://0"], unrelatedContext);

			const expectedHref = mainViewTargets.get("artifact://0");
			expect(expectedHref).toBeDefined();
			expect(expectedHref).toContain("Coordinator.ConsultFocus/0.");
			expect(childLinkTargets.get("artifact://0")).toBe(expectedHref);
			expect(focusedViewTargets.get("artifact://0")).toBe(expectedHref);
			expect(unrelatedTargets.size).toBe(0);

			expect((await router.resolve("artifact://0", focusedChildIdContext)).content).toContain(
				`${spillMarker}-line-1`,
			);
			expect((await router.resolve("artifact://0", focusedRootOwnerContext)).content).toContain(
				`${spillMarker}-line-1`,
			);
			expect(await router.locate("artifact://0", unrelatedContext)).toBeNull();

			// Finish Coordinator and verify a parked subagent ref (session === null) also resolves via ref.sessionId.
			coordinatorRelease.resolve();
			await rootPromptPromise;
			expect(AgentRegistry.global().get("Coordinator")).toBeUndefined();

			AgentRegistry.global().register({
				id: "ParkedSibling",
				displayName: "task",
				kind: "sub",
				sessionId: "parked-child-session-id",
				rootSessionId: rootSession.sessionId,
				rootSessionEpoch: rootSession.sessionManager.getArtifactEpoch(),
				status: "parked",
				session: null,
			});
			const parkedChildContext = {
				cwd,
				settings,
				localProtocolOptions: {
					getSessionId: () => "parked-child-session-id",
				},
			};
			expect((await resolveMarkdownLinkHrefs(["artifact://0"], parkedChildContext)).get("artifact://0")).toBe(
				expectedHref,
			);
			AgentRegistry.global().unregister("ParkedSibling");

			// Disposing the root session cleans up the retained descendant spill registration.
			await rootSession.dispose();
			expect((await resolveMarkdownLinkHrefs(["artifact://0"], mainViewContext)).size).toBe(0);
			expect(await router.locate("artifact://0", parkedChildContext)).toBeNull();
		} finally {
			coordinatorRelease.resolve();
			await rootPromptPromise.catch(() => undefined);
			await AgentLifecycleManager.global()
				.release("Coordinator")
				.catch(() => false);
			await rootSession.dispose();
			await unrelatedManager.close();
			mock.reset();
			availableSpy.mockRestore();
			findSpy.mockRestore();
			authStorage.close();
		}
	});
});
