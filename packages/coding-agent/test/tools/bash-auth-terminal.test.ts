import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/**
 * A UI whose `custom()` mounts the PTY overlay against a headless TUI over a
 * virtual terminal, as in `bash-interactive.test.ts`: the overlay runs for real,
 * nothing is drawn to a terminal.
 */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(
		factory: (tui: TUI, uiTheme: typeof theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
	): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
		return promise;
	};
	return { custom };
}

const DOAS = "/usr/bin/doas";
const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");
const doasUnavailable = ptyUnavailable || !fs.existsSync(DOAS);

function makeSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		skills: [],
		getSessionFile: () => null,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"astGrep.enabled": false,
			"astEdit.enabled": false,
			"grep.enabled": false,
			"glob.enabled": false,
		}),
	} as unknown as ToolSession;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

describe("BashTool authentication terminal", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		initTheme();
		tempDir = TempDir.createSync("@omp-bash-auth-");
		// The PTY path resolves its shell from settings; the direnv preflight
		// would otherwise inspect the test's own cwd.
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it.skipIf(doasUnavailable)("gives a doas command a terminal so it can prompt for the password", async () => {
		const tool = new BashTool(makeSession());
		const ctx = { hasUI: true, ui: headlessUi() } as unknown as AgentToolContext;
		// A password nobody types: the call must reach the prompt and then run out
		// its deadline, which is the observable proof a terminal was allocated.
		const result = await tool.execute(
			"call-auth",
			{ command: `${DOAS} true`, timeout: 4 },
			undefined,
			undefined,
			ctx,
		);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		expect(text).toContain("password");
		expect((result as { details?: { timedOut?: boolean } }).details?.timedOut).toBe(true);
	});

	it.skipIf(doasUnavailable)("says a terminal is missing when a doas command finds no interactive one", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-no-ui", { command: `${DOAS} true`, timeout: 20 }, undefined, undefined, {
			hasUI: false,
		} as unknown as AgentToolContext);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		expect(text).toContain("no interactive terminal is available here");
	});
});
