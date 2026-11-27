/**
 * A history picker's first paint can take hundreds of milliseconds on a long session: the
 * terminal first presents a frame saying the history is loading, in the composer hint's place,
 * and the next frame shows the picker.
 */
import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
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

const LOADER = "Loading the session history";
const PICKER = "pick the point to continue from";

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
	tempDir = TempDir.createSync("@pi-history-loader-");
	await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "git.enabled": false } });
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
	term = createModeTerminal({ columns: 120, rows: 32 });
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

/** Append `count` prompt/answer exchanges to the session's branch. */
function appendExchanges(count: number): void {
	for (let index = 0; index < count; index++) {
		session.sessionManager.appendMessage({ role: "user", content: `prompt ${index}`, timestamp: 2 * index + 1 });
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `answer ${index}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2 * index + 2,
		} satisfies AssistantMessage);
	}
}

/** A long history: the rewind picker's paint takes a while. */
const LONG = 200;

async function start(exchanges: number): Promise<void> {
	appendExchanges(exchanges);
	await mode.init({ suppressWelcomeIntro: true });
	await mode.renderInitialMessages();
	void mode.getUserInput();
	await term.settle();
}

it("says the history is loading in the composer hint's place, then shows the picker in the next frame", async () => {
	await start(LONG);
	const steady = term.screen();

	// The memory terminal feeds the screen as frames are written: each entry is the screen one frame left.
	const screens: string[][] = [];
	const stopWatching = mode.shell.host!.onFrame(() => screens.push(term.screen()));
	await mode.showUserMessageSelector();
	await mode.shell.nextFrame();
	stopWatching();

	// The loading frame moves nothing: it differs from the screen before it in one row, the composer's.
	const loading = screens.at(-2)!;
	expect(loading).toHaveLength(steady.length);
	const changed = loading.flatMap((row, index) => (row === steady[index] ? [] : [row]));
	expect(changed).toHaveLength(1);
	expect(changed[0]).toContain(LOADER);
	expect(loading.join("\n")).not.toContain(PICKER);

	// The picker's first frame directly follows it.
	const picker = screens.at(-1)!.join("\n");
	expect(picker).toContain(PICKER);
	expect(picker).not.toContain(LOADER);
});

it("opens a short history's picker at once, with no loading frame", async () => {
	await start(1);
	const screens: string[][] = [];
	const stopWatching = mode.shell.host!.onFrame(() => screens.push(term.screen()));
	void mode.showUserMessageSelector();
	// Opened before any frame: the keys that follow go to the picker.
	expect(mode.shell.overlays.open()).toBe(true);
	await mode.shell.nextFrame();
	stopWatching();
	expect(screens.some(screen => screen.join("\n").includes(LOADER))).toBe(false);
});

it("opens the picker over a dialog in the composer's place, whose frame never reads the notice", async () => {
	await start(LONG);
	mode.showEditorAreaDialog(() => jsx("text", { text: "a dialog" }));
	await term.settle();
	// Nothing on screen reads the notice: the wait asks for its frame instead of waiting on the next change.
	const opening = mode.showUserMessageSelector();
	expect(mode.shell.overlays.open()).toBe(false);
	await opening;
	expect(mode.shell.overlays.open()).toBe(true);
});

it("opens one picker for repeated requests while the first waits for its loading frame", async () => {
	await start(LONG);
	// Esc Esc twice in one terminal read: the composer still holds the keys until the picker opens.
	const first = mode.showUserMessageSelector();
	expect(mode.shell.overlays.open()).toBe(false);
	await Promise.all([first, mode.showUserMessageSelector()]);
	expect(mode.shell.overlays.nodes()).toHaveLength(1);
});
