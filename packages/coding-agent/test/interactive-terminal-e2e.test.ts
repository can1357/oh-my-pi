import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let stdoutRowsDescriptor: PropertyDescriptor | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 32 });
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		if (stdoutRowsDescriptor) Object.defineProperty(process.stdout, "rows", stdoutRowsDescriptor);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.waitForRender();

		term.sendInput("hi there omp");
		await term.waitForRender();
		term.sendInput("\r");
		const input = await pending;
		expect(input.text).toBe("hi there omp");

		// The optimistic user-message block must be on the physical screen now,
		// before any assistant output exists.
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("hi there omp")));
		const viewport = plainRows(term.getViewport());
		const hits = viewport.filter(row => row.includes("hi there omp"));
		if (hits.length !== 1) dump("viewport after submit", viewport);
		expect(hits.length).toBe(1);
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.waitForRender();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", buffer);
		expect(drafts.length).toBe(1);
		const welcomes = buffer.filter(row => row.includes("Welcome back!"));
		expect(welcomes.length).toBe(1);
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.waitForRender();

		const viewport = plainRows(term.getViewport());
		const editors = viewport.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", viewport);
		expect(editors.length).toBe(1);
		expect(viewport.filter(row => row.includes("Welcome back!")).length).toBeLessThanOrEqual(1);
		const buffer = plainRows(term.getScrollBuffer());
		expect(buffer.filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.waitForRender();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(120, 32);
		await Bun.sleep(300);
		await term.waitForRender();

		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after drag storm", buffer);
		expect(drafts.length).toBe(1);
		const viewport = plainRows(term.getViewport());
		expect(viewport.filter(row => row.includes("Welcome back!")).length).toBeLessThanOrEqual(1);

		// The editor is still live: typing paints into the one surviving editor.
		term.sendInput("X");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFTX")));
		expect(plainRows(term.getViewport()).filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
	});

	it("opens the final answer after completed tool work and restores the editor", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const workingAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "WORKING_THINKING_MARKER" },
				{ type: "text", text: "WORKING_CODE_MARKER" },
				{ type: "toolCall", id: "reader-call", name: "read", arguments: { path: "example.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const finalAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "FINAL_THINKING_MARKER" },
				{
					type: "text",
					text: [
						"RESPONSE_START",
						...Array.from({ length: 60 }, (_, index) => `RESPONSE_BODY_${String(index).padStart(2, "0")}`),
						"RESPONSE_END",
					].join("\n"),
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 4,
		};
		session.sessionManager.appendMessage({ role: "user", content: "PROMPT_START", timestamp: 1 });
		session.sessionManager.appendMessage(workingAssistant);
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "reader-call",
			toolName: "read",
			content: [{ type: "text", text: "TOOL_RESULT_MARKER" }],
			isError: false,
			timestamp: 3,
		});
		session.sessionManager.appendMessage(finalAssistant);
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		await mode.init({ suppressWelcomeIntro: true });
		await mode.renderInitialMessages();
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("EDITOR_FRAME_MARKER");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("EDITOR_FRAME_MARKER")));

		term.sendInput("\x1bu");
		await term.waitForRender(() =>
			plainRows(term.getViewport()).some(row => row.includes("Transcript") && row.includes("latest answer")),
		);
		const reader = plainRows(term.getViewport());
		const headerRow = reader.findIndex(row => row.includes("Transcript") && row.includes("latest answer"));
		const responseStartRow = reader.findIndex(row => row.includes("RESPONSE_START"));
		if (headerRow < 0 || responseStartRow !== headerRow + 2) dump("latest answer reader", reader);
		expect(responseStartRow).toBe(headerRow + 2);
		expect(reader.some(row => row.includes("WORKING_CODE_MARKER"))).toBe(false);
		expect(reader.some(row => row.includes("FINAL_THINKING_MARKER"))).toBe(false);
		expect(reader.some(row => row.includes("RESPONSE_END"))).toBe(false);

		term.sendInput("\x1b");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("EDITOR_FRAME_MARKER")));
		expect(
			plainRows(term.getViewport()).some(row => row.includes("Transcript") && row.includes("latest answer")),
		).toBe(false);
	});

	it("hides thinking already retired to native scrollback when Ctrl+T toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const THINK = "RETIRED_REASONING_MARKER";
		const thinkingMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: THINK },
				{ type: "text", text: "First visible answer." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		// A short viewport forces the oldest finalized blocks into immutable
		// terminal history, which is where the regression hid (a plain viewport
		// repaint leaves retired rows untouched).
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Observed reasoning content unlocks Ctrl+T and renders the block visible.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		// Retirement offers one finalized batch per frame under capacity pressure;
		// drive frames until the thinking turn commits to native scrollback.
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(THINK)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(THINK))).toBe(true);

		// A live editor draft must survive the toggle's history rebuild.
		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Ctrl+T (0x14): the real keybinding path toggles thinking hidden.
		term.sendInput("\x14");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(THINK)));

		// The retired history was cleared and replayed hidden — the marker is gone
		// from scrollback and viewport alike — while the live editor stays mounted.
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});
});
