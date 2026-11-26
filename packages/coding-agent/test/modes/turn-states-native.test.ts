/**
 * A turn's states as Tern holds them (settled blocks that change after all: a
 * display toggle, a background job's frames; the composer's Stop and mode
 * chip; the todo reminder's place in `main`) and as terminal rows draw them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { TempDir } from "@oh-my-pi/pi-utils";
import { todoReminderBlock } from "../../src/modes/controllers/event-blocks";
import { initTheme } from "../../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "../helpers/mode-terminal";
import { nativeShell } from "../helpers/native-shell";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The wire id of the node holding `node` (every node below a region has one). */
function parentOf(node: { readonly id: string; readonly parent: string | null }): string {
	if (node.parent === null) throw new Error(`${node.id} has no parent`);
	return node.parent;
}

describe("turn states", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-turn-states-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = createModeTerminal({ columns: 120, rows: 32 });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, new EventBus(), term.frame);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("hides and shows a finished reply’s thinking when thinking visibility changes", async () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Considering the request carefully." },
				{ type: "text", text: "Answer after thinking." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: 10,
		};
		mode.noteDisplayableThinkingContent(message);
		mode.presentAssistant(message);
		await using ui = await nativeShell(mode.shell);
		const reply = parentOf(ui.node("section"));
		const kinds = () => ui.get(reply).c.map(child => ui.get(child).k);
		expect(kinds()).toEqual(["section", "md"]);
		mode.hideThinkingBlock = true;
		expect(kinds()).toEqual(["md"]);
		expect(ui.node("md").p.text).toBe("Answer after thinking.");
		mode.hideThinkingBlock = false;
		expect(kinds()).toEqual(["section", "md"]);
	});

	it("keeps filling a returned background card with its job’s frames", async () => {
		const card = mode.presentToolCall({
			name: "bash",
			args: { command: "sleep 30" },
			tool: undefined,
			id: "job1",
			cwd: "/tmp",
		});
		card.setArgsComplete("job1");
		card.setExecutionStarted("job1");
		card.updateResult({ content: [{ type: "text", text: "started" }] }, true, "job1");
		card.parkAsBackground();
		mode.shell.transcript.settle(card.block);
		await using ui = await nativeShell(mode.shell);
		expect(ui.node("tool").p.status).toBe("running");
		card.updateResult({ content: [{ type: "text", text: "late output" }] }, false, "job1");
		expect(ui.node("tool").p.status).toBe("done");
	});

	it("sends the todo reminder as a checklist of its own in main, hidden with tool activity", async () => {
		mode.present(() =>
			todoReminderBlock([{ content: "Add tests", status: "in_progress" }], 1, 3, () => !mode.hideToolActivity),
		);
		await using ui = await nativeShell(mode.shell);
		const checklist = ui.node("checklist");
		expect(parentOf(checklist).endsWith("main")).toBe(true);
		expect(checklist.p).toMatchObject({ mode: "reminder", note: "reminder 1/3", role: "omp.notice.todo" });
		mode.hideToolActivity = true;
		expect(ui.node("checklist").p.hidden).toBe(true);
	});

	it("keeps the todo reminder box’s filled padding rows in terminal rows", () => {
		const block = mode.present(() =>
			todoReminderBlock([{ content: "Add tests", status: "in_progress" }], 1, 3, () => true),
		);
		const rows = paintNode(staticEnvironment(loadThemeSync("dark"), { now: 0 }), block.node, 60).rows;
		// A filled row above the header and one below the list; the blank row above the box is the separator's.
		expect(rows.map(row => stripEscapes(row).trim())).toEqual([
			"",
			expect.stringContaining("1 incomplete todo - reminder 1/3"),
			"",
			expect.stringContaining("Add tests"),
			"",
		]);
		expect(rows.every(row => row.includes("\x1b[7m"))).toBe(true);
	});

	it("offers Send again once a stopped submission has returned", async () => {
		await using ui = await nativeShell(mode.shell);
		const input = mode.startPendingSubmission({ text: "stop me" });
		expect(ui.node("text", "stop").p.text).toBe("Stop");
		// The session returned without running the turn (Esc during setup): no `agent_end` follows.
		mode.finishPendingSubmission(input);
		expect(ui.node("kbd", "send").p.role).toBe("omp.composer.send");
		expect(() => ui.node("text", "stop")).toThrow();
	});

	it("names a `?` draft’s mode on the composer and leads it with the btw chip", async () => {
		await using ui = await nativeShell(mode.shell);
		mode.composer.setText("? what is this");
		mode.isBtwMode = true;
		mode.updateEditorBorderColor();
		const editor = ui.node("editor");
		const line = ui.get(parentOf(editor));
		expect(ui.get(parentOf(line)).p.role).toBe("omp.editor.btw-ask");
		const chip = ui.get(line.c[0]!);
		expect(chip.p).toMatchObject({ role: "omp.composer.mode", title: "Asks a /btw side question" });
		expect(ui.get(chip.c[0]!).p.spans).toEqual([{ s: "btwMode", t: "btw" }]);
		// The chip stands in for the sigil; the question stays prose.
		expect(editor.p.decor).toEqual([{ from: 0, to: 2, s: "hide" }]);
		expect(editor.p.lang).toBeUndefined();
		mode.isBtwMode = false;
		mode.updateEditorBorderColor();
		expect(ui.get(parentOf(ui.node("editor"))).c).toHaveLength(1);
		expect(ui.get(parentOf(line)).p.role).toBe("omp.editor");
	});
});
