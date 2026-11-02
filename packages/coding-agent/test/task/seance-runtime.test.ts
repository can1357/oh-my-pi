import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import seanceAssignmentTemplate from "../../src/prompts/system/seance-assignment.md" with { type: "text" };
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { PreparedSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import { seanceIsolationOptions } from "@oh-my-pi/pi-coding-agent/task/seance-policy";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, prompt, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function preparedSourceSession(sourceFile: string, sourceSessionId: string): PreparedSeanceSession {
	return {
		fork: {
			sourceFile,
		},
		promptSuffix: model =>
			prompt.render(seanceAssignmentTemplate, {
				sourceSession: sourceSessionId,
				model: model ?? "",
			}),
	};
}

function sourceHeader(id: string, cwd: string, additionalDirectories: string[] = []) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
		...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
	};
}

function unrestrictedSourceInit() {
	return {
		type: "session_init",
		id: "inherited-init",
		parentId: null,
		timestamp: "2026-10-01T00:00:01.000Z",
		systemPrompt: ["source-only startup contract"],
		task: "source task",
		tools: ["read", "write", "task"],
		agent: "task",
		spawns: "*",
	};
}

function sourceMessage() {
	return {
		type: "message",
		id: "source-user",
		parentId: null,
		timestamp: "2026-10-01T00:00:02.000Z",
		message: { role: "user", content: "historical source request", timestamp: 1 },
	};
}

async function writeSourceSession(file: string, cwd: string, additionalDirectories: string[] = []): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const text = [sourceHeader("source-session", cwd, additionalDirectories), unrestrictedSourceInit(), sourceMessage()]
		.map(entry => JSON.stringify(entry))
		.join("\n");
	await Bun.write(file, `${text}\n`);
	return text + "\n";
}

/** The executor's seance fork: the source transcript in place, no artifact copy. */
function forkSeance(sourceFile: string, cwd: string, sessionFile: string): Promise<SessionManager> {
	return SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
		seance: true,
		suppressBreadcrumb: true,
		sessionFile,
		resetInheritedCost: true,
		repairInterruptedTail: true,
	});
}

function hostilePreparedExtension(onLoad: () => void): PreparedExtension {
	return {
		path: "/fixture/hostile-seance-extension.ts",
		resolvedPath: "/fixture/hostile-seance-extension.ts",
		factory: () => onLoad(),
		error: null,
	};
}

function revivalParent(cwd: string, preparedExtensions: PreparedExtension[]): AgentSession {
	return {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		effectiveExtensionRoots: {
			explicit: ["/fixture/hostile-seance-extension.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		},
		preparedExtensions,
	} as unknown as AgentSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("seance startup contracts", () => {
	it("builds a fresh SDK session with only historical tools and no extensions or outbound IRC", async () => {
		using tempDir = TempDir.createSync("@omp-seance-sdk-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceRoot = path.join(tempDir.path(), "source-additional");
		const settingsRoot = path.join(tempDir.path(), "settings-additional");
		await Promise.all([sourceRoot, settingsRoot].map(directory => fs.mkdir(directory, { recursive: true })));
		const markerNames = ["cwd-tree-leak.txt", "source-root-tree-leak.txt", "settings-root-tree-leak.txt"];
		await Promise.all(
			[
				path.join(cwd, markerNames[0]),
				path.join(sourceRoot, markerNames[1]),
				path.join(settingsRoot, markerNames[2]),
			].map(file => Bun.write(file, "must not be discovered")),
		);
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd, [sourceRoot]);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionPath = path.join(tempDir.path(), "hostile-extension.ts");
		const extensionMarker = path.join(tempDir.path(), "extension-loaded.txt");
		const extensionSource = [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(extensionMarker)}, "loaded");`,
			"export default api => {",
			"  api.registerTool({",
			'    name: "hostile_extension",',
			'    label: "Hostile",',
			'    description: "Should not load",',
			"    parameters: api.arktype({}),",
			'    execute: async () => ({ content: [{ type: "text", text: "loaded" }] }),',
			"  });",
			"};",
		].join("\n");
		await Bun.write(extensionPath, extensionSource);
		let session: AgentSession | undefined;
		try {
			const parentCapabilities = { enableIrc: true, enableMCP: true };
			const created = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model,
				settings: Settings.isolated({
					"workspace.additionalDirectories": [settingsRoot],
					includeWorkspaceTree: true,
				}),
				sessionManager: forked,
				agentName: "seance",
				toolNames: ["read", "grep", "glob"],
				requireYieldTool: true,
				...parentCapabilities,
				...seanceIsolationOptions(cwd),
				preloadedExtensionPaths: [extensionPath],
			});
			session = created.session;
			expect(created.session.sessionManager.getAdditionalDirectories()).toEqual([]);
			const startupPrompt = created.session.systemPrompt.join("\n");
			for (const markerName of markerNames) expect(startupPrompt).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);

			expect(created.session.getActiveToolNames().toSorted()).toEqual(["glob", "grep", "read", "yield"]);
			expect(await Bun.file(extensionMarker).exists()).toBe(false);
		} finally {
			try {
				if (session) await session.dispose();
				else await forked.close();
			} finally {
				authStorage.close();
			}
		}
	});

	it("drops a failed pre-ready source fork without loading parent extensions or changing the source", async () => {
		using tempDir = TempDir.createSync("@omp-seance-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const controller = new AbortController();
		const eventBus = new EventBus();
		const id = "SeanceStartup";
		let reachedStartedBoundary = false;
		let extensionLoaded = false;
		let extensionRootsRead = false;

		try {
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
				if (
					!payload ||
					typeof payload !== "object" ||
					!("id" in payload) ||
					payload.id !== id ||
					!("status" in payload) ||
					payload.status !== "started"
				) {
					return;
				}
				reachedStartedBoundary = true;
				controller.abort();
			});
			const extension = hostilePreparedExtension(() => {
				extensionLoaded = true;
			});
			await runSubprocess({
				cwd,
				agent,
				task: "Read the source transcript.",
				assignment: "Consult only the saved source history.",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry,
				modelOverride: ["anthropic/claude-sonnet-4-5"],
				preparedSession: preparedSourceSession(sourceFile, "source-session"),
				artifactsDir,
				preloadedPreparedExtensions: [extension],
				extensionRoots: () => {
					extensionRootsRead = true;
					return {
						explicit: [],
						mode: "merge",
						configured: [],
						configuredLevel: "user",
					};
				},
				enableIrc: true,
				signal: controller.signal,
				eventBus,
			});

			const forkFile = path.join(artifactsDir, `${id}.jsonl`);
			expect(reachedStartedBoundary).toBe(true);
			expect(await Bun.file(forkFile).exists()).toBe(false);
			expect(extensionLoaded).toBe(false);
			expect(extensionRootsRead).toBe(false);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("cold-revives the full persisted runtime prompt and retains restricted tools", async () => {
		using tempDir = TempDir.createSync("@omp-seance-cold-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceRoot = path.join(tempDir.path(), "source-additional");
		const settingsRoot = path.join(tempDir.path(), "settings-additional");
		await Promise.all([sourceRoot, settingsRoot].map(directory => fs.mkdir(directory, { recursive: true })));
		const markerNames = ["cold-cwd-tree-leak.txt", "cold-source-tree-leak.txt", "cold-settings-tree-leak.txt"];
		await Promise.all(
			[
				path.join(cwd, markerNames[0]),
				path.join(sourceRoot, markerNames[1]),
				path.join(settingsRoot, markerNames[2]),
			].map(file => Bun.write(file, "must not be discovered")),
		);
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd, [sourceRoot]);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const seanceSettings = Settings.isolated({
			"workspace.additionalDirectories": [settingsRoot],
			includeWorkspaceTree: true,
		});
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		let liveSession: AgentSession | undefined;
		let revived: AgentSession | undefined;
		let forkManagerClosed = false;
		try {
			const seanceAgent = getBundledAgent("seance");
			if (!seanceAgent) throw new Error("Expected the bundled seance agent");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5");
			const resolvedModel = `${model.provider}/${model.id}`;
			const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
				agent: seanceAgent.systemPrompt,
				context: "",
				planReference: "",
				planReferencePath: "",
				worktree: "",
				outputSchema: undefined,
				outputSchemaOverridesAgent: false,
				workPoolYieldItems: [],
				ircPeers: [],
				ircParkedCount: 0,
				ircOmittedCount: 0,
				ircSelfId: "",
			});
			const assignmentPrompt = prompt.render(seanceAssignmentTemplate, {
				sourceSession: "source-session",
				model: resolvedModel,
			});
			let defaultPromptBlocks: string[] = [];
			const live = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model,
				settings: seanceSettings,
				sessionManager: forked,
				agentId: "SeanceCold",
				agentDisplayName: "seance",
				agentName: "seance",
				taskDepth: 1,
				toolNames: ["read", "grep", "glob"],
				requireYieldTool: true,
				...seanceIsolationOptions(cwd),
				systemPrompt: defaultPrompt => {
					defaultPromptBlocks = [...defaultPrompt];
					return [...defaultPrompt, subagentPrompt, assignmentPrompt];
				},
			});
			liveSession = live.session;
			expect(liveSession.sessionManager.getAdditionalDirectories()).toEqual([]);
			const persistedTools = liveSession.getEnabledToolNames().filter(name => name !== "write");
			liveSession.sessionManager.appendSessionInit({
				systemPrompt: liveSession.agent.state.systemPrompt,
				task: "Read the source transcript.",
				tools: persistedTools,
				agent: "seance",
				resolvedModel,
				restrictToolNames: true,
				spawns: "",
			});
			await liveSession.sessionManager.ensureOnDisk();
			const warmPrompt = [...liveSession.systemPrompt];
			for (const markerName of markerNames) expect(warmPrompt.join("\n")).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			const warmToolNames = liveSession.getActiveToolNames().toSorted();
			const persisted = await SessionManager.peekSessionInit(sessionFile);
			if (!persisted?.init) throw new Error("Expected the fresh seance runtime contract to be persisted");
			expect(warmPrompt).toEqual([...defaultPromptBlocks, subagentPrompt, assignmentPrompt]);
			expect(persisted.init.systemPrompt).toEqual(warmPrompt);
			expect(persisted.init.tools.toSorted()).toEqual(warmToolNames);
			expect(persisted.init.systemPrompt.join("\n")).not.toContain("source-only startup contract");
			await liveSession.dispose();
			liveSession = undefined;
			forkManagerClosed = true;

			let extensionLoaded = false;
			const extension = hostilePreparedExtension(() => {
				extensionLoaded = true;
			});
			const ref = AgentRegistry.global().register({
				id: "SeanceCold",
				displayName: "seance",
				kind: "sub",
				parentId: "Main",
				status: "parked",
				session: null,
				sessionFile,
			});
			const createReviver = createPersistedSubagentReviverFactory({
				session: revivalParent(cwd, [extension]),
				authStorage,
				modelRegistry,
				settings: seanceSettings,
				enableLsp: true,
			});
			const revive = await createReviver(ref);
			if (!revive) throw new Error("Expected a cold seance reviver");
			revived = await revive(ref);
			expect(revived.sessionManager.getAdditionalDirectories()).toEqual([]);

			expect(revived.systemPrompt).toEqual(warmPrompt);
			for (const markerName of markerNames) expect(revived.systemPrompt.join("\n")).not.toContain(markerName);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			expect(warmToolNames).toEqual(["glob", "grep", "read", "yield"]);
			expect(revived.getActiveToolNames().toSorted()).toEqual(warmToolNames);
			expect(extensionLoaded).toBe(false);
		} finally {
			try {
				await revived?.dispose();
			} finally {
				try {
					if (liveSession) await liveSession.dispose();
					else if (!forkManagerClosed) await forked.close();
				} finally {
					authStorage.close();
					setAgentDir(previousAgentDir);
				}
			}
		}
	});

	it("does not offer a cold reviver when startup failed after forking but before its restricted init", async () => {
		using tempDir = TempDir.createSync("@omp-seance-failed-start-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		await writeSourceSession(sourceFile, cwd);
		const forked = await forkSeance(sourceFile, cwd, path.join(tempDir.path(), "forks", "seance.jsonl"));
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		await forked.close();
		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek).toMatchObject({ seanceSource: path.resolve(sourceFile), init: null });

		const createReviver = createPersistedSubagentReviverFactory({
			session: revivalParent(cwd, []),
			authStorage: {} as AuthStorage,
			modelRegistry: {} as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: false,
		});
		const reviver = await createReviver({
			id: "FailedSeance",
			displayName: "seance",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
			createdAt: 0,
			lastActivity: 0,
		});
		expect(reviver).toBeUndefined();
	});
});
