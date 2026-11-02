// Regression test: `/memory clear` in one project must not wipe another
// project's memory bookkeeping. The agent database is shared by every project
// using the same agent directory, so clearing project A used to delete project
// B's thread rows, stage 1 outputs and consolidation job, leaving B's
// generated files behind as orphans.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearMemoryData, getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import {
	closeMemoryDb,
	enqueueGlobalWatermark,
	openMemoryDb,
	upsertThreads,
} from "@oh-my-pi/pi-coding-agent/memories/storage";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

const CWD_A = "/projects/alpha";
const CWD_B = "/projects/beta";
const STAGE1_KIND = "memory_stage1";
const GLOBAL_KIND = "memory_consolidate_global";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("memory clear project scope", () => {
	let tempDir: TempDir;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@test-memory-clear-scope-");
		agentDir = tempDir.join("agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await tempDir.remove().catch(() => {});
	});

	test("clearing one project keeps the other project's memory state", async () => {
		const db = openMemoryDb(getAgentDbPath(agentDir));
		upsertThreads(db, [
			{ id: "thread-a", updatedAt: 100, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" },
			{ id: "thread-b", updatedAt: 101, rolloutPath: "/b.jsonl", cwd: CWD_B, sourceKind: "cli" },
		]);
		db.run("INSERT INTO stage1_outputs VALUES ('thread-a', 100, 'alpha raw', 'alpha summary', null, 100)");
		db.run("INSERT INTO stage1_outputs VALUES ('thread-b', 101, 'beta raw', 'beta summary', null, 101)");
		const insertStage1Job = db.prepare(
			"INSERT INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark) VALUES (?, ?, 'pending', 3, 0, 0)",
		);
		insertStage1Job.run(STAGE1_KIND, "thread-a");
		insertStage1Job.run(STAGE1_KIND, "thread-b");
		enqueueGlobalWatermark(db, 100, CWD_A, { forceDirtyWhenNotAdvanced: true });
		enqueueGlobalWatermark(db, 101, CWD_B, { forceDirtyWhenNotAdvanced: true });
		closeMemoryDb(db);

		const rootA = getMemoryRoot(agentDir, CWD_A);
		const rootB = getMemoryRoot(agentDir, CWD_B);
		await fs.mkdir(rootA, { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		await Bun.write(path.join(rootA, "MEMORY.md"), "# alpha memory\n");
		await Bun.write(path.join(rootB, "MEMORY.md"), "# beta memory\n");

		await clearMemoryData(agentDir, CWD_A);

		expect(await fileExists(path.join(rootA, "MEMORY.md"))).toBe(false);
		expect(await fileExists(path.join(rootB, "MEMORY.md"))).toBe(true);

		const check = openMemoryDb(getAgentDbPath(agentDir));
		const threads = check.query("SELECT id FROM threads ORDER BY id").all() as { id: string }[];
		const outputs = check.query("SELECT thread_id FROM stage1_outputs ORDER BY thread_id").all() as {
			thread_id: string;
		}[];
		const jobs = check.query("SELECT kind, job_key FROM jobs ORDER BY kind, job_key").all() as {
			kind: string;
			job_key: string;
		}[];
		closeMemoryDb(check);

		expect(threads).toEqual([{ id: "thread-b" }]);
		expect(outputs).toEqual([{ thread_id: "thread-b" }]);
		expect(jobs).toEqual([
			{ kind: GLOBAL_KIND, job_key: `global:${CWD_B}` },
			{ kind: STAGE1_KIND, job_key: "thread-b" },
		]);
	});
});
