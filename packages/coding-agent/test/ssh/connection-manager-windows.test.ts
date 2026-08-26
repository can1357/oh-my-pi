import { afterEach, describe, expect, it, vi } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import * as connectionManager from "../../src/ssh/connection-manager";

type ExecResult = { exitCode: number | null; stdout: string; stderr: string };

const HOST = { name: "probe-win-test", host: "probe-win-test.invalid" };

/**
 * Fake the `ptree.exec` layer every probe goes through. `respond` receives the
 * full ssh argv; the remote command is `argv.at(-1)`. Unmatched argv → benign
 * success (ControlMaster `-O check`, etc.).
 */
function mockSshExec(respond: (remoteCommand: string) => ExecResult) {
	return vi.spyOn(ptree, "exec").mockImplementation((async (argv: string[]) => {
		const remote = String(argv.at(-1) ?? "");
		return respond(remote);
	}) as unknown as typeof ptree.exec);
}

const PS_OK: ExecResult = { exitCode: 0, stdout: "PI_PS_OK\r\n", stderr: "" };
const PS_FAIL: ExecResult = { exitCode: 1, stdout: "", stderr: "not recognized" };
const COMPOUND_PARSE_ERROR: ExecResult = {
	exitCode: 1,
	stdout: "",
	stderr: "'||' is not recognized as an internal or external command",
};

describe("probeHostInfo layered classification", () => {
	afterEach(async () => {
		await connectionManager.invalidateHostMetadata([HOST.name]);
		vi.restoreAllMocks();
	});

	it("classifies a PS 5.1 default-shell host as windows with a powershell transferShell", async () => {
		const execSpy = mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) return COMPOUND_PARSE_ERROR;
			if (cmd.startsWith("sh -lc") || cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_OK;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("windows");
		expect(info.transferShell).toBe("powershell");
		// Windows main path also probes the compat shell; both must have failed.
		expect(info.compatEnabled).toBe(false);
		expect(execSpy).toHaveBeenCalled();
	});

	it("classifies a cmd default-shell host with no powershell at all as unknown", async () => {
		// Every probe fails, but connection-control commands (`ssh -O check`)
		// must still succeed — on ControlMaster-capable clients (Linux CI)
		// ensureConnection runs them, and a failing `-O check` would abort the
		// probe with "Failed to start SSH master" before classification.
		mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) return PS_FAIL;
			if (cmd.startsWith("sh -lc") || cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_FAIL;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("unknown");
		expect(info.transferShell).toBeUndefined();
	});

	it("routes an msys-uname host to windows but transfers via powershell, not the msys sh", async () => {
		mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) return COMPOUND_PARSE_ERROR;
			if (cmd.startsWith("sh -lc")) {
				return { exitCode: 0, stdout: "PI_TRANSFER_OK|MSYS_NT-10.0-19045", stderr: "" };
			}
			if (cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_OK;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("windows");
		expect(info.transferShell).toBe("powershell");
	});

	it("never probes powershell when a linux host answers the posix probes first", async () => {
		const execSpy = mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) return COMPOUND_PARSE_ERROR;
			if (cmd.startsWith("sh -lc")) {
				return { exitCode: 0, stdout: "PI_TRANSFER_OK|Linux", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("linux");
		expect(info.transferShell).toBe("sh");
		const commands = execSpy.mock.calls.map(call => String(call[0].at(-1)));
		expect(commands.some(c => c.includes("EncodedCommand"))).toBe(false);
	});

	it("probes the powershell transfer channel on a compound-probe windows hit", async () => {
		mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) {
				return { exitCode: 0, stdout: "PI_HOST_PROBE=msys_nt|powershell|", stderr: "" };
			}
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_OK;
			if (cmd.startsWith("sh -lc") || cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			// Connection-control commands succeed (see the cmd-host test above).
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("windows");
		expect(info.transferShell).toBe("powershell");
	});
	it("re-probes powershell when a posix probe recovers windows os on the os-empty main path", async () => {
		const execSpy = mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) {
				// Compound probe parsed, but $OSTYPE came back empty: the main
				// path holds os=unknown until the transfer probe's uname
				// recovers it — as windows, via an msys sh.
				return { exitCode: 0, stdout: "PI_HOST_PROBE=||\n", stderr: "" };
			}
			if (cmd.startsWith("sh -lc")) {
				return { exitCode: 0, stdout: "PI_TRANSFER_OK|MSYS_NT-10.0-19045", stderr: "" };
			}
			if (cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_OK;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("windows");
		expect(info.transferShell).toBe("powershell");
		// The msys sh that recovered the os must be discarded, not used.
		const commands = execSpy.mock.calls.map(call => String(call[0].at(-1)));
		expect(commands.some(c => c.includes("EncodedCommand"))).toBe(true);
	});

	it("classifies windows via the powershell layer when the parsed-but-unknown main path misses every posix shell", async () => {
		const execSpy = mockSshExec(cmd => {
			if (cmd.includes("PI_HOST_PROBE=")) {
				// Compound probe parsed, but every field is empty/unclassifiable:
				// the main path holds os=unknown, and no sh/bash/zsh answers.
				return { exitCode: 0, stdout: "PI_HOST_PROBE=||\n", stderr: "" };
			}
			if (cmd.startsWith("sh -lc") || cmd.startsWith("bash -lc") || cmd.startsWith("zsh -lc")) return PS_FAIL;
			if (cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand")) return PS_OK;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const info = await connectionManager.ensureHostInfo(HOST);
		expect(info.os).toBe("windows");
		expect(info.transferShell).toBe("powershell");
		const commands = execSpy.mock.calls.map(call => String(call[0].at(-1)));
		expect(commands.some(c => c.includes("EncodedCommand"))).toBe(true);
	});
});
