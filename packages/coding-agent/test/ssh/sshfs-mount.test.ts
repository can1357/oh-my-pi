import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as connectionManager from "../../src/ssh/connection-manager";
import { isMounted, mountRemote } from "../../src/ssh/sshfs-mount";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("mountRemote", () => {
	it("surfaces the shared ControlMaster directory guard before touching sshfs", async () => {
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "sshfs" ? "/bin/true" : null));
		vi.spyOn(connectionManager, "ensureSshControlDir").mockImplementation(() => {
			throw new Error("SSH control directory /tmp/omp-test is a symlink");
		});

		await expect(mountRemote({ name: "nixbox", host: "nixbox" })).rejects.toThrow("is a symlink");
	});
});

describe("isMounted", () => {
	it("detects a macOS mount point when mountpoint is unavailable", async () => {
		const parentPath = import.meta.dir;
		const mountPath = path.join(parentPath, "mounted");
		const stat = async (filePath: string) => ({ dev: filePath === mountPath ? 2 : 1 });

		await expect(isMounted(mountPath, { platform: "darwin", stat, which: () => null })).resolves.toBe(true);
	});
});
