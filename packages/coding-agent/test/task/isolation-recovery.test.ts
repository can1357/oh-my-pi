import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as isolationFs from "@oh-my-pi/pi-coding-agent/task/isolation-fs";
import { recoverDeadIsolations } from "@oh-my-pi/pi-coding-agent/task/isolation-recovery";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * The order a recovery saves and removes in, which is what makes it safe to
 * be killed at any point: every file is synced under a temporary name before
 * anything is renamed into place, the directory is synced after the renames,
 * and only then is the tree removed. A process that dies in between leaves
 * the tree, or the tree and a complete patch — never a removed tree and a
 * patch that is not on the disk.
 */

const OWNER_FIXTURE = path.join(import.meta.dir, "fixtures", "isolation-owner.ts");
const temporary: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporary.splice(0).map(dir => removeWithRetries(dir)));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	temporary.push(dir);
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

/** A sandbox with uncaptured work, made by a real process that is then SIGKILLed. */
async function deadOwnerSandbox(root: string): Promise<string> {
	const repo = await tempDir("omp-recovery-order-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "file.txt"), "base\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-q", "-m", "base");
	const child = Bun.spawn([process.execPath, OWNER_FIXTURE, repo, "OrderTask", "session-order", "dirty"], {
		cwd: path.dirname(OWNER_FIXTURE),
		env: { ...process.env, OMP_WORKTREE_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const decoder = new TextDecoder();
	for await (const line of readLines(child.stdout as ReadableStream<Uint8Array>)) {
		const text = decoder.decode(line);
		if (!text.startsWith("@@")) continue;
		child.kill("SIGKILL");
		await child.exited;
		return path.dirname((JSON.parse(text.slice(2)) as { mergedDir: string }).mergedDir);
	}
	throw new Error(`the owner exited before its sandbox was made: ${await new Response(child.stderr).text()}`);
}

describe("isolation start-up recovery", () => {
	it("syncs the patch and sidecar under temporary names, renames them in, syncs the directory, then removes the tree", async () => {
		const root = await tempDir("omp-recovery-order-wt-");
		const sandbox = await deadOwnerSandbox(root);
		const recovered = path.join(root, ".recovered");
		const events: string[] = [];
		const name = (target: string): string => path.relative(root, target);
		const writeFileDurably = isolationFs.writeFileDurably;
		vi.spyOn(isolationFs, "writeFileDurably").mockImplementation(async (file, contents) => {
			await writeFileDurably(file, contents);
			events.push(`synced ${name(file)}`);
		});
		const syncDirectory = isolationFs.syncDirectory;
		vi.spyOn(isolationFs, "syncDirectory").mockImplementation(async dir => {
			await syncDirectory(dir);
			events.push(`synced dir ${name(dir)}`);
		});
		const rename = isolationFs.rename;
		vi.spyOn(isolationFs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			events.push(`renamed ${name(String(from))} -> ${name(String(to))}`);
		});

		const report = await recoverDeadIsolations({ root });

		expect(report.recovered).toHaveLength(1);
		expect(report.removed).toEqual([sandbox]);
		const [saved] = report.recovered;
		const patch = name(saved?.patchPath ?? "");
		const sidecar = name(saved?.sidecarPath ?? "");
		const at = (event: string): number => {
			const index = events.findIndex(candidate => candidate.startsWith(event));
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		};
		const patchSynced = at(`synced ${patch}.`);
		const sidecarSynced = at(`synced ${sidecar}.`);
		const patchPlaced = at(`renamed ${patch}.`);
		const sidecarPlaced = at(`renamed ${sidecar}.`);
		const directorySynced = at(`synced dir ${name(recovered)}`);
		const treeRemoved = at(`renamed ${name(sandbox)} -> `);
		expect(Math.max(patchSynced, sidecarSynced)).toBeLessThan(Math.min(patchPlaced, sidecarPlaced));
		expect(patchPlaced).toBeLessThan(sidecarPlaced);
		expect(sidecarPlaced).toBeLessThan(directorySynced);
		expect(directorySynced).toBeLessThan(treeRemoved);
		expect(await fs.readFile(saved?.patchPath ?? "", "utf8")).toContain("work of OrderTask");
	}, 60_000);

	it("keeps the tree, and takes back what it had placed, when a save step fails", async () => {
		const root = await tempDir("omp-recovery-order-wt-");
		const sandbox = await deadOwnerSandbox(root);
		vi.spyOn(isolationFs, "syncDirectory").mockRejectedValue(new Error("EIO: the disk went away"));

		const report = await recoverDeadIsolations({ root });

		expect(report.removed).toEqual([]);
		expect(report.kept).toEqual([{ dir: sandbox, reason: expect.stringContaining("EIO: the disk went away") }]);
		expect(await fs.readFile(path.join(sandbox, "m", "task-output.txt"), "utf8")).toBe("work of OrderTask\n");
		// No patch is listed whose tree was not removed for it, and nothing half-written is left.
		expect(await fs.readdir(path.join(root, ".recovered"))).toEqual([]);
	}, 60_000);
});
