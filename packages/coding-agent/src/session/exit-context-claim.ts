/**
 * How a reader thread takes the word a sender left at `<intentDir>/<pid>`,
 * records it for every thread of the process, and clears what it read.
 *
 * Several readers (one per thread that runs sessions), a sender publishing a
 * new word, and a reader dying or stalling anywhere can all happen at once, so
 * the protocol keeps to four rules:
 *
 * - The only thing a reader ever does to the intent file is rename it, once per
 *   pass, to a copy named `.<pid>.claimed-<unique>` that no other pass can name.
 *   It never writes, renames over, or deletes the intent file, so a word a
 *   sender publishes during a pass is always left for a later read.
 * - A copy is deleted only by the pass that just read its bytes, and only once
 *   that pass has seen the board hold the copy's word or a later one — seen it
 *   in its own successful publication or in a read of its own. Nothing is ever
 *   deleted on a publication that failed, so a reader that dies leaves either
 *   the word recorded or a copy holding it.
 * - A pass finds copies by listing the directory, not by a note in shared
 *   memory. A copy whose maker died before it could record anything is still
 *   found, as is one left by an earlier process that had this pid.
 * - Words are merged by the modification time the sender's write left on the
 *   file, so no reader has to decide whether another is dead, nothing is taken
 *   over, and the word the process ends with does not depend on how threads
 *   were scheduled. That time is the sender's write to its staged file, not
 *   its rename of that file into place, so two senders for one pid whose
 *   writes overlap are ranked by which wrote last and not by which published
 *   last (`ExitContextWord`).
 *
 * Nothing here waits for another thread. The board is lock-free
 * (`./exit-context-protocol`), so its two steps — a load of its head and a
 * compare-exchange that publishes one record — are each a single atomic
 * instruction that either happened or did not. A thread terminated between any
 * two instructions leaves nothing held and nothing half done.
 *
 * The protocol is written as a sequence of effects instead of direct calls:
 * `./exit-context-worker` runs it against the real filesystem and the real
 * board, and `test/session/exit-context-claim.test.ts` runs several passes
 * against a model of both, stepping them one effect at a time and killing or
 * stalling each at every boundary, which is how every interleaving is covered.
 */
import * as path from "node:path";
import {
	EXIT_INTENT_MAX_CHARS,
	type ExitContextBoardEntry,
	type ExitContextPublishResult,
	type ExitContextWord,
} from "./exit-context-protocol";

/** What a reader learns from a file it reads: its first bytes and the modification time its sender's write left on it. */
export interface ExitContextFile {
	text: string;
	mtimeMs: number;
}

/**
 * One step of a claim: all the work the protocol asks of the filesystem and
 * the board. The two board steps are each one atomic instruction of
 * `./exit-context-protocol`, so a death between any two steps here is a death
 * the real reader thread can take.
 */
export type ExitContextClaimEffect =
	/** One `Atomics.load` of the board's head: what it holds for `intentPath`, and the publication that read saw. */
	| { kind: "board-read"; intentPath: string }
	/** One `Atomics.compareExchange`: make `word` the board's word for `intentPath`, replacing `expected`. */
	| { kind: "board-publish"; intentPath: string; expected: ExitContextBoardEntry; word: ExitContextWord }
	/** Rename `intentPath` to `claimedPath`, taking exactly the file that is there. */
	| { kind: "take"; intentPath: string; claimedPath: string }
	/** The claimed copies of this pid that are in the intent directory. */
	| { kind: "list" }
	/** The first bytes of a claimed copy. */
	| { kind: "read"; claimedPath: string }
	/** Delete a claimed copy this pass has read and seen recorded. */
	| { kind: "remove"; claimedPath: string };

/** What a step answers; a step that could not run answers as if it found nothing. */
export type ExitContextClaimOutcome =
	| { kind: "board-read"; entry: ExitContextBoardEntry }
	| { kind: "board-publish"; result: ExitContextPublishResult }
	| { kind: "take"; taken: boolean }
	| { kind: "list"; claimedPaths: string[] }
	| { kind: "read"; file: ExitContextFile | undefined }
	| { kind: "remove" };

/** A claim in progress: each `next` runs one step and hands back what it found. */
export type ExitContextClaim = Generator<ExitContextClaimEffect, string | undefined, ExitContextClaimOutcome>;

type ClaimStep<T> = Generator<ExitContextClaimEffect, T, ExitContextClaimOutcome>;

/** What one pass of the protocol needs to know. */
export interface ExitContextClaimInput {
	/** `<intentDir>/<pid>`, where the sender publishes. */
	intentPath: string;
	/** The copy this pass may rename the intent file to; no other pass can name it. */
	claimedPath: string;
	/** Epoch ms the process started: an older file was left for an earlier process with this pid. */
	processStartMs: number;
}

/** Start of the name of every copy of `pid`'s intent file; a reader deletes nothing else. */
export function claimedCopyPrefix(pid: number): string {
	return `.${pid}.claimed-`;
}

/** A name for one pass's copy that no other pass, thread or process can produce. */
export function claimedCopyPath(intentDir: string, pid: number): string {
	return path.join(intentDir, `${claimedCopyPrefix(pid)}${crypto.randomUUID()}`);
}

/**
 * The word in `file`, or `undefined` when it is blank or was left for an
 * earlier process with this pid. The test is the sender's write time, so a
 * word whose bytes were written before this process started and renamed into
 * place after is dropped too — a sender can only do that by addressing a pid
 * that did not yet exist when it began writing.
 */
function publishedWord(file: ExitContextFile, processStartMs: number): ExitContextWord | undefined {
	if (file.mtimeMs < processStartMs) return undefined;
	const word = file.text.trim().slice(0, EXIT_INTENT_MAX_CHARS);
	return word ? { word, mtimeMs: file.mtimeMs } : undefined;
}

/** The board's word for `intentPath` and the publication this read saw: one atomic load. */
function* boardRead(intentPath: string): ClaimStep<ExitContextBoardEntry> {
	const outcome = yield { kind: "board-read", intentPath };
	return outcome.kind === "board-read" ? outcome.entry : { word: undefined, version: 0 };
}

/** One attempt to publish `word` over exactly the state `expected` was read from. */
function* boardPublish(
	intentPath: string,
	expected: ExitContextBoardEntry,
	word: ExitContextWord,
): ClaimStep<ExitContextPublishResult> {
	const outcome = yield { kind: "board-publish", intentPath, expected, word };
	return outcome.kind === "board-publish" ? outcome.result : "full";
}

/**
 * Record `word`, and answer with the word the board holds for `intentPath` —
 * `word` itself when this pass published it, or the word a read of this pass
 * found standing and no older. `undefined` when the board had no room: nothing
 * was recorded, and the caller must delete nothing on the strength of it.
 *
 * Each turn of the loop is a read and at most one compare-exchange. A lost
 * exchange means another thread published in between, so this pass reads again
 * and decides against what it finds; since every publication moves the word
 * strictly forward and each pass publishes at most once, the loop ends.
 */
function* recordWord(intentPath: string, word: ExitContextWord): ClaimStep<ExitContextWord | undefined> {
	for (;;) {
		const entry = yield* boardRead(intentPath);
		if (entry.word && entry.word.mtimeMs >= word.mtimeMs) return entry.word;
		const result = yield* boardPublish(intentPath, entry, word);
		if (result === "published") return word;
		if (result === "full") return undefined;
	}
}

function* takeIntentFile(intentPath: string, claimedPath: string): ClaimStep<boolean> {
	const outcome = yield { kind: "take", intentPath, claimedPath };
	return outcome.kind === "take" && outcome.taken;
}

function* listClaimedCopies(): ClaimStep<string[]> {
	const outcome = yield { kind: "list" };
	return outcome.kind === "list" ? outcome.claimedPaths : [];
}

function* readClaimedCopy(claimedPath: string): ClaimStep<ExitContextFile | undefined> {
	const outcome = yield { kind: "read", claimedPath };
	return outcome.kind === "read" ? outcome.file : undefined;
}

function* removeClaimedCopy(claimedPath: string): ClaimStep<void> {
	yield { kind: "remove", claimedPath };
}

/**
 * One pass of the claim protocol: the word this exit records, or `undefined`
 * when no sender left one. A pass answers with the board's word; only when the
 * board had no room for it does it answer with what it read, for its own thread.
 */
export function* claimExitIntent(input: ExitContextClaimInput): ExitContextClaim {
	const { intentPath, claimedPath, processStartMs } = input;
	// A word the process has already recorded is its word. The intent file is
	// left alone then, so a word published after it keeps for the next process
	// instead of being consumed by an exit that will never report it.
	const known = (yield* boardRead(intentPath)).word;
	const copies = new Set<string>();
	if (known === undefined && (yield* takeIntentFile(intentPath, claimedPath))) copies.add(claimedPath);
	// Every copy of this pid: this pass's, one a reader that died mid-pass left,
	// one an earlier process with this pid left.
	for (const copy of yield* listClaimedCopies()) copies.add(copy);
	let newest: ExitContextWord | undefined;
	const read: { copy: string; word: ExitContextWord | undefined }[] = [];
	for (const copy of copies) {
		const file = yield* readClaimedCopy(copy);
		// Gone (another thread's pass cleared it) or unreadable: not this pass's to delete.
		if (!file) continue;
		const word = publishedWord(file, processStartMs);
		read.push({ copy, word });
		if (word && (!newest || word.mtimeMs > newest.mtimeMs)) newest = word;
	}
	// The newest word is recorded before any copy goes, so a death here loses
	// nothing; `standing` is what this pass saw the board hold afterwards, and
	// is `undefined` when it could not get the word on there at all.
	const standing = newest ? yield* recordWord(intentPath, newest) : known;
	for (const { copy, word } of read) {
		// A copy goes only once this pass has seen its word on the board, seen a
		// word written no earlier there, or found it was never this process's.
		if (word && !(standing && standing.mtimeMs >= word.mtimeMs)) continue;
		yield* removeClaimedCopy(copy);
	}
	const recorded = (yield* boardRead(intentPath)).word;
	// The board's word, unless this pass read a later one it could not record.
	return (newest && !(recorded && recorded.mtimeMs >= newest.mtimeMs) ? newest : recorded)?.word;
}

/** Run a claim to its end, performing each of its steps with `perform`. */
export function runExitIntentClaim(
	input: ExitContextClaimInput,
	perform: (effect: ExitContextClaimEffect) => ExitContextClaimOutcome,
): string | undefined {
	const claim = claimExitIntent(input);
	let step = claim.next();
	while (!step.done) step = claim.next(perform(step.value));
	return step.value;
}
