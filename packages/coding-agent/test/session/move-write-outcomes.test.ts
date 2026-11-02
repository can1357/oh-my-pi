import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The invariant these tests hold `SessionManager.moveWritten` to, for every
 * move after every step: `true` exactly when this manager confirmed a full
 * transcript of the moved session published to that move's own file — a
 * write that returned, or (asynchronous writes, which read back) one whose
 * body landed; `undefined` while that can still happen — the move is the
 * latest, or a publish to its file is still on its way; `false` otherwise.
 */

/** How the next full publish goes. */
type Outcome = "ok" | "fail" | "partial" | "landed-error";
/** Which writer publishes the transcript. */
type Writer = "sync" | "atomic" | "repair";

/** The session id in a full transcript's header, if `body` is one. */
function headerId(body: string): string | undefined {
	for (const line of body.split("\n", 3)) {
		try {
			const entry = JSON.parse(line) as { type?: string; id?: string };
			if (entry.type === "session") return entry.id;
		} catch {
			// A title slot or a truncated line: not the header.
		}
	}
	return undefined;
}

/**
 * File storage that fails the next full publish as `outcome` says, refuses
 * the ids it is told to (so a write under one moves the session), can hold
 * the next asynchronous publish before or after its bytes land, and keeps
 * the record the invariant is checked against.
 */
class ScriptedStorage extends FileSessionStorage {
	outcome: Outcome = "ok";
	/** Whether an id first claimed from now on is refused, so a write under it moves the session again. */
	refuseNewIds = true;
	readonly #refused = new Map<string, boolean>();
	/** `file` → session ids whose full transcript this manager could know reached it. */
	readonly #confirmed = new Map<string, Set<string>>();
	/** Files an asynchronous publish is still on its way to. */
	readonly inFlight = new Set<string>();
	hold?: { at: "before" | "after"; reached: PromiseWithResolvers<void>; go: PromiseWithResolvers<void> };

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		// The first id asked for is the owner's: always refused, so the first write moves.
		if (!this.#refused.has(sessionId)) this.#refused.set(sessionId, this.#refused.size === 0 || this.refuseNewIds);
		return this.#refused.get(sessionId) ? null : super.claimSession(sessionId, sessionPath);
	}

	confirmed(file: string, sessionId: string): boolean {
		return this.#confirmed.get(path.resolve(file))?.has(sessionId) ?? false;
	}

	#confirm(file: string, body: string): void {
		const id = headerId(body);
		if (!id) return;
		const key = path.resolve(file);
		let ids = this.#confirmed.get(key);
		if (!ids) this.#confirmed.set(key, (ids = new Set()));
		ids.add(id);
	}

	#take(): Outcome {
		const outcome = this.outcome;
		this.outcome = "ok";
		return outcome;
	}

	override writeTextSync(file: string, body: string, options?: SessionStorageWriteOptions): void {
		const outcome = this.#take();
		if (outcome === "fail") throw new Error("injected publish failure");
		if (outcome === "partial") {
			fs.writeFileSync(file, body.slice(0, 19));
			throw new Error("injected partial publish");
		}
		super.writeTextSync(file, body, options);
		// A synchronous write is confirmed only by returning: nothing reads it back.
		if (outcome === "landed-error") throw new Error("injected error after the publish landed");
		this.#confirm(file, body);
	}

	override async writeTextAtomic(file: string, body: string, options?: WriteTextAtomicOptions): Promise<void> {
		const outcome = this.#take();
		const hold = this.hold;
		this.hold = undefined;
		this.inFlight.add(path.resolve(file));
		// A writer recovers from a conflict over a file it wrote before and
		// retries instead of reading the file back; a conflict over a file it
		// expected not to exist it reads back like any other failure.
		let recovered = false;
		try {
			if (hold?.at === "before") {
				hold.reached.resolve();
				await hold.go.promise;
			}
			if (outcome === "fail") throw new Error("injected publish failure");
			if (outcome === "partial") {
				fs.writeFileSync(file, body.slice(0, 19));
				throw new Error("injected partial publish");
			}
			await super.writeTextAtomic(file, body, options);
			if (hold?.at === "after") {
				hold.reached.resolve();
				await hold.go.promise;
			}
			if (outcome === "landed-error") throw new Error("injected error after the publish landed");
		} catch (error) {
			recovered = error instanceof SessionWriteConflictError && error.expectedSize !== null;
			throw error;
		} finally {
			this.inFlight.delete(path.resolve(file));
			// Otherwise they read the file back once the call settles: if it
			// holds the body they meant to publish — whoever put it there —
			// that is confirmed, error or not.
			if (!recovered && fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) this.#confirm(file, body);
		}
	}
}

interface Step {
	writer: Writer;
	outcome: Outcome;
	/** Whether the ids this step creates are refused, so the next write moves again. */
	refuseNewIds: boolean;
}

const label = (steps: readonly Step[]) =>
	steps.map(s => `${s.writer}/${s.outcome}${s.refuseNewIds ? "/moves-again" : ""}`).join(" → ");

function* stepsOf(writers: readonly Writer[], outcomes: readonly Outcome[]): Generator<Step> {
	for (const writer of writers)
		for (const outcome of outcomes) for (const refuseNewIds of [true, false]) yield { writer, outcome, refuseNewIds };
}

function nextEventLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** A session file another process wrote first, so this process's first write moves off it. */
async function ownedFile(root: string): Promise<{ file: string; dir: string }> {
	const dir = path.join(root, "sessions");
	const owner = SessionManager.create(root, dir, new FileSessionStorage());
	owner.appendMessage({ role: "user", content: "the owner's turn", timestamp: Date.now() });
	await owner.ensureOnDisk();
	await owner.flush();
	const file = owner.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");
	await owner.close();
	return { file, dir };
}

/** What the invariant says `moveWritten(notice)` is now; `pending` are files a publish is still on its way to. */
function expectedOutcome(
	notice: SessionPersistenceNotice,
	latest: SessionPersistenceNotice | undefined,
	storage: ScriptedStorage,
	sealed: boolean,
): boolean | undefined {
	if (storage.confirmed(notice.to, notice.sessionId)) return true;
	if (sealed) return false;
	if (notice === latest || storage.inFlight.has(path.resolve(notice.to))) return undefined;
	return false;
}

/**
 * Every way `manager` disagrees with the invariant now, as readable lines.
 * A move's file is checked when the move is first reported written (then
 * added to `verified`): a later failed write may damage that file, which
 * says nothing about the move.
 */
function violations(
	manager: SessionManager,
	notices: readonly SessionPersistenceNotice[],
	storage: ScriptedStorage,
	sealed: boolean,
	when: string,
	verified: Set<SessionPersistenceNotice>,
): string[] {
	const found: string[] = [];
	notices.forEach((notice, index) => {
		const expected = expectedOutcome(notice, notices.at(-1), storage, sealed);
		const actual = manager.moveWritten(notice);
		if (actual !== expected) found.push(`${when}: move ${index + 1} reported ${actual}, expected ${expected}`);
		if (actual === true && !verified.has(notice)) {
			verified.add(notice);
			const onDisk = fs.existsSync(notice.to) ? headerId(fs.readFileSync(notice.to, "utf8")) : undefined;
			if (onDisk !== notice.sessionId)
				found.push(`${when}: move ${index + 1} reported written, file holds ${onDisk}`);
		}
	});
	return found;
}

async function runStep(manager: SessionManager, storage: ScriptedStorage, step: Step): Promise<void> {
	storage.outcome = step.outcome;
	storage.refuseNewIds = step.refuseNewIds;
	try {
		if (step.writer === "sync") manager.appendCustomEntry("step", {});
		else if (step.writer === "atomic") await manager.rewriteEntries();
		else await manager.recoverPersistenceFromCurrentState();
	} catch {
		// A failed publish may surface here; the invariant is about what was recorded.
	}
	storage.outcome = "ok";
	await nextEventLoopTurn();
}

/** Runs `steps` on a fresh manager over a copy of `source`, checking the invariant after each step and after sealing. */
async function violationsOf(
	root: string,
	source: { file: string; dir: string },
	steps: readonly Step[],
): Promise<string[]> {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const file = path.join(dir, path.basename(source.file));
	fs.copyFileSync(source.file, file);
	const storage = new ScriptedStorage();
	const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	const found: string[] = [];
	const verified = new Set<SessionPersistenceNotice>();
	try {
		for (const [index, step] of steps.entries()) {
			await runStep(manager, storage, step);
			found.push(...violations(manager, notices, storage, false, `after step ${index + 1}`, verified));
		}
		manager.seal();
		found.push(...violations(manager, notices, storage, true, "after seal", verified));
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
	return found.map(line => `${label(steps)}: ${line}`);
}

const allWriters = ["sync", "atomic", "repair"] as const;
const allOutcomes = ["ok", "fail", "partial", "landed-error"] as const;

describe("which moves count as written", () => {
	// Every ordering of two steps over every writer, outcome and next-move
	// choice; one test per first step.
	for (const first of stepsOf(allWriters, allOutcomes)) {
		it(`every second step after ${label([first])}`, async () => {
			using tempDir = TempDir.createSync("@omp-move-outcomes-");
			const source = await ownedFile(tempDir.path());
			const found: string[] = [];
			for (const second of stepsOf(allWriters, allOutcomes)) {
				found.push(...(await violationsOf(tempDir.path(), source, [first, second])));
			}
			expect(found).toEqual([]);
		}, 180_000);
	}

	// Three steps over the writers that publish synchronously and through the
	// repair, succeeding or failing.
	for (const first of stepsOf(["sync", "repair"], ["ok", "fail"])) {
		it(`every two further steps after ${label([first])}`, async () => {
			using tempDir = TempDir.createSync("@omp-move-outcomes-");
			const source = await ownedFile(tempDir.path());
			const found: string[] = [];
			for (const second of stepsOf(["sync", "repair"], ["ok", "fail"])) {
				for (const third of stepsOf(["sync", "repair"], ["ok", "fail"])) {
					found.push(...(await violationsOf(tempDir.path(), source, [first, second, third])));
				}
			}
			expect(found).toEqual([]);
		}, 180_000);
	}

	// An asynchronous publish to a move's file still on its way while a
	// synchronous write moves the session again (or stays) and publishes.
	for (const writer of ["atomic", "repair"] as const) {
		for (const at of ["before", "after"] as const) {
			for (const movesAgain of [true, false]) {
				it(`a ${writer} publish held ${at} its bytes land, while a sync write ${movesAgain ? "moves again" : "stays"}`, async () => {
					using tempDir = TempDir.createSync("@omp-move-outcomes-");
					const source = await ownedFile(tempDir.path());
					const file = path.join(tempDir.path(), "case", path.basename(source.file));
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.copyFileSync(source.file, file);
					const storage = new ScriptedStorage();
					const manager = await SessionManager.open(file, path.dirname(file), storage, {
						suppressBreadcrumb: true,
					});
					const notices: SessionPersistenceNotice[] = [];
					manager.onPersistenceNotice(notice => notices.push(notice));
					const found: string[] = [];
					const verified = new Set<SessionPersistenceNotice>();
					try {
						// The held publish moves the session off the owner's file; whether
						// its id is refused decides whether the sync write moves again.
						storage.refuseNewIds = movesAgain;
						const hold = { at, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
						storage.hold = hold;
						const publishing = (
							writer === "atomic" ? manager.rewriteEntries() : manager.recoverPersistenceFromCurrentState()
						).catch(() => {});
						await hold.reached.promise;
						found.push(...violations(manager, notices, storage, false, "while held", verified));
						storage.refuseNewIds = false;
						manager.appendCustomEntry("concurrent", {});
						await nextEventLoopTurn();
						found.push(...violations(manager, notices, storage, false, "after the concurrent write", verified));
						hold.go.resolve();
						await publishing;
						await nextEventLoopTurn();
						found.push(
							...violations(manager, notices, storage, false, "after the held publish settled", verified),
						);
						manager.seal();
						found.push(...violations(manager, notices, storage, true, "after seal", verified));
					} finally {
						manager.seal();
						await manager.close().catch(() => {});
					}
					expect(notices.length).toBeGreaterThan(0);
					expect(found).toEqual([]);
				}, 60_000);
			}
		}
	}
});
