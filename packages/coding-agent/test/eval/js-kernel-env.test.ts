import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { bunShimPathEntry, bunShimScript, jsKernelEnv } from "../../src/eval/js/kernel-env";
import * as workerClient from "../../src/subprocess/worker-client";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("JS eval kernel env", () => {
	const roots: string[] = [];
	const shimRoot = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bun-shim-"));
		roots.push(dir);
		return dir;
	};
	afterEach(() => {
		mock.restore();
		for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("marks the kernel as a tool process", () => {
		expect(jsKernelEnv({ PATH: "/usr/bin" }, { compiled: false }).OMPCODE).toBe("1");
	});

	it("puts a bun shim at the END of a compiled kernel's PATH when none resolves, so the fallback never fires", () => {
		const root = shimRoot();
		const env = jsKernelEnv(
			{ PATH: "/usr/bin:/bin" },
			{ compiled: true, execPath: "/opt/omp/omp", shimRoot: root, which: () => null },
		);
		const shimDir = env.PATH.slice("/usr/bin:/bin:".length);
		expect(env.PATH).toBe(`/usr/bin:/bin:${shimDir}`);
		expect(path.dirname(shimDir)).toBe(root);
		const shim = path.join(shimDir, "bun");
		expect(fs.readFileSync(shim, "utf8")).toBe(bunShimScript("/opt/omp/omp"));
		expect(fs.statSync(shim).mode & 0o111).toBe(0o111);
		expect(fs.readdirSync(shimDir)).toEqual(["bun"]);
	});

	it("re-enters the executable as bun: the shim runs the exec path with BUN_BE_BUN=1 and the caller's arguments", () => {
		const root = shimRoot();
		const fakeExec = path.join(root, "fake omp's exe");
		fs.writeFileSync(fakeExec, '#!/bin/sh\nprintf \'%s|%s\\n\' "$BUN_BE_BUN" "$*"\n', { mode: 0o755 });
		const shimDir = bunShimPathEntry(
			{ PATH: "/usr/bin:/bin" },
			{ compiled: true, execPath: fakeExec, shimRoot: root, which: () => null },
		);
		const out = Bun.spawnSync([path.join(shimDir ?? "", "bun"), "--version"], { env: { PATH: "/usr/bin:/bin" } });
		expect(out.stdout.toString()).toBe("1|--version\n");
	});

	it("installs no shim when bun already resolves or in a source run", () => {
		const root = shimRoot();
		expect(
			bunShimPathEntry({ PATH: "/x" }, { compiled: true, shimRoot: root, which: () => "/x/bun" }),
		).toBeUndefined();
		expect(bunShimPathEntry({ PATH: "/x" }, { compiled: false, shimRoot: root, which: () => null })).toBeUndefined();
		expect(fs.readdirSync(root)).toEqual([]);
	});

	it("gives each executable its own shim that never changes, so another version's live kernel keeps its target", () => {
		const root = shimRoot();
		const opts = { compiled: true, shimRoot: root, which: () => null };
		const dirA = bunShimPathEntry({ PATH: "/x" }, { ...opts, execPath: "/versions/a/omp" });
		const dirB = bunShimPathEntry({ PATH: "/x" }, { ...opts, execPath: "/versions/b/omp" });
		expect(dirA).not.toBe(dirB);
		expect(fs.readFileSync(path.join(dirA ?? "", "bun"), "utf8")).toBe(bunShimScript("/versions/a/omp"));
		expect(fs.readFileSync(path.join(dirB ?? "", "bun"), "utf8")).toBe(bunShimScript("/versions/b/omp"));
		const before = fs.statSync(path.join(dirA ?? "", "bun")).mtimeMs;
		expect(bunShimPathEntry({ PATH: "/x" }, { ...opts, execPath: "/versions/a/omp" })).toBe(dirA);
		expect(fs.statSync(path.join(dirA ?? "", "bun")).mtimeMs).toBe(before);
	});

	it("starts the kernel without a shim when the shim root cannot be created, keeping the tool-process mark", () => {
		const root = shimRoot();
		const blocked = path.join(root, "not-a-dir");
		fs.writeFileSync(blocked, "");
		const env = jsKernelEnv(
			{ PATH: "/usr/bin:/bin" },
			{ compiled: true, execPath: "/opt/omp/omp", shimRoot: blocked, which: () => null },
		);
		expect(env.PATH).toBe("/usr/bin:/bin");
		expect(env.OMPCODE).toBe("1");
	});

	it("leaves no staging file behind when publishing the shim fails", () => {
		const root = shimRoot();
		spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});
		const shimDir = bunShimPathEntry(
			{ PATH: "/x" },
			{ compiled: true, execPath: "/opt/omp/omp", shimRoot: root, which: () => null },
		);
		expect(shimDir).toBeUndefined();
		const [hashDir] = fs.readdirSync(root);
		expect(fs.readdirSync(path.join(root, hashDir ?? ""))).toEqual([]);
	});

	it("re-enters the executable an upgrade left in place, not a pruned process.execPath", () => {
		const root = shimRoot();
		spyOn(workerClient, "resolveExecutablePath").mockReturnValue("/usr/local/bin/omp");
		const shimDir = bunShimPathEntry({ PATH: "/x" }, { compiled: true, shimRoot: root, which: () => null });
		expect(fs.readFileSync(path.join(shimDir ?? "", "bun"), "utf8")).toBe(bunShimScript("/usr/local/bin/omp"));
	});
});
