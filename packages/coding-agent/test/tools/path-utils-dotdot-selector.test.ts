import { describe, expect, it } from "bun:test";
import {
	isFilesystemSourcePath,
	parseLineRangeChunk,
	parseLineRanges,
	splitPathAndSel,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

describe("`..` range selector alias", () => {
	it("treats `N..M` as the inclusive range `N-M`", () => {
		expect(parseLineRangeChunk("2724..2727")).toEqual({ startLine: 2724, endLine: 2727 });
		// Same line count and bounds as the canonical dash form.
		expect(parseLineRangeChunk("2724..2727")).toEqual(parseLineRangeChunk("2724-2727"));
	});

	it("treats trailing `N..` as open-ended, like `N-`", () => {
		expect(parseLineRangeChunk("301..")).toEqual({ startLine: 301, endLine: undefined });
		expect(parseLineRangeChunk("301..")).toEqual(parseLineRangeChunk("301-"));
	});

	it("accepts `..` inside comma-separated multi-range selectors", () => {
		expect(parseLineRanges("3..5,20..22")).toEqual([
			{ startLine: 3, endLine: 5 },
			{ startLine: 20, endLine: 22 },
		]);
	});

	it("allows mixing `..` and `-` separators across chunks", () => {
		expect(parseLineRanges("3-5,20..22")).toEqual([
			{ startLine: 3, endLine: 5 },
			{ startLine: 20, endLine: 22 },
		]);
	});

	it("rejects inverted `..` ranges with the same guard as `-`", () => {
		expect(() => parseLineRangeChunk("2727..2724")).toThrow(ToolError);
	});

	it("peels a trailing `:N..M` selector off the path", () => {
		expect(splitPathAndSel("packages/editor/src/Editor.ts:2724..2727")).toEqual({
			path: "packages/editor/src/Editor.ts",
			sel: "2724..2727",
		});
	});

	it("does not mistake a `..` path segment for a selector", () => {
		// No digits around the dots → still a plain path, not a range selector.
		expect(splitPathAndSel("foo:../bar.ts")).toEqual({ path: "foo:../bar.ts" });
	});
});

describe("isFilesystemSourcePath", () => {
	it("accepts POSIX, Windows drive, and UNC paths", () => {
		expect(isFilesystemSourcePath("/tmp/tools/systemd.ts")).toBe(true);
		expect(isFilesystemSourcePath("C:\\repo\\.omp\\tools\\systemd.ts")).toBe(true);
		expect(isFilesystemSourcePath("C:/.omp/tools/systemd.ts")).toBe(true);
		expect(isFilesystemSourcePath("\\\\server\\share\\.omp\\tools\\systemd.ts")).toBe(true);
		expect(isFilesystemSourcePath("//server/share/.omp/tools/systemd.ts")).toBe(true);
		expect(isFilesystemSourcePath("systemd.ts")).toBe(false);
		expect(isFilesystemSourcePath("<extension:systemd>")).toBe(false);
		expect(isFilesystemSourcePath("mcp:gog")).toBe(false);
	});
});
