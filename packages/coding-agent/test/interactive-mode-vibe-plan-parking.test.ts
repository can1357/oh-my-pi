/** Plan temporarily borrows Vibe's scope; approval, retries and reopening preserve its workers. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

class FaultStorage extends FileSessionStorage {
	failNextAtomicWrite = false;

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextAtomicWrite) {
			this.failNextAtomicWrite = false;
			throw Object.assign(new Error("journal publish failed"), { code: "ENOSPC" });
		}
		await super.writeTextAtomic(filePath, content, options);
	}
}

describe("InteractiveMode vibe parked by plan mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let storage: FaultStorage;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-vibe-plan-parking-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		storage = new FaultStorage();
		createMode(SessionManager.create(tempDir.path(), tempDir.path(), storage));
	});

	function createMode(manager: SessionManager): void {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const registryTools = [stubTool("read"), stubTool("todo")];
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: () => {
					throw new Error("No test stream configured");
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	}

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function seedWorker(): Promise<string> {
		await session.sessionManager.ensureOnDisk();
		const parentFile = session.sessionFile;
		if (!parentFile) throw new Error("Expected persisted parent");
		const child = SessionManager.create(tempDir.path(), tempDir.path());
		child.appendSessionInit({
			systemPrompt: ["Worker"],
			task: "Remember the migration decision",
			tools: ["read"],
			agent: "sonic",
		});
		child.appendMessage({ role: "user", content: "Keep the existing migration format.", timestamp: Date.now() });
		await child.ensureOnDisk();
		await child.flush();
		const source = child.getSessionFile();
		if (!source) throw new Error("Expected persisted worker");
		const childFile = `${parentFile.slice(0, -6)}/PlanWorker.jsonl`;
		await Bun.write(childFile, await Bun.file(source).text());
		await child.close();
		const parent = {
			getAgentId: () => session.getAgentId() ?? null,
			getSessionId: () => session.sessionManager.getSessionId(),
			getSessionFile: () => session.sessionFile ?? null,
			sessionManager: session.sessionManager,
			settings: session.settings,
		};
		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(parent);
		const base = { version: 1, id: "PlanWorker", ownerId: scope.ownerId, parentSessionId: scope.parentSessionId };
		session.sessionManager.appendCustomEntry("vibe-session-lifecycle", {
			...base,
			action: "spawn",
			cli: "fast",
			agent: "sonic",
			childSessionFile: "PlanWorker.jsonl",
			createdAt: Date.now(),
		});
		session.sessionManager.appendCustomEntry("vibe-session-lifecycle", { ...base, action: "turn-started", turn: 1 });
		session.sessionManager.appendCustomEntry("vibe-session-lifecycle", { ...base, action: "turn-settled", turn: 1 });
		await registry.rehydrate(parent);
		expect(AgentRegistry.global().get("PlanWorker")?.sessionFile).toBe(childFile);
		return childFile;
	}

	async function reopenSource(beforeReturn?: () => void): Promise<void> {
		await session.sessionManager.flush();
		const sourceFile = session.sessionFile;
		if (!sourceFile) throw new Error("Expected persisted source");
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendModeChange("none");
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target");
		await target.close();
		expect(await session.switchSession(targetFile)).toBe(true);
		beforeReturn?.();
		expect(await session.switchSession(sourceFile)).toBe(true);
	}

	async function writePlan(content: string, planFilePath = mode.planModePlanFilePath): Promise<string> {
		if (!planFilePath) throw new Error("Expected active plan");
		await Bun.write(
			resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			}),
			content,
		);
		return planFilePath;
	}

	it("holds compacted user input until Vibe owns every execution turn", async () => {
		await mode.handleVibeModeCommand();
		await seedWorker();
		await mode.handlePlanModeCommand();
		const planFilePath = await writePlan("# Migration\nKeep the workers.");
		session.sessionManager.appendMessage({ role: "user", content: "seed one", timestamp: Date.now() });
		session.sessionManager.appendMessage({ role: "user", content: "seed two", timestamp: Date.now() });
		const firstKeptEntryId = session.sessionManager.getLeafId();
		if (!firstKeptEntryId) throw new Error("Expected a transcript to compact");
		const provider = createMockModel({ handler: () => ({ content: ["Execution delegated."] }) });
		session.agent.streamFn = provider.stream;
		const prompts = vi.spyOn(session, "prompt");
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(session, "compact").mockImplementation(async () => {
			mode.queueCompactionMessage("queued operator directive", "followUp");
			return { summary: "Migration plan ready.", firstKeptEntryId, tokensBefore: 100 };
		});
		const activationStarted = Promise.withResolvers<void>();
		const releaseActivation = Promise.withResolvers<void>();
		const activate = session.activateVibeTools.bind(session);
		vi.spyOn(session, "activateVibeTools").mockImplementation(async tools => {
			activationStarted.resolve();
			await releaseActivation.promise;
			await activate(tools);
		});
		const approval = mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });
		await activationStarted.promise;
		try {
			expect(mode.compactionQueuedMessages.map(message => message.text)).toEqual(["queued operator directive"]);
			expect(session.isStreaming).toBe(false);
		} finally {
			releaseActivation.resolve();
			await approval;
			await Promise.all(prompts.mock.results.map(result => result.value));
			await session.waitForIdle();
		}
		expect(provider.calls).toHaveLength(2);
		expect(provider.calls[0].context.tools?.map(tool => tool.name)).toContain("vibe_spawn");
		expect(provider.calls.at(-1)?.context.tools?.map(tool => tool.name)).toContain("vibe_spawn");
	});

	it("keeps queued input from draining while the approved plan compacts", async () => {
		await mode.handleVibeModeCommand();
		await seedWorker();
		await mode.handlePlanModeCommand();
		const planFilePath = await writePlan("# Migration\nPreserve workers.");
		session.sessionManager.appendMessage({ role: "user", content: "seed one", timestamp: Date.now() });
		session.sessionManager.appendMessage({ role: "user", content: "seed two", timestamp: Date.now() });
		const firstKeptEntryId = session.sessionManager.getLeafId();
		if (!firstKeptEntryId) throw new Error("Expected a transcript to compact");
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");

		// Compaction's own `finally` reconnects and drains stranded queued messages;
		// approval must keep that drain suppressed until Vibe and the execution model
		// are back, or the queued turn runs on the plain plan toolset.
		let suppressionDepth = 0;
		let depthDuringCompaction = -1;
		const runTeardown = session.runModeExitTeardown.bind(session);
		vi.spyOn(session, "runModeExitTeardown").mockImplementation(async teardown => {
			suppressionDepth++;
			try {
				await runTeardown(teardown);
			} finally {
				suppressionDepth--;
			}
		});
		vi.spyOn(session, "compact").mockImplementation(async () => {
			depthDuringCompaction = suppressionDepth;
			return { summary: "Migration plan ready.", firstKeptEntryId, tokensBefore: 100 };
		});
		const provider = createMockModel({ handler: () => ({ content: ["Execution delegated."] }) });
		session.agent.streamFn = provider.stream;

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });

		expect(depthDuringCompaction).toBeGreaterThan(0);
		expect(mode.vibeModeEnabled).toBe(true);
	});

	it.each(["ok", "cancelled", "throw"] as const)(
		"restores the same worker after approved-plan compaction: %s",
		async outcome => {
			await mode.handleVibeModeCommand();
			const childFile = await seedWorker();
			await mode.handlePlanModeCommand();
			const planFilePath = await writePlan("# Plan\nPreserve worker conversations.");
			vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
			const provider = createMockModel({ handler: () => ({ content: ["Execution delegated."] }) });
			session.agent.streamFn = provider.stream;
			const compact = vi.spyOn(mode, "handleCompactCommand");
			if (outcome === "throw") compact.mockRejectedValue(new Error("Compaction failed"));
			else compact.mockResolvedValue(outcome);
			await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });
			expect(mode.vibeModeEnabled).toBe(true);
			expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
			expect(provider.calls).toHaveLength(outcome === "ok" ? 1 : 0);
			if (outcome === "ok") {
				expect(provider.calls[0].context.tools?.map(tool => tool.name)).toContain("vibe_spawn");
			}
		},
	);

	it("approves into a fresh execution context without replacing the worker's parent", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		const sessionId = session.sessionManager.getSessionId();
		session.agent.replaceMessages([
			{ role: "user", content: "Discard this pre-plan discussion.", timestamp: Date.now() },
		]);
		await mode.handlePlanModeCommand();
		const planFilePath = await writePlan("# Migration\nImplement the approved migration.");
		const provider = createMockModel({ handler: () => ({ content: ["Execution delegated."] }) });
		session.agent.streamFn = provider.stream;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
		expect(provider.calls).toHaveLength(1);
		expect(JSON.stringify(provider.calls[0].context.messages)).not.toContain("Discard this pre-plan discussion.");
		expect(provider.calls[0].context.tools?.map(tool => tool.name)).toContain("vibe_spawn");
	});

	it("restores Vibe when plan entry fails after parking", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		vi.spyOn(session, "setActiveToolsByName").mockRejectedValueOnce(new Error("tool activation failed"));

		await expect(mode.handlePlanModeCommand()).rejects.toThrow("tool activation failed");

		// No plan mode means no `/plan` to exit: leaving Vibe parked here would strand it.
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getVibeModeState()).toEqual({ enabled: true });
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("refuses fresh-context approval when the context reset is refused", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		const planFilePath = await writePlan("# Migration\nImplement the approved migration.");
		session.agent.replaceMessages([
			{
				role: "user",
				content: "Planning notes must not survive a fresh execution context.",
				timestamp: Date.now(),
			},
		]);
		// A foreground command in flight makes resetSessionContext() refuse.
		Object.defineProperty(session, "isBashRunning", { value: true, configurable: true });
		const errors: string[] = [];
		vi.spyOn(mode, "showError").mockImplementation(message => {
			errors.push(message);
		});
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });

		expect(errors.some(message => message.includes("Failed to finalize approved plan"))).toBe(true);
		expect(JSON.stringify(session.messages)).toContain("Planning notes must not survive");
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("keeps the plan but reports a refused reset on Save and quit", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		const planContent = "# Migration\nKeep the agreed format.";
		const planFilePath = await writePlan(planContent);
		const destination = `${tempDir.path()}/refused-reset-plan.md`;
		Object.defineProperty(session, "isBashRunning", { value: true, configurable: true });
		const errors: string[] = [];
		vi.spyOn(mode, "showError").mockImplementation(message => {
			errors.push(message);
		});
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Save and quit");
		vi.spyOn(mode, "showHookCustom").mockResolvedValue({ path: destination });
		vi.spyOn(session, "generateTitle").mockResolvedValue("Migration");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });

		expect(await Bun.file(destination).text()).toBe(planContent);
		expect(errors.some(message => message.includes("could not be reset"))).toBe(true);
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("restores Vibe even when Save and quit cannot reset the context", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		const planContent = "# Migration\nKeep the agreed format.";
		const planFilePath = await writePlan(planContent);
		const destination = `${tempDir.path()}/reset-threw-plan.md`;
		const errors: string[] = [];
		vi.spyOn(mode, "showError").mockImplementation(message => {
			errors.push(message);
		});
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Save and quit");
		vi.spyOn(mode, "showHookCustom").mockResolvedValue({ path: destination });
		vi.spyOn(session, "generateTitle").mockResolvedValue("Migration");
		vi.spyOn(session, "resetSessionContext").mockRejectedValue(new Error("base prompt refresh failed"));

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });

		expect(await Bun.file(destination).text()).toBe(planContent);
		expect(errors.some(message => message.includes("could not reset the context"))).toBe(true);
		expect(errors.some(message => message.includes("base prompt refresh failed"))).toBe(true);
		// Plan mode is already exited here, so a parked Vibe with no `/plan` left to
		// run would strand its workers.
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("releases a parked source scope when switching saved sessions", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		await session.sessionManager.flush();
		const sourceFile = session.sessionFile;
		if (!sourceFile) throw new Error("Expected persisted source");
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendModeChange("none");
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target");
		await target.close();

		expect(await session.switchSession(targetFile)).toBe(true);
		// A parked scope keeps live worker refs, so it must be suspended on the way
		// out exactly like an active one; otherwise a destination worker reusing the
		// id resolves against this parent's ref and is rejected.
		expect(AgentRegistry.global().get("PlanWorker")).toBeUndefined();

		expect(await session.switchSession(sourceFile)).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("saves the plan and restores its parked workers without changing their parent", async () => {
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		const sessionId = session.sessionManager.getSessionId();
		await mode.handlePlanModeCommand();
		const planContent = "# Migration\nKeep the agreed format.";
		const planFilePath = await writePlan(planContent);
		const destination = `${tempDir.path()}/saved-plan.md`;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Save and quit");
		vi.spyOn(mode, "showHookCustom").mockResolvedValue({ path: destination });
		vi.spyOn(session, "generateTitle").mockResolvedValue("Migration");
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration plan" });
		expect(await Bun.file(destination).text()).toBe(planContent);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it.each(["retry", "reopen"] as const)("recovers a failed Vibe journal publish through %s", async recovery => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		await mode.handlePlanModeCommand();
		await session.sessionManager.flush();
		storage.failNextAtomicWrite = true;
		await expect(mode.handlePlanModeCommand()).rejects.toThrow("journal publish failed");
		expect(mode.vibeModeEnabled).toBe(false);
		if (recovery === "retry") {
			await mode.handleVibeModeCommand();
		} else {
			await reopenSource();
		}
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});

	it("retains a live in-memory worker conversation through the full plan cycle", async () => {
		mode.stop();
		await session.dispose();
		const manager = SessionManager.inMemory(tempDir.path());
		vi.spyOn(manager, "getSessionId").mockReturnValue("test-parent-session");
		createMode(manager);
		await mode.handleVibeModeCommand();
		const model = session.model;
		if (!model) throw new Error("Expected worker model");
		const provider = createMockModel({ handler: () => ({ content: ["Continuing the migration."] }) });
		const child = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Worker"],
					tools: [],
					messages: [{ role: "user", content: "Keep the existing migration format.", timestamp: Date.now() }],
				},
				streamFn: provider.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		const ownerId = session.getAgentId() ?? "Main";
		VibeSessionRegistry.global().registerRecordForTests({ id: "MemoryWorker", ownerId, state: "idle" });
		AgentRegistry.global().register({
			id: "MemoryWorker",
			displayName: "MemoryWorker",
			kind: "sub",
			parentId: ownerId,
			session: child,
			sessionFile: null,
			status: "idle",
		});
		try {
			await mode.handlePlanModeCommand();
			await mode.handlePlanModeCommand();
			await mode.handlePlanModeCommand();
			expect(mode.vibeModeEnabled).toBe(true);
			const resumed = AgentRegistry.global().get("MemoryWorker")?.session;
			if (!resumed) throw new Error("Worker conversation was lost");
			await resumed.prompt("Continue after planning.");
			expect(JSON.stringify(provider.calls[0].context.messages)).toContain("Keep the existing migration format.");
		} finally {
			await child.dispose();
		}
	});

	it("parks workers while plan is paused and restores the original tools after leaving Vibe", async () => {
		await session.setActiveToolsByName(["read"]);
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getEnabledToolNames()).not.toContain("vibe_spawn");
		await mode.handlePlanModeCommand();
		expect(mode.planModePaused).toBe(true);
		expect(mode.vibeModeEnabled).toBe(false);
		await mode.handlePlanModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
		await mode.handleVibeModeCommand();
		expect(session.getEnabledToolNames()).toEqual(["read"]);
	});

	it.each([true, false])(
		"keeps parked Vibe after reviewing a new plan path with plan.enabled=%s",
		async planEnabled => {
			await mode.init({ suppressWelcomeIntro: true });
			await mode.handleVibeModeCommand();
			const childFile = await seedWorker();
			await mode.handlePlanModeCommand();
			const planFilePath = await writePlan("# Migration\nKeep the format.", "local://migration-plan.md");
			vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
			await mode.handlePlanApproval({ planFilePath, planExists: true, title: "Migration" });
			await reopenSource(() => cfgPlanEnabled.set(session.settings, planEnabled));
			if (planEnabled) {
				await expect(session.moveSession(tempDir.path(), `${tempDir.path()}/moved`)).rejects.toThrow(/plan mode/);
				vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
				await mode.handlePlanModeCommand();
				await mode.handlePlanModeCommand();
			}
			expect(mode.vibeModeEnabled).toBe(true);
			expect(AgentRegistry.global().get("PlanWorker")?.sessionFile).toBe(childFile);
		},
	);

	it.each([
		{ planEnabled: true, paused: false },
		{ planEnabled: true, paused: true },
		{ planEnabled: false, paused: false },
	])("restores persisted workers with %j", async ({ planEnabled, paused }) => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		const childFile = await seedWorker();
		await mode.handlePlanModeCommand();
		if (paused) await mode.handlePlanModeCommand();
		await reopenSource(() => cfgPlanEnabled.set(session.settings, planEnabled));
		if (planEnabled) {
			expect(mode.planModeEnabled).toBe(!paused);
			expect(mode.planModePaused).toBe(paused);
			expect(mode.vibeModeEnabled).toBe(false);
			const parentFile = session.sessionFile;
			await expect(session.moveSession(tempDir.path(), `${tempDir.path()}/moved`)).rejects.toThrow("plan");
			const warning = vi.spyOn(mode, "showWarning");
			await mode.handleMoveCommand(`${tempDir.path()}/moved`);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("plan mode"));
			expect(session.sessionFile).toBe(parentFile);
			if (!paused) await mode.handlePlanModeCommand();
			await mode.handlePlanModeCommand();
		}
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(false);
		expect(mode.vibeModeEnabled).toBe(true);
		expect(AgentRegistry.global().get("PlanWorker")).toMatchObject({ status: "parked", sessionFile: childFile });
	});
});
