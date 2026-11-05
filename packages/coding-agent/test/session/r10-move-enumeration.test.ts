/**
 * R10 Anthropic arm, finding F1 (NOT repo code yet — drop into
 * `packages/coding-agent/test/session/` to run it).
 *
 * `moveTranscriptTree` promises file storage "never throws once moving has
 * begun", because the caller's rollback can only put the session file back,
 * not the artifacts the directory merge already moved. The per-entry guard
 * keeps that promise for the rename; the enumeration that feeds the loop sits
 * outside it, so a subdirectory of the session's artifacts tree that cannot be
 * read throws out of the move and leaves the session file at its old path with
 * its subagent transcripts under the destination.
 *
 * Fails at b8ed4a159da6; the same project move completes at the merge base
 * 7ceb801092, where `mergeDirectoryInto` strands the unreadable subdirectory.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { copyTranscriptTree, moveTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | undefined;
let restore: string | undefined;

afterEach(() => {
	if (restore) fs.chmodSync(restore, 0o755);
	restore = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

test("a subagent directory that cannot be read strands, it does not fail the move", async () => {
	tempDir = TempDir.createSync("@omp-r10-move-");
	const from = tempDir.join("from");
	const to = tempDir.join("to");
	fs.mkdirSync(path.join(from, "Sub"), { recursive: true });
	fs.mkdirSync(to, { recursive: true });
	fs.writeFileSync(path.join(from, "A.jsonl"), "{}\n");
	fs.writeFileSync(path.join(from, "Sub", "Nested.jsonl"), "{}\n");
	restore = path.join(from, "Sub");
	fs.chmodSync(restore, 0o000);

	const moved = await moveTranscriptTree(new FileSessionStorage(), from, to);

	// The readable transcript moves; the unreadable subtree stays where it is.
	expect(moved.map(placement => path.basename(placement.from))).toEqual(["A.jsonl"]);
	expect(fs.existsSync(path.join(to, "A.jsonl"))).toBe(true);
	expect(fs.existsSync(path.join(from, "Sub"))).toBe(true);
});

/**
 * The other two round-10 findings are one mechanism: both operations asked
 * `exists` and then wrote, so a destination published in the gap was
 * destroyed. The gap is closed by refusing at the write itself, which is what
 * these two assert — a destination that is already taken survives with its
 * own bytes. A scheduled race proves the window; this proves the primitive
 * that makes the window unwinnable, and it cannot go stale the way a timing
 * test can.
 */
test("a move never replaces a transcript already at the destination", async () => {
	tempDir = TempDir.createSync("@omp-r10-move-keep-");
	const from = tempDir.join("from");
	const to = tempDir.join("to");
	fs.mkdirSync(from, { recursive: true });
	fs.mkdirSync(to, { recursive: true });
	fs.writeFileSync(path.join(from, "A.jsonl"), '{"who":"source"}\n');
	fs.writeFileSync(path.join(to, "A.jsonl"), '{"who":"keeper"}\n');

	const moved = await moveTranscriptTree(new FileSessionStorage(), from, to);

	expect(moved).toEqual([]);
	expect(fs.readFileSync(path.join(to, "A.jsonl"), "utf8")).toBe('{"who":"keeper"}\n');
	// Stranded, not lost: the source copy is still readable where it was.
	expect(fs.readFileSync(path.join(from, "A.jsonl"), "utf8")).toBe('{"who":"source"}\n');
});

test("a copy never replaces a transcript already at the destination", async () => {
	tempDir = TempDir.createSync("@omp-r10-copy-keep-");
	const from = tempDir.join("from");
	const to = tempDir.join("to");
	fs.mkdirSync(from, { recursive: true });
	fs.mkdirSync(to, { recursive: true });
	fs.writeFileSync(path.join(from, "A.jsonl"), '{"who":"source"}\n');
	fs.writeFileSync(path.join(to, "A.jsonl"), '{"who":"keeper"}\n');
	fs.writeFileSync(path.join(from, "B.jsonl"), '{"who":"fresh"}\n');

	const copied = await copyTranscriptTree(new FileSessionStorage(), from, to);

	// The free name is copied; the taken one keeps the bytes it had.
	expect(copied.map(placement => path.basename(placement.to))).toEqual(["B.jsonl"]);
	expect(fs.readFileSync(path.join(to, "A.jsonl"), "utf8")).toBe('{"who":"keeper"}\n');
	expect(fs.readFileSync(path.join(to, "B.jsonl"), "utf8")).toBe('{"who":"fresh"}\n');
});
