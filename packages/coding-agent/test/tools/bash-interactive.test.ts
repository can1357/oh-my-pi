import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/**
 * A UI whose `custom()` mounts the overlay factory against a headless TUI over
 * a virtual terminal and resolves with the value the overlay reports through
 * `done`. Nothing is rendered to a real terminal.
 */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(
		factory: (tui: TUI, uiTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
	): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
		return promise;
	};
	return { custom };
}

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

describe("runInteractiveBashPty", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		initTheme();
		tempDir = TempDir.createSync("@omp-bash-pty-env-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/** Run the env probe on a real PTY as a program started from the session exports `env`. */
	async function probe(env: Record<string, string>): Promise<string> {
		const command = `printf 'probe=%s term=%s ci=%s no_color=%s git_editor=%s gpg_tty=%s tty=%s\\n' "\${OMP_PTY_PROBE-unset}" "$TERM" "\${CI-unset}" "\${NO_COLOR-unset}" "\${GIT_EDITOR-unset}" "\${GPG_TTY-unset}" "$([ -t 0 ] && echo yes)"`;
		const result = await runInteractiveBashPty(headlessUi(), {
			command,
			application: "/bin/bash",
			args: ["-c", command],
			cwd: tempDir.path(),
			timeoutMs: 15_000,
			env: { PATH: Bun.env.PATH ?? "", HOME: tempDir.path(), ...env },
		});
		expect(result.exitCode).toBe(0);
		return result.output;
	}

	it.skipIf(ptyUnavailable)(
		"starts the program on a terminal from the session's exports, without the guards of unattended commands",
		async () => {
			// What the launch environment itself gives the program for the guarded names.
			const launch = await probe({ OMP_PTY_PROBE: "from-session" });

			// What the session shell exports while it runs a command nobody can answer.
			const output = await probe({
				OMP_PTY_PROBE: "from-session",
				TERM: "dumb",
				CI: "true",
				NO_COLOR: "1",
				GIT_EDITOR: "true",
				GPG_TTY: "not a tty",
			});

			expect(output).toContain("probe=from-session term=xterm-256color");
			expect(output).toContain("tty=yes");
			// The PTY writer can echo a final newline on teardown. Compare the probe's line.
			expect(output.replace(/\n+$/u, "")).toBe(launch.replace(/\n+$/u, ""));
		},
	);

	it.skipIf(ptyUnavailable)("keeps a value the session set itself where a guard would be", async () => {
		const output = await probe({
			TERM: "session-term",
			CI: "session-ci",
			NO_COLOR: "session-no-color",
			GIT_EDITOR: "session-git-editor",
			GPG_TTY: "session-gpg-tty",
		});

		expect(output).toContain(
			"term=session-term ci=session-ci no_color=session-no-color git_editor=session-git-editor gpg_tty=session-gpg-tty",
		);
	});
});
