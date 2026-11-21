import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Ctrl+O on tool output already committed to scrollback", () => {
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
		tempDir = TempDir.createSync("@pi-ctrlo-scrollback-");
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
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("contracts expanded rows already committed to scrollback on the second Ctrl+O", async () => {
		const DEEP = "RETIRED_EXPANDED_TOOL_OUTPUT_MARKER";
		const callId = "expand-retired-tool-call";
		const toolCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "printf many-lines" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [
				{
					type: "text",
					text: Array.from({ length: 16 }, (_, index) =>
						index === 15 ? DEEP : `output line ${index}`,
					).join("\n"),
				},
			],
			isError: false,
			timestamp: 2,
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 3,
		});

		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		mode.renderSessionContext({
			messages: [toolCall, toolResult],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		mode.ui.requestRender(true);
		await term.waitForRender();

		const committedHas = (text: string): boolean => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY).some(row => row.includes(text));
		};
		expect(committedHas(DEEP)).toBe(false);

		// First Ctrl+O expands the live card; the deep output becomes visible.
		term.sendInput("\x0f");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes(DEEP)));
		expect(mode.toolOutputExpanded).toBe(true);

		// More turns push the expanded card into immutable terminal scrollback.
		for (let index = 0; index < 20; index++) mode.addMessageToChat(assistantText(`Filler answer number ${index}.`));
		for (let index = 0; index < 40 && !committedHas(DEEP); index++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedHas(DEEP)).toBe(true);

		// The second Ctrl+O must contract rows already committed to scrollback, not just the live tail.
		term.sendInput("\x0f");
		await term.waitForRender();
		expect(mode.toolOutputExpanded).toBe(false);
		expect(committedHas(DEEP)).toBe(false);
	});
});
