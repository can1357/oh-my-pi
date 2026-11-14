import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	classifyGroupedLines,
	formatGroupedFiles,
	groupLineIndicesByBlank,
} from "@oh-my-pi/pi-tui/tools/grouped-file-output";

const REPO_ROOT = path.resolve("repo");
const OUTSIDE_DIR = path.resolve(path.parse(REPO_ROOT).root, "outside", "dir");

function toGroupedHeaderPath(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

describe("formatGroupedFiles", () => {
	it("nests subdirectories with deeper headings and blank-separates top groups", () => {
		const { model } = formatGroupedFiles(["pkg/ai/CHANGELOG.md", "pkg/ai/src/util/x.ts", "README.md"], file => ({
			modelLines: [`  ${file}`],
			headerSuffix: " (1)",
		}));

		expect(model).toEqual([
			"# README.md (1)",
			"  README.md",
			"",
			"# pkg/ai/",
			"## CHANGELOG.md (1)",
			"  pkg/ai/CHANGELOG.md",
			"",
			"## src/util/",
			"### x.ts (1)",
			"  pkg/ai/src/util/x.ts",
		]);
	});

	it("omits skipped files and their now-empty directories", () => {
		const { model } = formatGroupedFiles(["a/keep.ts", "a/drop.ts"], file => ({
			modelLines: [`  ${file}`],
			skip: file.endsWith("drop.ts"),
		}));
		expect(model).toEqual(["# a/", "## keep.ts", "  a/keep.ts"]);
	});
});

describe("classifyGroupedLines", () => {
	it("reconstructs absolute paths and display paths across a nested directory stack", () => {
		const lines = ["# pkg/ai/", "## CHANGELOG.md", "  match", "## src/util/", "### x.ts", "*12│const y = 1;"];
		const ctx = classifyGroupedLines(lines, REPO_ROOT);

		expect(ctx[0]).toMatchObject({ kind: "dir" });
		expect(ctx[1]).toMatchObject({
			kind: "file",
			headerPath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md"),
			displayPath: "pkg/ai/CHANGELOG.md",
		});
		expect(ctx[2]).toMatchObject({ kind: "content", filePath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md") });
		// `src/util/` is a folded subdirectory chain under `pkg/ai/`, not the root.
		expect(ctx[3]).toMatchObject({ kind: "dir" });
		expect(ctx[4]).toMatchObject({
			kind: "file",
			headerPath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
			displayPath: "pkg/ai/src/util/x.ts",
		});
		expect(ctx[5]).toMatchObject({
			kind: "content",
			filePath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
		});
	});

	it("keeps an absolute folded prefix instead of joining it onto the search base", () => {
		const ctx = classifyGroupedLines([`# ${toGroupedHeaderPath(OUTSIDE_DIR)}/`, "## file.txt"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "dir" });
		expect(ctx[1]).toMatchObject({ kind: "file", headerPath: path.join(OUTSIDE_DIR, "file.txt") });
	});

	it("keeps a directory name's own parenthesized part in its file's label and link", () => {
		const ctx = classifyGroupedLines(["# src (old)/", "## file.ts (2 replacements)"], REPO_ROOT);
		expect(ctx[1]).toMatchObject({
			kind: "file",
			displayPath: "src (old)/file.ts",
			suffix: "(2 replacements)",
			headerPath: path.join(REPO_ROOT, "src (old)", "file.ts"),
		});
	});

	it("keeps the leading `/` of absolute paths folded under a `# /` root", () => {
		const ctx = classifyGroupedLines(["# /", "## z.ts", "", "## tmp/a/", "### x.ts"], REPO_ROOT);
		expect([ctx[1]?.displayPath, ctx[4]?.displayPath]).toEqual(["/z.ts", "/tmp/a/x.ts"]);
	});

	it("drops only a hashline tag from a file name, not other `#` endings", () => {
		const ctx = classifyGroupedLines(["# a.ts#1A2B (1 replacement)", "# component.ts#dead"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ displayPath: "a.ts", suffix: "(1 replacement)" });
		expect(ctx[1]).toMatchObject({
			displayPath: "component.ts#dead",
			headerPath: path.join(REPO_ROOT, "component.ts#dead"),
		});
	});

	it("links body lines before any header to the single-file search base", () => {
		const searchBase = path.join(REPO_ROOT, "file.ts");
		const ctx = classifyGroupedLines(["*7│needle();"], searchBase);
		expect(ctx[0]).toMatchObject({ kind: "content", filePath: searchBase });
	});

	it("leaves url-like headers and their body lines to caller-side resolution", () => {
		const ctx = classifyGroupedLines(["# omp://docs/", "  body"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "file", url: "omp://docs/" });
		expect(ctx[0]?.headerPath).toBeUndefined();
		expect(ctx[1]).toMatchObject({ kind: "content", url: "omp://docs/", filePath: undefined });
	});

	it("gives a headerless URL scope's lines its URL, never a filesystem path", () => {
		const ctx = classifyGroupedLines(["*7│needle();"], REPO_ROOT, "local://notes/a.ts");
		expect(ctx[0]).toMatchObject({ kind: "content", url: "local://notes/a.ts", filePath: undefined });
	});
});

describe("groupLineIndicesByBlank", () => {
	it("breaks on blank-line runs and keeps original indices", () => {
		expect(groupLineIndicesByBlank(["a", "b", "", "", "c"])).toEqual([[0, 1], [4]]);
	});

	it("returns a single group of non-empty lines when no blanks are present", () => {
		expect(groupLineIndicesByBlank(["a", "b", "c"])).toEqual([[0, 1, 2]]);
	});
});
