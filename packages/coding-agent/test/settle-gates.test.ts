import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	annotateUnverifiedMergeSummary,
	isolatedApplyShouldLatch,
	isParentVerifyCwdInMergedTree,
	isTautologicalParentVerifyCommand,
	isTrivialParentVerifyEvalCode,
	MERGED_UNVERIFIED_MARKER,
	skipLeadingEnvAssignmentTokens,
	UnverifiedMergeLatch,
} from "../src/session/settle-gates";

describe("isolatedApplyShouldLatch", () => {
	it("latches only a successful isolated apply that actually merged work", () => {
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: true, exitCode: 0 })).toBe(
			true,
		);
		// No-op merge: repo is clean but nothing was applied — no unverified work.
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: false, exitCode: 0 })).toBe(
			false,
		);
		expect(isolatedApplyShouldLatch({ isolated: false, applyChanges: true, hadAnyChanges: true, exitCode: 0 })).toBe(
			false,
		);
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: true, exitCode: 1 })).toBe(
			false,
		);
	});
});

describe("annotateUnverifiedMergeSummary", () => {
	it("appends the marker once when latching", () => {
		const latched = annotateUnverifiedMergeSummary("\n\nMerged branch: x", true);
		expect(latched).toContain(MERGED_UNVERIFIED_MARKER);
		expect(annotateUnverifiedMergeSummary(latched, true)).toBe(latched);
		expect(annotateUnverifiedMergeSummary("\n\nMerged branch: x", false)).toBe("\n\nMerged branch: x");
	});
});

describe("UnverifiedMergeLatch", () => {
	it("marks and clears", () => {
		const latch = new UnverifiedMergeLatch();
		expect(latch.latched).toBe(false);
		expect(latch.generation).toBe(0);
		latch.mark();
		expect(latch.latched).toBe(true);
		expect(latch.generation).toBe(1);
		latch.clear();
		expect(latch.latched).toBe(false);
		expect(latch.generation).toBe(1);
	});

	it("clearIfGeneration only clears a matching generation", () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		latch.clearIfGeneration(0);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(1);
		expect(latch.latched).toBe(false);
		latch.mark();
		expect(latch.generation).toBe(2);
		latch.clearIfGeneration(1);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(false);
	});

	it("one matching verify does not clear two overlapping marks", () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		latch.mark();
		expect(latch.generation).toBe(2);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(false);
	});
});

describe("skipLeadingEnvAssignmentTokens", () => {
	it("strips leading NAME=value tokens", () => {
		expect(skipLeadingEnvAssignmentTokens(["CI=1", "pwd"])).toEqual(["pwd"]);
		expect(skipLeadingEnvAssignmentTokens(["FOO=1", "BAR=2", "true"])).toEqual(["true"]);
		expect(skipLeadingEnvAssignmentTokens(["FOO=1"])).toEqual([]);
		expect(skipLeadingEnvAssignmentTokens(["bun", "test"])).toEqual(["bun", "test"]);
	});
});

describe("isTautologicalParentVerifyCommand", () => {
	it("rejects ls/pwd/echo and accepts a real test command", () => {
		expect(isTautologicalParentVerifyCommand("pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("ls -la")).toBe(true);
		expect(isTautologicalParentVerifyCommand("echo ok && pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test test/foo.test.ts")).toBe(false);
		expect(isTautologicalParentVerifyCommand("git status")).toBe(true);
		expect(isTautologicalParentVerifyCommand("cat package.json")).toBe(true);
		expect(isTautologicalParentVerifyCommand("rg TODO src")).toBe(true);
		expect(isTautologicalParentVerifyCommand("git commit -m x")).toBe(false);
	});

	it("treats env-prefixed tautologies and assignment-only segments as non-evidence", () => {
		expect(isTautologicalParentVerifyCommand("CI=1 pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("FOO=1 BAR=2 true")).toBe(true);
		expect(isTautologicalParentVerifyCommand("FOO=1")).toBe(true);
		expect(isTautologicalParentVerifyCommand("FOO=1 && BAR=2")).toBe(true);
		expect(isTautologicalParentVerifyCommand("CI=1 bun test test/foo.test.ts")).toBe(false);
	});

	it("strips leading cd wrappers before classifying the remaining command", () => {
		expect(isTautologicalParentVerifyCommand("cd packages/foo && pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("cd packages/foo && ls")).toBe(true);
		expect(isTautologicalParentVerifyCommand("cd packages/foo; pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("cd packages/foo && bun test")).toBe(false);
		expect(isTautologicalParentVerifyCommand("cd packages/foo; bun test")).toBe(false);
	});

	it("rejects shell-backgrounded verification as non-evidence", () => {
		expect(isTautologicalParentVerifyCommand("bun test & true")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test test/foo.test.ts &")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test && true")).toBe(false);
	});

	it("treats redirection ampersands as status-preserving verification", () => {
		expect(isTautologicalParentVerifyCommand("bun test 2>&1")).toBe(false);
		expect(isTautologicalParentVerifyCommand("bun test &>/tmp/log")).toBe(false);
		expect(isTautologicalParentVerifyCommand("bun test <&0")).toBe(false);
	});

	it("rejects status-negated verification as non-evidence", () => {
		expect(isTautologicalParentVerifyCommand("! bun test")).toBe(true);
		expect(isTautologicalParentVerifyCommand("!bun test")).toBe(true);
		expect(isTautologicalParentVerifyCommand("time ! bun test")).toBe(true);
		expect(isTautologicalParentVerifyCommand("time -p ! bun test")).toBe(true);
	});

	it("rejects status-masking shell chains as non-evidence", () => {
		expect(isTautologicalParentVerifyCommand("bun test || true")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test; true")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test | cat")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test && bun test")).toBe(false);
	});

	it("rejects newline-masked verification as non-evidence", () => {
		expect(isTautologicalParentVerifyCommand("bun test\ntrue")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test test/foo.test.ts\npwd")).toBe(true);
	});
});

describe("isTrivialParentVerifyEvalCode", () => {
	it("rejects literal and arithmetic-only cells", () => {
		expect(isTrivialParentVerifyEvalCode(undefined)).toBe(true);
		expect(isTrivialParentVerifyEvalCode("")).toBe(true);
		expect(isTrivialParentVerifyEvalCode("1+1")).toBe(true);
		expect(isTrivialParentVerifyEvalCode("1 + 1;")).toBe(true);
		expect(isTrivialParentVerifyEvalCode("(1+1)")).toBe(true);
		expect(isTrivialParentVerifyEvalCode("void 0")).toBe(true);
		expect(isTrivialParentVerifyEvalCode('"ok"')).toBe(true);
		expect(isTrivialParentVerifyEvalCode("true")).toBe(true);
		expect(isTrivialParentVerifyEvalCode("null")).toBe(true);
	});

	it("accepts cells that exercise project code", () => {
		expect(isTrivialParentVerifyEvalCode("await read('package.json')")).toBe(false);
		expect(isTrivialParentVerifyEvalCode("import { add } from './src/math.ts'; add(1, 1)")).toBe(false);
		expect(isTrivialParentVerifyEvalCode("Bun.spawnSync(['bun', 'test'])")).toBe(false);
	});
});

describe("isParentVerifyCwdInMergedTree", () => {
	it("accepts session cwd / repo root and rejects outside trees", () => {
		expect(isParentVerifyCwdInMergedTree(undefined, "/repo")).toBe(true);
		expect(isParentVerifyCwdInMergedTree("/repo", "/repo")).toBe(true);
		expect(isParentVerifyCwdInMergedTree("/repo/packages/a", "/repo")).toBe(true);
		expect(isParentVerifyCwdInMergedTree("/repo/.git", "/cwd", "/repo")).toBe(true);
		expect(isParentVerifyCwdInMergedTree("/tmp", "/repo")).toBe(false);
		expect(isParentVerifyCwdInMergedTree("/repo-other", "/repo")).toBe(false);
	});

	it("rejects symlink cwd that resolves outside the merged tree", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verify-cwd-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verify-out-"));
		const link = path.join(root, "external");
		try {
			fs.symlinkSync(outside, link);
			expect(isParentVerifyCwdInMergedTree(link, root)).toBe(false);
			expect(isParentVerifyCwdInMergedTree(path.join(root, "src"), root)).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
