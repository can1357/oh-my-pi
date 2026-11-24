import { describe, expect, it } from "bun:test";
import { analyzeCalls, classifySegment, commandSegments } from "./checks";

const bash = (command: string, ms = 1) => ({ name: "bash", args: { command }, ms });

describe("scope benchmark check accounting", () => {
	it("classifies segments by their leading program, past wrappers and env assignments", () => {
		const kinds = commandSegments(
			"cd app && FOO=1 timeout 60 bunx tsc --noEmit; bun test test/slug.test.ts | tail -5\nbun src/main.ts; git diff",
		).map(classifySegment);
		expect(kinds).toEqual([[], ["typecheck", "install"], ["test"], [], ["run"], ["vcs"]]);
	});

	it("charges searches rooted at the filesystem or home, not at the workspace", () => {
		const kinds = commandSegments(
			"find / -name duration.ts 2>/dev/null; find ~ -maxdepth 6 -name x; find /var/folders/ws/app -name x; rg foo .",
		).map(classifySegment);
		expect(kinds).toEqual([["scan"], ["scan"], [], []]);
	});

	it("charges a full suite but not the test the task names, nor VCS inspection", () => {
		const { checks } = analyzeCalls(
			[bash("bun test test/slug.test.ts", 120), bash("cd .. && bun test", 9_000), bash("git status")],
			{ allowedChecks: [/^bun\s+test\s+(\.\/)?test\/slug/], paths: [] },
		);
		expect(checks.map(check => [check.kinds, check.unrequested, check.ms])).toEqual([
			[["test"], false, 120],
			[["test"], true, 9_000],
			[["vcs"], false, 1],
		]);
	});

	it("finds commands inside eval cells", () => {
		const { checks } = analyzeCalls([{ name: "eval", args: { code: 'await sh("bun test")' }, ms: 5 }], {
			allowedChecks: [],
			paths: [],
		});
		expect(checks).toMatchObject([{ tool: "eval", kinds: ["test"], unrequested: true }]);
	});

	it("counts reads of a file only after it was edited", () => {
		const { postEditReads } = analyzeCalls(
			[
				{ name: "read", args: { path: "/tmp/ws/src/config.ts" }, ms: 1 },
				{ name: "edit", args: { input: "*** Edit File: src/config.ts\n…" }, ms: 1 },
				{ name: "read", args: { path: "/tmp/ws/src/client.ts" }, ms: 1 },
				bash("cat src/config.ts"),
				{ name: "read", args: { path: "src/config.ts" }, ms: 1 },
			],
			{ allowedChecks: [], paths: ["src/config.ts", "src/client.ts"] },
		);
		expect(postEditReads).toBe(2);
	});
});
