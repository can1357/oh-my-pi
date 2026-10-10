import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	findExtensionDirectoryIndex,
	resolveExtensionDirectory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/directory-resolution";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("extension directory diagnostics", () => {
	let dir: TempDir;

	beforeEach(() => {
		dir = TempDir.createSync("@extension-directory-diagnostics-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		dir.removeSync();
	});

	it("reports denied index probes while still selecting a readable fallback index", () => {
		const denied = path.join(dir.path(), "index.ts");
		const fallback = path.join(dir.path(), "index.js");
		fs.writeFileSync(fallback, "");
		const originalStat = fs.statSync;
		const error = Object.assign(new Error("denied"), { code: "EACCES" });
		spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
			if (String(file) === denied) throw error;
			return originalStat(file);
		}) as typeof fs.statSync);
		const diagnostics: string[] = [];
		expect(
			findExtensionDirectoryIndex(dir.path(), ["index.ts", "index.js"], {
				throwUnexpectedStatErrors: true,
				onReadError: file => diagnostics.push(file),
			}),
		).toBe(fallback);
		expect(diagnostics).toEqual([denied]);
	});

	it("reports denied manifest entries without enabling convention fallback", () => {
		const denied = path.join(dir.path(), "denied.ts");
		fs.writeFileSync(
			path.join(dir.path(), "package.json"),
			JSON.stringify({ omp: { extensions: ["denied.ts", "missing.ts"] } }),
		);
		fs.writeFileSync(path.join(dir.path(), "index.ts"), "");
		const originalStat = fs.statSync;
		spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
			if (String(file) === denied) throw Object.assign(new Error("denied"), { code: "EPERM" });
			return originalStat(file);
		}) as typeof fs.statSync);
		const diagnostics: string[] = [];
		expect(
			resolveExtensionDirectory(dir.path(), {
				indexNames: ["index.ts"],
				isScanFile: name => name.endsWith(".ts"),
				onReadError: file => diagnostics.push(file),
			}),
		).toEqual({ declared: true, files: [] });
		expect(diagnostics).toEqual([denied]);
	});

	it("reports denied children and keeps readable siblings and missing probes quiet", () => {
		const denied = path.join(dir.path(), "denied.ts");
		const readable = path.join(dir.path(), "readable.ts");
		fs.writeFileSync(denied, "");
		fs.writeFileSync(readable, "");
		fs.symlinkSync(path.join(dir.path(), "missing.ts"), path.join(dir.path(), "dangling.ts"));
		const originalStat = fs.statSync;
		spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
			if (String(file) === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
			return originalStat(file);
		}) as typeof fs.statSync);
		const diagnostics: string[] = [];
		expect(
			resolveExtensionDirectory(dir.path(), {
				indexNames: ["index.ts"],
				isScanFile: name => name.endsWith(".ts"),
				onReadError: file => diagnostics.push(file),
			}),
		).toEqual({ declared: false, files: [readable] });
		expect(diagnostics).toEqual([denied]);
	});

	it("reports denied manifest reads and directory scans while keeping ENOTDIR quiet", () => {
		const manifest = path.join(dir.path(), "package.json");
		spyOn(fs, "readFileSync").mockImplementation(() => {
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		});
		spyOn(fs, "readdirSync").mockImplementation(() => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		const diagnostics: string[] = [];
		const options = {
			indexNames: ["index.ts"],
			isScanFile: () => true,
			onReadError: (file: string) => diagnostics.push(file),
		};
		expect(resolveExtensionDirectory(dir.path(), options)).toEqual({ declared: false, files: [] });
		expect(diagnostics).toEqual([manifest, dir.path()]);
		spyOn(fs, "readFileSync").mockRestore();
		spyOn(fs, "readdirSync").mockRestore();
		fs.writeFileSync(path.join(dir.path(), "file.ts"), "");
		diagnostics.length = 0;
		expect(resolveExtensionDirectory(path.join(dir.path(), "file.ts"), options)).toEqual({
			declared: false,
			files: [],
		});
		expect(diagnostics).toEqual([]);
	});
});
