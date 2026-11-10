import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { makeAssistantMessage } from "./session-manager/helpers";

const ROWS = 32;

function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("text-mode command reports on a real terminal core", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

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
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => screen(term).includes(last));
		return last;
	}

	async function runCommand(command: string, shown: string): Promise<void> {
		term.sendInput(command);
		await term.waitForRender(() => screen(term).some(row => row.includes(command)));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(shown)));
	}

	async function writeSummaryReply(manager: SessionManager, text: string, timestamp: number): Promise<void> {
		manager.appendMessage({ ...makeAssistantMessage(), content: [{ type: "text", text }], timestamp });
		await manager.flush();
	}

	async function seedSummaryTree(): Promise<{ mainFile: string; childFile: string; report: string }> {
		await writeSummaryReply(session.sessionManager, "Older root summary", Date.now() - 60_000);
		const mainFile = session.sessionManager.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted main transcript");
		const artifactsDir = mainFile.slice(0, -".jsonl".length);
		fs.mkdirSync(artifactsDir, { recursive: true });
		const child = await SessionManager.open(path.join(artifactsDir, "SummaryWorker.jsonl"), undefined, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
			parentSession: mainFile,
		});
		const report = [
			"# Child summary heading",
			"",
			"```ts",
			"const answer = 42;",
			"```",
			"",
			"Earlier content for scrolling.",
			"\tIndented tab content.",
			...Array.from({ length: 80 }, (_, index) => `Child report line ${index}`),
			"CHILD_SUMMARY_END_MARKER",
		].join("\n");
		await writeSummaryReply(child, report, Date.now());
		const childFile = child.getSessionFile();
		if (!childFile) throw new Error("Expected a persisted child transcript");
		await child.close();
		return { mainFile, childFile, report };
	}

	it("browses a persisted child summary, searches, scrolls, closes, and opens the latest directly", async () => {
		await mountTranscript(5);
		const { mainFile, childFile } = await seedSummaryTree();
		const leafBefore = session.sessionManager.getLeafId();
		const entriesBefore = structuredClone(session.sessionManager.getEntries());
		const mainBytesBefore = fs.readFileSync(mainFile);
		const childBytesBefore = fs.readFileSync(childFile);

		term.sendInput("/summary");
		await term.waitForRender(() => screen(term).some(row => row.includes("/summary")));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes("Session summaries")));
		await term.waitForRender(() => screen(term).some(row => row.includes("const answer")));
		const pickerRows = screen(term);
		expect(pickerRows.some(row => /1\..*SummaryWorker/.test(row))).toBe(true);
		expect(pickerRows.filter(row => row.includes("Child summary heading"))).toHaveLength(1);
		term.sendInput("\x1b[B");
		await term.waitForRender(() => !screen(term).some(row => row.includes("const answer")));
		term.sendInput("\x1b[A");
		await term.waitForRender(() => screen(term).some(row => row.includes("const answer")));
		term.sendInput("Child summary heading");
		await term.waitForRender(() => screen(term).some(row => row.includes("SummaryWorker")));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes("Child summary heading")));
		expect(screen(term).some(row => row.includes("CHILD_SUMMARY_END_MARKER"))).toBe(false);
		term.sendInput("\x1b[4~");
		await term.waitForRender(() => screen(term).some(row => row.includes("CHILD_SUMMARY_END_MARKER")));
		term.sendInput("\x1b[5~");
		await term.waitForRender(() => !screen(term).some(row => row.includes("CHILD_SUMMARY_END_MARKER")));
		term.sendInput("\x1b[1~");
		await term.waitForRender(() => screen(term).some(row => row.includes("Earlier content for scrolling.")));

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Child summary heading")));
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes("CHILD_SUMMARY_END_MARKER"))).toBe(false);

		term.sendInput("/summary last");
		await term.waitForRender(() => screen(term).some(row => row.includes("/summary last")));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes("Child summary heading")));
		expect(screen(term).some(row => row.includes("CHILD_SUMMARY_END_MARKER"))).toBe(false);
		term.sendInput("\x1b[4~");
		await term.waitForRender(() => screen(term).some(row => row.includes("CHILD_SUMMARY_END_MARKER")));
		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Child summary heading")));

		expect(session.sessionManager.getLeafId()).toBe(leafBefore);
		expect(session.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(fs.readFileSync(mainFile)).toEqual(mainBytesBefore);
		expect(fs.readFileSync(childFile)).toEqual(childBytesBefore);
	});

	it.each([
		{ fullscreen: false, key: "\x1b\x12" },
		{ fullscreen: true, key: "\x1b[114;7u" },
		{ fullscreen: false, key: "\x1b[27;7;114~" },
	])(
		"prepends a quoted summary without changing the conversation (fullscreen=$fullscreen, key=$key)",
		async ({ fullscreen, key }) => {
			await mountTranscript(5);
			const text = fullscreen ? (await seedSummaryTree()).report : "Short reference summary";
			if (!fullscreen) await writeSummaryReply(session.sessionManager, text, Date.now());
			const beforeEntries = structuredClone(session.sessionManager.getEntries());
			const beforeMessages = structuredClone(session.messages);
			await runCommand("/summary last", "Inject");
			const question = "My ^unsent\nquestion";
			mode.editor.setText(question);
			mode.editor.handleInput("\x1b[D");
			term.sendInput(key);
			await term.waitForRender(
				() =>
					mode.editor.getExpandedText().includes("> Short reference summary") ||
					mode.editor.getExpandedText().includes("> CHILD_SUMMARY_END_MARKER"),
			);
			const draft = mode.editor.getExpandedText();
			for (const line of text.split(/\r?\n/)) expect(draft).toContain(`> ${line}`);
			expect(draft.startsWith("> ")).toBe(true);
			expect(draft.endsWith(`> ${text.split(/\r?\n/).at(-1)}\n\n${question}`)).toBe(true);
			expect(draft.split("^")).toHaveLength(2);
			expect(mode.editor.getCursor()).toEqual({ line: draft.split("\n").length - 1, col: "question".length });
			expect(session.isStreaming).toBe(false);
			expect(session.messages).toEqual(beforeMessages);
			expect(session.sessionManager.getEntries()).toEqual(beforeEntries);
			if (!fullscreen) {
				term.sendInput(key);
				await term.waitForRender();
				expect(mode.editor.getExpandedText()).toBe(draft);
				term.sendInput("\x1b");
			}
			await term.waitForRender(() => !screen(term).some(row => row.includes("Inject")));
			expect(mode.editor.getExpandedText()).toBe(draft);
		},
	);

	it("does not steal f or literal carets from normal draft typing", async () => {
		await mountTranscript(5);
		await writeSummaryReply(session.sessionManager, "Quoted reference", Date.now());
		await runCommand("/summary last", "Inject");
		term.sendInput("foo ^ bar");
		await term.waitForRender(() => mode.editor.getExpandedText() === "foo ^ bar");
		expect(session.messages).toEqual([]);
	});

	it("leaves a blank prompt after injecting into an empty draft", async () => {
		await mountTranscript(5);
		await writeSummaryReply(session.sessionManager, "Quoted reference", Date.now());
		await runCommand("/summary last", "Inject");
		term.sendInput("\x1b\x12");
		await term.waitForRender(() => mode.editor.getExpandedText().includes("> Quoted reference"));
		const draft = mode.editor.getExpandedText();
		expect(draft.startsWith("> ")).toBe(true);
		expect(draft.endsWith("> Quoted reference\n\n")).toBe(true);
		term.sendInput("My next question ^");
		await term.waitForRender(() => mode.editor.getExpandedText() === `${draft}My next question ^`);
		expect(session.messages).toEqual([]);
	});

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc returns to the untouched screen (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			const before = screen(term);
			await runCommand("/changelog full", "Full Changelog");
			expect(screen(term).some(row => row.includes("PgUp/PgDn scroll"))).toBe(true);
			expect(screen(term).some(row => row.includes(last))).toBe(false);
			const page = screen(term).join("\n");
			term.sendInput("\x1b[6~");
			await term.waitForRender(() => screen(term).join("\n") !== page);
			expect(screen(term).some(row => row.includes("Full Changelog"))).toBe(true);

			term.sendInput("\x1b");
			await term.waitForRender(() => !screen(term).some(row => row.includes("Full Changelog")));
			expect(screen(term).indexOf(last)).toBe(before.indexOf(last));
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a report that fits above the editor like /btw and Esc takes it away", async () => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		await runCommand("/tools", "Available Tools");
		expect(screen(term).some(row => row.includes("to close"))).toBe(true);
		// Inline: the transcript stays on the main screen, only covered from below.
		expect(screen(term).some(row => row.startsWith("TRANSCRIPT"))).toBe(true);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Available Tools")));
		expect(screen(term).indexOf(last)).toBe(lastRow);
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		const blocks = mode.chatContainer.children.length;
		await runCommand(command, title);
		expect(mode.chatContainer.children).toHaveLength(blocks);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes(title)));
		expect(screen(term).indexOf(last)).toBe(lastRow);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
