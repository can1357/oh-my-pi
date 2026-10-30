import { expect, it } from "bun:test";
import * as path from "node:path";
import { gitRelativePath } from "../src/commit/agentic";

it("matches Windows changelog paths to staged Git paths in a split plan", () => {
	const cwd = "D:\\repo";
	const stagedFiles = [
		"packages/a/src/x.ts",
		"packages/b/src/y.ts",
		"packages/a/CHANGELOG.md",
		"packages/b/CHANGELOG.md",
	];
	const plannedFiles = new Set([
		"packages/a/src/x.ts",
		"packages/b/src/y.ts",
		...["packages/a/CHANGELOG.md", "packages/b/CHANGELOG.md"].map(file =>
			gitRelativePath(cwd, path.win32.join(cwd, file), path.win32),
		),
	]);

	expect(stagedFiles.filter(file => !plannedFiles.has(file))).toEqual([]);
});
