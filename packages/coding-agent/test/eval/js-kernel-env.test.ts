import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { BUN_STUB_MESSAGE, bunStubPathEntry, jsKernelEnv } from "../../src/eval/js/kernel-env";

const isWindows = process.platform === "win32";
// Windows runs a `.cmd` stub through cmd.exe, which lives in System32.
const systemPath = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : undefined;

describe("JS eval kernel env", () => {
	afterEach(() => {
		mock.restore();
	});

	it("makes Bun.$`bun` reach the stub instead of the running executable when no bun is on PATH", async () => {
		using dir = TempDir.createSync("@omp-bun-stub-");
		const env = jsKernelEnv(
			{ PATH: systemPath ?? dir.path() },
			{ compiled: true, stubDir: dir.join("stub"), which: () => null },
		);
		expect(env.PATH).toBe(`${systemPath ?? dir.path()}${path.delimiter}${dir.join("stub")}`);
		// In a source run Bun's shell falls back to this bun; the stub must win over that fallback.
		const result = await $`bun --version`.env(env).nothrow().quiet();
		expect(result.exitCode).toBe(127);
		expect(result.stderr.toString()).toContain(BUN_STUB_MESSAGE);
	});

	it("leaves the env alone when bun already resolves or in a source run", () => {
		using dir = TempDir.createSync("@omp-bun-stub-");
		const base = { PATH: "/x" };
		const stubDir = dir.join("stub");
		expect(jsKernelEnv(base, { compiled: true, stubDir, which: () => "/x/bun" })).toEqual(base);
		expect(jsKernelEnv(base, { compiled: false, stubDir, which: () => null })).toEqual(base);
		expect(fs.existsSync(stubDir)).toBe(false);
	});

	it.skipIf(!isWindows)("moves a Windows `Path` key to `PATH` so a Worker's Bun.$ searches the stub", () => {
		using dir = TempDir.createSync("@omp-bun-stub-");
		const env = jsKernelEnv({ Path: "C:\\x" }, { compiled: true, stubDir: dir.join("stub"), which: () => null });
		expect(env).toEqual({ PATH: `C:\\x;${dir.join("stub")}` });
	});

	it("keeps using a stub another version left when it cannot be replaced", () => {
		using dir = TempDir.createSync("@omp-bun-stub-");
		const stubDir = dir.join("stub");
		fs.mkdirSync(stubDir);
		fs.writeFileSync(path.join(stubDir, isWindows ? "bun.cmd" : "bun"), "older stub", { mode: 0o755 });
		spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EPERM" });
		});
		expect(bunStubPathEntry("/x", { compiled: true, stubDir, which: () => null })).toBe(stubDir);
	});

	it("starts the kernel without a stub, leaving no staging file, when publishing fails", () => {
		using dir = TempDir.createSync("@omp-bun-stub-");
		spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});
		const stubDir = dir.join("stub");
		expect(bunStubPathEntry("/x", { compiled: true, stubDir, which: () => null })).toBeUndefined();
		expect(fs.readdirSync(stubDir)).toEqual([]);
	});
});
