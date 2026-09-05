import { describe, expect, it } from "bun:test";
import { isFullyQualifiedPath, stripWindowsExtendedLengthPathPrefix, windowsPathToWslMount } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\omp.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\omp.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\omp.exe", "win32")).toBe(
			"\\\\server\\share\\omp.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\omp.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("windowsPathToWslMount", () => {
	it("clamps parent traversal at the Windows drive root", () => {
		expect(windowsPathToWslMount("C:\\..\\Windows\\x")).toBe("/mnt/c/Windows/x");
	});

	it("rejects paths without an absolute Windows drive", () => {
		expect(windowsPathToWslMount("/home/me/file.txt")).toBeUndefined();
	});
});

describe("isFullyQualifiedPath", () => {
	it("identifies fully qualified Windows paths across platforms", () => {
		expect(isFullyQualifiedPath("C:\\omp\\bin\\omp.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("c:/omp/bin/omp.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("\\\\server\\share\\omp.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("C:omp", "win32")).toBe(false);
		expect(isFullyQualifiedPath(".\\omp", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\bin\\omp", "win32")).toBe(false);
	});

	it("identifies absolute POSIX paths", () => {
		expect(isFullyQualifiedPath("/usr/local/bin/omp", "darwin")).toBe(true);
		expect(isFullyQualifiedPath("/usr/local/bin/omp", "linux")).toBe(true);
		expect(isFullyQualifiedPath("./omp", "darwin")).toBe(false);
		expect(isFullyQualifiedPath("omp", "linux")).toBe(false);
	});
});
