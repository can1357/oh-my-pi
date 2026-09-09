// Regression tests for #369: Phase 2 memory consolidation must be isolated
// per project working directory. Before the fix, a single global job key
// caused all projects' stage1 outputs to be merged into whichever project
// triggered consolidation first.

import { describe, expect, it } from "bun:test";
import {
	closeMemoryDb,
	enqueueGlobalWatermark,
	listStage1OutputsForGlobal,
	openMemoryDb,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "@oh-my-pi/pi-coding-agent/memories/storage";

const CWD_A = "/projects/alpha";
const CWD_B = "/projects/beta";

describe("memory project isolation", () => {
	it("listStage1OutputsForGlobal filters by cwd", () => {
		const db = openMemoryDb(":memory:");
		try {
			upsertThreads(db, [
				{ id: "thread-a", updatedAt: 1000, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" },
				{ id: "thread-b", updatedAt: 1001, rolloutPath: "/b.jsonl", cwd: CWD_B, sourceKind: "cli" },
			]);

			// Insert stage1 outputs directly (bypassing job machinery)
			db.run("INSERT INTO stage1_outputs VALUES ('thread-a', 1000, 'alpha raw memory', 'alpha summary', null, 999)");
			db.run("INSERT INTO stage1_outputs VALUES ('thread-b', 1001, 'beta raw memory', 'beta summary', null, 999)");

			const aOutputs = listStage1OutputsForGlobal(db, 100, CWD_A);
			const bOutputs = listStage1OutputsForGlobal(db, 100, CWD_B);

			// Each project sees only its own outputs
			expect(aOutputs).toHaveLength(1);
			expect(aOutputs[0].rawMemory).toBe("alpha raw memory");
			expect(aOutputs[0].cwd).toBe(CWD_A);

			expect(bOutputs).toHaveLength(1);
			expect(bOutputs[0].rawMemory).toBe("beta raw memory");
			expect(bOutputs[0].cwd).toBe(CWD_B);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("enqueueGlobalWatermark creates separate job rows per project", () => {
		const db = openMemoryDb(":memory:");
		try {
			enqueueGlobalWatermark(db, 1000, CWD_A, { forceDirtyWhenNotAdvanced: true });
			enqueueGlobalWatermark(db, 1001, CWD_B, { forceDirtyWhenNotAdvanced: true });

			const jobs = db
				.query("SELECT job_key FROM jobs WHERE kind = 'memory_consolidate_global' ORDER BY job_key")
				.all() as { job_key: string }[];

			expect(jobs).toHaveLength(2);
			expect(jobs[0].job_key).toBe(`global:${CWD_A}`);
			expect(jobs[1].job_key).toBe(`global:${CWD_B}`);
		} finally {
			closeMemoryDb(db);
		}
	});

	it("tryClaimGlobalPhase2Job claims only the requested project's job", () => {
		const db = openMemoryDb(":memory:");
		try {
			enqueueGlobalWatermark(db, 1000, CWD_A, { forceDirtyWhenNotAdvanced: true });
			enqueueGlobalWatermark(db, 1001, CWD_B, { forceDirtyWhenNotAdvanced: true });

			// Claim project A
			const resultA = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_A,
			});

			expect(resultA.kind).toBe("claimed");

			// Project B's job is still claimable — not affected by A's claim
			const resultB = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_B,
			});

			expect(resultB.kind).toBe("claimed");

			// Attempting to re-claim A while it's running returns skipped_running
			const resultAAgain = tryClaimGlobalPhase2Job(db, {
				workerId: "test-worker-2",
				leaseSeconds: 60,
				nowSec: 2000,
				cwd: CWD_A,
			});

			expect(resultAAgain.kind).toBe("skipped_running");
		} finally {
			closeMemoryDb(db);
		}
	});
});
