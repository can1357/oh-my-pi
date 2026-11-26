import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { type JSXNode, jsx, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, transcriptText } from "./helpers/mode-terminal";

/** A plain transcript line. */
function line(text: string): () => JSXNode {
	return () => jsx("text", { text });
}

/** Whether `node` is `root` or inside it. */
function within(root: UiNode, node: UiNode | null): boolean {
	return node !== null && (root === node || root.children().some(child => within(child, node)));
}

/** A node as the native backend describes it. */
interface Described {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly scroll?: unknown;
	readonly c?: readonly Described[];
}

describe("issue #4806 command output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-4806-");
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
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		// Reports and sheets run on the shell: keys reach them through the terminal.
		term = createModeTerminal({ columns: 100, rows: 40 });
		await term.start();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		mode.isInitialized = true;
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		HistoryStorage.close();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Natively, reports open as sheets (Tern). */
	const goNative = () => vi.spyOn(mode.shell, "native").mockReturnValue(true);
	const report = () => mode.shell.dock.slot("report");

	it("docks a short report above the editor without touching the streaming transcript; Esc removes it", async () => {
		const streamedReply = mode.present(line("agent is streaming"), { live: true });
		mode.shell.focus(mode.composer.field);
		new InputController(mode).setupKeyHandlers();
		const abort = vi.spyOn(session, "abort");

		mode.handleToolsCommand();

		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);
		await term.waitFor(screen => screen.some(row => row.includes("Available Tools")));
		// The editor keeps focus: typing still goes to the prompt.
		expect(mode.shell.focused()).toBe(mode.composer.field);

		// The editor's Esc closes the report before it would interrupt the streaming turn.
		term.press("escape");
		await term.waitFor(() => !report().occupied());
		expect(abort).not.toHaveBeenCalled();
		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);
	});

	it("natively opens reports as focused sheets like /usage whose long bodies scroll; Esc closes them", async () => {
		goNative();
		streaming = false;
		const sheet = () => mode.shell.overlays.top();
		const describe = (): Described | undefined => {
			const node = sheet()?.node;
			return node ? (describeTree(node, staticEnvironment(currentTheme())) as Described) : undefined;
		};
		const find = (root: Described | undefined, test: (node: Described) => boolean): Described | undefined => {
			if (!root) return undefined;
			if (test(root)) return root;
			for (const child of root.c ?? []) {
				const found = find(child, test);
				if (found) return found;
			}
			return undefined;
		};

		mode.handleToolsCommand();
		expect(describe()).toMatchObject({ k: "overlay", p: { size: "lg", modal: true } });
		expect(within(sheet()!.node, mode.shell.focused())).toBe(true);
		expect(mode.shell.transcript.blocks()).toHaveLength(0);
		expect(report().occupied()).toBe(false);

		// A second report replaces the first sheet instead of stacking.
		const first = sheet();
		await mode.handleChangelogCommand("full");
		expect(first?.closed).toBe(true);
		expect(mode.shell.overlays.nodes()).toHaveLength(1);
		// The sheet body is the terminal's scroller; Page Down reaches it as a scroll request.
		const bodyScroll = () => find(describe(), node => node.scroll !== undefined)?.scroll;
		expect(bodyScroll()).toBeUndefined();
		term.press("pagedown");
		await term.settle();
		expect(bodyScroll()).toEqual({ by: "page-down", n: 1 });
		term.press("pagedown");
		await term.settle();
		expect(bodyScroll()).toEqual({ by: "page-down", n: 2 });

		term.press("escape");
		await term.waitFor(() => !mode.shell.overlays.open());
		expect(mode.shell.focused()).toBe(mode.composer.field);
	});

	it("closes an open native report sheet when the transcript is reset for another session", () => {
		goNative();
		streaming = false;
		mode.handleContextCommand();
		expect(mode.shell.overlays.open()).toBe(true);

		mode.resetTranscript();

		expect(mode.shell.overlays.open()).toBe(false);
		expect(mode.shell.focused()).toBe(mode.composer.field);
	});

	it("mounts deferred command output once after the active turn ends", async () => {
		const streamedReply = mode.present(line("agent is streaming"), { live: true });

		mode.presentCommandOutput(line("Deferred Output"));

		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.shell.transcript.blocks()).toHaveLength(2);
		expect(transcriptText(mode.shell, 80).match(/Deferred Output/g)).toHaveLength(1);
	});

	it("drops deferred command output when the session changes before agent_end", async () => {
		const streamedReply = mode.present(line("old session is streaming"), { live: true });
		const previousSessionId = session.sessionManager.getSessionId();

		mode.presentCommandOutput(line("Deferred Output"));
		await session.newSession();

		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);
	});
});
