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
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { collectGcErrors, type GcResult } from "../src/cli/gc-cli";
import {
	isProcessAlive,
	journalIdentity,
	readSessionOwnerPids,
	SessionFileLockError,
	SessionManager,
} from "../src/session/session-manager";
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
	archived: number;
	blobsDeleted: number;
	breadcrumb: string;
}

async function runGcChild(
	agentDir: string,
	apply: boolean,
	extra?: { passes?: string[]; keep?: number; interpose?: "change" | "owner" },
): Promise<GcChildOutcome> {
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
			GC_TEST_PARENT_PID: String(process.pid),
			...(extra?.passes ? { GC_TEST_EXTRA: extra.passes.join(",") } : {}),
			...(extra?.keep !== undefined ? { GC_TEST_KEEP: String(extra.keep) } : {}),
			...(extra?.interpose ? { GC_TEST_INTERPOSE: extra.interpose } : {}),
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
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
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
			expect((await readSessionOwnerPids(sessionFile)).length).toBe(2);

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
				const foreign = (await readSessionOwnerPids(sessionFile)).filter(pid => pid !== process.pid);
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
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// Repair closes the writer and rewrites under its own claim; the
		// manager stays open, so ownership (and the gc skip) must survive.
		await manager.recoverPersistenceFromCurrentState();
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// The next append still works (no stale self-lock) and re-arms nothing.
		manager.appendMessage(userMessage("recovery-after"));
		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
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
			// Registration happens BEFORE the marker check: our pid is already
			// visible to any gc recheck while we wait out the prune.
			expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
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

	it("setSessionFile awaits the owner sidecar write before accepting the load", async () => {
		await buildSessionWithTwoUndoTails();
		// Hold the sidecar lock the way an in-flight gc marker write would.
		// tryAcquireFileLock derives `<target>.lock`, matching the sidecar
		// lock withFileLock(ownerSidecarPath(file)) uses.
		const handle = tryAcquireFileLock(`${sessionFile}.owner`);
		expect(handle?.acquired).toBe(true);
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		let opened = false;
		const opening = (async () => {
			await manager.setSessionFile(sessionFile);
			opened = true;
		})();
		await Bun.sleep(200);
		// Registration is queued behind the lock, and the marker check
		// follows the durable pid write — so the load is not accepted yet.
		expect(opened).toBe(false);
		handle?.release();
		await opening;
		expect(opened).toBe(true);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		await manager.close();
	});

	it("a stale marker left by a dead gc process is recovered, not awaited", async () => {
		await buildSessionWithTwoUndoTails();
		// A gc that died mid-prune: marker names a reaped (provably dead) pid.
		const dead = Bun.spawnSync({ cmd: [process.execPath, "-e", ""] });
		const deadPid = dead.pid!;
		expect(isProcessAlive(deadPid)).toBe(false);
		fs.writeFileSync(`${sessionFile}.owner.pruning`, `${deadPid}\n`);
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		try {
			await manager.setSessionFile(sessionFile); // must not hang
			expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
			expect(fs.existsSync(`${sessionFile}.owner.pruning`)).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("setSessionFile refuses the load when ownership never establishes", async () => {
		await buildSessionWithTwoUndoTails();
		// A sidecar path that cannot be written (a directory) makes every
		// registration attempt fail fast instead of contending 5s on a lock.
		fs.mkdirSync(`${sessionFile}.owner`, { recursive: true });
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await expect(manager.setSessionFile(sessionFile)).rejects.toBeInstanceOf(SessionFileLockError);
		// An unreadable sidecar fails closed now: readers surface the error
		// instead of reporting "no owners" for a live process to prune under.
		await expect(readSessionOwnerPids(sessionFile)).rejects.toMatchObject({ code: "EISDIR" });
		fs.rmSync(`${sessionFile}.owner`, { recursive: true, force: true });
		await manager.close();
	});

	it("a load aborted by gate exhaustion releases its ownership claim", async () => {
		await buildSessionWithTwoUndoTails();
		// Churn the journal deterministically INSIDE each load attempt:
		// loadSessionFile stats through the storage, so appending after the
		// stat but before the entry read guarantees the post-registration
		// identity probe never matches the pre-load identity. Every attempt
		// reloads until the gate exhausts.
		class ChurningStorage extends FileSessionStorage {
			override statSync(filePath: string) {
				const stat = super.statSync(filePath);
				if (path.resolve(filePath) === path.resolve(sessionFile)) {
					fs.appendFileSync(filePath, "\n");
				}
				return stat;
			}
		}
		await expect(SessionManager.open(sessionFile, sessionsDir, new ChurningStorage())).rejects.toBeInstanceOf(
			SessionFileLockError,
		);
		// The rejected open left no manager reference to close, so the claim
		// must already be gone — otherwise gc sees this pid as an owner
		// until process exit.
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("an unreadable prune marker aborts the load instead of clearing it", async () => {
		await buildSessionWithTwoUndoTails();
		// A marker path that cannot be read (a directory) must not report
		// "no prune in flight" — that would accept a possibly pre-prune
		// journal.
		fs.mkdirSync(`${sessionFile}.owner.pruning`, { recursive: true });
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await expect(manager.setSessionFile(sessionFile)).rejects.toMatchObject({ code: "EISDIR" });
		// The aborted load released its claim.
		fs.rmSync(`${sessionFile}.owner.pruning`, { recursive: true, force: true });
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
		await manager.close();
	});

	it("a non-gated registration failure retries via the record backstop", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// Same-file restore: the claim must survive restoreState untouched.
		const snapshot = manager.captureState();
		manager.restoreState(snapshot);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		await manager.close();
	});

	it("a non-gated registration failure retries via the record backstop", async () => {
		await buildSessionWithTwoUndoTails();
		const source = SessionManager.create(sessionsDir, sessionsDir);
		await source.setSessionFile(sessionFile);
		const snapshot = source.captureState();
		await source.close();

		// restoreState onto the snapshot's file is a NON-gated registration:
		// its append fails against an unwritable sidecar, which must unlatch
		// the slot so the #recordEntry backstop retries once it clears.
		const otherFile = path.join(sessionsDir, `20260823T000003_${Snowflake.next()}.jsonl`);
		fs.writeFileSync(otherFile, fs.readFileSync(sessionFile));
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(otherFile);
		fs.mkdirSync(`${sessionFile}.owner`, { recursive: true });
		manager.restoreState(snapshot);
		await Bun.sleep(50);
		fs.rmSync(`${sessionFile}.owner`, { recursive: true, force: true });

		// The next recorded entry retries registration for the live file.
		manager.appendMessage(userMessage("after restore"));
		await Bun.sleep(50);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("moveTo aborts before renaming when the destination claim fails", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);

		const destDir = path.join(agentDir, "sessions", "moved-blocked");
		const dest = path.join(destDir, path.basename(sessionFile));
		fs.mkdirSync(destDir, { recursive: true });
		fs.mkdirSync(`${dest}.owner`, { recursive: true }); // unwritable claim path

		await expect(manager.moveTo(path.join(agentDir, "project2"), destDir)).rejects.toBeInstanceOf(
			SessionFileLockError,
		);
		// Nothing moved: the journal is still at the source, still owned.
		expect(fs.existsSync(dest)).toBe(false);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		fs.rmSync(`${dest}.owner`, { recursive: true, force: true });
		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("fork refuses when the new file's owner claim cannot be established", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);

		// No sidecar file can be created while the session dir is read-only,
		// so the fork's preclaim fails and the fork must be refused with the
		// old session left claimed and active.
		fs.chmodSync(sessionsDir, 0o500);
		try {
			await expect(manager.fork()).rejects.toBeInstanceOf(SessionFileLockError);
		} finally {
			fs.chmodSync(sessionsDir, 0o700);
		}
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		expect(manager.getSessionFile()).toBe(sessionFile);
		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("a failed session switch keeps the previous session owned", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);

		// Switch target whose load fails: its sidecar cannot be written.
		const otherFile = path.join(sessionsDir, `20260823T000001_${Snowflake.next()}.jsonl`);
		fs.writeFileSync(otherFile, fs.readFileSync(sessionFile));
		fs.mkdirSync(`${otherFile}.owner`, { recursive: true });
		await expect(manager.setSessionFile(otherFile)).rejects.toBeInstanceOf(SessionFileLockError);
		fs.rmSync(`${otherFile}.owner`, { recursive: true, force: true });

		// The previous session's claim survived the failed switch — the
		// rollback snapshot stays protected from gc.
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		expect(await readSessionOwnerPids(otherFile)).toEqual([]);
		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("combined run prunes undo tails before archive and blob passes", async () => {
		// A tail referencing a blob that nothing else mentions, aged past
		// every threshold, with keep 0 so the whole tail goes away.
		const hash = new Bun.SHA256().update("ordering-blob").digest("hex");
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		manager.appendMessage(userMessage("u1"));
		const a1 = manager.appendMessage(assistantMessage("a1"));
		manager.appendMessage(userMessage(`tail-with-blob ${hash}`));
		manager.appendMessage(assistantMessage("tail-reply"));
		const tip = manager.getLeafId();
		manager.branchWithSummary(a1, "", { kind: "user-undo", undoOf: tip, steps: 1, droppedPrompts: "" });
		await manager.close();
		fs.mkdirSync(path.join(agentDir, "blobs"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "blobs", hash), "blob-bytes");
		const old = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(sessionFile, old, old);
		fs.utimesSync(path.join(agentDir, "blobs", hash), old, old);
		// Default retention keeps the newest session unarchived; the point
		// here is pass ordering, so retention is zeroed via config.
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			["gc:", "  retainNewestGlobal: 0", "  retainNewestPerCwd: 0", ""].join("\n"),
		);

		const outcome = await runGcChild(agentDir, true, { passes: ["archive", "blobs"], keep: 0 });

		// Same run: tails pruned, journal archived WITHOUT the tail, blob
		// swept because its only reference was in the pruned tail.
		expect(outcome.entriesRemoved).toBeGreaterThan(0);
		expect(outcome.archived).toBe(1);
		expect(outcome.blobsDeleted).toBe(1);
		const archiveGz = path.join(
			agentDir,
			"archive",
			"sessions",
			"fixture-bucket",
			`${path.basename(sessionFile)}.gz`,
		);
		const restored = Bun.gunzipSync(new Uint8Array(fs.readFileSync(archiveGz)));
		const archivedText = Buffer.from(restored).toString("utf-8");
		// The tail entries are gone from the archived journal and the
		// marker is stamped pruned — the prune ran BEFORE the move.
		expect(archivedText).not.toContain("tail-with-blob");
		expect(archivedText).toContain("prunedAt");
		expect(fs.existsSync(path.join(agentDir, "blobs", hash))).toBe(false);
	});

	it("moveTo claims the destination sidecar before the journal rename", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);

		const destDir = path.join(agentDir, "sessions", "moved-bucket");
		const dest = path.join(destDir, path.basename(sessionFile));
		const originalRename = fs.promises.rename.bind(fs.promises);
		let journalRenameSeen = false;
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (path.resolve(String(to)) === path.resolve(dest) && String(from).endsWith(".jsonl")) {
				// The invariant: the moment the journal becomes visible at
				// its destination, the destination sidecar already carries
				// this manager's pid.
				const sidecar = fs.readFileSync(`${dest}.owner`, "utf-8");
				expect(sidecar.trim().split("\n")).toContain(String(process.pid));
				journalRenameSeen = true;
			}
			return originalRename(from, to);
		});
		try {
			await manager.moveTo(path.join(agentDir, "project"), destDir);
		} finally {
			renameSpy.mockRestore();
		}
		expect(journalRenameSeen).toBe(true);
		expect(await readSessionOwnerPids(dest)).toContain(process.pid);
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
		await manager.close();
		expect(await readSessionOwnerPids(dest)).toEqual([]);
	});

	it("moveTo refuses while a foreign writer owns the source journal", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);

		const destDir = path.join(agentDir, "sessions", "move-locked");
		// A separate process opens the append writer (and with it the
		// journal's file lock) and stays alive.
		const fixture = path.resolve(import.meta.dir, "fixtures/gc-undo-tails-child.ts");
		const child = Bun.spawn({
			cmd: [process.execPath, fixture],
			cwd: path.resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				GC_TEST_MODE: "hold-writer",
				GC_TEST_SESSION_FILE: sessionFile,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const heldMarker = `${sessionFile}.held`;
		try {
			// Wait until the child's append writer (and its journal lock) is
			// actually open — signaled via marker file, not the held-open pipe.
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(heldMarker)) {
				if (Date.now() > deadline) throw new Error("hold-writer child never signaled");
				await Bun.sleep(50);
			}
			await expect(manager.moveTo(path.join(agentDir, "project-locked"), destDir)).rejects.toBeInstanceOf(
				SessionFileLockError,
			);
			// Nothing moved and the source claim is intact.
			expect(fs.existsSync(sessionFile)).toBe(true);
			expect(fs.existsSync(path.join(destDir, path.basename(sessionFile)))).toBe(false);
			expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);
		} finally {
			child.kill();
			await child.exited;
			fs.rmSync(heldMarker, { force: true });
		}

		// The holder is gone; the same move now succeeds.
		await manager.moveTo(path.join(agentDir, "project-locked"), destDir);
		expect(manager.getSessionFile()).not.toBe(sessionFile);
		await manager.close();
	});

	it("prune mtime restore skips a journal that changed after the prune", async () => {
		await buildSessionWithTwoUndoTails();
		const old = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(sessionFile, old, old);
		const staleMtime = fs.statSync(sessionFile).mtimeMs;
		// A concurrent update lands between the prune publish and the
		// restore decision (child interposes on the prune): the journal is
		// no longer the one we pruned.
		const outcome = await runGcChild(agentDir, true, { interpose: "change" });
		expect(outcome.entriesRemoved).toBeGreaterThan(0);
		// The concurrent update's fresh mtime survived — restoring the stale
		// one would let a later archive pass treat the live session as cold.
		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(staleMtime);
	});

	it("prune mtime restore skips when a live owner appears", async () => {
		await buildSessionWithTwoUndoTails();
		const old = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(sessionFile, old, old);
		const staleMtime = fs.statSync(sessionFile).mtimeMs;
		// The gc child itself registers as a live owner between prune and
		// restore decision.
		const outcome = await runGcChild(agentDir, true, { interpose: "owner" });
		expect(outcome.entriesRemoved).toBeGreaterThan(0);
		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(staleMtime);
	});

	it("fork of a memory-backed session skips filesystem claims entirely", async () => {
		const manager = SessionManager.create(sessionsDir, sessionsDir, new MemorySessionStorage());
		manager.appendMessage(userMessage("u1"));
		manager.appendMessage(assistantMessage("a1"));

		// A virtual session path has no sidecar to claim; the fork must
		// succeed and leave no .owner file anywhere in the tree.
		await manager.fork();
		expect(manager.getSessionFile()).toBeDefined();
		const ownerFiles: string[] = [];
		const walk = (dir: string): void => {
			for (const name of fs.readdirSync(dir)) {
				const full = path.join(dir, name);
				if (fs.statSync(full).isDirectory()) walk(full);
				else if (name.endsWith(".owner")) ownerFiles.push(full);
			}
		};
		walk(agentDir);
		expect(ownerFiles).toEqual([]);
	});

	it("publish refuses while a same-process sibling manager holds the journal", async () => {
		await buildSessionWithTwoUndoTails();
		const actor = await SessionManager.open(sessionFile, sessionsDir, undefined, {
			suppressBreadcrumb: true,
		});
		// A sibling in THIS process loads the pre-prune tree and appends its
		// own claim line — same pid, so pid-deduplicated checks cannot see it.
		const sibling = await SessionManager.open(sessionFile, sessionsDir, undefined, {
			suppressBreadcrumb: true,
		});
		const before = fs.readFileSync(sessionFile, "utf-8");

		const counts = await actor.pruneUserUndoTails(0, true);
		expect(counts.skippedLive).toBe(true);
		expect(counts.removed).toBe(0);
		expect(fs.readFileSync(sessionFile, "utf-8")).toBe(before);

		// With the sibling gone the raw own-pid count is back to one and the
		// same actor prunes successfully.
		await sibling.close();
		const counts2 = await actor.pruneUserUndoTails(0, true);
		expect(counts2.skippedLive).toBeUndefined();
		expect(counts2.removed).toBeGreaterThan(0);
		await actor.close();
	});

	it("journal identity fails closed on unreadable stats", async () => {
		// ENOENT reads as absent; every other stat failure propagates.
		expect(await journalIdentity(path.join(agentDir, "missing.jsonl"))).toBeUndefined();
		const asFile = path.join(agentDir, "not-a-dir");
		fs.writeFileSync(asFile, "x");
		await expect(journalIdentity(path.join(asFile, "child.jsonl"))).rejects.toThrow();
	});

	it("a failed switch followed by rollback does not double-claim the old session", async () => {
		await buildSessionWithTwoUndoTails();
		// The manager's storage churns ONLY the switch target, so the
		// target's identity gate can never stabilize: the switch fails
		// AFTER its registration succeeded.
		const otherFile = path.join(sessionsDir, `20260823T000004_${Snowflake.next()}.jsonl`);
		fs.writeFileSync(otherFile, fs.readFileSync(sessionFile));
		class SwitchChurn extends FileSessionStorage {
			override statSync(filePath: string) {
				const stat = super.statSync(filePath);
				if (path.resolve(filePath) === path.resolve(otherFile)) {
					fs.appendFileSync(filePath, "\n");
				}
				return stat;
			}
		}
		const manager = await SessionManager.open(sessionFile, sessionsDir, new SwitchChurn());
		const snapshot = manager.captureState();

		await expect(manager.setSessionFile(otherFile)).rejects.toBeInstanceOf(SessionFileLockError);

		// Rollback: switchSession's catch restores the snapshot. Exactly ONE
		// claim line for the old session — the retained one, not a second.
		manager.restoreState(snapshot);
		const sidecarFile = `${sessionFile}.owner`;
		expect(fs.readFileSync(sidecarFile, "utf-8").trim().split("\n")).toEqual([String(process.pid)]);
		await manager.close();
		expect(fs.existsSync(sidecarFile)).toBe(false);
	});

	it("fork registers ownership of the new session file", async () => {
		await buildSessionWithTwoUndoTails();
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		const forked = await manager.fork();
		expect(forked).toBeDefined();
		expect(await readSessionOwnerPids(forked!.newSessionFile)).toContain(process.pid);
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
		await manager.close();
		expect(await readSessionOwnerPids(forked!.newSessionFile)).toEqual([]);
	});

	it("two managers on one session keep it owned until the last closes", async () => {
		await buildSessionWithTwoUndoTails();
		const first = SessionManager.create(sessionsDir, sessionsDir);
		await first.setSessionFile(sessionFile);
		const second = SessionManager.create(sessionsDir, sessionsDir);
		await second.setSessionFile(sessionFile);
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// Either close removes only its own line; the survivor keeps the
		// session owned so gc cannot prune under it.
		await first.close();
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await second.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
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
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.setSessionName("retitle-only", "user");
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
	});

	it("a compaction-style rewriteEntries keeps the session owned while the manager is open", async () => {
		const manager = SessionManager.create(sessionsDir, sessionsDir);
		await manager.setSessionFile(sessionFile);
		manager.appendMessage(userMessage("compaction-cold"));
		manager.appendMessage(userMessage("compaction-writer"));
		await manager.flush();
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		// rewriteEntries closes the append writer for an atomic whole-file
		// rewrite; the manager remains live, so gc must still see an owner.
		await manager.rewriteEntries();
		expect(await readSessionOwnerPids(sessionFile)).toContain(process.pid);

		await manager.close();
		expect(await readSessionOwnerPids(sessionFile)).toEqual([]);
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
