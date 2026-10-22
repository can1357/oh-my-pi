/**
 * The memory snapshot a branch must record for itself.
 *
 * A branch move — a fork into a new session file, a rewind, an `ask`
 * re-answer, a manual tool replay — can leave the session's prompt carrying
 * the memory block while the branch the session continues on holds no snapshot
 * of its own. A later resume then rereads the memory files and rebuilds a
 * different prompt. Every test below drives one of those moves and asserts
 * what the transcript ends up containing, or what a later resume restores.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	saveLearnedLesson,
	stagedMemorySnapshot,
} from "@oh-my-pi/pi-coding-agent/memories";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

const MEMORY_SNAPSHOT_TYPE = "memory-snapshot";
const LESSON = "Lesson at session start";
const LATER_LESSON = "Learned after the branch move";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	tempDir: TempDir;
	agentDir: string;
	cwd: string;
	settings: Settings;
	sessionsDir: string;
	/** The memory block the session's base prompt carries. */
	block: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		await harness?.session.dispose();
		harness?.tempDir.removeSync();
	}
});

/**
 * Build a session whose base prompt carries the memory block.
 *
 * `memoryState: "now"` creates the transcript's memory state up front (a fresh
 * session); `"later"` leaves it to {@link armMemoryState}, which stands in for
 * the startup recording a resumed session performs: the snapshot is appended
 * after the persisted tail, so a branch move that cuts earlier leaves the
 * branch without a snapshot of its own.
 */
async function createHarness(options: {
	responses: MockResponseSource;
	tools?: AgentTool[];
	extensionRunner?: unknown;
	memoryState?: "now" | "later";
}): Promise<Harness> {
	const tempDir = TempDir.createSync("@omp-memory-snapshot-branch-");
	const agentDir = path.join(tempDir.path(), "agent");
	const sessionsDir = path.join(tempDir.path(), "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	const settings = Settings.isolated({
		"memory.backend": "local",
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
	});
	await settings.reloadForCwd(tempDir.path());
	const cwd = settings.getCwd();
	await saveLearnedLesson(agentDir, cwd, { content: LESSON });

	const sessionManager = SessionManager.create(cwd, sessionsDir);
	const block =
		options.memoryState === "now"
			? await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, sessionManager)
			: await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings);
	if (!block) throw new Error("Expected a memory block");

	const mock = createMockModel({ responses: options.responses });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: [block], tools: options.tools ?? [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		extensionRunner: options.extensionRunner as never,
	});
	session.subscribe(() => {});
	const harness = { session, sessionManager, mock, tempDir, agentDir, cwd, settings, sessionsDir, block };
	harnesses.push(harness);
	return harness;
}

/** The startup recording of a resumed session: the snapshot lands after the persisted tail. */
async function armMemoryState(harness: Harness): Promise<void> {
	await buildMemoryToolDeveloperInstructions(harness.agentDir, harness.cwd, harness.settings, harness.sessionManager);
	const recorder = stagedMemorySnapshot(harness.sessionManager)?.commit([harness.block]);
	recorder?.();
}

/** How many memory snapshots the active branch records. */
function snapshotCount(sessionManager: SessionManager): number {
	let count = 0;
	for (const entry of sessionManager.getBranchView()) {
		if (entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_TYPE) count++;
	}
	return count;
}

/** The first user message entry of the active branch. */
function firstUserEntryId(sessionManager: SessionManager): string | undefined {
	for (const entry of sessionManager.getBranchView()) {
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	return undefined;
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("memory snapshot on the branch a session continues on", () => {
	it("records the snapshot on the file a fork into a new session carries", async () => {
		const harness = await createHarness({
			responses: [
				{ content: ["first"], stopReason: "stop" },
				{ content: ["second"], stopReason: "stop" },
			],
			memoryState: "later",
		});

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();
		await armMemoryState(harness);
		expect(snapshotCount(harness.sessionManager)).toBe(1);

		// The user forks at the first user message: the new file holds the path
		// up to that message, which predates the recorded snapshot.
		const userEntryId = firstUserEntryId(harness.sessionManager);
		if (!userEntryId) throw new Error("Expected a user entry");
		const sourceFile = harness.sessionManager.getSessionFile();
		await harness.session.fork(userEntryId);
		const forkedFile = harness.sessionManager.getSessionFile();
		if (!forkedFile) throw new Error("Expected a forked session file");
		expect(forkedFile).not.toBe(sourceFile);
		expect(snapshotCount(harness.sessionManager)).toBe(0);

		// The next turn continues on the forked branch, under the same
		// memory-bearing base prompt.
		await harness.session.prompt("again");
		await harness.session.waitForIdle();

		// The forked branch must record the memory block its prompt carries.
		expect(snapshotCount(harness.sessionManager)).toBe(1);

		// A later resume of the forked file restores that block instead of
		// rereading the memory files.
		await saveLearnedLesson(harness.agentDir, harness.cwd, { content: LATER_LESSON });
		await harness.session.flushToDisk();
		const resumed = await SessionManager.open(forkedFile, harness.sessionsDir);
		const rebuilt = await buildMemoryToolDeveloperInstructions(
			harness.agentDir,
			harness.cwd,
			harness.settings,
			resumed,
		);
		expect(rebuilt).toContain(LESSON);
		expect(rebuilt).not.toContain(LATER_LESSON);
	});

	it("records no snapshot when the turn's final prompt drops the memory block", async () => {
		const harness = await createHarness({
			responses: [{ content: ["done"], stopReason: "stop" }],
			memoryState: "now",
			extensionRunner: {
				hasHandlers: () => false,
				emit: async () => undefined,
				emitBeforeAgentStart: async () => ({ systemPrompt: ["a prompt without the memory block"] }),
			},
		});

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		// The extension replaced the prompt, so the provider never received the
		// memory block: the transcript must not claim one.
		expect(snapshotCount(harness.sessionManager)).toBe(0);

		// A later resume rereads the memory files instead of restoring the stale
		// block the provider never saw.
		await saveLearnedLesson(harness.agentDir, harness.cwd, { content: LATER_LESSON });
		await harness.session.flushToDisk();
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		const resumed = await SessionManager.open(file, harness.sessionsDir);
		const rebuilt = await buildMemoryToolDeveloperInstructions(
			harness.agentDir,
			harness.cwd,
			harness.settings,
			resumed,
		);
		expect(rebuilt).toContain(LATER_LESSON);
	});

	it("records the snapshot on the branch a checkpoint rewind continues on", async () => {
		const checkpointSchema = type({ goal: type("string") });
		const rewindSchema = type({ report: type("string") });
		const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
			name: "checkpoint",
			label: "Checkpoint",
			description: "Create a checkpoint",
			parameters: checkpointSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "checkpoint" }],
					details: { startedAt: "2026-01-01T00:00:00.000Z" },
				};
			},
		};
		const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
			name: "rewind",
			label: "Rewind",
			description: "Rewind to the checkpoint",
			parameters: rewindSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: "rewind requested" }],
					details: { report: params.report, rewound: true },
				};
			},
		};

		const harness = await createHarness({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
					],
					stopReason: "toolUse",
				},
				{ content: ["checkpointed"], stopReason: "stop" },
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind",
							name: "rewind",
							arguments: { report: "back to the checkpoint" },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			tools: [checkpointTool as AgentTool, rewindTool as AgentTool],
			memoryState: "later",
		});

		// The checkpoint is created first; the snapshot the startup records lands
		// after it, so the rewind moves the leaf past the snapshot.
		await harness.session.prompt("investigate with a checkpoint");
		await harness.session.waitForIdle();
		await armMemoryState(harness);
		expect(snapshotCount(harness.sessionManager)).toBe(1);

		await harness.session.prompt("rewind to the checkpoint");
		await harness.session.waitForIdle();

		// The branch the turn continued on holds a snapshot of its own: the
		// rewind cut the recorded one away.
		expect(snapshotCount(harness.sessionManager)).toBe(1);
	});

	it("records the snapshot on the sibling branch an ask re-answer continues on", async () => {
		const harness = await createHarness({
			responses: [{ content: ["resumed"], stopReason: "stop" }],
			memoryState: "later",
		});

		const { session, sessionManager } = harness;
		const questions = [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: [{ label: "staging" }, { label: "production" }],
			},
		];
		sessionManager.appendMessage(userMsg("please deploy"));
		const askCallId = "ask-call-1";
		sessionManager.appendMessage({
			...assistantMsg(""),
			content: [
				{
					type: "toolCall" as const,
					id: askCallId,
					name: "ask",
					arguments: { questions },
				},
			],
			stopReason: "toolUse" as const,
		});
		const askResultId = sessionManager.appendMessage({
			role: "toolResult" as const,
			toolCallId: askCallId,
			toolName: "ask",
			content: [{ type: "text" as const, text: "User selected: staging" }],
			details: { question: questions[0].question, options: ["staging"], multi: false, selectedOptions: ["staging"] },
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistantMsg("deploying to staging"));
		await armMemoryState(harness);
		expect(snapshotCount(sessionManager)).toBe(1);

		const newAnswer: AgentToolResult<AskToolDetails> = {
			content: [{ type: "text", text: "User selected: production" }],
			details: {
				question: questions[0].question,
				options: ["staging", "production"],
				multi: false,
				selectedOptions: ["production"],
			},
		};

		const probe = await session.navigateTree(askResultId, { allowAskReopen: true });
		expect(probe.reopenAsk).toBeDefined();
		const committed = await session.navigateTree(askResultId, {
			allowAskReopen: true,
			reanswerAskResult: newAnswer,
		});
		expect(committed.askReanswerCommitted).toBe(true);

		// The sibling branch predates the recorded snapshot.
		expect(snapshotCount(sessionManager)).toBe(0);

		session.resumeAfterAskReanswer();
		await session.waitForIdle();

		// The continuation sends the memory-bearing prompt, so the sibling branch
		// must record a snapshot of its own.
		expect(snapshotCount(sessionManager)).toBe(1);
	});

	it("records the snapshot on the branch a manual tool replay continues on", async () => {
		const probeSchema = type({ value: type("string") });
		const probeTool: AgentTool<typeof probeSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute() {
				throw new Error("probe failed");
			},
		};

		const harness = await createHarness({
			responses: [
				{
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				},
				{ throw: "the provider failed after the tool batch" },
				{ content: ["recovered after replay"], stopReason: "stop" },
			],
			tools: [probeTool as AgentTool],
			memoryState: "later",
		});

		// The failed tool batch is persisted first; the snapshot the startup
		// records lands after it.
		await harness.session.prompt("run the probe");
		await harness.session.waitForIdle();
		await armMemoryState(harness);
		expect(snapshotCount(harness.sessionManager)).toBe(1);

		await expect(harness.session.retry()).resolves.toBe(true);
		await harness.session.waitForIdle();

		// The replay branches back to the tool-calling assistant, so the branch
		// the continuation runs on must record a snapshot of its own.
		expect(snapshotCount(harness.sessionManager)).toBe(1);
	});
});
