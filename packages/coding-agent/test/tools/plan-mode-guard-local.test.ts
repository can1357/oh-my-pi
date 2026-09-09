import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ARTIFACTS_DIR = path.join(os.tmpdir(), "agent-artifacts");
const REPO_ROOT = path.join(os.tmpdir(), "repo");
const PLANS_DIR = path.join(os.tmpdir(), "plans");

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	return {
		cwd: overrides.cwd ?? REPO_ROOT,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => PLANS_DIR,
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	} as unknown as ToolSession;
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join(ARTIFACTS_DIR, "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "omp-local", "session-42", "memo.txt"),
		);
	});
});

describe("resolvePlanPath resolves literally (no plan-mode redirect)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("resolves a bare path against cwd regardless of plan mode", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join(REPO_ROOT, "PLAN.md"));
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join(REPO_ROOT, "src", "foo.ts"));
	});

	it("resolves a local:// plan file to the session local root", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(resolvePlanPath(session, "local://some-plan.md")).toBe(path.join(ARTIFACTS_DIR, "local", "some-plan.md"));
	});

	it("unwraps a `[PATH#TAG]` hashline header to the inner filesystem path", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		const planPath = path.join(ARTIFACTS_DIR, "local", "some-plan.md");
		expect(resolvePlanPath(session, "[local://some-plan.md#ABCD]")).toBe(planPath);
		expect(resolvePlanPath(session, `[${planPath}#ABCD]`)).toBe(planPath);
		expect(resolvePlanPath(session, "[local://some-plan.md]")).toBe(planPath);
	});

	it("leaves malformed bracketed paths untouched so downstream errors surface", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		// Inner path with a non-tag `#`, selector tail, or empty body falls outside
		// the strict header shape and is resolved literally against the session cwd
		// so the eventual write/edit reports a real "file not found" instead of
		// silently rewriting the target.
		const nonHexHeader = `[${path.join(ARTIFACTS_DIR, "x")}#nothex]`;
		const selectorHeader = `[${path.join(ARTIFACTS_DIR, "x")}#ABCD:1-2]`;
		expect(resolvePlanPath(session, nonHexHeader)).toBe(path.join(REPO_ROOT, nonHexHeader));
		expect(resolvePlanPath(session, selectorHeader)).toBe(path.join(REPO_ROOT, selectorHeader));
	});
});

describe("enforcePlanModeWrite (working tree read-only, local:// sandbox writable)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("accepts writes to any local:// file", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(() => enforcePlanModeWrite(session, "local://auth-refactor-plan.md", { op: "create" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, "local://scratch/notes.md", { op: "update" })).not.toThrow();
	});

	it("rejects writes to the working tree", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(/working tree is read-only/);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "create" })).toThrow(/working tree is read-only/);
	});

	it("rejects deletes and renames outright", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/,
		);
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { move: "local://renamed.md" })).toThrow(
			/renaming files is not allowed/,
		);
	});

	it("is a no-op when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).not.toThrow();
	});
});

describe("enforcePlanModeWrite accepts absolute local-sandbox paths", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("allows the absolute path returned by `read local://...` (== sandbox-resolved path)", async () => {
		// Use an existing temp directory so the realpath check inside the guard
		// sees a real filesystem even when the OS exposes temp paths through aliases.
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		try {
			const session = makeSession({ artifactsDir, planMode });
			const absolute = resolvePlanPath(session, "local://my-plan.md");
			expect(() => enforcePlanModeWrite(session, absolute, { op: "update" })).not.toThrow();
		} finally {
			await removeWithRetries(artifactsDir);
		}
	});

	it("allows bracketed hashline headers for local sandbox paths", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		try {
			const session = makeSession({ artifactsDir, planMode });
			const absolute = resolvePlanPath(session, "local://my-plan.md");

			// Strict hashline shape `[PATH]` or `[PATH#XXXX]` is unwrapped to the
			// inner path for both the sandbox check and the eventual resolution.
			expect(() => enforcePlanModeWrite(session, `[${absolute}#ABCD]`, { op: "update" })).not.toThrow();
			expect(() => enforcePlanModeWrite(session, `[${absolute}]`, { op: "update" })).not.toThrow();
			expect(() => enforcePlanModeWrite(session, `[local://my-plan.md#ABCD]`, { op: "update" })).not.toThrow();
		} finally {
			await removeWithRetries(artifactsDir);
		}
	});

	it("rejects malformed bracketed headers instead of silently unwrapping them", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		const sandboxPlanPath = path.join(ARTIFACTS_DIR, "local", "plan.md");

		// Selector tails (`#TAG:lines`), non-hex tags, and short tags fall outside
		// the strict header shape; we leave them alone so the downstream resolver
		// surfaces the real error rather than treating the bracketed blob as a path.
		expect(() => enforcePlanModeWrite(session, `[${sandboxPlanPath}#ABCD:1-2]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, `[${sandboxPlanPath}#nothex]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});

	it("still rejects absolute paths outside the local sandbox", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		const workingTreePath = path.join(REPO_ROOT, "src", "foo.ts");

		expect(() => enforcePlanModeWrite(session, workingTreePath, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, `[${workingTreePath}#ABCD]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});
});
