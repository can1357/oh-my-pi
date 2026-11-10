import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createToolCallBlock } from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-call-block";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TspAgentProps } from "@oh-my-pi/pi-wire";

const ALPHA = "LiveCardAlpha";
const BETA = "LiveCardBeta";

function aborted(id: string, index: number, task: string): SingleResult {
	return {
		index,
		id,
		agent: "task",
		agentSource: "bundled",
		task,
		exitCode: 1,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1000 + index,
		tokens: 0,
		requests: 0,
		aborted: true,
		abortReason: "Cancelled by user",
	};
}

function progress(id: string, extra: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Reply to Main",
		recentTools: [],
		recentOutput: [],
		toolCount: 1,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...extra,
	};
}

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if ("k" in child) out.push(...nodes(child));
	return out;
}

/** The TSP `agent` node a card draws for `id`. */
function agentProps(card: ToolExecutionComponent, id: string): TspAgentProps {
	const agent = nodes(card.describe()).find(node => node.k === "agent" && node.key === id);
	if (!agent) throw new Error(`No agent node for ${id}`);
	return agent.p as TspAgentProps;
}

/** The ANSI row a card draws for `id`. */
function ansiRow(card: ToolExecutionComponent, id: string): string {
	const row = Bun.stripANSI(card.render(160).join("\n"))
		.split("\n")
		.find(line => line.includes(id));
	if (!row) throw new Error(`No ANSI row for ${id}`);
	return row;
}

describe("settled task card rows follow agents that run again", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	const registry = AgentRegistry.global();

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-task-card-live-agents-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		await mode.init({ suppressWelcomeIntro: true });
		// A TSP surface (Tern) draws the card's agent nodes.
		setNativeRendering(true);
	});

	afterEach(async () => {
		setNativeRendering(false);
		vi.useRealTimers();
		registry.unregister(ALPHA);
		registry.unregister(BETA);
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	/** A cancelled two-agent task call's settled card, mounted in the main transcript. */
	function settledTaskCard(details: TaskToolDetails): ToolExecutionComponent {
		vi.spyOn(session, "hasBuiltInTool").mockImplementation(name => name === "task");
		const card = createToolCallBlock(mode, {
			name: "task",
			args: {
				tasks: [
					{ name: ALPHA, task: "Fix the lexer" },
					{ name: BETA, task: "Fix the parser" },
				],
			},
			tool: undefined,
			id: "call-task",
			cwd: tempDir.path(),
		}) as ToolExecutionComponent;
		mode.chatContainer.addChild(card);
		card.updateResult({ content: [{ type: "text", text: "Task cancelled" }], details, isError: true }, false);
		return card;
	}

	/** A blocking call the user cancelled: one aborted result per agent. */
	function cancelledTaskCard(): ToolExecutionComponent {
		return settledTaskCard({
			projectAgentsDir: null,
			results: [aborted(ALPHA, 0, "Fix the lexer"), aborted(BETA, 1, "Fix the parser")],
			totalDurationMs: 1001,
		});
	}

	/** A transcript path inside the open session's artifacts tree. */
	function inSessionFile(id: string): string {
		const root = mode.sessionManager.getSessionFile();
		if (!root?.endsWith(".jsonl")) throw new Error("Expected a persisted session file");
		return path.join(root.slice(0, -".jsonl".length), `${id}.jsonl`);
	}

	function registerRunning(id: string, session: AgentSessionHandle | null = null) {
		return registry.register({
			id,
			displayName: id,
			kind: "sub",
			session,
			status: "running",
			sessionFile: inSessionFile(id),
		});
	}

	function emitProgress(id: string, extra: Partial<AgentProgress>): void {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Reply to Main",
			parentToolCallId: "call-task",
			progress: progress(id, extra),
		});
	}

	function emitLifecycle(id: string, status: "started" | "aborted"): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: "task",
			agentSource: "bundled",
			status,
			index: 0,
			parentToolCallId: "call-task",
		});
	}

	it("draws a revived agent's node running with its current tool, then its recorded status once the run ends", () => {
		const card = cancelledTaskCard();
		expect(agentProps(card, ALPHA).status).toBe("aborted");
		vi.useFakeTimers();

		registerRunning(ALPHA);
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "running", tool: null });
		expect(agentProps(card, ALPHA).stats?.took).toBeUndefined();
		expect(agentProps(card, BETA).status).toBe("aborted");
		// Terminal rows keep the recorded status: scrollback cannot repaint a `running` row.
		expect(ansiRow(card, ALPHA)).toContain("aborted");

		// The wake turn's run monitor reports its progress on the session tree's bus.
		const readStartMs = Date.now();
		emitProgress(ALPHA, { currentTool: "read", currentToolIntent: "Reading lexer", currentToolStartMs: readStartMs });
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({
			status: "running",
			tool: { name: "read", intent: "Reading lexer" },
		});

		// The same call's streamed intent settles after its first frame.
		emitProgress(ALPHA, {
			currentTool: "read",
			currentToolIntent: "Reading parser",
			currentToolStartMs: readStartMs,
		});
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA).tool).toMatchObject({ name: "read", intent: "Reading parser" });

		registry.setStatus(ALPHA, "idle");
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "aborted", tool: null, stats: { took: 1000 } });
	});

	it("draws a background call's settled progress row running while its agent runs again", () => {
		const card = settledTaskCard({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1001,
			progress: [
				progress(ALPHA, { status: "aborted", task: "Fix the lexer", durationMs: 1000 }),
				progress(BETA, { index: 1, status: "aborted", task: "Fix the parser", durationMs: 1001 }),
			],
			async: { state: "failed", jobId: ALPHA, type: "task" },
		});
		expect(agentProps(card, ALPHA).status).toBe("aborted");
		vi.useFakeTimers();

		registerRunning(ALPHA);
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "running", tool: null });
		expect(agentProps(card, ALPHA).stats?.took).toBeUndefined();
		expect(agentProps(card, BETA).status).toBe("aborted");
	});

	it("shows no tool from the previous turn's last progress snapshot before the new turn reports", () => {
		const card = cancelledTaskCard();
		vi.useFakeTimers();

		// The cancelled run's last frame was mid-call; its lifecycle then ended aborted.
		emitProgress(ALPHA, { currentTool: "bash", currentToolStartMs: Date.now() });
		emitLifecycle(ALPHA, "aborted");
		// IRC revives the agent: a wake turn starts before its first progress frame.
		registerRunning(ALPHA);
		emitLifecycle(ALPHA, "started");
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "running", tool: null });
	});

	it("keeps a node recorded while an agent from another session's transcript holds the same id", () => {
		const card = cancelledTaskCard();
		vi.useFakeTimers();

		registerRunning(ALPHA);
		// `/new` started another session whose task call allocated the same name.
		registry.register({
			id: BETA,
			displayName: BETA,
			kind: "sub",
			session: null,
			status: "running",
			sessionFile: path.join(tempDir.path(), "other-session", `${BETA}.jsonl`),
		});
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA).status).toBe("running");
		expect(agentProps(card, BETA).status).toBe("aborted");
	});

	it("returns a node to its recorded status once the run hands over its result, though the ref still streams", () => {
		const card = cancelledTaskCard();
		vi.useFakeTimers();

		const ref = registerRunning(ALPHA, { isStreaming: true } as unknown as AgentSessionHandle);
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA).status).toBe("running");

		registry.markResultAccepted(ALPHA, ref);
		expect(registry.get(ALPHA)?.status).toBe("running");
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA).status).toBe("aborted");
	});

	it("repaints a settled card when the mirrored liveness changes with no registry event", () => {
		const card = cancelledTaskCard();
		vi.useFakeTimers();

		registerRunning(ALPHA);
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA).status).toBe("running");

		// A collab guest writes the host's run lifecycle onto the mirrored ref, so
		// nothing on the registry announces that the run handed over its result.
		const mirrored = registry.get(ALPHA);
		if (!mirrored) throw new Error("Expected the mirrored ref");
		mirrored.lifecycle = { ...mirrored.lifecycle, acceptedAt: Date.now() };
		mode.scheduleLiveTaskCardRefresh();
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "aborted", tool: null, stats: { took: 1000 } });
	});

	it("asks the local registry again once a collab guest leaves, with no registry event", async () => {
		vi.useFakeTimers();
		// A local agent keeps running quietly through the collab session.
		registerRunning(ALPHA);
		vi.advanceTimersByTime(100);
		const guest = new CollabGuestLink(mode);
		mode.setCollabGuest(guest);
		mode.syncRunningSubagentBadge();
		// Leaving rebuilds the local transcript while the guest still holds it: the card asks its empty mirror.
		const card = cancelledTaskCard();
		expect(agentProps(card, ALPHA).status).toBe("aborted");

		await guest.leave("left");
		expect(mode.collabGuest).toBeUndefined();
		vi.advanceTimersByTime(100);
		expect(agentProps(card, ALPHA)).toMatchObject({ status: "running", tool: null });
	});

	it("never redraws a terminal card for an agent that runs again", () => {
		setNativeRendering(false);
		const card = cancelledTaskCard();

		registerRunning(ALPHA);
		emitProgress(ALPHA, { currentTool: "read", currentToolStartMs: Date.now() });
		expect(card.refreshLiveTaskAgents()).toBe(false);
		expect(ansiRow(card, ALPHA)).toContain("aborted");
	});

	it("never asks the live agents about a task card a shadowing extension draws", () => {
		const source = vi.spyOn(mode, "liveTaskAgents");
		const extensionTask: AgentTool = {
			name: "task",
			label: "Extension Task",
			description: "delegates to another runner",
			parameters: { type: "object", additionalProperties: true },
			renderResult: () => new Text("Delegated to the extension runner", 0, 0),
			async execute() {
				return { content: [{ type: "text", text: "Delegated" }] };
			},
		};
		vi.spyOn(session, "hasBuiltInTool").mockReturnValue(false);
		const card = createToolCallBlock(mode, {
			name: "task",
			args: { job: ALPHA },
			tool: extensionTask,
			id: "call-extension-task",
			cwd: tempDir.path(),
		}) as ToolExecutionComponent;
		mode.chatContainer.addChild(card);
		registerRunning(ALPHA);

		// The extension's details share only the built-in's `results` array name.
		const details = { results: [{ id: ALPHA }, null] };
		expect(() =>
			card.updateResult({ content: [{ type: "text", text: "Delegated" }], details, isError: false }, false),
		).not.toThrow();
		expect(card.refreshLiveTaskAgents()).toBe(false);
		expect(source).not.toHaveBeenCalled();
		expect(Bun.stripANSI(card.render(160).join("\n"))).toContain("Delegated to the extension runner");
	});

	it("catches a card up when native rendering resumes while its agent runs again", () => {
		const card = cancelledTaskCard();
		vi.useFakeTimers();
		// An external editor stops the native surface; agent events meanwhile reach a terminal card.
		setNativeRendering(false);
		registerRunning(ALPHA);
		vi.advanceTimersByTime(100);

		setNativeRendering(true);
		expect(agentProps(card, ALPHA).status).toBe("running");
	});
});
