import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable fallback on unlinked binary", () => {
	const originalExecPathDesc = Object.getOwnPropertyDescriptor(process, "execPath");
	const originalArgv0Desc = Object.getOwnPropertyDescriptor(process, "argv0");
	const originalPath = process.env.PATH;

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalExecPathDesc) {
			Object.defineProperty(process, "execPath", originalExecPathDesc);
		}
		if (originalArgv0Desc) {
			Object.defineProperty(process, "argv0", originalArgv0Desc);
		}
	});

	function setProcessProp(prop: "execPath" | "argv0", value: string) {
		Object.defineProperty(process, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	function mockFileStat(isFile: boolean, mode = 0o755): fs.Stats {
		return {
			isFile: () => isFile,
			mode,
		} as unknown as fs.Stats;
	}

	it("returns process.execPath when the file exists and is executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(fs, "statSync").mockReturnValue(mockFileStat(true, 0o755));
		expect(resolveExecutablePath()).toBe(process.execPath);
	});

	it("prefers original absolute launcher path over generic PATH match when executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/omp";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return otherOmpInPath;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation((p: fs.PathLike) => {
			if (p === originalLauncher || p === otherOmpInPath) return mockFileStat(true, 0o755);
			throw new Error("ENOENT");
		});

		const resolved = resolveExecutablePath();
		expect(resolved).toBe(originalLauncher);
	});

	it("falls back to PATH when original absolute launcher is a directory or not executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/omp";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return otherOmpInPath;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation((p: fs.PathLike) => {
			// Launcher exists but is a directory or has no execute bit (mode 0644)
			if (p === originalLauncher) return mockFileStat(false, 0o644);
			if (p === otherOmpInPath) return mockFileStat(true, 0o755);
			throw new Error("ENOENT");
		});

		const resolved = resolveExecutablePath();
		expect(resolved).toBe(otherOmpInPath);
	});

	it("does not resolve relative argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "./omp");

		const cwdRogueBinary = path.resolve("./omp");
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "./omp") return cwdRogueBinary;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation((p: fs.PathLike) => {
			if (p === cwdRogueBinary) return mockFileStat(true, 0o755);
			throw new Error("ENOENT");
		});

		// Relative argv0 must not resolve against cwd; falls back to missingPath gracefully
		const resolved = resolveExecutablePath();
		expect(resolved).toBe(missingPath);
	});

	it("does not treat Windows drive-relative paths (e.g. C:omp) as bare commands", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "C:\\Tools\\omp.exe";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "C:omp");

		let whichCalledWith: string | undefined;
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			whichCalledWith = cmd;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		resolveExecutablePath();

		// Should not pass "C:omp" to which as a bare name; only "omp" generic fallback is queried
		expect(whichCalledWith).toBe("omp");
	});

	it("rejects relative PATH entries and empty components when searching PATH fallbacks", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omp");

		// Set PATH with relative components: '.', './bin', and empty slot '::'
		process.env.PATH = [".", "./bin", "", "/usr/bin"].join(path.delimiter);

		let inspectedSearchPath: string | undefined;
		vi.spyOn(Bun, "which").mockImplementation((cmd: string, options?: { PATH?: string }) => {
			inspectedSearchPath = options?.PATH;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		resolveExecutablePath();

		// PATH passed to Bun.which must only contain absolute entries (/usr/bin)
		expect(inspectedSearchPath).toBe("/usr/bin");
	});

	it("does not call Bun.which when PATH contains only relative entries or is empty", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omp");

		// PATH containing only relative entries
		process.env.PATH = [".", "./bin", "node_modules/.bin"].join(path.delimiter);

		const whichSpy = vi.spyOn(Bun, "which");
		(vi.spyOn(fs, "statSync") as any).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("rejects non-absolute results returned from Bun.which", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omp");

		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue("./relative/omp" as string);
		(vi.spyOn(fs, "statSync") as any).mockImplementation((p: fs.PathLike) => {
			// missingPath does NOT exist, but the relative candidate exists:
			if (p === "./relative/omp") return mockFileStat(true, 0o755);
			throw new Error("ENOENT");
		});

		// Fallback must be engaged, Bun.which called, and the non-absolute result rejected
		const resolved = resolveExecutablePath();
		expect(whichSpy).toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("falls back to Bun.which('omp') when original execPath was unlinked and argv0 has no path", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omp");

		const mockUpgradedPath = "/opt/homebrew/bin/omp";
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return mockUpgradedPath;
			return null;
		});
		(vi.spyOn(fs, "statSync") as any).mockImplementation((p: fs.PathLike) => {
			if (p === mockUpgradedPath) return mockFileStat(true, 0o755);
			throw new Error("ENOENT");
		});

		const resolved = resolveExecutablePath();
		expect(resolved).toBe(mockUpgradedPath);
		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__omp_worker_test"],
		});
	});

	it("does not perform fallback lookup when isCompiledBinary is false", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);

		const whichSpy = vi.spyOn(Bun, "which");
		(vi.spyOn(fs, "statSync") as any).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/omp";
		setProcessProp("execPath", missingPath);
		vi.spyOn(Bun, "which").mockReturnValue(null);
		(vi.spyOn(fs, "statSync") as any).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
