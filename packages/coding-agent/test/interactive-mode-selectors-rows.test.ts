/**
 * The inline selectors on terminal rows (no Tern): each takes the composer's place and its keys,
 * and gives both back when it closes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

describe("inline selectors on terminal rows", () => {
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
		tempDir = TempDir.createSync("@pi-selectors-rows-");
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
		term = createModeTerminal({ columns: 100, rows: 32 });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, term.frame);
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

	it("/debug takes the keys: Down moves the selection, Escape gives the composer back", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		/** What the screen draws before `label` on its row (the selection marker lives there); undefined off screen. */
		const lead = (label: string): string | undefined => {
			const line = term.screen().find(candidate => candidate.includes(label));
			return line?.slice(0, line.indexOf(label));
		};

		await mode.showDebugSelector();
		await term.waitFor(screen => screen.some(line => line.includes("Debug Tools")));
		const selected = lead("Open: artifact folder");
		const plain = lead("Report: performance issue");
		expect(selected).not.toBe(plain);

		// Both rows stay on screen and trade leads: the marker moved and the sheet is still open. The
		// waits stay under the test's own timeout, so a menu that ignores its keys fails with the
		// screen it left.
		term.press("down");
		await term.waitFor(
			() => lead("Report: performance issue") === selected && lead("Open: artifact folder") === plain,
			2000,
		);

		term.press("escape");
		await term.waitFor(screen => !screen.some(line => line.includes("Debug Tools")), 2000);
		term.type("a");
		await term.waitFor(() => mode.composer.text() === "a");
	});
});
