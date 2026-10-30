import { describe, expect, it } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { needsNativeTeardown } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

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
