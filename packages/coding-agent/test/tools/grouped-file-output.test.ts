import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	classifyGroupedLines,
	formatGroupedFiles,
	groupLineIndicesByBlank,
} from "@oh-my-pi/pi-coding-agent/tools/grouped-file-output";

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
	it("reconstructs absolute paths across a nested directory stack", () => {
		const lines = ["# pkg/ai/", "## CHANGELOG.md", "  match", "## src/util/", "### x.ts", "*12│const y = 1;"];
		const ctx = classifyGroupedLines(lines, REPO_ROOT);

		expect(ctx[0]).toMatchObject({ kind: "dir", headerPath: path.join(REPO_ROOT, "pkg", "ai") });
		expect(ctx[1]).toMatchObject({ kind: "file", headerPath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md") });
		expect(ctx[2]).toMatchObject({ kind: "content", filePath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md") });
		// `src/util/` is a folded subdirectory chain under `pkg/ai/`, not the root.
		expect(ctx[3]).toMatchObject({ kind: "dir", headerPath: path.join(REPO_ROOT, "pkg", "ai", "src", "util") });
		expect(ctx[4]).toMatchObject({
			kind: "file",
			headerPath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
		});
		expect(ctx[5]).toMatchObject({
			kind: "content",
			filePath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
		});
	});

	it("keeps an absolute folded prefix instead of joining it onto the search base", () => {
		const ctx = classifyGroupedLines([`# ${toGroupedHeaderPath(OUTSIDE_DIR)}/`, "## file.txt"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "dir", headerPath: OUTSIDE_DIR });
		expect(ctx[1]).toMatchObject({ kind: "file", headerPath: path.join(OUTSIDE_DIR, "file.txt") });
	});

	it("links body lines before any header to the single-file search base", () => {
		const searchBase = path.join(REPO_ROOT, "file.ts");
		const ctx = classifyGroupedLines(["*7│needle();"], searchBase);
		expect(ctx[0]).toMatchObject({ kind: "content", filePath: searchBase });
	});

	it("flags url-like headers for caller-side resolution without a filesystem path", () => {
		const ctx = classifyGroupedLines(["# omp://docs/", "  body"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "file", isUrl: true });
		expect(ctx[0]?.headerPath).toBeUndefined();
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
