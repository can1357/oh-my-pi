import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadTasks, resolveDataset } from "../src/tb/dataset";

const cleanupDirs: string[] = [];

async function makeFixture(): Promise<{ root: string; tasksDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tb-dataset-"));
	cleanupDirs.push(root);
	const tasksDir = path.join(root, "tasks");
	const validDir = path.join(tasksDir, "alpha-task");
	const skippedDir = path.join(tasksDir, "missing-image");
	await fs.mkdir(validDir, { recursive: true });
	await fs.mkdir(skippedDir, { recursive: true });
	await Bun.write(
		path.join(validDir, "task.toml"),
		`[environment]
docker_image = "terminal-bench/alpha:latest"
cpus = 2
memory_mb = 4096
storage_mb = 8192

[environment.env]
STRING_VALUE = "ready"
NUMBER_VALUE = 7
BOOL_VALUE = true

[verifier.env]
ATTEMPTS = 3

[metadata]
difficulty = "hard"
`,
	);
	await Bun.write(path.join(validDir, "instruction.md"), "Repair the alpha service.\nPreserve its output.\n");
	await Bun.write(path.join(skippedDir, "task.toml"), "[environment]\ncpus = 1\n");
	await Bun.write(path.join(skippedDir, "instruction.md"), "This task must be skipped.\n");
	return { root, tasksDir };
}

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Terminal-Bench dataset", () => {
	it("parses task metadata and applies include/exclude globs", async () => {
		const { tasksDir } = await makeFixture();
		const tasks = await loadTasks(tasksDir);

		expect(tasks).toEqual([
			{
				name: "alpha-task",
				dir: path.join(tasksDir, "alpha-task"),
				instruction: "Repair the alpha service.\nPreserve its output.\n",
				image: "terminal-bench/alpha:latest",
				cpus: 2,
				memoryMb: 4096,
				storageMb: 8192,
				agentTimeoutSec: 900,
				verifierTimeoutSec: 900,
				environmentEnv: { STRING_VALUE: "ready", NUMBER_VALUE: "7", BOOL_VALUE: "true" },
				verifierEnv: { ATTEMPTS: "3" },
				difficulty: "hard",
				category: "",
			},
		]);
		expect((await loadTasks(tasksDir, { include: ["alpha-*"] })).map(task => task.name)).toEqual(["alpha-task"]);
		expect(await loadTasks(tasksDir, { include: ["alpha-*"], exclude: ["*-task"] })).toEqual([]);
		expect(await loadTasks(tasksDir, { include: ["other-*"] })).toEqual([]);
	});

	it("resolves both a dataset root and a tasks directory", async () => {
		const { root, tasksDir } = await makeFixture();
		expect(await resolveDataset(root, path.join(root, "unused-cache"))).toBe(tasksDir);
		expect(await resolveDataset(tasksDir, path.join(root, "unused-cache"))).toBe(tasksDir);
	});
});
