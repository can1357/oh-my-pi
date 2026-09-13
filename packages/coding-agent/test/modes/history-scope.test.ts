import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	historyScopeKey,
	historyScopeRing,
	resolveHistoryScope,
	type HistoryScopeContext,
} from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import type { HistoryScopeKind } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-history-scope-cfg-");
});

afterEach(async () => {
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("resolveHistoryScope", () => {
	it("falls back to cwd — never to global — when the scope has no subject", () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		fs.mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		const outsideRepo: HistoryScopeContext = { sessionId: "", cwd: dir.path() };

		expect(resolveHistoryScope("session", outsideRepo)).toEqual({ kind: "cwd", value: dir.path() });
		expect(resolveHistoryScope("repo", outsideRepo)).toEqual({ kind: "cwd", value: dir.path() });
		expect(resolveHistoryScope("nonsense" as HistoryScopeKind, outsideRepo)).toEqual({
			kind: "cwd",
			value: dir.path(),
		});
	});

	it("resolves each scope to its own subject", () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		fs.mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		const context: HistoryScopeContext = { sessionId: "session-1", cwd: repo };

		expect(resolveHistoryScope("session", context)).toEqual({ kind: "session", value: "session-1" });
		expect(resolveHistoryScope("cwd", context)).toEqual({ kind: "cwd", value: repo });
		expect(resolveHistoryScope("repo", context)).toEqual({ kind: "repo", value: repo });
		expect(resolveHistoryScope("global", context)).toEqual({ kind: "global" });
	});
});

describe("historyScopeRing", () => {
	it("rotates the narrow-to-wide ring around the resolved start scope", () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		fs.mkdirSync(repo, { recursive: true });
		git(repo, "init", "--quiet");
		const context: HistoryScopeContext = { sessionId: "session-1", cwd: repo };

		const ring = historyScopeRing("session", context);
		expect(ring.map(scope => scope.kind)).toEqual(["session", "cwd", "repo", "global"]);
		// Each entry must carry the subject reads are made with, not just its kind: an entry
		// stripped down to `{ kind }` would silently return nothing for Ctrl+R.
		for (const scope of ring) {
			expect(scope).toEqual(resolveHistoryScope(scope.kind, context));
		}
		expect(ring[1]?.value).toBe(repo);
		expect(ring[2]?.value).toBe(repo);
		expect(historyScopeRing("repo", context).map(scope => scope.kind)).toEqual(["repo", "global", "session", "cwd"]);
	});

	it("resolves repository scope from a subdirectory or a linked worktree", () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		const sub = path.join(repo, "src", "deep");
		const worktree = path.join(dir.path(), "repo-wt");
		fs.mkdirSync(sub, { recursive: true });
		git(repo, "init", "--quiet");
		git(repo, "commit", "--allow-empty", "--quiet", "-m", "init");
		git(repo, "worktree", "add", "--quiet", "--detach", worktree);

		// Without primary-root resolution the scope would carry the directory itself and
		// `history.scope: repo` would stop matching the repository's other directories.
		expect(resolveHistoryScope("repo", { sessionId: "s", cwd: sub })).toEqual({ kind: "repo", value: repo });
		expect(resolveHistoryScope("repo", { sessionId: "s", cwd: worktree })).toEqual({ kind: "repo", value: repo });
	});

	it("drops repository scope outside a repository and starts on cwd, not global", () => {
		const dir = tempDir!;
		const context: HistoryScopeContext = { sessionId: "session-1", cwd: dir.path() };

		const ring = historyScopeRing("repo", context);
		// Without this, Ctrl+R would open on every project while the Up arrow reads cwd.
		expect(ring.map(scope => scope.kind)).toEqual(["cwd", "global", "session"]);
	});

	it("drops session scope when there is no conversation id", () => {
		const dir = tempDir!;
		const context: HistoryScopeContext = { sessionId: "", cwd: dir.path() };

		expect(historyScopeRing("global", context).map(scope => scope.kind)).toEqual(["global", "cwd"]);
	});
});

describe("historyScopeKey", () => {
	it("separates scopes that share a value but read different sets", () => {
		// At a repository root, cwd and repo carry the same directory yet read different rows.
		expect(historyScopeKey({ kind: "cwd", value: "/repo" })).not.toBe(
			historyScopeKey({ kind: "repo", value: "/repo" }),
		);
		expect(historyScopeKey({ kind: "session", value: "a" })).not.toBe(
			historyScopeKey({ kind: "session", value: "b" }),
		);
	});

	it("treats two spellings of one directory as the same data set", () => {
		const dir = tempDir!;
		const repo = path.join(dir.path(), "repo");
		const link = dir.join("repo-link");
		fs.mkdirSync(repo, { recursive: true });
		fs.symlinkSync(repo, link, "dir");

		// A different spelling must not look like a new scope: the editor would re-seed and
		// drop recalled drafts even though the rows read back are identical.
		expect(historyScopeKey({ kind: "cwd", value: link })).toBe(historyScopeKey({ kind: "cwd", value: repo }));
		expect(historyScopeKey({ kind: "repo", value: link })).toBe(historyScopeKey({ kind: "repo", value: repo }));
		// An empty value stays itself instead of resolving to the process directory.
		expect(historyScopeKey({ kind: "cwd", value: "" })).toBe("cwd\u0000");
		expect(historyScopeKey({ kind: "global" })).toBe("global\u0000");
	});
});
