import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
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
 * write that returned, or (asynchronous writes, which read back or wait for
 * the store's confirmation) one whose body landed; `undefined` while that
 * can still happen — a publish to its file is still on its way, or the move
 * is the latest and this manager can still write it (it is not sealed, or
 * the close after the seal has not finished); `false` otherwise. A sealed
 * manager keeps a move open for a bounded time only; past the bound it is
 * `false`, "not confirmed before the bound".
 */

/** How the next full publish goes. */
type Outcome = "ok" | "fail" | "partial" | "landed-error";
/** Which writer publishes the transcript. */
type Writer = "sync" | "atomic" | "repair";
/** Where the manager is: still writing, sealed with the close after the seal still to come, or closed after it. */
type Phase = "writing" | "sealed" | "closed";

/** What a test's storage knows of the files the session moved to. */
interface GroundTruth {
	/** Whether a full transcript of `sessionId` reached `file` in a way this manager could know. */
	confirmed(file: string, sessionId: string): boolean;
	/** Whether a publish to `file` is still on its way. */
	publishing(file: string): boolean;
	/** The session id in the header of what `file` holds now, if anything. */
	headerAt(file: string): string | undefined;
}

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
class ScriptedStorage extends FileSessionStorage implements GroundTruth {
	outcome: Outcome = "ok";
	/** Whether an id first claimed from now on is refused, so a write under it moves the session again. */
	refuseNewIds = true;
	readonly #refused = new Map<string, boolean>();
	/** `file` → session ids whose full transcript this manager could know reached it. */
	readonly #confirmed = new Map<string, Set<string>>();
	/** Files an asynchronous publish is still on its way to. */
	readonly #inFlight = new Set<string>();
	hold?: { at: "before" | "after"; reached: PromiseWithResolvers<void>; go: PromiseWithResolvers<void> };

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		// The first id asked for is the owner's: always refused, so the first write moves.
		if (!this.#refused.has(sessionId)) this.#refused.set(sessionId, this.#refused.size === 0 || this.refuseNewIds);
		return this.#refused.get(sessionId) ? null : super.claimSession(sessionId, sessionPath);
	}

	confirmed(file: string, sessionId: string): boolean {
		return this.#confirmed.get(path.resolve(file))?.has(sessionId) ?? false;
	}

	publishing(file: string): boolean {
		return this.#inFlight.has(path.resolve(file));
	}

	headerAt(file: string): string | undefined {
		return fs.existsSync(file) ? headerId(fs.readFileSync(file, "utf8")) : undefined;
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
		this.#inFlight.add(path.resolve(file));
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
			this.#inFlight.delete(path.resolve(file));
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

/** What the invariant says `moveWritten(notice)` is now. */
function expectedOutcome(
	notice: SessionPersistenceNotice,
	latest: SessionPersistenceNotice | undefined,
	truth: GroundTruth,
	phase: Phase,
): boolean | undefined {
	if (truth.confirmed(notice.to, notice.sessionId)) return true;
	if (truth.publishing(notice.to)) return undefined;
	if (notice === latest && phase !== "closed") return undefined;
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
	truth: GroundTruth,
	phase: Phase,
	when: string,
	verified: Set<SessionPersistenceNotice>,
): string[] {
	const found: string[] = [];
	notices.forEach((notice, index) => {
		const expected = expectedOutcome(notice, notices.at(-1), truth, phase);
		const actual = manager.moveWritten(notice);
		if (actual !== expected) found.push(`${when}: move ${index + 1} reported ${actual}, expected ${expected}`);
		if (actual === true && !verified.has(notice)) {
			verified.add(notice);
			const onDisk = truth.headerAt(notice.to);
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

/**
 * Runs `steps` on a fresh manager over a copy of `source`, checking the
 * invariant after each step, after sealing, and after the close that follows.
 */
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
			found.push(...violations(manager, notices, storage, "writing", `after step ${index + 1}`, verified));
		}
		manager.seal();
		found.push(...violations(manager, notices, storage, "sealed", "after seal", verified));
		await manager.close().catch(() => {});
		found.push(...violations(manager, notices, storage, "closed", "after close", verified));
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
	return found.map(line => `${label(steps)}: ${line}`);
}

/**
 * Captures, without starting them, the timers `run` arms — the bound a seal
 * arms over the moves it leaves open — so a test fires them when it says.
 */
function timersArmedDuring(run: () => void): (() => void)[] {
	const armed: (() => void)[] = [];
	const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		_ms?: number,
		...args: unknown[]
	) => {
		armed.push(() => callback(...args));
		const token = { unref: () => token, ref: () => token, hasRef: () => false };
		return token;
	}) as unknown as typeof setTimeout);
	try {
		run();
	} finally {
		spy.mockRestore();
	}
	return armed;
}

const allWriters = ["sync", "atomic", "repair"] as const;
const allOutcomes = ["ok", "fail", "partial", "landed-error"] as const;

describe("which moves count as written", () => {
	// A test that times out never reaches its own restore: restore every spy here.
	afterEach(() => {
		mock.restore();
	});

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
						found.push(...violations(manager, notices, storage, "writing", "while held", verified));
						storage.refuseNewIds = false;
						manager.appendCustomEntry("concurrent", {});
						await nextEventLoopTurn();
						found.push(
							...violations(manager, notices, storage, "writing", "after the concurrent write", verified),
						);
						hold.go.resolve();
						await publishing;
						await nextEventLoopTurn();
						found.push(
							...violations(manager, notices, storage, "writing", "after the held publish settled", verified),
						);
						manager.seal();
						found.push(...violations(manager, notices, storage, "sealed", "after seal", verified));
						await manager.close().catch(() => {});
						found.push(...violations(manager, notices, storage, "closed", "after close", verified));
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

	// The manager is sealed while an asynchronous publish to the moved file is
	// on its way: before its bytes land, or after they land with its readback
	// still to come. Settling, it records what it did; the close after the seal
	// ends what is still open. Never settling, the seal's bound ends the wait:
	// the move is then `false`, "not confirmed before the bound", and a publish
	// that lands after the bound is not recorded.
	for (const writer of ["atomic", "repair"] as const) {
		for (const at of ["before", "after"] as const) {
			for (const settles of [true, false]) {
				it(`a ${writer} publish held ${at} its bytes land when the manager is sealed, ${settles ? "then settling" : "never settling before the bound"}`, async () => {
					using tempDir = TempDir.createSync("@omp-move-outcomes-");
					const source = await ownedFile(tempDir.path());
					const file = path.join(tempDir.path(), "case", path.basename(source.file));
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.copyFileSync(source.file, file);
					const storage = new ScriptedStorage();
					storage.refuseNewIds = false;
					const manager = await SessionManager.open(file, path.dirname(file), storage, {
						suppressBreadcrumb: true,
					});
					const notices: SessionPersistenceNotice[] = [];
					manager.onPersistenceNotice(notice => notices.push(notice));
					const found: string[] = [];
					const verified = new Set<SessionPersistenceNotice>();
					const hold = { at, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
					storage.hold = hold;
					const publishing = (
						writer === "atomic" ? manager.rewriteEntries() : manager.recoverPersistenceFromCurrentState()
					).catch(() => {});
					try {
						await hold.reached.promise;
						expect(notices).toHaveLength(1);
						const bounds = timersArmedDuring(() => manager.seal());
						found.push(...violations(manager, notices, storage, "sealed", "at the seal", verified));
						if (settles) {
							hold.go.resolve();
							await publishing;
							await nextEventLoopTurn();
							found.push(
								...violations(manager, notices, storage, "sealed", "after the publish settled", verified),
							);
							await manager.close().catch(() => {});
							found.push(...violations(manager, notices, storage, "closed", "after close", verified));
						} else {
							// The seal leaves the move open, and bounds how long.
							expect(bounds).toHaveLength(1);
							for (const fire of bounds) fire();
							expect(notices.map(notice => manager.moveWritten(notice))).toEqual([false]);
							hold.go.resolve();
							await publishing;
							await nextEventLoopTurn();
							expect(notices.map(notice => manager.moveWritten(notice))).toEqual([false]);
						}
					} finally {
						hold.go.resolve();
						await publishing;
						await manager.close().catch(() => {});
					}
					expect(found).toEqual([]);
				}, 60_000);
			}
		}
	}
});

/**
 * An indexed backend that, while `holding`, holds every full write until the
 * test lands or fails it, so each deferred publish is confirmed (or not) when
 * the test says.
 */
class DeferredBackend implements SessionStorageBackend, GroundTruth {
	readonly files = new Map<string, string>();
	readonly #held = new Map<string, PromiseWithResolvers<boolean>>();
	holding = false;

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [...this.files].map(([file, content]) => ({ path: file, size: Buffer.byteLength(content), mtimeMs: 1 }));
	}

	async readFull(file: string): Promise<string | null> {
		return this.files.get(file) ?? null;
	}

	async readSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(file) ?? "");
		const suffix = suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString() : "";
		return [bytes.subarray(0, prefixBytes).toString(), suffix];
	}

	async writeFull(
		file: string,
		content: string,
		_mtimeMs: number,
		_title?: unknown,
		expectedSize?: number | null,
	): Promise<void> {
		if (this.holding) {
			const gate = Promise.withResolvers<boolean>();
			this.#held.set(file, gate);
			const lands = await gate.promise;
			this.#held.delete(file);
			if (!lands) throw new Error("injected deferred publish failure");
		}
		const current = this.files.get(file);
		const actual = current === undefined ? null : Buffer.byteLength(current);
		if (expectedSize !== undefined && expectedSize !== actual) {
			throw new SessionWriteConflictError(file, expectedSize, actual);
		}
		this.files.set(file, content);
	}

	async append(file: string, line: string): Promise<void> {
		this.files.set(file, (this.files.get(file) ?? "") + line);
	}

	async updateSessionTitle(): Promise<void> {}

	async truncate(file: string): Promise<void> {
		this.files.set(file, "");
	}

	async remove(files: string[]): Promise<void> {
		for (const file of files) this.files.delete(file);
	}

	async move(src: string, dst: string): Promise<void> {
		const content = this.files.get(src);
		if (content !== undefined) this.files.set(dst, content);
		this.files.delete(src);
	}

	/** Lands (or fails) the held write to `file`. */
	settle(file: string, lands: boolean): void {
		const gate = this.#held.get(file);
		if (!gate) throw new Error(`no write held for ${file}`);
		gate.resolve(lands);
	}

	get heldCount(): number {
		return this.#held.size;
	}

	confirmed(file: string, sessionId: string): boolean {
		return this.headerAt(file) === sessionId;
	}

	publishing(file: string): boolean {
		return this.#held.has(file);
	}

	headerAt(file: string): string | undefined {
		const content = this.files.get(file);
		return content === undefined ? undefined : headerId(content);
	}
}

/** Indexed storage that refuses the first two ids it is asked to claim: the owner's, then the first move's. */
class IndexedRefusingTwoIds extends IndexedSessionStorage {
	readonly #refused = new Set<string>();

	claimSession(sessionId: string): (() => void) | null {
		if (this.#refused.size < 2) this.#refused.add(sessionId);
		return this.#refused.has(sessionId) ? null : () => {};
	}
}

describe("which moves count as written on a store that confirms publishes later", () => {
	// Two moves, each with its full transcript queued on the store before
	// either is confirmed; the store confirms (or rejects) them in either
	// order. A confirmation records the move to its own file, whatever was
	// queued since — the next move's publish included.
	for (const order of ["first move's first", "second move's first"] as const) {
		for (const firstLands of [true, false]) {
			for (const secondLands of [true, false]) {
				it(`two deferred publishes, the ${order}: first ${firstLands ? "lands" : "fails"}, second ${secondLands ? "lands" : "fails"}`, async () => {
					using tempDir = TempDir.createSync("@omp-move-outcomes-");
					const source = await ownedFile(tempDir.path());
					const backend = new DeferredBackend();
					backend.files.set(source.file, fs.readFileSync(source.file, "utf8"));
					const storage = new IndexedRefusingTwoIds(backend);
					await storage.initialize();
					const manager = await SessionManager.open(source.file, source.dir, storage, {
						suppressBreadcrumb: true,
					});
					const notices: SessionPersistenceNotice[] = [];
					manager.onPersistenceNotice(notice => notices.push(notice));
					const found: string[] = [];
					const verified = new Set<SessionPersistenceNotice>();
					backend.holding = true;
					try {
						manager.appendCustomEntry("first", {});
						await nextEventLoopTurn();
						manager.appendCustomEntry("second", { larger: "the second transcript" });
						await nextEventLoopTurn();
						expect(notices).toHaveLength(2);
						expect(backend.heldCount).toBe(2);
						found.push(...violations(manager, notices, backend, "writing", "with both queued", verified));
						backend.holding = false;
						const [first, second] = notices;
						const settles =
							order === "first move's first"
								? [
										[first, firstLands],
										[second, secondLands],
									]
								: [
										[second, secondLands],
										[first, firstLands],
									];
						for (const [index, [notice, lands]] of (settles as [SessionPersistenceNotice, boolean][]).entries()) {
							backend.settle(notice.to, lands);
							await nextEventLoopTurn();
							await nextEventLoopTurn();
							found.push(
								...violations(
									manager,
									notices,
									backend,
									"writing",
									`after confirmation ${index + 1}`,
									verified,
								),
							);
						}
						await storage.drain().catch(() => {});
						await nextEventLoopTurn();
						found.push(...violations(manager, notices, backend, "writing", "after the store drained", verified));
						// The session's next write goes to the second move's file, under
						// an id it may claim: it stays there, whichever publish failed.
						manager.appendCustomEntry("after both settled", {});
						await nextEventLoopTurn();
						await storage.drain().catch(() => {});
						await nextEventLoopTurn();
						if (notices.length !== 2)
							found.push(`a later write moved the session again: ${notices.length} moves`);
						found.push(...violations(manager, notices, backend, "writing", "after a later write", verified));
						manager.seal();
						found.push(...violations(manager, notices, backend, "sealed", "after seal", verified));
						await manager.close().catch(() => {});
						found.push(...violations(manager, notices, backend, "closed", "after close", verified));
					} finally {
						backend.holding = false;
						for (const notice of notices) if (backend.publishing(notice.to)) backend.settle(notice.to, false);
						manager.seal();
						await manager.close().catch(() => {});
					}
					expect(found).toEqual([]);
				}, 60_000);
			}
		}
	}
});
