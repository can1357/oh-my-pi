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
		} finally {
			await holder.close();
		}
		// Claim released on close: a later writer can append again.
		const successor = SessionManager.create(sessionsDir, sessionsDir);
		await successor.setSessionFile(sessionFile);
		successor.appendMessage(userMessage("successor"));
		await successor.close();
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
