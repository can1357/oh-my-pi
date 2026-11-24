import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { jsx } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

const ROWS = 32;

/** The viewport row showing `text` (blocks are indented), or -1. */
function rowOf(screen: string[], text: string): number {
	return screen.findIndex(row => row.trim() === text);
}

describe("text-mode command reports on a real terminal core", () => {
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
		tempDir = TempDir.createSync("@pi-command-report-");
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
		term = createModeTerminal({ columns: 120, rows: ROWS });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		for (let i = 0; i < rows; i++) mode.present(() => jsx("text", { text: `TRANSCRIPT ${i}` }));
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitFor(screen => rowOf(screen, last) !== -1);
		await term.settle();
		return last;
	}

	async function runCommand(command: string, shown: string): Promise<void> {
		term.type(command);
		await term.waitFor(screen => screen.some(row => row.includes(command)));
		term.press("enter");
		await term.waitFor(screen => screen.some(row => row.includes(shown)));
	}

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc returns to the untouched screen (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			const before = rowOf(term.screen(), last);
			await runCommand("/changelog full", "Full Changelog");
			expect(term.screen().some(row => row.includes("PgUp/PgDn scroll"))).toBe(true);
			expect(rowOf(term.screen(), last)).toBe(-1);
			const page = term.screen().join("\n");
			term.press("pagedown");
			await term.waitFor(screen => screen.join("\n") !== page);
			expect(term.screen().some(row => row.includes("Full Changelog"))).toBe(true);

			term.press("escape");
			await term.waitFor(screen => !screen.some(row => row.includes("Full Changelog")));
			expect(rowOf(term.screen(), last)).toBe(before);
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = [...term.scrollback(), ...term.screen()];
			expect(buffer.filter(row => row.trim() === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a report that fits above the editor like /btw and Esc takes it away", async () => {
		const last = await mountTranscript(40);
		// Typing the command opens the autocomplete menu, which pushes transcript rows into history
		// for good; open and close it once so the baseline already has that shift.
		term.type("/tools");
		await term.waitFor(screen => screen.some(row => row.includes("Open debug tools selector")));
		for (let i = 0; i < "/tools".length; i++) term.press("backspace");
		await term.waitFor(screen => !screen.some(row => row.includes("Open debug tools selector")));
		await term.settle();
		const lastRow = rowOf(term.screen(), last);
		await runCommand("/tools", "Available Tools");
		expect(term.screen().some(row => row.includes("to close"))).toBe(true);
		// Inline: on the main screen, covering the live transcript rows; none of it reaches history.
		expect(term.engine.isMainScreen).toBe(true);
		expect(term.scrollback().some(row => row.includes("Available Tools"))).toBe(false);

		term.press("escape");
		await term.waitFor(screen => !screen.some(row => row.includes("Available Tools")));
		expect(rowOf(term.screen(), last)).toBe(lastRow);
	});

	it.each([
		[3, "leaves it in place"],
		[40, "clips its top rows"],
	])("draws a docked report under the transcript rows that still fit (%i transcript rows: %s)", async rows => {
		const last = await mountTranscript(rows);
		const before = term.screen();
		const scrolled = term.scrollback().length;
		await runCommand("/ssh help", "SSH Host Management");
		const screen = term.screen();
		const reportTop = screen.findIndex(row => row.includes("SSH Host Management"));
		// The transcript's tail stays on screen, the report right under it.
		expect(rowOf(screen, last)).toBe(reportTop - 1);
		if (rows === 3) expect(rowOf(screen, last)).toBe(rowOf(before, last));
		else expect(rowOf(screen, "TRANSCRIPT 38")).toBe(reportTop - 3);
		// The rows it covers are not moved into history: closing it brings the screen back as it was.
		expect(term.scrollback()).toHaveLength(scrolled);

		term.press("escape");
		await term.waitFor(screen => !screen.some(row => row.includes("SSH Host Management")));
		expect(term.screen()).toEqual(before);
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		const last = await mountTranscript(40);
		const lastRow = rowOf(term.screen(), last);
		const blocks = mode.shell.transcript.blocks().length;
		await runCommand(command, title);
		expect(mode.shell.transcript.blocks()).toHaveLength(blocks);

		term.press("escape");
		await term.waitFor(screen => !screen.some(row => row.includes(title)));
		expect(rowOf(term.screen(), last)).toBe(lastRow);
		const buffer = [...term.scrollback(), ...term.screen()];
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
