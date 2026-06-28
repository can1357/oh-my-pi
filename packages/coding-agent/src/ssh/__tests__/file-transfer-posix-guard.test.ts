import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../connection-manager";
import * as connectionManager from "../connection-manager";
import { readRemoteFile, writeRemoteFile } from "../file-transfer";

describe("ssh file-transfer POSIX guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a confirmed Windows remote before running any POSIX command", async () => {
		// Stub BOTH the connection and the host-info probe so the guard is reached
		// without opening a real SSH connection and before any command is spawned.
		const ensureConnectionSpy = vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		const ensureHostInfoSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 2,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };
		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(/Windows host/);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(/Windows host/);
		// Prove the guard ran through the stubbed transport rather than failing early
		// for an unrelated reason (e.g. a future import refactor bypassing the mocks).
		expect(ensureConnectionSpy).toHaveBeenCalled();
		expect(ensureHostInfoSpy).toHaveBeenCalled();
	});

	it("rejects a non-POSIX login shell (csh/tcsh/fish classify as non-sh) before any transfer", async () => {
		// csh/tcsh history-expand `!`, and fish can't parse our POSIX source; all
		// classify as a non-sh shell, so the guard must refuse them before any spawn.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 3,
			os: "linux",
			shell: "unknown",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "fishbox", host: "fishbox" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/non-POSIX login shell/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/non-POSIX login shell/);
	});

	it("allows a POSIX login shell (sh/bash/zsh) to run the transfer commands directly", async () => {
		// A POSIX login shell runs our snippets verbatim; the guard must let it through.
		// Reject at buildRemoteCommand to capture the command before any real ssh spawn.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 3,
			os: "linux",
			shell: "sh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "shbox", host: "shbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);

		// Reached buildRemoteCommand → the guard allowed the POSIX shell. Commands are
		// sent verbatim (no `sh -c` wrapper); write keeps its stdin staging.
		expect(buildSpy.mock.calls[0]?.[1]).toContain("head -c 1025");
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
	});
});
