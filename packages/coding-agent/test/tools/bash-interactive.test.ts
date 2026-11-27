import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import type { ExtensionCustomFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ensureTheme } from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { createRoot, type UiNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { extensionTheme } from "../../src/ui/extensions/render-output";
import { keyEvent } from "../helpers/input-harness";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/**
 * A UI whose `custom()` builds the console view against a 100×30 host, hands
 * the view to `onView`, and resolves with the value the console reports
 * through `done`. Nothing is rendered to a real terminal.
 */
function headlessUi(onView?: (view: UiNode) => void): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(factory: ExtensionCustomFactory<T>): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		const host: ExtensionUiHost = {
			requestRender() {},
			size: () => ({ columns: 100, rows: 30 }),
			suspend: run => run(),
		};
		ensureTheme();
		const view = await createRoot(() =>
			factory(host, extensionTheme(currentTheme()), KeybindingsManager.inMemory(), resolve),
		);
		if (view && typeof view === "object" && "kind" in view) onView?.(view);
		return promise;
	};
	return { custom };
}

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

describe("runInteractiveBashPty", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
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
			// The guards never reach the program: it sees the launch values, whatever they are.
			expect(output).toBe(launch);
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
	it.skipIf(ptyUnavailable)("forwards keys typed into the console to the program", async () => {
		const started = Promise.withResolvers<void>();
		let view: UiNode | undefined;
		const command = `read -r line; printf 'got=%s\\n' "$line"`;
		const running = runInteractiveBashPty(
			headlessUi(node => {
				view = node;
			}),
			{
				command,
				application: "/bin/bash",
				args: ["-c", command],
				cwd: tempDir.path(),
				timeoutMs: 15_000,
				env: { PATH: Bun.env.PATH ?? "", HOME: tempDir.path() },
				onStart: () => started.resolve(),
			},
		);
		await started.promise;
		if (!view) throw new Error("expected the console view");
		for (const key of ["h", "i", "enter"]) expect(view.handlers.onKey?.(keyEvent(key))).toBe(true);

		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("got=hi");
	});
});
