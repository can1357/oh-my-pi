/**
 * CLI-level coverage for `omp gc --undo-tails`:
 * - sessions with a live owner process (append-writer sidecar) are skipped;
 * - stale sidecars (dead pid) do not block pruning;
 * - scanning is breadcrumb-suppressed (dry run leaves --continue state alone);
 * - per-file failures reach collectGcErrors (nonzero exit path);
 * - no gc-undo-* temp directories are left behind.
 *
 * The gc run happens in a child process: PI_CODING_AGENT_DIR and a terminal
 * id are set before any omp module loads, so the global dirs singleton in
 * the child resolves inside the test's temp tree and any unsuppressed
 * breadcrumb write would land where the test can see it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { collectGcErrors, type GcResult } from "../src/cli/gc-cli";
import { isProcessAlive, readSessionOwnerPids, SessionManager } from "../src/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "../src/session/session-storage";

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic" as const,
		provider: "anthropic" as const,
		model: "test-model",
		stopReason: "stop" as const,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		timestamp: Date.now(),
	};
}

interface GcChildOutcome {
	skippedLive: number;
	markersPruned: number;
	entriesRemoved: number;
	errors: number;
	breadcrumb: string;
}

async function runGcChild(agentDir: string, apply: boolean): Promise<GcChildOutcome> {
	// Static fixture module (test/fixtures/gc-undo-tails-child.ts): the
	// spawn env carries the agent dir, so the child's top-level imports
	// resolve the singleton inside the test tree. process.execPath keeps the
	// child under the same bun that runs the tests (repo pins bun >=1.4 for
	// Bun.JSONL in session listing).
	const fixture = path.resolve(import.meta.dir, "fixtures/gc-undo-tails-child.ts");
	const proc = Bun.spawn({
		cmd: [process.execPath, fixture],
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			ZELLIJ_PANE_ID: "gc-breadcrumb-test",
			GC_TEST_AGENT_DIR: agentDir,
			GC_TEST_APPLY: apply ? "1" : "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	const resultLine = stdout.split("\n").find(line => line.startsWith("GC_TEST_RESULT "));
	const crumbLine = stdout.split("\n").find(line => line.startsWith("GC_TEST_BREADCRUMB "));
	if (!resultLine || !crumbLine) {
		throw new Error(`gc child produced no result:\n${stdout}`);
	}
	return {
		...JSON.parse(resultLine.slice("GC_TEST_RESULT ".length)),
		breadcrumb: crumbLine.slice("GC_TEST_BREADCRUMB ".length).trim(),
	} as GcChildOutcome;
}

describe("omp gc --undo-tails (CLI)", () => {
	let agentDir: string;
	let sessionsDir: string;
	let sessionFile: string;

	beforeEach(() => {
		agentDir = path.join(os.tmpdir(), `pi-gc-cli-test-${Snowflake.next()}`);
		// gc discovers sessions in per-directory buckets under sessions/, not
		// at the top level, so the fixture mirrors that layout.
		sessionsDir = path.join(agentDir, "sessions", "fixture-bucket");
		fs.mkdirSync(sessionsDir, { recursive: true });
		sessionFile = path.join(sessionsDir, `20260823T000000_${Snowflake.next()}.jsonl`);
	});

	afterEach(() => {
		if (agentDir && fs.existsSync(agentDir)) removeSyncWithRetries(agentDir);
	});

	/** Two undo tails on disk, writer closed, no owner sidecar. */
	async function buildSessionWithTwoUndoTails(): Promise<void> {
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		manager.appendMessage(userMessage("u1"));
		const a1 = manager.appendMessage(assistantMessage("a1"));
		manager.appendMessage(userMessage("tail-one"));
		manager.appendMessage(assistantMessage("tail-one-reply"));
		const tipOne = manager.getLeafId();
		manager.branchWithSummary(a1, "", { kind: "user-undo", undoOf: tipOne, steps: 1, droppedPrompts: "" });
		manager.appendMessage(userMessage("tail-two"));
		manager.appendMessage(assistantMessage("tail-two-reply"));
		const tipTwo = manager.getLeafId();
		manager.branchWithSummary(a1, "", { kind: "user-undo", undoOf: tipTwo, steps: 1, droppedPrompts: "" });
		await manager.close();
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
	}

	it("dry run reports pruneable tails without writing anything, breadcrumbs included", async () => {
		await buildSessionWithTwoUndoTails();
		const before = fs.readFileSync(sessionFile, "utf8");

		const outcome = await runGcChild(agentDir, false);

		expect(outcome.errors).toBe(0);
		expect(outcome.markersPruned).toBe(1);
		expect(outcome.skippedLive).toBe(0);
		// Storage maintenance must not repoint this terminal's --continue
		// target: suppressed breadcrumb means no terminal-sessions file at all.
		expect(outcome.breadcrumb).toBe("ABSENT");
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
	});

	it("apply with a live owner process skips the session", async () => {
		await buildSessionWithTwoUndoTails();
		const before = fs.readFileSync(sessionFile, "utf8");
		const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
		try {
			fs.writeFileSync(`${sessionFile}.owner`, `${sleeper.pid}\n`, { encoding: "utf-8" });
			expect(isProcessAlive(sleeper.pid!)).toBe(true);

			const outcome = await runGcChild(agentDir, true);

			expect(outcome.skippedLive).toBe(1);
			expect(outcome.entriesRemoved).toBe(0);
			expect(outcome.markersPruned).toBe(0);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
		} finally {
			sleeper.kill();
			await sleeper.exited;
		}
	});

	it("stale owner sidecar (dead pid) does not block pruning", async () => {
		await buildSessionWithTwoUndoTails();
		const dead = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await dead.exited;
		fs.writeFileSync(`${sessionFile}.owner`, `${dead.pid}\n`, { encoding: "utf-8" });
		expect(isProcessAlive(dead.pid!)).toBe(false);

		const outcome = await runGcChild(agentDir, true);

		expect(outcome.skippedLive).toBe(0);
		expect(outcome.markersPruned).toBe(1);
		expect(outcome.entriesRemoved).toBeGreaterThan(0);
	});

	it("a sidecar with several owners skips while any one pid is alive", async () => {
		await buildSessionWithTwoUndoTails();
		const before = fs.readFileSync(sessionFile, "utf8");
		const dead = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await dead.exited;
		const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
		try {
			fs.writeFileSync(`${sessionFile}.owner`, `${dead.pid}\n${sleeper.pid}\n`, { encoding: "utf-8" });
			expect(readSessionOwnerPids(sessionFile).length).toBe(2);

			const outcome = await runGcChild(agentDir, true);

			expect(outcome.skippedLive).toBe(1);
			expect(outcome.entriesRemoved).toBe(0);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
		} finally {
			sleeper.kill();
			await sleeper.exited;
		}
	});

	it("an owner appearing between preflight and publish turns the prune into a skip", async () => {
		await buildSessionWithTwoUndoTails();
		// A live manager in ANOTHER process opens the session after gc's
		// preflight would have run; its registration must abort the publish
		// under the claim, leaving disk intact.
		const fixture = path.resolve(import.meta.dir, "fixtures/gc-undo-tails-child.ts");
		const holder = Bun.spawn({
			cmd: [process.execPath, fixture],
			cwd: path.resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				ZELLIJ_PANE_ID: "gc-hold-open-test",
				GC_TEST_AGENT_DIR: agentDir,
				GC_TEST_APPLY: "0",
				GC_TEST_MODE: "hold-open",
				GC_TEST_SESSION_FILE: sessionFile,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		let childPid: number | undefined;
		try {
			// Wait until the child's registration is visible on the sidecar.
			for (let i = 0; i < 100 && childPid === undefined; i++) {
				await Bun.sleep(20);
				const foreign = readSessionOwnerPids(sessionFile).filter(pid => pid !== process.pid);
				if (foreign.length > 0) childPid = foreign[0];
			}
			expect(childPid).toBeDefined();

			const gcManager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
			try {
				const counts = await gcManager.pruneUserUndoTails(0, true);
				expect(counts.skippedLive).toBe(true);
				expect(counts.markers).toBe(0);
				// Disk untouched: both markers still carry an undoOf.
				const onDisk = fs.readFileSync(sessionFile, "utf-8");
				expect(onDisk.includes("user-undo")).toBe(true);
				expect(onDisk.includes("prunedAt")).toBe(false);
			} finally {
				await gcManager.close();
			}
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	it("a second process' writer claim blocks appends to the same session file", async () => {
		await buildSessionWithTwoUndoTails();
		// Manager one holds the append writer (and its lock claim).
		const holder = SessionManager.create(sessionsDir, sessionsDir);
		await holder.setSessionFile(sessionFile);
		holder.appendMessage(userMessage("held-cold"));
		// First append rewrites the whole file (cold path, claim released);
		// the SECOND opens the persistent append writer and holds the claim.
		holder.appendMessage(userMessage("held"));
		await holder.flush();
		try {
			const rival = SessionManager.create(sessionsDir, sessionsDir);
			await rival.setSessionFile(sessionFile);
			expect(() => rival.appendMessage(userMessage("rival"))).toThrow(/locked by another process/);
			// The atomic publication path takes the same claim: a whole-file
			// rewrite under contention raises instead of publishing.
			await expect(rival.rewriteEntries()).rejects.toThrow(/locked by another process/);
		} finally {
			await holder.close();
		}
		// Claim released on close: a later writer can append again.
		const successor = SessionManager.create(sessionsDir, sessionsDir);
		await successor.setSessionFile(sessionFile);
		successor.appendMessage(userMessage("successor"));
		await successor.close();
	});

	it("memory storage with a virtual session path appends without OS locks", async () => {
		const storage = new MemorySessionStorage();
		const virtualPath = "/sessions/proj/virtual-session.jsonl";
		// Memory storage stats must find the path, so seed an empty file.
		storage.writeTextSync(virtualPath, "");
		const manager = SessionManager.create(sessionsDir, sessionsDir, storage);
		await manager.setSessionFile(virtualPath);
		// Before the fileBacked gate this threw trying to create
		// /sessions/proj/virtual-session.jsonl.lock on the local filesystem.
		manager.appendMessage(userMessage("memory-cold"));
		manager.appendMessage(userMessage("memory-writer"));
		await manager.flush();
		const userTexts = manager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry));
		expect(userTexts.some(text => text.includes("memory-writer"))).toBe(true);
		await manager.close();
	});

	it("a failed writer open releases the exclusive claim", async () => {
		class FailingWriterStorage extends FileSessionStorage {
			override openWriter(): never {
				throw new Error("simulated EMFILE");
			}
		}
		const manager = SessionManager.create(sessionsDir, sessionsDir, new FailingWriterStorage());
		await manager.setSessionFile(sessionFile);
		// The first file-backed append takes the cold whole-file rewrite; the
		// second opens the append writer. The open failure is swallowed by the
		// hot path by design (callers stay non-throwing), but the claim the
		// writer was about to hold must be released, not leaked.
		manager.appendMessage(userMessage("cold"));
		manager.appendMessage(userMessage("doomed"));
		// Settle this manager's pending rewrite under the repair claim, then
		// prove the claim is free: another manager locks and appends.
		await manager.recoverPersistenceFromCurrentState();
		const successor = SessionManager.create(sessionsDir, sessionsDir);
		await successor.setSessionFile(sessionFile);
		successor.appendMessage(userMessage("after-failure-cold"));
		successor.appendMessage(userMessage("after-failure"));
		await successor.close();
		await manager.close();
	});

	it("authoritative recovery releases the writer claim but keeps manager ownership", async () => {
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		manager.appendMessage(userMessage("recovery-cold"));
		manager.appendMessage(userMessage("recovery-writer"));
		await manager.flush();
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// Repair closes the writer and rewrites under its own claim; the
		// manager stays open, so ownership (and the gc skip) must survive.
		await manager.recoverPersistenceFromCurrentState();
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// The next append still works (no stale self-lock) and re-arms nothing.
		manager.appendMessage(userMessage("recovery-after"));
		await manager.close();
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("an open that overlaps a prune marker waits and reloads post-prune content", async () => {
		await buildSessionWithTwoUndoTails();
		const writer = SessionManager.create(sessionsDir, sessionsDir);
		await writer.setSessionFile(sessionFile);

		// Simulate an in-flight gc prune: marker present while the victim opens.
		fs.writeFileSync(`${sessionFile}.owner.pruning`, `${process.pid}\n`);
		const victim = SessionManager.create(sessionsDir, sessionsDir);
		let opened: Promise<void> | undefined;
		try {
			opened = victim.setSessionFile(sessionFile);
			await Bun.sleep(80);
			// The prune "finishes": new content lands, then the marker clears.
			writer.appendMessage(userMessage("extra-during-prune"));
			fs.rmSync(`${sessionFile}.owner.pruning`);
			await opened;
			// The victim reloaded after the marker cleared: its tree matches
			// disk, including the entry the "prune" wrote under it.
			expect(JSON.stringify(victim.getBranch()).includes("extra-during-prune")).toBe(true);
		} finally {
			await victim.close().catch(() => undefined);
			await writer.close();
		}
	});

	it("fork registers ownership of the new session file", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		const forked = await manager.fork();
		expect(forked).toBeDefined();
		expect(readSessionOwnerPids(forked!.newSessionFile)).toContain(process.pid);
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
		await manager.close();
		expect(readSessionOwnerPids(forked!.newSessionFile)).toEqual([]);
	});

	it("two managers on one session keep it owned until the last closes", async () => {
		await buildSessionWithTwoUndoTails();
		const first = SessionManager.create(sessionsDir, sessionsDir);
		await first.setSessionFile(sessionFile);
		const second = SessionManager.create(sessionsDir, sessionsDir);
		await second.setSessionFile(sessionFile);
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// Either close removes only its own line; the survivor keeps the
		// session owned so gc cannot prune under it.
		await first.close();
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await second.close();
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
		// Last line removed: the sidecar file itself is gone, not left empty.
		expect(fs.existsSync(`${sessionFile}.owner`)).toBe(false);
	});

	it("a resumed session owns its file from open, without appending anything", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		// No entries recorded: ownership must already be registered so an
		// idle resume (or a title-only change, which bypasses #recordEntry)
		// is not pruned by gc.
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.setSessionName("retitle-only", "user");
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.close();
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("a compaction-style rewriteEntries keeps the session owned while the manager is open", async () => {
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		manager.appendMessage(userMessage("compaction-cold"));
		manager.appendMessage(userMessage("compaction-writer"));
		await manager.flush();
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// rewriteEntries closes the append writer for an atomic whole-file
		// rewrite; the manager remains live, so gc must still see an owner.
		await manager.rewriteEntries();
		expect(readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.close();
		expect(readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("collectGcErrors surfaces undo-tail failures for the exit status", () => {
		const errors = collectGcErrors({
			undoTails: {
				filesScanned: 1,
				markersPruned: 0,
				entriesRemoved: 0,
				skippedLive: 0,
				keep: 1,
				files: [],
				errors: ["/tmp/x.jsonl: boom"],
			},
			// Partial result: only the undoTails branch matters to the collector.
		} as unknown as GcResult);
		expect(errors).toEqual(["undo-tails: /tmp/x.jsonl: boom"]);
	});

	it("scanning leaves no gc-undo-* temp directories behind", async () => {
		await buildSessionWithTwoUndoTails();
		const tmpBefore = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("gc-undo-"));
		await runGcChild(agentDir, false);
		const tmpAfter = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("gc-undo-"));
		expect(tmpAfter.length).toBe(tmpBefore.length);
	});
});
