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

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

/**
 * Write a stand-in for the real auth command, named `doas`/`sudo` so the routing
 * keys on it the way it keys on the installed one. The prompting stand-in reads
 * the password from the controlling terminal, as `doas` and `sudo` do — with no
 * terminal the write fails, which is exactly the failure the routing prevents.
 */
function writeAuthCommand(dir: string, name: "doas" | "sudo", body: string): string {
	const path = `${dir}/${name}`;
	fs.writeFileSync(path, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(path, 0o755);
	return path;
}

const PROMPT_FOR_PASSWORD = "printf 'Password: ' > /dev/tty\nread -r _ < /dev/tty\nprintf 'authenticated\\n'";

function makeSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		skills: [],
		getSessionFile: () => null,
		settings: Settings.isolated({
			"async.enabled": true,
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

	it.skipIf(ptyUnavailable)("gives an auth command a terminal so it can prompt for the password", async () => {
		const doas = writeAuthCommand(tempDir.path(), "doas", PROMPT_FOR_PASSWORD);
		const tool = new BashTool(makeSession());
		const ctx = { hasUI: true, ui: headlessUi() } as unknown as AgentToolContext;
		// A password nobody types: the call must reach the prompt and then run out
		// its deadline, which is the observable proof a terminal was allocated.
		const result = await tool.execute(
			"call-auth",
			{ command: `${doas} true`, timeout: 4 },
			undefined,
			undefined,
			ctx,
		);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		expect(text).toContain("Password:");
		expect(text).not.toContain("authenticated");
		expect((result as { details?: { timedOut?: boolean } }).details?.timedOut).toBe(true);
	});

	it.skipIf(ptyUnavailable)("says a terminal is missing when an auth command finds no interactive one", async () => {
		const doas = writeAuthCommand(tempDir.path(), "doas", PROMPT_FOR_PASSWORD);
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-no-ui", { command: `${doas} true`, timeout: 20 }, undefined, undefined, {
			hasUI: false,
		} as unknown as AgentToolContext);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		expect(text).toContain("no interactive terminal is available here");
		expect(text).toContain("only succeeds if it needs no password");
		expect(text).not.toContain("cannot authenticate");
	});

	it.skipIf(ptyUnavailable)("does not claim an auth command failed when it needs no password", async () => {
		// A `NOPASSWD` rule or a cached credential is the normal case for a
		// passwordless command, so a headless run that exits 0 must not be
		// reported as an authentication failure.
		const sudo = writeAuthCommand(tempDir.path(), "sudo", "printf 'ok\\n'");
		const tool = new BashTool(makeSession());
		const result = await tool.execute(
			"call-nopasswd",
			{ command: `${sudo} true`, timeout: 20 },
			undefined,
			undefined,
			{
				hasUI: false,
			} as unknown as AgentToolContext,
		);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		expect(text).toContain("ok");
		expect(text).toContain("no interactive terminal is available here");
		expect(text).not.toContain("cannot authenticate");
	});

	it.skipIf(ptyUnavailable)("leaves an explicit pty: false call on the plain executor", async () => {
		const doas = writeAuthCommand(tempDir.path(), "doas", PROMPT_FOR_PASSWORD);
		const tool = new BashTool(makeSession());
		const ctx = { hasUI: true, ui: headlessUi() } as unknown as AgentToolContext;
		const result = await tool.execute(
			"call-pty-false",
			{ command: `${doas} true`, timeout: 20, pty: false },
			undefined,
			undefined,
			ctx,
		);
		const text = resultText(result as { content: Array<{ type: string; text?: string }> });

		// No prompt: the stand-in could not reach a terminal, and nothing offered one.
		expect(text).not.toContain("Password:");
		expect(text).not.toContain("no interactive terminal is available here");
	});

	it("refuses an async call that needs a terminal for its password", async () => {
		const tool = new BashTool(makeSession());
		// Detection runs before the job starts, so the command never runs and no
		// real `sudo` is needed.
		await expect(
			tool.execute("call-async", { command: "sudo true", timeout: 20, async: true }, undefined, undefined, {
				hasUI: true,
				ui: headlessUi(),
			} as unknown as AgentToolContext),
		).rejects.toThrow("an async job has none");
	});
});
