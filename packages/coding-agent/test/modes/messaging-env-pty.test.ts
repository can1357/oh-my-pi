import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { runInteractiveBashPty } from "../../src/tools/bash-interactive";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;
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

const unavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");
describe("messaging env in interactive PTY commands", () => {
	let temp: TempDir;
	beforeEach(async () => {
		initTheme();
		temp = TempDir.createSync("@messaging-env-pty-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: temp.path() });
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: temp.path(),
				OMP_MESSAGING_SOCKET: "parent-socket",
				OMP_MESSAGING_TOKEN: "parent-token",
			},
			prefix: undefined,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		temp.removeSync();
	});

	it.skipIf(unavailable)("removes both inherited and overlay credentials from a helper's real PTY child", async () => {
		const result = await runInteractiveBashPty(headlessUi(), {
			command: 'printf "socket=<%s> token=<%s>" "${OMP_MESSAGING_SOCKET-unset}" "${OMP_MESSAGING_TOKEN-unset}"',
			cwd: temp.path(),
			timeoutMs: 15_000,
			env: { OMP_MESSAGING_SOCKET: "overlay-socket", OMP_MESSAGING_TOKEN: "overlay-token" },
			stripEnv: ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"],
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("socket=<> token=<>");
	});
});
