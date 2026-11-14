import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { bunShimPathEntry, bunShimScript, jsKernelEnv } from "../../src/eval/js/kernel-env";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("JS eval kernel env", () => {
	const dirs: string[] = [];
	const shimDir = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bun-shim-"));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("marks the kernel as a tool process", () => {
		expect(jsKernelEnv({ PATH: "/usr/bin" }, { compiled: false }).OMPCODE).toBe("1");
	});

	it("puts a bun shim at the END of a compiled kernel's PATH when none resolves, so the fallback never fires", () => {
		const dir = shimDir();
		const env = jsKernelEnv(
			{ PATH: "/usr/bin:/bin" },
			{ compiled: true, execPath: "/opt/omp/omp", shimDir: dir, which: () => null },
		);
		expect(env.PATH).toBe(`/usr/bin:/bin:${dir}`);
		const shim = path.join(dir, "bun");
		expect(fs.readFileSync(shim, "utf8")).toBe(bunShimScript("/opt/omp/omp"));
		expect(fs.statSync(shim).mode & 0o111).toBe(0o111);
	});

	it("re-enters the executable as bun: the shim runs the exec path with BUN_BE_BUN=1 and the caller's arguments", () => {
		const dir = shimDir();
		const fakeExec = path.join(dir, "fake omp's exe");
		fs.writeFileSync(fakeExec, '#!/bin/sh\nprintf \'%s|%s\\n\' "$BUN_BE_BUN" "$*"\n', { mode: 0o755 });
		bunShimPathEntry(
			{ PATH: "/usr/bin:/bin" },
			{ compiled: true, execPath: fakeExec, shimDir: dir, which: () => null },
		);
		const out = Bun.spawnSync([path.join(dir, "bun"), "--version"], { env: { PATH: "/usr/bin:/bin" } });
		expect(out.stdout.toString()).toBe("1|--version\n");
	});

	it("installs no shim when bun already resolves, in a source run, or on an unchanged PATH", () => {
		const dir = shimDir();
		expect(bunShimPathEntry({ PATH: "/x" }, { compiled: true, shimDir: dir, which: () => "/x/bun" })).toBeUndefined();
		expect(bunShimPathEntry({ PATH: "/x" }, { compiled: false, shimDir: dir, which: () => null })).toBeUndefined();
		expect(fs.existsSync(path.join(dir, "bun"))).toBe(false);
	});

	it("rewrites a shim that names another executable, so a moved binary leaves no stale shim", () => {
		const dir = shimDir();
		const opts = { compiled: true, shimDir: dir, which: () => null };
		bunShimPathEntry({ PATH: "/x" }, { ...opts, execPath: "/old/omp" });
		bunShimPathEntry({ PATH: "/x" }, { ...opts, execPath: "/new/omp" });
		expect(fs.readFileSync(path.join(dir, "bun"), "utf8")).toBe(bunShimScript("/new/omp"));
	});
});
