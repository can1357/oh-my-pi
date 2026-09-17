import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, WhichCachePolicy } from "../src/which";

describe("$which", () => {
	const originalPath = process.env.PATH;
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.PATH = originalPath;
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("uses the current process PATH for each cached lookup", () => {
		const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-which-first-"));
		const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-which-second-"));
		tempDirs.push(firstDir, secondDir);

		const command = `omp-which-${process.pid}`;
		const firstExecutable = path.join(firstDir, command);
		const secondExecutable = path.join(secondDir, command);
		fs.writeFileSync(firstExecutable, "#!/bin/sh\n");
		fs.writeFileSync(secondExecutable, "#!/bin/sh\n");
		fs.chmodSync(firstExecutable, 0o755);
		fs.chmodSync(secondExecutable, 0o755);

		process.env.PATH = firstDir;
		expect($which(command)).toBe(firstExecutable);

		process.env.PATH = secondDir;
		expect($which(command)).toBe(secondExecutable);
	});

	it("returns null when requireAbsolutePaths is true and PATH contains only relative entries", () => {
		process.env.PATH = [".", "./bin", ""].join(path.delimiter);
		expect($which("some-command", { requireAbsolutePaths: true })).toBeNull();
	});

	it.skipIf(process.platform === "win32")(
		"resolves absolute PATH entries while ignoring relative ones when requireAbsolutePaths is true",
		() => {
			const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-which-abs-"));
			tempDirs.push(testDir);

			const command = `omp-test-cmd-${process.pid}`;
			const executable = path.join(testDir, command);
			fs.writeFileSync(executable, "#!/bin/sh\n");
			fs.chmodSync(executable, 0o755);

			process.env.PATH = [".", "./bin", "", testDir].join(path.delimiter);
			expect($which(command, { requireAbsolutePaths: true })).toBe(executable);
		},
	);
	// Tests stub `Bun.which` per test to keep PATH lookups hermetic. If `$which`
	// captured the original function at import, such a stub would be bypassed and
	// host binaries would leak into the result.
	it("honours a Bun.which stub installed after import", () => {
		const command = `omp-which-stubbed-${process.pid}`;
		const stubbedPath = path.join(os.tmpdir(), "omp-which-stub", command);
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(stubbedPath);

		expect($which(command, { cache: WhichCachePolicy.Bypass })).toBe(stubbedPath);
		expect(whichSpy).toHaveBeenCalledWith(command, expect.objectContaining({ PATH: process.env.PATH }));
	});

	it("does not alias cache entries when cwd/PATH contain the old separator byte", () => {
		const sep = "";
		const first = `/tmp/which-first-${process.pid}`;
		const second = `/tmp/which-second-${process.pid}`;
		const whichSpy = vi
			.spyOn(Bun, "which")
			.mockImplementation((command: string, options?: Bun.WhichOptions) =>
				options?.cwd === "a" && options?.PATH === `b${sep}c` ? first : second,
			);

		expect($which("cmd", { cwd: "a", PATH: `b${sep}c` })).toBe(first);
		expect($which("cmd", { cwd: `a${sep}b`, PATH: "c" })).toBe(second);
		expect(whichSpy).toHaveBeenCalledTimes(2);
	});
});
