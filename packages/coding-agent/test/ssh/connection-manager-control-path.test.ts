/**
 * Regression for #15974: a `ControlPath` from the user's ssh_config must win
 * over omp's own socket, so `ssh://` reuses a master the user already
 * authenticated (MFA / keyboard-interactive hosts that `BatchMode=yes` can
 * never reach) instead of trying to start a fresh one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import {
	buildRemoteCommand,
	closeConnection,
	ensureConnection,
	getControlPathTemplate,
} from "../../src/ssh/connection-manager";

let binDir: string;
let fakeSsh: string;
let logPath: string;
let userMaster: string;

// Fake `ssh`: `-G` reports configured ControlPaths for `cfg-host` and
// `idle-host`. `cfg-host` already has a master; `idle-host` has none until
// the test simulates a user starting one. Remote probes run locally.
const FAKE_SSH = `#!/usr/bin/env bash
echo "$*" >> "__LOG__"
case " $* " in
	*" -G "*)
		case "\${!#}" in
			cfg-host) echo "controlpath /tmp/user-master.sock" ;;
			idle-host) echo "controlpath /tmp/idle-master.sock" ;;
			none-host) echo "controlpath none" ;;
		esac
		echo "batchmode no"
		exit 0 ;;
	*" -O check "*)
		case " $* " in
			*ControlPath=*) exit 255 ;;
			*" idle-host "*) if [ ! -f "__USER_MASTER__" ]; then exit 255; fi ;;
		esac
		echo "Master running" >&2
		exit 0 ;;
	*" -O exit "*) if [ "\${!#}" = idle-host ]; then rm -f "__USER_MASTER__"; fi; exit 0 ;;
	*" -M "*)
		case " $* " in *" idle-host "*) exit 0 ;; esac
		echo "Permission denied (keyboard-interactive)." >&2; exit 255 ;;
esac
exec bash -c "\${!#}"
`;

async function callsFor(destination: string): Promise<string[]> {
	const log = await Bun.file(logPath).text();
	return log.split("\n").filter(call => ` ${call} `.includes(` ${destination} `));
}

beforeAll(async () => {
	binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-control-path-"));
	fakeSsh = path.join(binDir, "ssh");
	logPath = path.join(binDir, "calls.log");
	userMaster = path.join(binDir, "user-master");
	await fs.writeFile(fakeSsh, FAKE_SSH.replace("__LOG__", logPath).replaceAll("__USER_MASTER__", userMaster), {
		mode: 0o755,
	});
	await Bun.write(logPath, "");
});

afterAll(async () => {
	await fs.rm(binDir, { recursive: true, force: true });
});

beforeEach(() => {
	const realExec = ptree.exec;
	vi.spyOn(ptree, "exec").mockImplementation((cmd, options) =>
		realExec(cmd[0] === "ssh" ? [fakeSsh, ...cmd.slice(1)] : cmd, options),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("ssh_config ControlPath (#15974)", () => {
	it("reuses the master at the configured ControlPath and leaves it running on close", async () => {
		const host = { name: "omp-test-15974-cfg-host", host: "cfg-host" };
		await ensureConnection(host);
		const args = await buildRemoteCommand(host, "true");
		await closeConnection(host.name);

		const calls = await callsFor("cfg-host");
		expect(calls.some(call => call.includes("-O check") && !call.includes("ControlPath="))).toBe(true);
		expect(calls.some(call => call.startsWith("-M "))).toBe(false);
		expect(calls.some(call => call.includes("-O exit"))).toBe(false);
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args.some(arg => arg.startsWith("ControlPersist="))).toBe(false);
		expect(args).toContain("BatchMode=yes");
	});

	it("leaves a new user-owned master running after the configured socket had no master", async () => {
		const host = { name: "omp-test-15974-idle-host", host: "idle-host" };
		await ensureConnection(host);
		// The configured socket was empty at check time. Its owner later
		// authenticates and starts a master before omp closes the host.
		await Bun.write(userMaster, "");
		await closeConnection(host.name);

		const calls = await callsFor("idle-host");
		expect(calls.some(call => call.includes("-O check"))).toBe(true);
		expect(calls.some(call => call.startsWith("-M "))).toBe(false);
		expect(calls.some(call => call.includes("-O exit"))).toBe(false);
	});

	it("keeps omp's socket when ssh_config sets no ControlPath or `none`", async () => {
		for (const name of ["plain-host", "none-host"]) {
			const args = await buildRemoteCommand({ name, host: name }, "true", { platform: "linux" });
			expect(args).toContain(`ControlPath=${getControlPathTemplate()}`);
			expect(args).toContain("ControlPersist=3600");
		}
	});
});
