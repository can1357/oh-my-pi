import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ArtifactManager, type ArtifactManagerApi } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { readTaskReportHistory } from "@oh-my-pi/pi-coding-agent/task/report";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { PreparedSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { localSession } from "../helpers/local-session";

const MOCK_API_SOURCE = "seance-artifact-lifecycle-test";
const AGENT_ID = "SeanceArtifactLifecycle";
const UNSTRUCTURED_AGENT_ID = "SeanceUnstructuredLifecycle";
function preparedSession(sourceFile: string, sourceSessionId: string): PreparedSeanceSession {
	return {
		fork: {
			sourceFile,
		},
		promptSuffix: model => `Consulting ${sourceSessionId} with ${model ?? "the saved model"}.`,
	};
}

function makeModelRegistry(authStorage: AuthStorage, modelsPath: string, model: MockModel): ModelRegistry {
	const registry = new ModelRegistry(authStorage, modelsPath);
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(registry, "getAvailableForProviders").mockReturnValue([model]);
	vi.spyOn(registry, "getAll").mockReturnValue([model]);
	vi.spyOn(registry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : undefined,
	);
	return registry;
}

function revivalParent(cwd: string): AgentSession {
	return {
		sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
		effectiveExtensionRoots: {
			explicit: [],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		},
		preparedExtensions: [],
	} as unknown as AgentSession;
}

function waitForSettlement(eventBus: EventBus, id: string): Promise<string> {
	const settled = Promise.withResolvers<string>();
	const unsubscribe = eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (!payload || typeof payload !== "object") return;
		const frame = payload as { id?: unknown; status?: unknown };
		if (
			frame.id === id &&
			(frame.status === "completed" || frame.status === "failed" || frame.status === "aborted")
		) {
			settled.resolve(frame.status);
		}
	});
	return settled.promise.finally(unsubscribe);
}

async function waitForWake(session: AgentSession, eventBus: EventBus, id: string, messageId: string): Promise<void> {
	const settled = waitForSettlement(eventBus, id);
	const outcome = await session.deliverIrcMessage({
		id: messageId,
		from: "HistoricalReader",
		to: id,
		body: "Continue with the next follow-up.",
		ts: Date.now(),
	});
	expect(outcome).toBe("woken");
	expect(await settled).toBe("completed");
	await session.waitForIdle();
}

beforeEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
});

describe("seance artifact lifecycle", () => {
	it("publishes the latest warm and cold yield beside sibling results", async () => {
		using tempDir = TempDir.createSync("@omp-seance-artifact-lifecycle-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await fs.mkdir(cwd, { recursive: true });

		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "host-session",
				timestamp,
				cwd,
			},
			{
				type: "session_init",
				id: "host-init",
				parentId: null,
				timestamp,
				systemPrompt: ["host-only startup contract"],
				task: "host task",
				tools: ["read"],
				agent: "task",
				spawns: "*",
			},
			{
				type: "message",
				id: "host-message",
				parentId: "host-init",
				timestamp,
				message: { role: "user", content: "historical request", timestamp: 1 },
			},
		];
		const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(sourceFile, sourceText);

		const mock = createMockModel({
			provider: "mock",
			id: "seance-artifact-lifecycle",
			responses: [
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "initial answer" } } }] },
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "warm answer" } } }] },
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "cold answer" } } }] },
			],
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const eventBus = new EventBus();
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		let lifecycle = AgentLifecycleManager.global();

		try {
			const result = await runSubprocess({
				cwd,
				agent,
				task: "Consult the current host session.",
				assignment: "Read the saved context and submit a result.",
				index: 0,
				id: AGENT_ID,
				settings,
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride: [`${mock.model.provider}/${mock.model.id}`],
				preparedSession: preparedSession(sourceFile, "host-session"),
				artifactsDir,
				enableIrc: true,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				eventBus,
			});
			expect(result.exitCode).toBe(0);

			const publishedPath = path.join(artifactsDir, `${AGENT_ID}.md`);
			expect(result.outputPath).toBe(publishedPath);
			expect(AgentRegistry.global().get(AGENT_ID)?.history?.outputPath).toBe(publishedPath);
			expect(await Bun.file(publishedPath).text()).toContain("initial answer");

			const liveSession = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
			await waitForWake(liveSession, eventBus, AGENT_ID, "warm-follow-up");
			expect(await Bun.file(publishedPath).text()).toContain("warm answer");

			await lifecycle.park(AGENT_ID);
			AgentLifecycleManager.resetGlobalForTests();
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: revivalParent(cwd),
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				eventBus,
			});
			lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(reviveFactory, () => 0);
			const coldSession = localSession(await lifecycle.ensureLive(AGENT_ID));
			await waitForWake(coldSession, eventBus, AGENT_ID, "cold-follow-up");

			expect(await Bun.file(publishedPath).text()).toContain("cold answer");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			await AgentLifecycleManager.global()
				.release(AGENT_ID)
				.catch(() => false);
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("preserves an unstructured seance result contract through fresh, warm, and cold turns", async () => {
		using tempDir = TempDir.createSync("@omp-seance-unstructured-lifecycle-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });

		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "unstructured-host",
				timestamp,
				cwd,
			},
			{
				type: "session_init",
				id: "host-init",
				parentId: null,
				timestamp,
				systemPrompt: ["host-only startup contract"],
				task: "host task",
				tools: ["read"],
				agent: "task",
				spawns: "*",
			},
			{
				type: "message",
				id: "host-message",
				parentId: "host-init",
				timestamp,
				message: { role: "user", content: "historical request", timestamp: 1 },
			},
		];
		const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const mock = createMockModel({
			provider: "mock",
			id: "seance-unstructured-lifecycle",
			responses: [{ content: ["Initial unstructured answer"] }],
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const eventBus = new EventBus();
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		let lifecycle = AgentLifecycleManager.global();

		try {
			const result = await runSubprocess({
				cwd,
				agent,
				task: "Consult the current host session.",
				assignment: "Read the saved context and submit a final message.",
				index: 0,
				id: UNSTRUCTURED_AGENT_ID,
				settings,
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride: [`${mock.model.provider}/${mock.model.id}`],
				preparedSession: preparedSession(sourceFile, "unstructured-host"),
				artifactsDir,
				enableIrc: true,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				structured: false,
				eventBus,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Initial unstructured answer");

			const childSessionFile = path.join(artifactsDir, `${UNSTRUCTURED_AGENT_ID}.jsonl`);
			const publishedPath = path.join(artifactsDir, `${UNSTRUCTURED_AGENT_ID}.md`);
			const persisted = await SessionManager.peekSessionInit(childSessionFile);
			expect(persisted?.init?.tools).not.toContain("yield");
			expect(await Bun.file(publishedPath).text()).toContain("Initial unstructured answer");

			const liveSession = localSession(AgentRegistry.global().get(UNSTRUCTURED_AGENT_ID)?.session);
			expect(liveSession.getActiveToolNames()).not.toContain("yield");
			mock.push({ content: ["Warm unstructured answer"] });
			await waitForWake(liveSession, eventBus, UNSTRUCTURED_AGENT_ID, "warm-unstructured-follow-up");
			expect(await Bun.file(publishedPath).text()).toContain("Initial unstructured answer");

			await lifecycle.park(UNSTRUCTURED_AGENT_ID);
			AgentLifecycleManager.resetGlobalForTests();
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: revivalParent(cwd),
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				eventBus,
			});
			lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(reviveFactory, () => 0);
			const coldSession = localSession(await lifecycle.ensureLive(UNSTRUCTURED_AGENT_ID));
			expect(coldSession.getActiveToolNames()).not.toContain("yield");
			mock.push({ content: ["Cold unstructured answer"] });
			await waitForWake(coldSession, eventBus, UNSTRUCTURED_AGENT_ID, "cold-unstructured-follow-up");

			expect(await Bun.file(publishedPath).text()).toContain("Initial unstructured answer");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			await AgentLifecycleManager.global()
				.release(UNSTRUCTURED_AGENT_ID)
				.catch(() => false);
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps public reports in the parent namespace through real warm and cold revival and release", async () => {
		using tempDir = TempDir.createSync("@omp-seance-report-owner-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "source", "historical.jsonl");
		const id = "SeanceReportOwner";
		const parentId = "Main";
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "report-source", timestamp, cwd },
			{
				type: "session_init",
				id: "source-init",
				parentId: null,
				timestamp,
				systemPrompt: ["historical source contract"],
				task: "historical task",
				tools: ["read"],
				agent: "task",
				spawns: "*",
			},
			{
				type: "message",
				id: "source-message",
				parentId: "source-init",
				timestamp,
				message: { role: "user", content: "historical request", timestamp: 1 },
			},
		];
		const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const mock = createMockModel({
			provider: "mock",
			id: "seance-report-owner",
			responses: [{ content: ["Initial public report: café."] }],
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"launch.enabled": false,
		});
		const eventBus = new EventBus();
		const previousAgentDir = getAgentDir();
		let parentManager: SessionManager | undefined;

		try {
			setAgentDir(path.join(tempDir.path(), "agent"));
			const agent = getBundledAgent("seance");
			if (!agent) throw new Error("Expected the bundled seance agent");
			parentManager = SessionManager.create(cwd, path.join(tempDir.path(), "parent-sessions"));
			const parentArtifactManager = new ArtifactManager(path.join(tempDir.path(), "parent-reports"));
			parentManager.adoptArtifactManager(parentArtifactManager);
			await parentManager.ensureOnDisk();
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) throw new Error("Expected a persisted parent session");
			// Source, child transcripts, and public numeric reports have independent roots.
			const artifactsDir = parentSessionFile.slice(0, -".jsonl".length);
			const parentInbox: Array<Parameters<AgentSession["deliverIrcMessage"]>[0]> = [];
			const parentSession = {
				...revivalParent(cwd),
				getAgentId: () => parentId,
				sessionManager: parentManager,
				isDisposed: false,
				deliverIrcMessage: async (message: Parameters<AgentSession["deliverIrcMessage"]>[0]) => {
					parentInbox.push(message);
					return "injected" as const;
				},
			} as AgentSession;
			AgentRegistry.global().register({
				id: parentId,
				displayName: "parent",
				kind: "main",
				session: parentSession,
				sessionFile: parentSessionFile,
				status: "idle",
			});
			const parentZeroText = "Unrelated parent artifact zero.\n";
			const parentOneText = "Unrelated parent artifact one.\n";
			const privateText = "Private child artifact zero; never public.\n";
			const parentZero = await parentArtifactManager.save(parentZeroText, "read");
			const parentOne = await parentArtifactManager.save(parentOneText, "bash");
			expect([parentZero, parentOne]).toEqual(["0", "1"]);

			async function artifactBytes(manager: ArtifactManagerApi, artifactId: string): Promise<Buffer> {
				const file = await manager.getPath(artifactId);
				if (!file) throw new Error(`Missing artifact ${artifactId} in ${manager.dir}`);
				return fs.readFile(file);
			}

			async function expectReport(
				report: TaskReportReference | undefined,
				text: string,
			): Promise<TaskReportReference> {
				if (!report) throw new Error("Expected a typed public report");
				expect(report.status).toBe("complete");
				expect(report.runId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
				if (!report.artifact) throw new Error("Expected a numeric public report artifact");
				expect(report.artifact.id).toMatch(/^\d+$/);
				expect(report.artifact.uri).toBe(`artifact://${report.artifact.id}`);
				const bytes = await artifactBytes(parentArtifactManager, report.artifact.id);
				expect(bytes).toEqual(Buffer.from(text));
				expect(report.artifact.bytes).toBe(bytes.byteLength);
				expect(report.artifact.sha256).toBe(new Bun.SHA256().update(bytes).digest("hex"));
				return report;
			}

			const runtimeManagers: Array<{
				session: AgentSession;
				manager: SessionManager;
				artifacts: ArtifactManagerApi;
			}> = [];
			let privateId: string | undefined;
			let privateFiles: string[] = [];
			const createAgentSession = sdk.createAgentSession;
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
				const created = await createAgentSession(options);
				const manager = created.session.sessionManager;
				const artifacts = manager.getArtifactManager();
				if (!artifacts) throw new Error("Expected the real child's private artifact manager");
				expect(artifacts).not.toBe(parentArtifactManager);
				expect(artifacts.dir).toBe(path.join(artifactsDir, id));
				runtimeManagers.push({ session: created.session, manager, artifacts });
				if (runtimeManagers.length === 1) {
					// The source has no reserved numeric ids: the actual private namespace starts at zero.
					privateId = await artifacts.save(privateText, "private");
					expect(privateId).toBe(parentZero);
					const privateBytes = await artifactBytes(artifacts, privateId);
					const parentBytes = await artifactBytes(parentArtifactManager, parentZero);
					expect(privateBytes).toEqual(Buffer.from(privateText));
					expect(parentBytes).toEqual(Buffer.from(parentZeroText));
					expect(privateBytes).not.toEqual(parentBytes);
					privateFiles = (await artifacts.listFiles()).toSorted();
					expect(privateFiles).toEqual(["0.private.log"]);
				}
				return created;
			});

			async function expectNamespacesUnchanged(): Promise<void> {
				if (privateId === undefined) throw new Error("Expected the private collision seed");
				expect(await artifactBytes(parentArtifactManager, parentZero)).toEqual(Buffer.from(parentZeroText));
				expect(await artifactBytes(parentArtifactManager, parentOne)).toEqual(Buffer.from(parentOneText));
				for (const { manager, artifacts } of runtimeManagers) {
					expect(manager.getArtifactManager()).toBe(artifacts);
					expect(artifacts).not.toBe(parentArtifactManager);
					expect((await artifacts.listFiles()).toSorted()).toEqual(privateFiles);
					expect(await artifactBytes(artifacts, privateId)).toEqual(Buffer.from(privateText));
				}
			}

			let lifecycle = AgentLifecycleManager.global();
			const initial = await runSubprocess({
				cwd,
				agent,
				task: "Consult the historical source.",
				assignment: "Return a public report as a final message.",
				index: 0,
				id,
				settings,
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride: [`${mock.model.provider}/${mock.model.id}`],
				preparedSession: preparedSession(sourceFile, "report-source"),
				artifactsDir,
				parentArtifactManager,
				parentAgentId: parentId,
				structured: false,
				enableIrc: true,
				enableLsp: false,
				enableMCP: false,
				eventBus,
			});
			expect(initial.exitCode).toBe(0);
			const first = await expectReport(initial.report, "Initial public report: café.");
			expect(runtimeManagers).toHaveLength(1);
			expect(AgentRegistry.global().get(id)?.session).toBe(runtimeManagers[0].session);
			await expectNamespacesUnchanged();

			await lifecycle.park(id);
			expect(AgentRegistry.global().get(id)).toMatchObject({ status: "parked", session: null });
			mock.push({ content: ["Warm public continuation."] });
			const warm = await runSubagentFollowUpTurn({
				id,
				agent,
				message: "Continue the public report.",
				structured: false,
				artifactsDir,
				parentArtifactManager,
				eventBus,
			});
			expect(warm.exitCode).toBe(0);
			const second = await expectReport(warm.report, "Initial public report: café.\n\nWarm public continuation.");
			expect(second.runId).not.toBe(first.runId);
			expect(second.artifact?.id).not.toBe(first.artifact?.id);
			expect(runtimeManagers).toHaveLength(2);
			expect(runtimeManagers[1].manager).not.toBe(runtimeManagers[0].manager);
			expect(AgentRegistry.global().get(id)?.session).toBe(runtimeManagers[1].session);
			await expectReport(first, "Initial public report: café.");
			await expectNamespacesUnchanged();

			await lifecycle.park(id);
			expect(AgentRegistry.global().get(id)).toMatchObject({ status: "parked", session: null });
			AgentLifecycleManager.resetGlobalForTests();
			lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: parentSession,
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
					eventBus,
				}),
				() => 0,
			);
			// IRC uses the cold factory's registered-parent sink, not a follow-up option override.
			const coldSession = await lifecycle.ensureLive(id);
			mock.push({ content: ["Cold public continuation."] });
			const coldSettlement = waitForSettlement(eventBus, id);
			expect(
				await coldSession.deliverIrcMessage({
					id: "cold-report-owner-follow-up",
					from: parentId,
					to: id,
					body: "Continue the public report after cold revival.",
					ts: Date.now(),
				}),
			).toBe("woken");
			expect(await coldSettlement).toBe("completed");
			const coldRuntime = runtimeManagers[2]!;
			expect(coldSession).toBe(coldRuntime.session);
			await coldRuntime.session.waitForIdle();
			const third = await expectReport(
				readTaskReportHistory(coldRuntime.manager, id),
				"Initial public report: café.\n\nWarm public continuation.\n\nCold public continuation.",
			);
			expect(new Set([first.runId, second.runId, third.runId]).size).toBe(3);
			expect(new Set([first.artifact?.id, second.artifact?.id, third.artifact?.id]).size).toBe(3);
			expect(runtimeManagers).toHaveLength(3);
			expect(runtimeManagers[2].manager).not.toBe(runtimeManagers[1].manager);
			await expectNamespacesUnchanged();

			expect(await lifecycle.release(id)).toBe(true);
			expect(lifecycle.has(id)).toBe(false);
			expect(AgentRegistry.global().get(id)).toBeUndefined();
			await expectReport(first, "Initial public report: café.");
			await expectReport(second, "Initial public report: café.\n\nWarm public continuation.");
			await expectReport(
				third,
				"Initial public report: café.\n\nWarm public continuation.\n\nCold public continuation.",
			);
			await expectNamespacesUnchanged();
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			try {
				await AgentLifecycleManager.global()
					.release(id)
					.catch(() => false);
				await parentManager?.close();
			} finally {
				AgentRegistry.global().unregister(parentId);
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});

	it("allocates past the source's artifact ids and resolves inherited ids to the source, never another session", async () => {
		using tempDir = TempDir.createSync("@omp-seance-artifact-ids-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const sourceArtifacts = sourceFile.slice(0, -".jsonl".length);
		await Bun.write(
			sourceFile,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "host", timestamp: "2026-10-01T00:00:00.000Z", cwd })}\n`,
		);
		for (let id = 0; id < 5; id++) {
			await Bun.write(path.join(sourceArtifacts, `${id}.read.log`), `source artifact ${id}`);
		}
		const otherFile = path.join(tempDir.path(), "other", "other.jsonl");
		await Bun.write(path.join(otherFile.slice(0, -".jsonl".length), "2.read.log"), "other session artifact 2");
		await Bun.write(path.join(otherFile.slice(0, -".jsonl".length), "9.bash.log"), "other session only");
		AgentRegistry.global().register({
			id: "OtherSession",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: otherFile,
			status: "parked",
		});

		const fork = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: path.join(sourceArtifacts, `${AGENT_ID}.jsonl`),
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		try {
			expect(await fork.saveArtifact("seance output", "bash")).toBe("5");
			const toolSession: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => fork.getSessionFile() ?? null,
				getSessionSpawns: () => "",
				getArtifactsDir: () => fork.getArtifactsDir(),
				settings: Settings.isolated(),
				seanceSourceArtifactsDir: fork.getSeanceSourceArtifactsDir() ?? undefined,
			};
			const context = sessionResolveContext(toolSession);
			const router = InternalUrlRouter.instance();

			expect((await router.resolve("artifact://2", context)).content).toBe("source artifact 2");
			expect((await router.resolve("artifact://5", context)).content).toBe("seance output");
			await expect(router.resolve("artifact://9", context)).rejects.toThrow("Artifact 9 not found");
			// Without the seance binding the other session's artifact is reachable, so the miss above is scoping.
			expect((await router.resolve("artifact://9")).content).toBe("other session only");
		} finally {
			await fork.close();
		}
	});

	it("leaves only each seance's transcript and result in a repeatedly consulted host's artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-seance-repeat-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await Bun.write(
			sourceFile,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "host",
					timestamp: "2026-10-01T00:00:00.000Z",
					cwd,
				},
				{
					type: "message",
					id: "host-message",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					message: { role: "user", content: "historical request", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await Bun.write(path.join(artifactsDir, "0.read.log"), "host artifact bytes");

		const seanceIds = ["SeanceRepeatOne", "SeanceRepeatTwo"];
		const mock = createMockModel({
			provider: "mock",
			id: "seance-repeat",
			responses: seanceIds.map(id => ({
				content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: id } } }],
			})),
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");

		try {
			for (const id of seanceIds) {
				const result = await runSubprocess({
					cwd,
					agent,
					task: "Consult the current host session.",
					assignment: "Read the saved context and submit a result.",
					index: 0,
					id,
					settings,
					modelRegistry,
					authStorage,
					getApiKey: async () => "test-key",
					modelOverride: [`${mock.model.provider}/${mock.model.id}`],
					preparedSession: preparedSession(sourceFile, "host"),
					artifactsDir,
					enableLsp: false,
					enableMCP: false,
					parentAgentId: "Main",
				});
				expect(result.exitCode).toBe(0);
			}

			const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: artifactsDir }), file =>
				file.replaceAll("\\", "/"),
			);
			expect(files.toSorted()).toEqual([
				"0.read.log",
				"SeanceRepeatOne.jsonl",
				"SeanceRepeatOne.md",
				"SeanceRepeatTwo.jsonl",
				"SeanceRepeatTwo.md",
			]);
		} finally {
			for (const id of seanceIds) {
				await AgentLifecycleManager.global()
					.release(id)
					.catch(() => false);
			}
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});
});
