import { describe, expect, it } from "bun:test";
import { formatGroupedPaths } from "../src/path-tree";

describe("formatGroupedPaths", () => {
	it("folds a shared absolute prefix into one heading and nests the rest", () => {
		const output = formatGroupedPaths([
			"/Users/me/proj/shared/wasm/llvm.hpp",
			"/Users/me/proj/shared/wasm/vm.hpp",
			"/Users/me/proj/shared/xstd.hpp",
			"/Users/me/proj/shared/apollo/details/hash.hpp",
			"/Users/me/proj/flash/main.cpp",
		]);

		expect(output).toBe(
			[
				"# /Users/me/proj/",
				"## shared/",
				"xstd.hpp",
				"### wasm/",
				"llvm.hpp",
				"vm.hpp",
				"### apollo/details/",
				"hash.hpp",
				"## flash/",
				"main.cpp",
			].join("\n"),
		);
	});

	it("lists a directory's own files before its subdirectories", () => {
		const output = formatGroupedPaths(["pkg/sub/deep.txt", "pkg/top.txt"]);
		// `top.txt` is a direct child of pkg; `sub/` is a subdirectory. Files first.
		expect(output).toBe(["# pkg/", "top.txt", "## sub/", "deep.txt"].join("\n"));
	});

	it("emits a single root-level file with no directory heading", () => {
		expect(formatGroupedPaths(["single.txt"])).toBe("single.txt");
	});

	it("appends annotate suffixes to file lines, keyed by the full original path", () => {
		const output = formatGroupedPaths(["src/a.ts", "src/b.ts"], path => (path === "src/a.ts" ? " (RW)" : " (Read)"));
		expect(output).toBe(["# src/", "a.ts (RW)", "b.ts (Read)"].join("\n"));
	});

	it("keeps matched directories (trailing slash) as headings", () => {
		expect(formatGroupedPaths(["alpha/tests/", "beta/tests/"])).toBe(["# alpha/tests/", "# beta/tests/"].join("\n"));
	});
});
