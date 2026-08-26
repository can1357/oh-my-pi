/**
 * `/checkpoint` and `/rollback` command handlers (text/ACP + headless-safe).
 *
 * Exercises the exported `runCheckpointCommand` / `runRollbackCommand` against
 * a real git repo + overridden checkpoint metadata root, mirroring the
 * workspace-checkpoints fixture setup.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { WorkspaceCheckpointService, type WorkspaceRollbackSessionSurface } from "../src/checkpoints";
import { runCheckpointCommand, runRollbackCommand } from "../src/slash-commands/builtin-workspace";

interface Workspace {
	repoDir: string;
	metadataRoot: string;
	service: WorkspaceCheckpointService;
}

const workspaces: string[] = [];

async function makeWorkspace(): Promise<Workspace> {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cmd-repo-"));
	const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cmd-meta-"));
	workspaces.push(repoDir, metadataRoot);
	const init = await $`git init --initial-branch=main`.cwd(repoDir).quiet().nothrow();
	if (init.exitCode !== 0) throw new Error(`git init failed (exit ${init.exitCode})`);
	await $`git config user.name "Command Test"`.cwd(repoDir).quiet();
	await $`git config user.email "commands@example.com"`.cwd(repoDir).quiet();
	await Bun.write(path.join(repoDir, "tracked.txt"), "original\n");
	await $`git add -A`.cwd(repoDir).quiet();
	await $`git commit -m "initial"`.cwd(repoDir).quiet();
	return { repoDir, metadataRoot, service: new WorkspaceCheckpointService({ metadataRoot }) };
}

afterEach(async () => {
	for (const dir of workspaces.splice(0)) await removeWithRetries(dir).catch(() => {});
});

describe("runCheckpointCommand", () => {
	test("creates a checkpoint and reports exactly a created line", async () => {
		const { repoDir, service } = await makeWorkspace();
		const output: string[] = [];
		await runCheckpointCommand("", {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			enabled: true,
			service,
		});
		expect(output).toHaveLength(1);
		expect(output[0]).toMatch(/^Checkpoint [0-9a-f]{10} created\n/);
	});

	test("reports the dedup message when the workspace is unchanged", async () => {
		const { repoDir, service } = await makeWorkspace();
		const output: string[] = [];
		const deps = {
			sessionId: "s1",
			cwd: repoDir,
			output: (t: string) => {
				output.push(t);
			},
			enabled: true,
			service,
		};
		await runCheckpointCommand("", deps);
		output.length = 0;
		await runCheckpointCommand("", deps);
		expect(output[0]).toMatch(/^Checkpoint [0-9a-f]{10} already current \(unchanged\)$/);
	});

	test("honors the disabled-gate hint", async () => {
		const { repoDir, service } = await makeWorkspace();
		const output: string[] = [];
		await runCheckpointCommand("", {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			enabled: false,
			service,
		});
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Checkpoints are disabled");
		expect(output[0]).toContain("checkpoints.enabled");
	});

	test("lists checkpoints newest-first", async () => {
		const { repoDir, service } = await makeWorkspace();
		const output: string[] = [];
		const first = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "first" });
		// Distinct workspace content between creates — identical trees dedup to one checkpoint.
		await Bun.write(path.join(repoDir, "changed.txt"), "v2");
		const second = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "second" });
		expect(second.id).not.toBe(first.id);
		await runCheckpointCommand("list", {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			enabled: true,
			service,
		});
		const lines = output[0]!.split("\n");
		const secondIdx = lines.findIndex(line => line.includes(second.id));
		const firstIdx = lines.findIndex(line => first && line.includes(first.id));
		expect(secondIdx).toBeGreaterThanOrEqual(0);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		// Newest first: the second checkpoint's row precedes the first's.
		expect(secondIdx).toBeLessThan(firstIdx);
	});

	test("shows checkpoint metadata including bytes and skipped count", async () => {
		const { repoDir, service } = await makeWorkspace();
		const meta = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "detail" });
		const output: string[] = [];
		await runCheckpointCommand(`show ${meta.id}`, {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			enabled: true,
			service,
		});
		expect(output[0]).toContain(meta.id);
		expect(output[0]).toContain("reason: manual");
		expect(output[0]).toContain("skipped files: 0");
	});
});

describe("runRollbackCommand", () => {
	test("rolls back to a checkpoint and notifies via the surface (happy path)", async () => {
		const { repoDir, service } = await makeWorkspace();
		const created = await service.create({ sessionId: "s1", cwd: repoDir, reason: "manual", label: "base" });

		// Dirty the workspace: modify tracked + add an untracked file.
		await Bun.write(path.join(repoDir, "tracked.txt"), "changed\n");
		await Bun.write(path.join(repoDir, "extra.txt"), "new\n");

		const output: string[] = [];
		const surface: WorkspaceRollbackSessionSurface & { entries: Array<{ type: string; data: unknown }> } = {
			entries: [],
			appendCustomEntry(type, data) {
				this.entries.push({ type, data });
				return "e1";
			},
		};
		await runRollbackCommand(created.id, {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			service,
			notify: surface,
		});
		expect(output).toHaveLength(1);
		const text = output[0]!;
		expect(text).toContain(`Rolled back to checkpoint ${created.id}`);
		expect(text).toMatch(/Restored files: \d+/);
		expect(text).toMatch(/Removed files: \d+/);
		expect(text).toMatch(/Safety checkpoint: [0-9a-f]{10}/);
		expect(surface.entries).toHaveLength(1);
		expect(surface.entries[0]!.type).toBe("workspace_rolled_back");
		// Workspace restored to the base snapshot.
		expect(await Bun.file(path.join(repoDir, "tracked.txt")).text()).toBe("original\n");
		expect(await Bun.file(path.join(repoDir, "extra.txt")).exists()).toBe(false);
	});

	test("surfaces a clean error when no checkpoint matches (no throw)", async () => {
		const { repoDir, service } = await makeWorkspace();
		const output: string[] = [];
		await runRollbackCommand("does-not-exist", {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			service,
		});
		expect(output).toHaveLength(1);
		expect(output[0]).toContain('No checkpoint matches "does-not-exist"');
	});

	test("surfaces a thrown error without throwing", async () => {
		const { repoDir } = await makeWorkspace();
		const output: string[] = [];
		const fakeService = {
			get: async () => ({ id: "x", sessionId: "s1" }),
			rollback: async () => {
				throw new Error("boom");
			},
		} as unknown as WorkspaceCheckpointService;
		await runRollbackCommand("x", {
			sessionId: "s1",
			cwd: repoDir,
			output: t => {
				output.push(t);
			},
			service: fakeService,
		});
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Rollback error: boom");
	});
});
