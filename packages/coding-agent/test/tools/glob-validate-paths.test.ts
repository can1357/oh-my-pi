import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import {
	expandDelimitedPathEntries,
	parseFindPattern,
	resolveToolSearchScope,
	splitDelimitedPathEntry,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ToolCall } from "../../src/ui/transcript/tool-block";
import { toolCallText, toolText } from "../helpers/tool-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("delimited path expansion", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "delimited-paths-"));
		await fs.mkdir(path.join(tempDir, "apps"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "packages"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "folder with spaces"), { recursive: true });
		await Bun.write(path.join(tempDir, "apps", "a.txt"), "apps\n");
		await Bun.write(path.join(tempDir, "packages", "b.txt"), "packages\n");
		await Bun.write(path.join(tempDir, "folder with spaces", "file.txt"), "spaces\n");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("splits comma, semicolon, and space delimited entries when parts resolve", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt, packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt;packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
	});

	it("keeps an existing path with spaces intact", async () => {
		expect(await splitDelimitedPathEntry("folder with spaces/file.txt", tempDir)).toBeNull();
		expect(await expandDelimitedPathEntries(["folder with spaces/file.txt"], tempDir)).toEqual([
			"folder with spaces/file.txt",
		]);
	});

	it("does not split commas inside brace globs", async () => {
		expect(await splitDelimitedPathEntry("src/{a,b}.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("src/{a,b}.txt, packages/b.txt", tempDir)).toEqual([
			"src/{a,b}.txt",
			"packages/b.txt",
		]);
	});

	it("does not split backslash-escaped delimiters", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt\\,packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("apps/a.txt\\;packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("folder\\ with\\ spaces/file.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("uses strong delimiters leniently and whitespace delimiters conservatively", async () => {
		expect(await splitDelimitedPathEntry("missing.txt, packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt;packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("cleans trailing strong delimiters and expands glob entries", async () => {
		expect(await expandDelimitedPathEntries(["apps/a.txt,"], tempDir)).toEqual(["apps/a.txt"]);
		expect(
			await expandDelimitedPathEntries(["apps/**/*.txt, packages/**/*.txt"], tempDir, {
				splitter: parseFindPattern,
			}),
		).toEqual(["apps/**/*.txt", "packages/**/*.txt"]);
	});

	it("splits a semicolon list whose joined string exceeds NAME_MAX (issue #7597)", async () => {
		// Bare filenames in one directory form a single slash-free run once joined,
		// so ~12 short entries already push the run past NAME_MAX (255). lstat on
		// the joined string then throws ENAMETOOLONG, which used to be read as an
		// inconclusive probe and suppress the split, collapsing the whole list to
		// one non-existent literal path.
		const names: string[] = [];
		for (let i = 0; i < 20; i++) {
			const name = `enametoolong-probe-${String(i).padStart(2, "0")}.txt`;
			await Bun.write(path.join(tempDir, name), "needle\n");
			names.push(name);
		}
		const joined = names.join("; ");
		expect(joined.length).toBeGreaterThan(255);
		expect(await splitDelimitedPathEntry(joined, tempDir)).toEqual(names);
		expect(await expandDelimitedPathEntries([joined], tempDir)).toEqual(names);
	});

	it("normalizes Windows path separators before parsing find globs", async () => {
		expect(parseFindPattern("apps\\**\\*.txt")).toEqual({
			basePath: "apps",
			globPattern: "**/*.txt",
			hasGlob: true,
		});

		expect(await splitDelimitedPathEntry("apps/a.txt\\,packages/b.txt", tempDir)).toBeNull();
		const parsed = parseFindPattern("C:\\work\\repo\\src\\**\\*.ts");
		expect(parsed).toEqual({
			basePath: "C:/work/repo/src",
			globPattern: "**/*.ts",
			hasGlob: true,
		});
	});

	it("normalizes Windows separators for search scope globs", async () => {
		const scope = await resolveToolSearchScope({
			rawPaths: ["apps\\**\\*.txt"],
			cwd: tempDir,
			internalUrlAction: "search",
			filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
		});

		expect(scope.searchPath).toBe(path.join(tempDir, "apps"));
		expect(scope.globFilter).toBe("**/*.txt");
	});
});

describe("glob tool card", () => {
	it("accepts a single string paths value before validation", () => {
		const args = { paths: "src/**/*.ts" };
		const renderings = [
			toolCallText(new ToolCall({ id: "call-1", name: "glob", args }), 160),
			toolText({
				name: "glob",
				args,
				result: { content: [{ type: "text", text: "src/index.ts\n" }] },
				partial: true,
				width: 160,
			}),
			toolText({
				name: "glob",
				args,
				result: { content: [{ type: "text", text: "" }], details: { fileCount: 0, files: [] } },
				partial: true,
				width: 160,
			}),
			toolText({
				name: "glob",
				args,
				result: {
					content: [{ type: "text", text: "src/index.ts" }],
					details: { fileCount: 1, files: ["src/index.ts"] },
				},
				partial: true,
				width: 160,
			}),
		];

		for (const rendered of renderings) {
			expect(rendered).toContain("src/**/*.ts");
		}
	});
});
