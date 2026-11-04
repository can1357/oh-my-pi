import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { needsNativeTeardown } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const { IsoBackendKind } = natives;

// The sidecar set decides which retained workspaces `omp worktree clear`
// routes through native `isoStop` instead of plain recursive `rm`.
describe("retained workspace teardown set", () => {
	it("routes mounts and subvolumes through native teardown, nothing else", () => {
		for (const kind of [IsoBackendKind.Overlayfs, IsoBackendKind.Projfs, IsoBackendKind.Btrfs]) {
			expect(needsNativeTeardown(kind)).toBe(true);
		}
		for (const kind of [
			IsoBackendKind.Apfs,
			// ZFS clones need dataset-aware teardown too, but isoStop locates
			// the dataset by its recorded mountpoint property, which no longer
			// matches after the retain rename — pi-iso mount-table support first.
			IsoBackendKind.Zfs,
			IsoBackendKind.LinuxReflink,
			IsoBackendKind.WindowsBlockClone,
			IsoBackendKind.Rcopy,
		]) {
			expect(needsNativeTeardown(kind)).toBe(false);
		}
	});

	it("rejects non-backend values", () => {
		for (const value of [undefined, null, "overlayfs", 1.5, -1, 999]) {
			expect(needsNativeTeardown(value)).toBe(false);
		}
	});
});

describe("process start time", () => {
	it("answers null, not a throw, on a host whose PATH has no `ps`", async () => {
		// Off Linux every claim, lease and writer record asks `ps` for a start
		// time. A host without it — Windows, a minimal container — must fall
		// back to the pid-only check the record already allows, not fail the
		// claim. The spawn resolves `ps` from the process's own PATH, so the
		// probe runs in a child started with a PATH that holds nothing.
		const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-ps-"));
		try {
			const module = path.join(import.meta.dir, "../../src/task/isolation-fs.ts");
			const probe = [
				`const { processStartTime } = await import(${JSON.stringify(module)});`,
				"try { console.log(JSON.stringify({ value: await processStartTime(process.pid) })); }",
				"catch (error) { console.log(JSON.stringify({ threw: String(error) })); }",
			].join(" ");
			const child = Bun.spawn([process.execPath, "-e", probe], {
				env: { ...Bun.env, PATH: emptyPath },
				stdout: "pipe",
				stderr: "ignore",
			});
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			expect(JSON.parse(out.trim().split("\n").at(-1) ?? "{}")).toEqual({ value: null });
		} finally {
			await removeWithRetries(emptyPath);
		}
	}, 30_000);
});
