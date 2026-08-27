import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { DANGLING_TOOL_EXECUTION_REASON } from "@oh-my-pi/pi-coding-agent/session/tool-journal-correlation";
import { TempDir } from "@oh-my-pi/pi-utils";
import { captureKillMidToolJournal, KILL_MID_TOOL_COMMAND_MARKER } from "./helpers/kill-mid-tool-capture";

/**
 * `rebuildChatFromMessages` against a v4-journaled dangling tool call.
 *
 * A `presentation_events` call persists its `tool_execution_started` record the
 * moment it starts, so a *running* tool's record is on the branch for the whole
 * execution while its `tool_execution_settled` counterpart is still missing. The
 * assistant turn that carried the call is committed at `message_end`, before
 * `executeToolCalls` runs, so a mid-stream rebuild (`/shake`, auto-compaction, a
 * settings toggle) sees a journal-covered dangling call whose live component is
 * simultaneously in `pendingTools` — the fold says `interrupted`, the live
 * component says running, and both want to own the same on-screen block.
 *
 * The preserve-and-restore bookkeeping in `rebuildChatFromMessages` already
 * declares who wins that: a call whose live component survives the rebuild is
 * the sole render owner (`preservedLiveToolCallIds`), and the replay renders
 * nothing for it. The second test is the plain resumed-session case, where no
 * live component exists and the interrupted card is what must render.
 */
const CMD = "sleep 60 # MARKER_IMODE_DANGLE_7QZ4";
const TITLE = "Run MARKER_IMODE_TITLE_7QZ4";
const ELISION_NOTICE = "tool call elided";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** User turn, its assistant turn carrying a dangling `call-1`, and that call's `started` journal record. */
function journaledDanglingEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-21T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-08-21T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: CMD } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "tool_execution_started",
			id: "j1",
			parentId: "m2",
			timestamp: "2026-08-21T00:00:02.000Z",
			recordVersion: 1,
			executionId: toolExecutionId("exec-IMODE0001"),
			call: {
				toolCallId: "call-1",
				toolName: "bash",
				title: TITLE,
				kind: "execute",
				rawInput: { command: CMD },
			},
			presentation: { version: 1, facts: [] },
		},
	] as unknown as SessionEntry[];
}

function renderChat(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
}

function countCommand(mode: InteractiveMode): number {
	const rendered = renderChat(mode);
	let count = 0;
	let index = 0;
	while (true) {
		const found = rendered.indexOf(CMD, index);
		if (found === -1) return count;
		count++;
		index = found + CMD.length;
	}
}

function toolCards(mode: InteractiveMode): ToolExecutionComponent[] {
	return mode.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

describe("rebuildChatFromMessages with a v4-journaled dangling tool call", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	const created: ToolExecutionComponent[] = [];

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-imode-journal-dangling-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		for (const component of created.splice(0)) component.stopAnimation();
		for (const component of mode ? toolCards(mode) : []) component.stopAnimation();
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function stubTranscript(entries: SessionEntry[]): void {
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);
	}

	function addLiveBash(): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: CMD },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"call-1",
		);
		created.push(component);
		mode.chatContainer.addChild(component);
		mode.pendingTools.set("call-1", component);
		return component;
	}

	it("leaves a still-running journaled call to its live component instead of also replaying an interrupted card", () => {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		stubTranscript(journaledDanglingEntries());

		const live = addLiveBash();
		expect(countCommand(mode)).toBe(1);

		mode.rebuildChatFromMessages();

		// The journal cannot tell a running execution from an abandoned one — both
		// are a `started` record with no settlement. The live component can, and it
		// is the one this rebuild preserved, so it stays the only block for call-1.
		expect(toolCards(mode)).toEqual([live]);
		expect(countCommand(mode)).toBe(1);
		expect(renderChat(mode)).not.toContain(DANGLING_TOOL_EXECUTION_REASON);
		// Suppressing the replay copy must not resurrect the elision placeholder
		// either: the call is on screen, live.
		expect(renderChat(mode)).not.toContain(ELISION_NOTICE);
		// Still routable: the pending result lands in the on-screen block.
		expect(mode.pendingTools.get("call-1")).toBe(live);
	});

	it("renders the interrupted card end-to-end when no live component owns the journaled call", () => {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		stubTranscript(journaledDanglingEntries());

		mode.rebuildChatFromMessages();

		// Resumed session: the process died mid-execution, nothing is live, and the
		// folded journal record is the only account of the call. It must render as
		// real interrupted history through this consumer too — not as the silent
		// elision count it was before the journal existed.
		expect(toolCards(mode)).toHaveLength(1);
		const rendered = renderChat(mode);
		expect(rendered).toContain(CMD);
		expect(rendered).toContain(DANGLING_TOOL_EXECUTION_REASON);
		expect(rendered).not.toContain(ELISION_NOTICE);
		// The replayed card is history, never a live routing target.
		expect(mode.pendingTools.size).toBe(0);
	});
});

/**
 * The TUI-side half of the restored
 * `kill-mid-tool` coverage. The two tests above already prove
 * `rebuildChatFromMessages` renders a hand-built dangling journal record as
 * an interrupted card; what was still unproven is that a genuinely killed
 * process leaves that exact durable signature on disk in the first place.
 * `captureKillMidToolJournal` (test/helpers/kill-mid-tool-capture.ts) drives a
 * real `bash` call through a real, persisted `AgentSession` blocked on a lock
 * file, reads the session JSONL back off disk while the process is still
 * blocked, and only then releases it -- the same real capture the ACP-side
 * row in `acp-deterministic-phase-gate.test.ts` drives through the reducer.
 * This row feeds that capture through `InteractiveMode`'s real
 * `buildTranscriptSessionContext` -> `rebuildChatFromMessages` path instead.
 */
describe("rebuildChatFromMessages against a real kill-mid-tool capture", () => {
	beforeAll(() => {
		initTheme();
	});

	it("renders a genuinely killed bash call as an interrupted card, not a silent elision", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		const { capturedEntries, callId, session, dispose } = await captureKillMidToolJournal();
		let mode: InteractiveMode | undefined;
		try {
			mode = new InteractiveMode(session, "test");
			mode.ui.requestRender = vi.fn();
			vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
				buildSessionContext(capturedEntries, undefined, undefined, { transcript: true }),
			);

			mode.rebuildChatFromMessages();

			const cards = mode.chatContainer.children.filter(
				(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
			);
			expect(cards).toHaveLength(1);
			const rendered = Bun.stripANSI(mode.chatContainer.render(160).join("\n"));
			expect(rendered).toContain(KILL_MID_TOOL_COMMAND_MARKER);
			expect(rendered).toContain(DANGLING_TOOL_EXECUTION_REASON);
			expect(rendered).not.toContain(ELISION_NOTICE);
			expect(mode.pendingTools.has(callId)).toBe(false);
		} finally {
			for (const component of mode
				? mode.chatContainer.children.filter(
						(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
					)
				: []) {
				component.stopAnimation();
			}
			mode?.stop();
			vi.restoreAllMocks();
			await dispose();
		}
	}, 15_000);
});
