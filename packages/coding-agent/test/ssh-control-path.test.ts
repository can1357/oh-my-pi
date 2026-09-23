import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertOwnerPrivateDir,
	controlDirGuardError,
	controlPathFitsBudget,
	getControlDir,
	getControlPathTemplate,
	resolveSshControlDir,
	sshControlFallbackDir,
} from "../src/ssh/connection-manager";

// Regression coverage for #9070: named-profile roots pushed the SSH ControlPath
// past macOS's 104-byte sun_path once OpenSSH appends its mux temp suffix.
describe("SSH control-path budget (#9070)", () => {
	it("rejects a control dir that overflows sun_path once %C.sock + mux temp bind is added", () => {
		// A representative macOS named-profile control dir is 48 bytes; the
		// temporary bind path is 48 + 63 = 111 >= 104, so it must not fit.
		const profileDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		expect(Buffer.byteLength(profileDir)).toBe(48);
		expect(controlPathFitsBudget(profileDir, "darwin")).toBe(false);
		// The default (unprofiled) macOS dir stays within budget.
		expect(controlPathFitsBudget("/Users/arthur/.omp/ssh-control", "darwin")).toBe(true);
	});

	it("places the darwin boundary at 40 bytes of control dir", () => {
		expect(controlPathFitsBudget("a".repeat(40), "darwin")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(41), "darwin")).toBe(false);
	});

	it("routes on platform: 42-byte dir fits Linux's 108 but not macOS's 104", () => {
		const dir = "a".repeat(42);
		expect(controlPathFitsBudget(dir, "darwin")).toBe(false);
		expect(controlPathFitsBudget(dir, "linux")).toBe(true);
		// Linux boundary sits at 44 bytes.
		expect(controlPathFitsBudget("a".repeat(44), "linux")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(45), "linux")).toBe(false);
	});
});

describe("sshControlFallbackDir", () => {
	it("is deterministic and leaves 11 bytes of macOS sun_path slack", () => {
		const canonicalDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		const a = sshControlFallbackDir(canonicalDir, 501);
		const b = sshControlFallbackDir(canonicalDir, 501);
		expect(a).toBe(b);
		expect(a).toBe("/tmp/omp-5434354bc38f9a50fbbd");
		expect(Buffer.byteLength(a)).toBe(29);
		const tempBind = path.join(a, `${"a".repeat(40)}.sock.${"b".repeat(16)}`);
		expect(Buffer.byteLength(tempBind)).toBe(92);
		expect(103 - Buffer.byteLength(tempBind)).toBe(11);
		expect(controlPathFitsBudget(a, "darwin")).toBe(true);
	});

	it("isolates distinct canonical control directories and uids", () => {
		const base = "/Users/arthur/.omp/ssh-control";
		expect(sshControlFallbackDir(base, 501)).not.toBe(
			sshControlFallbackDir("/different/xdg/state/omp/ssh-control", 501),
		);
		expect(sshControlFallbackDir(base, 501)).not.toBe(sshControlFallbackDir(base, 502));
	});
});

describe("resolveSshControlDir", () => {
	it("keeps the canonical dir when it fits", () => {
		const canonicalDir = "/Users/arthur/.omp/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, platform: "darwin", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});

	it("relocates to the bounded shared fallback when the canonical dir overflows", () => {
		const canonicalDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		const choice = resolveSshControlDir({ canonicalDir, platform: "darwin", uid: 501, tmpBase: "/tmp" });
		expect(choice).toEqual({ dir: "/tmp/omp-5434354bc38f9a50fbbd", shared: true });
		expect(controlPathFitsBudget(choice.dir, "darwin")).toBe(true);
	});

	it("keeps distinct fallback masters for the same profile under different XDG state roots", () => {
		const a = resolveSshControlDir({
			canonicalDir: "/very/long/xdg-state-a/omp/profiles/upstream/ssh-control",
			platform: "darwin",
			uid: 501,
		});
		const b = resolveSshControlDir({
			canonicalDir: "/very/long/xdg-state-b/omp/profiles/upstream/ssh-control",
			platform: "darwin",
			uid: 501,
		});
		expect(a.shared).toBe(true);
		expect(b.shared).toBe(true);
		expect(a.dir).not.toBe(b.dir);
	});

	it("never relocates on Windows (ControlMaster unused) even for a long path", () => {
		const canonicalDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, platform: "win32", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});

	it("keeps the canonical dir when there is no uid to key the fallback", () => {
		const canonicalDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, platform: "darwin", uid: undefined })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});
});

describe("controlDirGuardError", () => {
	const ok = { isSymlink: false, isDir: true, uid: 501, mode: 0o700 };

	it("accepts an owner-private directory", () => {
		expect(controlDirGuardError(ok, 501)).toBeNull();
	});

	it("rejects a symlink, non-directory, foreign owner, and loose mode", () => {
		expect(controlDirGuardError({ ...ok, isSymlink: true }, 501)).toBe("is a symlink");
		expect(controlDirGuardError({ ...ok, isDir: false }, 501)).toBe("is not a directory");
		expect(controlDirGuardError({ ...ok, uid: 999 }, 501)).toContain("not 501");
		expect(controlDirGuardError({ ...ok, mode: 0o755 }, 501)).toContain("0700");
	});

	it("skips the owner check when the process has no uid", () => {
		expect(controlDirGuardError({ ...ok, uid: 999 }, undefined)).toBeNull();
	});
});

describe("assertOwnerPrivateDir", () => {
	let scratch: string;

	afterEach(() => {
		if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
	});

	const mkScratch = () => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ssh-guard-"));
		return scratch;
	};

	it("accepts a real owner-private directory and normalizes loose perms in place", () => {
		const dir = path.join(mkScratch(), "ctl");
		fs.mkdirSync(dir, { mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		expect(() => assertOwnerPrivateDir(dir)).not.toThrow();
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("refuses a symlinked final component without following it (TOCTOU swap guard)", () => {
		const root = mkScratch();
		const victim = path.join(root, "victim");
		fs.mkdirSync(victim, { mode: 0o700 });
		const link = path.join(root, "ctl");
		fs.symlinkSync(victim, link);
		// A symlink pointing at an otherwise-valid 0700 directory must still be
		// rejected: O_NOFOLLOW refuses the link itself, so a later re-target cannot
		// slip a foreign directory past the guard.
		expect(() => assertOwnerPrivateDir(link)).toThrow("is a symlink");
	});

	it("refuses a non-directory", () => {
		const file = path.join(mkScratch(), "ctl");
		fs.writeFileSync(file, "");
		expect(() => assertOwnerPrivateDir(file)).toThrow("is not a directory");
	});
});

describe("control template sharing", () => {
	// sshfs-mount consumes getControlPathTemplate()/getControlDir() verbatim, so
	// the %C.sock basename and its parent dir must stay in lockstep.
	it("keeps %C.sock under the resolved control dir", () => {
		expect(getControlPathTemplate()).toBe(path.join(getControlDir(), "%C.sock"));
	});
});
