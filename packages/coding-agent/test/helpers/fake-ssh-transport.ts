import { vi } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import * as connectionManager from "../../src/ssh/connection-manager";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import { quotePosixArgument } from "../../src/utils/shell-quote";

/** Execute production POSIX snippets locally, without an SSH connection or global environment changes. */
export function fakeSshTransport(home: (target: SSHConnectionTarget) => string, onSpawn?: () => void) {
	const commands: Array<{ target: SSHConnectionTarget; command: string }> = [];
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 4,
		os: "linux",
		shell: "sh",
		transferShell: "sh",
		compatEnabled: false,
	});
	vi.spyOn(connectionManager, "buildRemoteCommand").mockImplementation(async (target, command) => {
		commands.push({ target, command });
		return ["--fixture", `HOME=${quotePosixArgument(home(target))}; export HOME; ${command}`];
	});
	const spawn = ptree.spawn;
	vi.spyOn(ptree, "spawn").mockImplementation((command, options) => {
		if (command[0] === "ssh" && command[1] === "--fixture") {
			const child = spawn(["sh", "-c", command[2]], options);
			onSpawn?.();
			return child;
		}
		return spawn(command, options);
	});
	return { commands };
}
