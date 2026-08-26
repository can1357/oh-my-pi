import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	CheckpointError,
	type CheckpointMeta,
	defaultCheckpointsRoot,
	emitWorkspaceRolledBack,
	onWorkspaceRolledBack,
	WorkspaceCheckpointService,
} from "../../src/checkpoints";
import * as git from "../../src/utils/git";

/**
 * Every case runs against a real `git init` repository in a temp dir with the
 * checkpoint metadata root pointed at a sibling temp dir, so nothing touches
 * `~/.omp`, the settings singleton, or another test's state.
 */
interface Workspace {
	readonly repoDir: string;
	readonly metadataRoot: string;
	readonly service: WorkspaceCheckpointService;
}

const workspaces: string[] = [];

async function makeWorkspace(options: { maxPerSession?: number; maxFileBytes?: number } = {}): Promise<Workspace> {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cp-repo-"));
	const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cp-meta-"));
	workspaces.push(repoDir, metadataRoot);
	const init = await $`git init --initial-branch=main`.cwd(repoDir).quiet().nothrow();
	if (init.exitCode !== 0) throw new Error(`git init failed (exit ${init.exitCode})`);
	await $`git config user.name "Checkpoint Test"`.cwd(repoDir).quiet();
	await $`git config user.email "checkpoints@example.com"`.cwd(repoDir).quiet();
	await Bun.write(path.join(repoDir, "tracked.txt"), "original\n");
	await Bun.write(path.join(repoDir, ".gitignore"), "ignored.log\n");
	await $`git add -A`.cwd(repoDir).quiet();
	await $`git commit -m "initial"`.cwd(repoDir).quiet();
	return {
		repoDir,
		metadataRoot,
		service: new WorkspaceCheckpointService({ metadataRoot, ...options }),
	};
}

async function readFileText(...segments: string[]): Promise<string | null> {
	try {
		return await Bun.file(path.join(...segments)).text();
	} catch {
		return null;
	}
}

afterEach(async () => {
	for (const dir of workspaces.splice(0)) await removeWithRetries(dir).catch(() => {});
});

describe("WorkspaceCheckpointService capture", () => {
	test("captures a clean workspace and records identity, ref, and metadata", async () => {
		const { repoDir, service, metadataRoot } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "clean" });

		expect(meta.id).toMatch(/^[0-9a-f]{10}$/);
		expect(meta.refName).toBe(`refs/omp/checkpoints/s1/${meta.id}`);
		expect(meta.label).toBe("clean");
		expect(meta.reason).toBe("manual");
		const resolvedRoot = await git.repo.root(repoDir);
		expect(resolvedRoot).not.toBeNull();
		expect(meta.identity.worktreePath).toBe(resolvedRoot ?? "");
		expect(meta.headShaAtCapture).toBe(await git.head.sha(repoDir));
		expect(meta.bytesCaptured).toBeGreaterThan(0);
		expect(meta.skippedFiles).toEqual([]);
		expect(meta.metaPath).toBe(path.join(metadataRoot, "s1", `${meta.id}.json`));
		expect(await git.ref.resolve(repoDir, meta.refName)).not.toBeNull();
		expect(await Bun.file(meta.metaPath).exists()).toBe(true);
	});

	test("HEAD, branch, and index are untouched by a capture", async () => {
		const { repoDir, service } = await makeWorkspace();
		const headBefore = await git.head.sha(repoDir);
		await Bun.write(path.join(repoDir, "staged.txt"), "staged\n");
		await $`git add staged.txt`.cwd(repoDir).quiet();
		const statusBefore = await git.status(repoDir);

		await service.create({ sessionId: "s1", cwd: repoDir, reason: "auto" });

		expect(await git.head.sha(repoDir)).toBe(headBefore);
		expect(await git.branch.current(repoDir)).toBe("main");
		expect(await git.status(repoDir)).toBe(statusBefore);
	});

	test("captures dirty tracked content, untracked files, and binary payloads; skips ignored files", async () => {
		const { repoDir, service } = await makeWorkspace();
		const binary = new Uint8Array([0, 1, 2, 250, 255, 0, 42]);
		await Bun.write(path.join(repoDir, "tracked.txt"), "modified\n");
		await Bun.write(path.join(repoDir, "untracked.txt"), "new file\n");
		await Bun.write(path.join(repoDir, "blob.bin"), binary);
		await Bun.write(path.join(repoDir, "ignored.log"), "noise\n");
		await Bun.write(path.join(repoDir, "nested", "deep", "file.txt"), "nested\n");

		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const paths = await git.ls.tree(repoDir, meta.treeSha);

		expect(paths).toContain("tracked.txt");
		expect(paths).toContain("untracked.txt");
		expect(paths).toContain("blob.bin");
		expect(paths).toContain("nested/deep/file.txt");
		expect(paths).not.toContain("ignored.log");
	});

	test("identical workspace state dedups to the existing checkpoint", async () => {
		const { repoDir, service } = await makeWorkspace();
		const first = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "keep" });
		const second = await service.create({ sessionId: "s1", cwd: repoDir, reason: "auto" });

		expect(second.id).toBe(first.id);
		expect(second.reason).toBe("manual");
		expect(second.label).toBe("keep");
		expect(await service.countForSession("s1", repoDir)).toBe(1);
	});

	test("files over the size limit are excluded and reported, not silently captured", async () => {
		const { repoDir, service } = await makeWorkspace({ maxFileBytes: 32 });
		await Bun.write(path.join(repoDir, "huge.bin"), "x".repeat(4096));
		await Bun.write(path.join(repoDir, "small.txt"), "tiny\n");

		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const paths = await git.ls.tree(repoDir, meta.treeSha);

		expect(meta.skippedFiles).toEqual(["huge.bin"]);
		expect(paths).not.toContain("huge.bin");
		expect(paths).toContain("small.txt");
	});

	test("a workspace with too many oversize files is refused instead of half-captured", async () => {
		const { repoDir, service } = await makeWorkspace({ maxFileBytes: 4 });
		for (let index = 0; index < 51; index += 1) {
			await Bun.write(path.join(repoDir, `big-${index}.bin`), "0123456789");
		}

		await expect(service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" })).rejects.toThrow(
			/exceed the 4-byte checkpoint limit/,
		);
		expect(await service.countForSession("s1", repoDir)).toBe(0);
	});

	test("the default metadata root is the checkpoints dir inside the workspace's session dir", async () => {
		const { repoDir } = await makeWorkspace();
		const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cp-sessions-"));
		workspaces.push(sessionsRoot);

		const root = defaultCheckpointsRoot(repoDir, sessionsRoot);

		expect(path.basename(root)).toBe("checkpoints");
		expect(path.dirname(path.dirname(root))).toBe(sessionsRoot);
	});

	test("a non-git cwd is refused by create and rollback", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cp-plain-"));
		workspaces.push(plainDir);

		await expect(service.create({ sessionId: "s1", cwd: plainDir, reason: "manual" })).rejects.toThrow(
			CheckpointError,
		);
		await expect(service.rollback(meta, { sessionId: "s1", cwd: plainDir })).rejects.toThrow(/not a git repository/);
	});
});

describe("WorkspaceCheckpointService queries", () => {
	test("lists newest first, resolves by id prefix, and reports the latest", async () => {
		const { repoDir, service } = await makeWorkspace();
		const first = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "one" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "second\n");
		const second = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "two" });

		const listed = await service.list("s1", repoDir);
		expect(listed.map(meta => meta.id)).toEqual([second.id, first.id]);
		expect((await service.latest("s1", repoDir))?.id).toBe(second.id);
		expect((await service.get("s1", repoDir, first.id.slice(0, 4)))?.id).toBe(first.id);
		expect(await service.get("s1", repoDir, "zzzz")).toBeUndefined();
	});

	test("checkpoints of another session are not listed", async () => {
		const { repoDir, service } = await makeWorkspace();
		await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });

		expect(await service.list("s2", repoDir)).toEqual([]);
		expect(await service.countForSession("s2", repoDir)).toBe(0);
	});

	test("a checkpoint from another workspace is filtered out of the listing", async () => {
		const { repoDir, service, metadataRoot } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const foreign: CheckpointMeta = {
			...meta,
			id: "abcdef0123",
			identity: { ...meta.identity, worktreePath: path.join(os.tmpdir(), "omp-cp-elsewhere") },
			refName: "refs/omp/checkpoints/s1/abcdef0123",
			metaPath: path.join(metadataRoot, "s1", "abcdef0123.json"),
		};
		await Bun.write(foreign.metaPath, JSON.stringify(foreign));
		await git.ref.update(repoDir, foreign.refName, (await git.ref.resolve(repoDir, meta.refName)) ?? "HEAD");

		expect((await service.list("s1", repoDir)).map(entry => entry.id)).toEqual([meta.id]);
	});

	test("a crash between ref and metadata leaves no valid checkpoint", async () => {
		const { repoDir, service, metadataRoot } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });

		// Ref without metadata (crash before the metadata rename).
		await fs.rm(meta.metaPath);
		expect(await service.list("s1", repoDir)).toEqual([]);
		expect(await git.ref.resolve(repoDir, meta.refName)).not.toBeNull();

		// Metadata without ref (crash/GC after the ref was lost).
		await Bun.write(meta.metaPath, JSON.stringify(meta));
		await git.ref.delete(repoDir, meta.refName);
		expect(await service.list("s1", repoDir)).toEqual([]);

		// Unparsable metadata is filtered too.
		await Bun.write(path.join(metadataRoot, "s1", "0123456789.json"), "{ not json");
		expect(await service.list("s1", repoDir)).toEqual([]);
	});
});

describe("WorkspaceCheckpointService rollback", () => {
	test("restores a modified tracked file and leaves HEAD alone", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const headBefore = await git.head.sha(repoDir);
		await Bun.write(path.join(repoDir, "tracked.txt"), "broken\n");

		const result = await service.rollback(meta, { sessionId: "s1", cwd: repoDir });

		expect(result.ok).toBe(true);
		expect(result.restoredFiles).toBe(1);
		// Worktree and index both hold the restored content, so a rolled-back file
		// that matches HEAD leaves no phantom staged diff behind.
		expect(await git.status(repoDir)).toBe("");
		expect(result.removedFiles).toBe(0);
		expect(await readFileText(repoDir, "tracked.txt")).toBe("original\n");
		expect(await git.head.sha(repoDir)).toBe(headBefore);
		expect(await git.branch.current(repoDir)).toBe("main");
	});

	test("restores a deleted file and removes a file created after the checkpoint", async () => {
		const { repoDir, service } = await makeWorkspace();
		await Bun.write(path.join(repoDir, "keep.txt"), "keep\n");
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });

		await fs.rm(path.join(repoDir, "keep.txt"));
		await $`git rm --cached --quiet tracked.txt`.cwd(repoDir).quiet().nothrow();
		await fs.rm(path.join(repoDir, "tracked.txt"));
		await Bun.write(path.join(repoDir, "created-later.txt"), "extra\n");
		await Bun.write(path.join(repoDir, "new-dir", "created-later.txt"), "extra\n");

		const result = await service.rollback(meta, { sessionId: "s1", cwd: repoDir });

		expect(result.ok).toBe(true);
		expect(await readFileText(repoDir, "keep.txt")).toBe("keep\n");
		expect(await readFileText(repoDir, "tracked.txt")).toBe("original\n");
		expect(await readFileText(repoDir, "created-later.txt")).toBeNull();
		expect(await readFileText(repoDir, "new-dir", "created-later.txt")).toBeNull();
		expect(result.restoredFiles).toBe(2);
		expect(result.removedFiles).toBe(2);
	});

	test("restores binary content byte-for-byte", async () => {
		const { repoDir, service } = await makeWorkspace();
		const original = new Uint8Array([0, 10, 255, 128, 7, 0, 3]);
		await Bun.write(path.join(repoDir, "blob.bin"), original);
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "blob.bin"), new Uint8Array([9, 9, 9]));

		const result = await service.rollback(meta, { sessionId: "s1", cwd: repoDir });

		expect(result.ok).toBe(true);
		expect(await Bun.file(path.join(repoDir, "blob.bin")).bytes()).toEqual(original);
	});

	test("a dirty workspace is captured as a safety checkpoint that can itself be restored", async () => {
		const { repoDir, service } = await makeWorkspace();
		const target = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "work in progress\n");
		await Bun.write(path.join(repoDir, "scratch.txt"), "scratch\n");

		const rolledBack = await service.rollback(target, { sessionId: "s1", cwd: repoDir });
		expect(rolledBack.ok).toBe(true);
		const safety = rolledBack.safetyCheckpoint;
		expect(safety).toBeDefined();
		expect(safety?.reason).toBe("pre-rollback");
		expect(await readFileText(repoDir, "scratch.txt")).toBeNull();

		const undone = await service.rollback(safety as CheckpointMeta, { sessionId: "s1", cwd: repoDir });
		expect(undone.ok).toBe(true);
		expect(await readFileText(repoDir, "tracked.txt")).toBe("work in progress\n");
		expect(await readFileText(repoDir, "scratch.txt")).toBe("scratch\n");
	});

	test("rolling back an already-matching workspace is a no-op without a safety capture", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });

		const result = await service.rollback(meta, { sessionId: "s1", cwd: repoDir });

		expect(result).toEqual({ ok: true, restoredFiles: 0, removedFiles: 0 });
		expect(await service.countForSession("s1", repoDir)).toBe(1);
	});

	test("rejects a checkpoint from another session or another workspace without touching files", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "dirty\n");

		const wrongSession = await service.rollback(meta, { sessionId: "other", cwd: repoDir });
		expect(wrongSession.ok).toBe(false);
		expect(wrongSession.error).toContain("belongs to session");

		const foreign: CheckpointMeta = {
			...meta,
			identity: { ...meta.identity, worktreePath: path.join(os.tmpdir(), "omp-cp-elsewhere") },
		};
		const wrongWorkspace = await service.rollback(foreign, { sessionId: "s1", cwd: repoDir });
		expect(wrongWorkspace.ok).toBe(false);
		expect(wrongWorkspace.error).toContain("was captured in");

		expect(await readFileText(repoDir, "tracked.txt")).toBe("dirty\n");
	});

	test("a missing snapshot ref fails the rollback instead of emptying the workspace", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "dirty\n");
		await git.ref.delete(repoDir, meta.refName);

		const result = await service.rollback(meta, { sessionId: "s1", cwd: repoDir });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("no longer present");
		expect(await readFileText(repoDir, "tracked.txt")).toBe("dirty\n");
	});

	test("a failed transaction keeps the journal and the safety checkpoint for recovery", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "dirty\n");

		// Simulate a crash mid-apply: the target tree object disappears between
		// PREPARE and APPLY, so the transaction cannot complete.
		const corrupted: CheckpointMeta = { ...meta, treeSha: "0".repeat(40) };
		const result = await service.rollback(corrupted, { sessionId: "s1", cwd: repoDir });

		expect(result.ok).toBe(false);
		expect(result.safetyCheckpoint).toBeDefined();
		const journal = await service.pendingRollback("s1", repoDir);
		expect(journal?.phase).toBe("failed");
		expect(journal?.targetTreeSha).toBe(corrupted.treeSha);
		expect(journal?.safetyCheckpointId).toBe(result.safetyCheckpoint?.id);
		expect(await Bun.file(service.journalPath("s1", repoDir)).exists()).toBe(true);
		// The workspace still holds its content — nothing was silently discarded.
		expect(await readFileText(repoDir, "tracked.txt")).toBe("dirty\n");
	});

	test("a successful rollback closes the journal and notifies consumers", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "dirty\n");
		const entries: { customType: string; data?: unknown }[] = [];
		const observed: string[] = [];
		const unsubscribe = onWorkspaceRolledBack(event => observed.push(event.checkpoint.id));

		try {
			const result = await service.rollback(meta, {
				sessionId: "s1",
				cwd: repoDir,
				notify: {
					appendCustomEntry(customType, data) {
						entries.push({ customType, data });
						return "entry-1";
					},
				},
			});
			expect(result.ok).toBe(true);
		} finally {
			unsubscribe();
		}

		expect(await service.pendingRollback("s1", repoDir)).toBeUndefined();
		expect(entries.map(entry => entry.customType)).toEqual(["workspace_rolled_back"]);
		expect(observed).toEqual([meta.id]);
	});

	test("emitWorkspaceRolledBack survives a throwing listener", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const observed: string[] = [];
		const unsubscribeBad = onWorkspaceRolledBack(() => {
			throw new Error("listener boom");
		});
		const unsubscribeGood = onWorkspaceRolledBack(event => observed.push(event.checkpoint.id));

		try {
			emitWorkspaceRolledBack(undefined, meta);
		} finally {
			unsubscribeBad();
			unsubscribeGood();
		}

		expect(observed).toEqual([meta.id]);
	});
});

describe("WorkspaceCheckpointService retention", () => {
	test("prunes the oldest automatic checkpoints and protects manual ones", async () => {
		const { repoDir, service } = await makeWorkspace({ maxPerSession: 3 });
		const kept = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "pin" });
		const created: CheckpointMeta[] = [];
		for (let index = 0; index < 4; index += 1) {
			await Bun.write(path.join(repoDir, "tracked.txt"), `auto ${index}\n`);
			created.push(await service.create({ sessionId: "s1", cwd: repoDir, reason: "auto" }));
		}
		expect(created.map(meta => meta.reason)).toEqual(["auto", "auto", "auto", "auto"]);

		const remaining = await service.list("s1", repoDir);
		expect(remaining.length).toBe(3);
		expect(remaining.map(meta => meta.id)).toContain(kept.id);
		expect(remaining.map(meta => meta.id)).toEqual([created[3].id, created[2].id, kept.id]);
		// Pruned checkpoints release their refs too, so the objects can be GC'd.
		expect(await git.ref.resolve(repoDir, created[0].refName)).toBeNull();
		expect(await git.ref.resolve(repoDir, created[1].refName)).toBeNull();
		expect(await git.ref.resolve(repoDir, kept.refName)).not.toBeNull();
	});

	test("prune drops refs that no valid metadata points at", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		const orphanRef = "refs/omp/checkpoints/s1/dead0dead0";
		await git.ref.update(repoDir, orphanRef, (await git.ref.resolve(repoDir, meta.refName)) ?? "HEAD");

		await service.pruneSession("s1", repoDir);

		expect(await git.ref.resolve(repoDir, orphanRef)).toBeNull();
		expect(await git.ref.resolve(repoDir, meta.refName)).not.toBeNull();
	});

	test("deleteForSession removes every ref and metadata file for that session only", async () => {
		const { repoDir, service } = await makeWorkspace();
		const mine = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual" });
		await Bun.write(path.join(repoDir, "tracked.txt"), "other session\n");
		const other = await service.create({ sessionId: "s2", cwd: repoDir, reason: "manual" });

		const removed = await service.deleteForSession("s1", repoDir);

		expect(removed).toBe(1);
		expect(await git.ref.resolve(repoDir, mine.refName)).toBeNull();
		expect(await Bun.file(mine.metaPath).exists()).toBe(false);
		expect(await service.countForSession("s1", repoDir)).toBe(0);
		expect(await git.ref.resolve(repoDir, other.refName)).not.toBeNull();
		expect((await service.list("s2", repoDir)).map(entry => entry.id)).toEqual([other.id]);
	});
});
