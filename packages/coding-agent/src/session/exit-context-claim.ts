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
 * - A word goes on the board before the copy it came from is deleted, and a
 *   copy is deleted only by the pass that just read its bytes. A reader that
 *   dies therefore leaves either the word recorded or a copy holding it.
 * - A pass finds copies by listing the directory, not by a note in shared
 *   memory. A copy whose maker died before it could record anything is still
 *   found, as is one left by an earlier process that had this pid.
 * - Words are merged by the mtime the sender's write left on the file, so no
 *   reader has to decide whether another is dead, nothing is taken over, and
 *   the word the process ends with does not depend on how threads were
 *   scheduled.
 *
 * The protocol is written as a sequence of effects instead of direct calls:
 * `./exit-context-worker` runs it against the real filesystem and the real
 * board, and `test/session/exit-context-claim.test.ts` runs several passes
 * against a model of both, stepping them one effect at a time and killing or
 * stalling each at every boundary, which is how every interleaving is covered.
 */
import * as path from "node:path";
import { EXIT_INTENT_MAX_CHARS, type ExitContextWord } from "./exit-context-protocol";

/** What a reader learns from a file it reads: its first bytes and when its sender wrote it. */
export interface ExitContextFile {
	text: string;
	mtimeMs: number;
}

/** One step of a claim: all the work the protocol asks of the filesystem and the board. */
export type ExitContextClaimEffect =
	/** The word the process has recorded for `intentPath`. */
	| { kind: "recorded"; intentPath: string }
	/** Rename `intentPath` to `claimedPath`, taking exactly the file that is there. */
	| { kind: "take"; intentPath: string; claimedPath: string }
	/** The claimed copies of this pid that are in the intent directory. */
	| { kind: "list" }
	/** The first bytes of a claimed copy. */
	| { kind: "read"; claimedPath: string }
	/** Record `word` for `intentPath` unless a later word is already recorded. */
	| { kind: "record"; intentPath: string; word: ExitContextWord }
	/** Delete a claimed copy this pass has read. */
	| { kind: "remove"; claimedPath: string };

/** What a step answers; a step that could not run answers as if it found nothing. */
export type ExitContextClaimOutcome =
	| { kind: "recorded"; word: ExitContextWord | undefined }
	| { kind: "take"; taken: boolean }
	| { kind: "list"; claimedPaths: string[] }
	| { kind: "read"; file: ExitContextFile | undefined }
	| { kind: "record"; word: ExitContextWord | undefined }
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

/** The word in `file`, or `undefined` when it is blank or was left for an earlier process with this pid. */
function publishedWord(file: ExitContextFile, processStartMs: number): ExitContextWord | undefined {
	if (file.mtimeMs < processStartMs) return undefined;
	const word = file.text.trim().slice(0, EXIT_INTENT_MAX_CHARS);
	return word ? { word, mtimeMs: file.mtimeMs } : undefined;
}

function* recordedWord(intentPath: string): ClaimStep<ExitContextWord | undefined> {
	const outcome = yield { kind: "recorded", intentPath };
	return outcome.kind === "recorded" ? outcome.word : undefined;
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

function* recordWord(intentPath: string, word: ExitContextWord): ClaimStep<ExitContextWord | undefined> {
	const outcome = yield { kind: "record", intentPath, word };
	return outcome.kind === "record" ? outcome.word : undefined;
}

function* removeClaimedCopy(claimedPath: string): ClaimStep<void> {
	yield { kind: "remove", claimedPath };
}

/**
 * One pass of the claim protocol: the word this exit records, or `undefined`
 * when no sender left one. A pass answers with the board's word; only when the
 * board stayed locked does it answer with what it read, for its own thread.
 */
export function* claimExitIntent(input: ExitContextClaimInput): ExitContextClaim {
	const { intentPath, claimedPath, processStartMs } = input;
	// A word the process has already recorded is its word. The intent file is
	// left alone then, so a word published after it keeps for the next process
	// instead of being consumed by an exit that will never report it.
	let known = yield* recordedWord(intentPath);
	const copies = new Set<string>();
	if (known === undefined && (yield* takeIntentFile(intentPath, claimedPath))) copies.add(claimedPath);
	// Every copy of this pid: this pass's, one a reader that died mid-pass left,
	// one an earlier process with this pid left.
	for (const copy of yield* listClaimedCopies()) copies.add(copy);
	let newest: ExitContextWord | undefined;
	const read: string[] = [];
	for (const copy of copies) {
		const file = yield* readClaimedCopy(copy);
		// Gone (another thread's pass cleared it) or unreadable: not this pass's to delete.
		if (!file) continue;
		read.push(copy);
		const word = publishedWord(file, processStartMs);
		if (word && (!newest || word.mtimeMs > newest.mtimeMs)) newest = word;
	}
	// The word is recorded before any copy goes, so a death here loses nothing.
	if (newest) known = (yield* recordWord(intentPath, newest)) ?? newest;
	// Each copy read is now recorded, superseded by a word its sender published
	// later, or older than this process.
	for (const copy of read) yield* removeClaimedCopy(copy);
	return ((yield* recordedWord(intentPath)) ?? known)?.word;
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
