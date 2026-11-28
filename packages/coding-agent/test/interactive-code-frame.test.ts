import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgTuiCodeFrame } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

describe("tui.codeFrame setting", () => {
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
		tempDir = TempDir.createSync("@pi-code-frame-e2e-");
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
		term = createModeTerminal({ columns: 100, rows: 24 });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, term.frame);
		vi.spyOn(mode.shell, "native").mockImplementation(() => false);
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

	function appendReply(text: string, timestamp: number): void {
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
	}

	it("redraws a reply already in terminal history when the setting flips, in both directions", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();

		appendReply("Run it:\n\n```sh\necho hi\n```", 1);
		for (let index = 0; index < 40; index++) appendReply(`Filler paragraph ${index}.`, 10 + index);
		await mode.renderInitialMessages();
		await term.waitFor(screen => screen.some(row => row.includes("Filler paragraph 39")));
		// The fenced reply has scrolled off the screen into terminal history.
		expect(term.screen().some(row => row.includes("echo hi"))).toBe(false);
		expect(term.scrollback().some(row => row.includes("```sh"))).toBe(true);

		cfgTuiCodeFrame.set(mode.settings, true);
		await term.waitFor(() => term.scrollback().some(row => row.includes("╌╌ sh ╌")));
		const framed = term.scrollback();
		expect(framed.some(row => row.includes("```"))).toBe(false);
		// The frame adds nothing to the code row itself.
		expect(framed.filter(row => row.includes("echo hi")).map(row => row.trim())).toEqual(["echo hi"]);

		cfgTuiCodeFrame.set(mode.settings, false);
		await term.waitFor(() => term.scrollback().some(row => row.includes("```sh")));
		expect(term.scrollback().some(row => row.includes("╌"))).toBe(false);
	});
});
