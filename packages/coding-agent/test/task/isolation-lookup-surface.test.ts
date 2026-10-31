import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The isolation path may not ask the filesystem a yes/no question.
 *
 * Seven findings in one round, and five before them, were one mistake: a read
 * that failed became "nothing is there", and "nothing is there" authorised a
 * delete. The three-valued `Lookup` fixed every call site it reached, so the
 * remaining risk is a *new* call site written in the old form. This is the
 * check for that — the only one a program can make cheaply, which is why it is
 * a test rather than a reviewer's habit.
 *
 * `isolation-lookup.ts` is the one module allowed to call these: it is where
 * the error becomes a value.
 */
const GUARDED = [
	"src/task/isolation-ownership.ts",
	"src/task/isolation-lease.ts",
	"src/task/isolation-runner.ts",
	"src/task/worktree.ts",
	"src/cli/worktree-cli.ts",
];

/** Reads whose failure a caller can mistake for an absence. */
const RAW_READ = /\bfs\.(stat|lstat|readdir|access|realpath|readFile)\s*\(|Bun\.file\([^)]*\)\s*\.\s*(exists|json|text)\s*\(/;

describe("the isolation path's filesystem surface", () => {
	it("asks no question the filesystem can answer with a swallowed error", async () => {
		const root = path.resolve(import.meta.dir, "../..");
		const offences: string[] = [];
		for (const file of GUARDED) {
			const source = await fs.readFile(path.join(root, file), "utf8");
			source.split("\n").forEach((line, index) => {
				if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
				if (RAW_READ.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}

		expect(offences).toEqual([]);
	});

	it("keeps the lookup module as the only place an error becomes a value", async () => {
		const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/task/isolation-lookup.ts"), "utf8");

		// Three answers, and `unknown` carries why. A two-valued helper added
		// here would put the whole subsystem back where it started.
		expect(source).toContain('kind: "found"');
		expect(source).toContain('kind: "absent"');
		expect(source).toContain('kind: "unknown"');
		expect(source).toContain("isEnoent(error)");
	});
});
