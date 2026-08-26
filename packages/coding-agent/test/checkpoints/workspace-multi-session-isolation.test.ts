import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { type CheckpointMeta, WorkspaceCheckpointService } from "../../src/checkpoints";
import * as git from "../../src/utils/git";

/**
 * Integration test for multi-session isolation.
 *
 * Two independent sessions operate on the SAME physical repository R through
 * LINKED WORKTREES:
 *   - Workspace A = the primary checkout R, on branch `main`.
 *   - Workspace B = `git worktree add` of R at a sibling path, on branch
 *     `feature`. Linked worktrees share the object database AND the shared ref
 *     store, but each session gets its own metadata-root override, and the
 *     per-worktree identity (worktreePath) scopes checkpoints and rollbacks.
 *
 * Every assertion inspects observable file contents and git state — never
 * internal fields of the service. The scenario is the spec-mandated flow:
 * capture in each session, session-scoped listing, cross-session rollback,
 * rollback-back, canonical-repo safety, and wrong-workspace rejection.
 */

interface MultiSessionRepo {
	readonly baseDir: string;
	readonly repoDir: string;
	readonly worktreeB: string;
	readonly metaA: string;
	readonly metaB: string;
	readonly serviceA: WorkspaceCheckpointService;
	readonly serviceB: WorkspaceCheckpointService;
	readonly initialSha: string;
}

// Temp dirs allocated by makeMultiSessionRepo; removed wholesale in afterEach
// so the suite leaves nothing behind.
const tracked: string[] = [];

async function readFileText(...segments: string[]): Promise<string | null> {
	try {
		return await Bun.file(path.join(...segments)).text();
	} catch {
		return null;
	}
}

async function makeMultiSessionRepo(): Promise<MultiSessionRepo> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-"));
	tracked.push(baseDir);
	const repoDir = path.join(baseDir, "primary");
	const worktreeB = path.join(baseDir, "worktree-B");
	await fs.mkdir(repoDir, { recursive: true });

	const init = await $`git init --initial-branch=main`.cwd(repoDir).quiet().nothrow();
	if (init.exitCode !== 0) throw new Error(`git init failed (exit ${init.exitCode}): ${init.stderr}`);
	await $`git config user.name "Isolation Test"`.cwd(repoDir).quiet();
	await $`git config user.email "isolation@example.com"`.cwd(repoDir).quiet();
	await Bun.write(path.join(repoDir, "foo.txt"), "seed content\n");
	await $`git add -A`.cwd(repoDir).quiet();
	await $`git commit -m "initial"`.cwd(repoDir).quiet();

	// Linked worktree B on branch `feature`, sharing R's object db + ref store.
	const wt = await $`git worktree add -b feature ${worktreeB}`.cwd(repoDir).quiet().nothrow();
	if (wt.exitCode !== 0) throw new Error(`git worktree add failed (exit ${wt.exitCode}): ${wt.stderr}`);

	const metaA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-metaA-"));
	const metaB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-metaB-"));
	tracked.push(metaA, metaB);

	const initialSha = (await git.head.sha(repoDir)) ?? "";
	if (!initialSha) throw new Error("could not resolve initial HEAD sha");

	return {
		baseDir,
		repoDir,
		worktreeB,
		metaA,
		metaB,
		serviceA: new WorkspaceCheckpointService({ metadataRoot: metaA }),
		serviceB: new WorkspaceCheckpointService({ metadataRoot: metaB }),
		initialSha,
	};
}

afterEach(async () => {
	for (const dir of tracked.splice(0)) await removeWithRetries(dir).catch(() => {});
});

describe("multi-session checkpoint + rollback isolation across linked worktrees", () => {
	test("sessions A (primary) and B (worktree) stay isolated across capture, rollback, and rejection", async () => {
		const env = await makeMultiSessionRepo();
		const { repoDir: A, worktreeB: B, serviceA, serviceB, initialSha } = env;

		const A1 = "A1 content\n";
		const A2 = "A2 content\n";
		const B1 = "B1 content\n";
		const B2 = "B2 content\n";

		// ── Step 1: session A edits foo.txt to A1, checkpoints it, then edits to A2.
		await Bun.write(path.join(A, "foo.txt"), A1);
		const a1: CheckpointMeta = await serviceA.create({
			sessionId: "sess-A",
			cwd: A,
			reason: "manual",
			label: "A-one",
		});
		await Bun.write(path.join(A, "foo.txt"), A2);

		// ── Step 2: session B independently edits foo.txt in its worktree to B1,
		//    checkpoints it, then edits to B2.
		await Bun.write(path.join(B, "foo.txt"), B1);
		const b1: CheckpointMeta = await serviceB.create({
			sessionId: "sess-B",
			cwd: B,
			reason: "manual",
			label: "B-one",
		});
		await Bun.write(path.join(B, "foo.txt"), B2);

		// ── Step 3: session scoping — each list shows only its own checkpoint,
		//    and the other session's checkpoint is absent even when queried from
		//    the opposite workspace (metadata roots are scoped, not just namespaces).
		const aList = await serviceA.list("sess-A", A);
		const bList = await serviceB.list("sess-B", B);
		expect(aList.map(meta => meta.id)).toEqual([a1.id]);
		expect(bList.map(meta => meta.id)).toEqual([b1.id]);
		expect(await serviceA.list("sess-B", A)).toEqual([]);
		expect(await serviceB.list("sess-A", B)).toEqual([]);

		// ── Step 4: roll A back to A1.
		const rollbackToA1 = await serviceA.rollback(a1, { sessionId: "sess-A", cwd: A });
		expect(rollbackToA1.ok).toBe(true);
		expect(rollbackToA1.safetyCheckpoint).toBeDefined();
		expect(rollbackToA1.safetyCheckpoint?.reason).toBe("pre-rollback");
		expect(rollbackToA1.restoredFiles).toBe(1);

		// ── Step 5: observable effects of the A rollback.
		// A's file is restored to A1; B's file is completely untouched (still B2).
		expect(await readFileText(A, "foo.txt")).toBe(A1);
		expect(await readFileText(B, "foo.txt")).toBe(B2);
		// HEAD and branch are unchanged in both checkouts.
		expect(await git.head.sha(A)).toBe(initialSha);
		expect(await git.branch.current(A)).toBe("main");
		expect(await git.head.sha(B)).toBe(initialSha);
		expect(await git.branch.current(B)).toBe("feature");
		// Both session ref namespaces coexist in the SHARED ref store.
		expect(await git.ref.resolve(A, a1.refName)).not.toBeNull();
		expect(await git.ref.resolve(B, b1.refName)).not.toBeNull();
		const sessARefs = (await git.ref.list(A, "refs/omp/checkpoints/sess-A")).map(entry => entry.refName);
		const sessBRefs = (await git.ref.list(A, "refs/omp/checkpoints/sess-B")).map(entry => entry.refName);
		expect(sessARefs).toContain(a1.refName);
		expect(sessBRefs).toContain(b1.refName);
		// The pre-rollback safety capture also landed under sess-A.
		expect(sessARefs).toContain(rollbackToA1.safetyCheckpoint!.refName);

		// ── Step 6: rollback-back — restore A to the pre-rollback (A2) state.
		const rollbackBack = await serviceA.rollback(rollbackToA1.safetyCheckpoint!, {
			sessionId: "sess-A",
			cwd: A,
		});
		expect(rollbackBack.ok).toBe(true);
		expect(rollbackBack.safetyCheckpoint).toBeDefined();
		expect(await readFileText(A, "foo.txt")).toBe(A2);

		// ── Step 7: canonical-repo safety — roll B back to B1.
		const rollbackToB1 = await serviceB.rollback(b1, { sessionId: "sess-B", cwd: B });
		expect(rollbackToB1.ok).toBe(true);
		expect(rollbackToB1.safetyCheckpoint).toBeDefined();
		// A is still at A2; B is restored to B1.
		expect(await readFileText(A, "foo.txt")).toBe(A2);
		expect(await readFileText(B, "foo.txt")).toBe(B1);
		// The worktree list is intact: both checkouts are still registered.
		const wtList = await git.worktree.list(A);
		const wtPaths = new Set(wtList.map(entry => path.resolve(entry.path)));
		expect(wtPaths.has(path.resolve(A))).toBe(true);
		expect(wtPaths.has(path.resolve(B))).toBe(true);
		// Neither rollback touched a branch ref.
		expect(await git.head.sha(A)).toBe(initialSha);
		expect(await git.branch.current(A)).toBe("main");
		expect(await git.head.sha(B)).toBe(initialSha);
		expect(await git.branch.current(B)).toBe("feature");

		// ── Step 8: wrong-workspace rejection through the REAL path. A checkpoint
		//    captured by sess-A must be refused when sess-B (cwd B) tries to apply
		//    it — and no file in either workspace may change.
		const aFooBefore = await readFileText(A, "foo.txt");
		const bFooBefore = await readFileText(B, "foo.txt");
		const rejected = await serviceA.rollback(a1, { sessionId: "sess-B", cwd: B });
		expect(rejected.ok).toBe(false);
		expect(rejected.error).toContain("belongs to session");
		expect(await readFileText(A, "foo.txt")).toBe(aFooBefore);
		expect(await readFileText(B, "foo.txt")).toBe(bFooBefore);
	});
});
