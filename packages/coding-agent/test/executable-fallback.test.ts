import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable fallback on unlinked binary", () => {
	const originalExecPath = process.execPath;
	const originalArgv0 = process.argv0;

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		Object.defineProperty(process, "argv0", { value: originalArgv0, configurable: true });
	});

	it("returns process.execPath when the file exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		expect(resolveExecutablePath()).toBe(originalExecPath);
	});

	it("prefers original launcher path with path separator over generic PATH match", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/omp";

		Object.defineProperty(process, "execPath", { value: missingPath, configurable: true });
		Object.defineProperty(process, "argv0", { value: originalLauncher, configurable: true });

		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return otherOmpInPath;
			return null;
		});
		vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
			if (p === missingPath) return false;
			if (p === originalLauncher) return true;
			if (p === otherOmpInPath) return true;
			return false;
		});

		const resolved = resolveExecutablePath();
		expect(resolved).toBe(originalLauncher);
	});

	it("does not resolve bare argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		Object.defineProperty(process, "execPath", { value: missingPath, configurable: true });
		Object.defineProperty(process, "argv0", { value: "omp", configurable: true });

		const cwdRogueBinary = path.resolve("omp");
		vi.spyOn(Bun, "which").mockReturnValue(null);
		vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
			if (p === cwdRogueBinary) return true; // untrusted file exists in repo cwd
			return false;
		});

		// Must not pick up cwdRogueBinary; falls back to missingPath gracefully
		const resolved = resolveExecutablePath();
		expect(resolved).toBe(missingPath);
	});

	it("falls back to Bun.which('omp') when original execPath was unlinked and argv0 has no path", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		Object.defineProperty(process, "execPath", { value: missingPath, configurable: true });
		Object.defineProperty(process, "argv0", { value: "omp", configurable: true });

		const mockUpgradedPath = "/opt/homebrew/bin/omp";
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return mockUpgradedPath;
			return null;
		});
		vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
			if (p === missingPath) return false;
			if (p === mockUpgradedPath) return true;
			return false;
		});

		const resolved = resolveExecutablePath();
		expect(resolved).toBe(mockUpgradedPath);
		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__omp_worker_test"],
		});
	});

	it("falls back to process.argv0 when Bun.which('omp') is unavailable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/custom/install/bin/omp";
		Object.defineProperty(process, "execPath", { value: missingPath, configurable: true });
		Object.defineProperty(process, "argv0", { value: "my-omp", configurable: true });

		const mockCustomPath = "/usr/local/bin/my-omp";
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => {
			if (cmd === "my-omp") return mockCustomPath;
			return null;
		});
		vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
			if (p === missingPath) return false;
			if (p === mockCustomPath) return true;
			return false;
		});

		expect(resolveExecutablePath()).toBe(mockCustomPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/omp";
		Object.defineProperty(process, "execPath", { value: missingPath, configurable: true });
		vi.spyOn(Bun, "which").mockReturnValue(null);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
