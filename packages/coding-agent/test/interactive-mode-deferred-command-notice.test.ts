import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type JSXNode, jsx } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { TempDir } from "@oh-my-pi/pi-utils";
import { showCommandMessage } from "../src/modes/controllers/command-controller-shared";
import { DeferredCommand } from "../src/ui/dock/deferred";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

type Harness = {
	mode: InteractiveMode;
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
};

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
	if (harness) {
		harness.setStreaming(false);
		harness.mode.clearTransientSessionUi();
		for (const block of harness.mode.shell.transcript.blocks()) harness.mode.shell.transcript.remove(block);
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-deferred-notice-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	initTheme();
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Deferred notice", "user");
	let streaming = false;
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 in the registry");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		createModeTerminal().frame,
	);
	harness = {
		mode,
		session,
		authStorage,
		tempDir,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
	return harness;
}

/** `nodes` as plain terminal rows at 120 columns. */
function rows(nodes: () => JSXNode): string[] {
	const term = createTestTerminal(() => ({ main: nodes() }), { columns: 120, rows: 1000 });
	try {
		const screen = term.screen();
		while (screen.length > 0 && screen.at(-1) === "") screen.pop();
		return screen;
	} finally {
		term.dispose();
	}
}

/** The deferred-output preview above the prompt. */
function noticeRows(mode: InteractiveMode): string[] {
	return rows(() => DeferredCommand({ model: mode.hud.deferred }));
}

function noticeText(mode: InteractiveMode): string {
	return noticeRows(mode).join("\n");
}

function transcriptRowCount(mode: InteractiveMode): number {
	return rows(() => mode.shell.transcript.nodes).length;
}

function transcriptText(mode: InteractiveMode): string {
	return rows(() => mode.shell.transcript.nodes).join("\n");
}

/** A command's output panel. */
function panel(text: string): () => JSXNode {
	return () => jsx("text", { text });
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	harness?.mode.stop();
	await harness?.session.dispose();
	harness?.authStorage.close();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode deferred command preview", () => {
	it("shows the panel immediately mid-turn without touching the transcript", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const transcriptBefore = transcriptRowCount(mode);

		mode.presentCommandOutput(panel("Claude 5 Hour: 62% used"));

		// The answer is visible right away, which is the whole point: before this,
		// a command run mid-turn was indistinguishable from a dead one.
		expect(noticeText(mode)).toContain("Claude 5 Hour: 62% used");
		// But never via the transcript: a mid-turn transcript mount re-renders rows
		// below the growing live block and duplicates them in native scrollback
		// (issues #4806/#6767), which is what deferral was introduced to stop.
		expect(transcriptRowCount(mode)).toBe(transcriptBefore);
		expect(transcriptText(mode)).not.toContain("Claude 5 Hour");
	});

	it("mounts mid-turn output straight into the transcript on a Tern surface", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		// A native surface reconciles a document instead of appending scrollback,
		// so there is nothing to duplicate and no reason to hold a clipped preview
		// above the prompt for the rest of the turn.
		vi.spyOn(mode.shell, "native").mockReturnValue(true);
		mode.presentCommandOutput(panel("Context 112K / 1m"));

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("Context 112K / 1m");
	});

	it("counts commands rather than the components each one queues", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);

		// One command commonly queues a spacer plus its panel; that is still one
		// command from the user's point of view.
		mode.presentCommandOutput(() => [jsx("text", { text: "spacer" }), jsx("text", { text: "usage panel" })]);
		expect(noticeText(mode)).toContain("1 command output");

		mode.presentCommandOutput(panel("advisor panel"));
		expect(noticeText(mode)).toContain("2 command outputs");
	});

	it("caps a tall panel so the prompt stays on screen", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const tall = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");

		mode.presentCommandOutput(panel(tall));

		const notice = noticeRows(mode);
		expect(notice.length).toBeLessThan(60);
		expect(notice.join("\n")).toContain("row 0");
		expect(notice.join("\n")).toContain("more rows");
		// The tail is not silently dropped: it arrives in full at the settle.
		expect(notice.join("\n")).not.toContain("row 199");
	});

	it("clears the preview and mounts the panels once the turn settles", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(panel("usage panel"));
		expect(noticeText(mode)).not.toBe("");

		setStreaming(false);
		mode.flushPendingCommandOutput();

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("hides the preview on Esc without interrupting the turn and still mounts the output at the settle", async () => {
		const { mode, session, setStreaming } = await createHarness();
		setStreaming(true);
		const abort = vi.spyOn(session, "abort").mockResolvedValue(undefined);

		// `/mcp reload` mid-turn: its status messages queue as command output.
		showCommandMessage(mode, "Reloading MCP servers and runtime tools...");
		showCommandMessage(mode, "MCP reload complete");
		expect(noticeText(mode)).toContain("2 command outputs");
		expect(noticeText(mode)).toContain("to hide");

		mode.interruptFromPointer();

		expect(noticeText(mode)).toBe("");
		expect(abort).not.toHaveBeenCalled();
		expect(transcriptText(mode)).not.toContain("MCP reload complete");

		// Output queued after the dismissal previews on its own.
		mode.presentCommandOutput(panel("usage panel"));
		expect(noticeText(mode)).toContain("1 command output");
		expect(noticeText(mode)).not.toContain("MCP reload complete");

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		const transcript = transcriptText(mode);
		const reloading = transcript.indexOf("Reloading MCP servers");
		const complete = transcript.indexOf("MCP reload complete");
		const usage = transcript.indexOf("usage panel");
		expect(reloading).toBeGreaterThanOrEqual(0);
		expect(complete).toBeGreaterThan(reloading);
		expect(usage).toBeGreaterThan(complete);
		expect(noticeText(mode)).toBe("");
	});

	it("shows no preview when the agent is idle, since output mounts immediately", async () => {
		const { mode } = await createHarness();

		mode.presentCommandOutput(panel("usage panel"));

		expect(noticeText(mode)).toBe("");
		expect(transcriptText(mode)).toContain("usage panel");
	});

	it("drops a stale preview when the session is reset while output is queued", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(panel("usage panel"));
		expect(noticeText(mode)).not.toBe("");

		mode.clearTransientSessionUi();

		expect(noticeText(mode)).toBe("");
	});

	it("starts the queue over after a reset, so a later command previews alone", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(panel("stale panel"));

		// The reset keeps the same session id here, so nothing downstream can
		// recognise the leftover queue as stale; it has to be dropped at the reset.
		mode.clearTransientSessionUi();
		mode.presentCommandOutput(panel("fresh panel"));

		const notice = noticeText(mode);
		expect(notice).toContain("fresh panel");
		expect(notice).not.toContain("stale panel");
		expect(notice).toContain("1 command output");
		expect(notice).not.toContain("2 command outputs");
	});

	it("mounts deferred command output once after the active turn ends", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const streamedReply = mode.present(panel("agent is streaming"), { live: true });

		mode.presentCommandOutput(panel("Deferred Output"));

		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.shell.transcript.blocks()).toHaveLength(2);
		expect(transcriptText(mode).match(/Deferred Output/g)).toHaveLength(1);
	});

	it("opens the usage dashboard overlay without touching the transcript, even mid-stream", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const usageReports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];
		const streamedReply = mode.present(panel("agent is streaming"), { live: true });
		const showDashboard = vi.spyOn(mode, "showUsageDashboard").mockImplementation(() => {});

		await mode.handleUsageCommand(usageReports);

		// /usage renders as an overlay (the /settings idiom): nothing may mount
		// into the transcript, mid-stream or otherwise — mounting above the
		// growing live block is what duplicated in native scrollback (#6767).
		expect(showDashboard).toHaveBeenCalledTimes(1);
		expect(showDashboard).toHaveBeenCalledWith(usageReports, undefined);
		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);

		setStreaming(false);
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		// Turn end must not flush any deferred usage panel either.
		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);
	});

	it("drops deferred command output when the session changes before agent_end", async () => {
		const { mode, session, setStreaming } = await createHarness();
		setStreaming(true);
		const streamedReply = mode.present(panel("old session is streaming"), { live: true });
		const previousSessionId = session.sessionManager.getSessionId();

		mode.presentCommandOutput(panel("Deferred Output"));
		await session.newSession();

		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		setStreaming(false);
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.shell.transcript.blocks()).toEqual([streamedReply]);
	});
});
