/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured {@link Filesystem}, strips BOM and normalizes line endings,
 * validates the section snapshot tag (with {@link Recovery}), applies the
 * result back through the same {@link Filesystem}.
 *
 * Two layers:
 *
 * - {@link Patcher.apply} — high-level, all-or-nothing. Preflights every
 *   section in memory before any write hits disk, then commits in order.
 * - {@link Patcher.prepare} / {@link Patcher.commit} — granular primitives
 *   for callers that need per-section control (e.g. batched LSP flush,
 *   custom interleaving). `prepare` performs all the read-side work,
 *   validates the section snapshot tag (with recovery), and applies the
 *   edits in memory. `commit` writes the prepared result and records a
 *   fresh snapshot.
 *
 * Because `prepare` already runs the full apply, a multi-section batch is
 * naturally all-or-nothing: by the time any `commit` runs, every section
 * has been validated.
 *
 * The patcher itself is stateless across calls; reuse one instance per
 * filesystem configuration.
 */
import * as path from "node:path";
import { applyEdits } from "./apply";
import { hasBlockEdit, resolveBlockEdits } from "./block";
import { commitClipboard, forkClipboard, startClipboardBatch, validateClipboardSequence } from "./clipboard";
import { computeFileHash, formatHashlineHeader } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import {
	HEADTAIL_DRIFT_WARNING,
	missingSnapshotTagMessage,
	pathRecoveredFromTagMessage,
	type RevealedLine,
	unseenLinesMessage,
	writeDriftWarning,
} from "./messages";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { InvalidAbsoluteRangeError } from "./parser";
import { Recovery, type RecoveryResult } from "./recovery";
import type { Snapshot, SnapshotStore } from "./snapshots";
import type { ApplyResult, BlockResolution, BlockResolver, BlockSpan, Clipboard, Edit, FileOp } from "./types";

/**
 * Upper bound on the number of unseen anchor lines whose actual file content
 * we inline into a rejection error (see {@link Patcher.assertSeenLines}). Big
 * enough to fit the common "edit a whole function body" retry path in one
 * message, small enough to keep the error human-readable when the model
 * over-anchors and to preserve the "re-read first" fallback for genuinely
 * blind wide edits (only the revealed prefix gets merged into `seenLines`).
 */
const SEEN_LINE_REVEAL_CAP = 40;

/**
 * Per-revealed-line character cap. Matches the read/search column cap so a
 * revealed anchor line can never dump a minified megabyte-wide bundle line
 * into the tool error, TUI, and model context. Lines longer than the cap
 * are trimmed to `cap` characters plus an `…` marker AND flag the entire
 * reveal as truncated so no line joins `seenLines` — the model must re-read
 * the range to prove it saw the full width.
 */
const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;

export interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/** Snapshot store that minted and resolves hashline section tags. Required. */
	snapshots: SnapshotStore;
	/**
	 * Resolves `replace_block N:` anchors to concrete line spans via tree-sitter.
	 * Optional: when omitted, any `replace_block N:` edit throws on apply (the
	 * host did not wire a resolver). Plain line-range ops never need it.
	 */
	blockResolver?: BlockResolver;
	/**
	 * Enforce the seen-line guard: reject anchored edits on lines the read/search
	 * that minted the tag never displayed. Defaults to `true`. When `false`, tags
	 * validate on content hash alone and any anchor into the tagged content applies.
	 */
	enforceSeenLines?: boolean;
	/**
	 * Host-owned clipboard register shared across batches, so `CUT` content
	 * can be `PASTE`d by a later {@link Patcher.apply} call. Each batch works
	 * on a fork and publishes it back only after writes land.
	 */
	clipboard?: Clipboard;
}

/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
	/** Section path (as authored, after cwd-resolution at parse time). */
	path: string;
	/** Filesystem-canonical key for this section (e.g. absolute path). */
	canonicalPath: string;
	/** `"noop"` when the apply produced no change; `"delete"` removes the file; otherwise `"create"` / `"update"`. */
	op: "create" | "update" | "delete" | "noop";
	/** Pre-edit text (LF-normalized, BOM-stripped). */
	before: string;
	/** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
	after: string;
	/** Same text as `after` but with the original BOM and line ending restored. */
	persisted: string;
	/** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
	written: string;
	/**
	 * 4-hex content-hash tag. Hashes the content the {@link Filesystem}
	 * reports actually landed on disk (see `written`), which normally equals
	 * `after` but can diverge when the write path transforms content (e.g. an
	 * ACP-bridge write reformatted by the client's format-on-save). Use to
	 * anchor follow-up edits.
	 */
	fileHash: string;
	/** Hashline section header (`[path#tag]`) of the post-edit content. */
	header: string;
	/** 1-indexed first changed line in `after`, or `undefined` for noops. */
	firstChangedLine?: number;
	/** Warnings collected by the parser, applier, and (optionally) recovery. */
	warnings: string[];
	/** Destination path when this section includes `MV DEST`. */
	moveDest?: string;
	/**
	 * Resolved spans for block ops, present when the apply matched the tagged
	 * content. Undefined for patches with no block ops and for drift recovery.
	 */
	blockResolutions?: BlockResolution[];
}

export interface PatcherApplyResult {
	sections: PatchSectionResult[];
}

/**
 * Opaque token returned by {@link Patcher.prepare}. Carries the section, the
 * raw file content read off disk, and the in-memory apply result.
 * {@link Patcher.commit} just writes the {@link PreparedSection.applyResult}.
 */
export class PreparedSection {
	/** @internal */
	constructor(
		readonly section: PatchSection,
		readonly canonicalPath: string,
		readonly exists: boolean,
		readonly rawContent: string,
		readonly bom: string,
		readonly lineEnding: LineEnding,
		readonly normalized: string,
		readonly applyResult: ApplyResult,
		readonly parseWarnings: readonly string[],
		readonly fileOp: FileOp | undefined,
	) {}

	/** Convenience: returns true when the apply produced no change and no file op. */
	get isNoop(): boolean {
		return this.fileOp === undefined && this.applyResult.text === this.normalized;
	}
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete" || edit.kind === "block" || edit.kind === "cut") return true;
		if (edit.kind === "paste") {
			if (edit.at.kind === "span") return true;
			return edit.at.cursor.kind === "before_anchor" || edit.at.cursor.kind === "after_anchor";
		}
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): void {
	if (fileHash !== undefined) return;
	throw new Error(missingSnapshotTagMessage(sectionPath));
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}
function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

function hasUtf8Bom(bytes: Uint8Array | undefined): boolean {
	return bytes !== undefined && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

/**
 * High-level patcher. Wires a {@link Filesystem} and a required
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore;
	readonly recovery: Recovery;
	readonly blockResolver: BlockResolver | undefined;
	readonly clipboard: Clipboard | undefined;
	readonly #enforceSeenLines: boolean;

	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
		this.blockResolver = options.blockResolver;
		this.clipboard = options.clipboard;
		this.#enforceSeenLines = options.enforceSeenLines ?? true;
	}

	/**
	 * Apply every section in `patch`. `prepare` runs the full apply for each
	 * section in memory before any write hits the filesystem, so a
	 * multi-section batch is naturally all-or-nothing. Returns one
	 * {@link PatchSectionResult} per section in the original patch order.
	 */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		// One register per batch: `CUT` in one section feeds `PASTE` in a later
		// one, so content can move across files. A host-owned register
		// (see PatcherOptions.clipboard) additionally persists across batches:
		// work on a fork and publish it per landed section, so a failed batch
		// never poisons the persistent register and a mid-batch failure still
		// preserves content already cut from disk.
		const clipboard = startClipboardBatch(this.clipboard);

		// Single-section fast path.
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0], clipboard);
			const result = await this.commit(prepared);
			if (this.clipboard !== undefined) commitClipboard(clipboard, this.clipboard);
			return { sections: [result] };
		}

		// Prepare every section first so any failure (stale hash, missing
		// file, parse error, in-memory no-op) surfaces before any write.
		const prepared: PreparedSection[] = [];
		// Register state after each section's prepare. Commits are non-atomic:
		// when a later write fails, the sections before it are already on disk,
		// so the host register must reflect exactly the landed prefix — content
		// a landed CUT deleted would otherwise be lost.
		const sectionStates: Clipboard[] = [];
		for (const section of patch.sections) {
			prepared.push(await this.prepare(section, clipboard));
			sectionStates.push(forkClipboard(clipboard));
		}
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}

		const results: PatchSectionResult[] = [];
		for (let index = 0; index < prepared.length; index++) {
			try {
				results.push(await this.commit(prepared[index]));
			} catch (error) {
				// A mid-batch write failure leaves earlier sections on disk with no
				// rollback; report exactly which sections landed so the caller can
				// re-issue only the missing ones instead of double-applying.
				const written = prepared.slice(0, index).map(entry => entry.section.path);
				const notWritten = prepared.slice(index + 1).map(entry => entry.section.path);
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to write ${prepared[index].section.path}: ${message}` +
						(written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
						(notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
					{ cause: error },
				);
			}
			if (this.clipboard !== undefined) commitClipboard(sectionStates[index], this.clipboard);
		}
		return { sections: results };
	}

	/**
	 * Run the preflight pass only: read, parse, validate, apply-in-memory.
	 * No writes hit the filesystem. Use for CI checks and dry runs.
	 */
	async preflight(patch: Patch): Promise<void> {
		// Dry run: fork the register and never publish it back.
		const clipboard = startClipboardBatch(this.clipboard);
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section, clipboard));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}
	}

	async #parseWithRangeDiagnostics(section: PatchSection) {
		try {
			return section.parse();
		} catch (error) {
			if (!(error instanceof InvalidAbsoluteRangeError) || !this.blockResolver) throw error;
			let span: BlockSpan | null = null;
			try {
				const read = await this.#tryRead(section.path);
				if (read.exists) {
					const normalized = normalizeToLF(stripBom(read.rawContent).text);
					span = this.blockResolver({ path: section.path, text: normalized, line: error.startLine });
				}
			} catch {
				// Source-aware enrichment is best-effort; preserve the actionable parser error.
			}
			throw span?.start === error.startLine && span.end > span.start ? error.withBlock(span) : error;
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the snapshot
	 * tag (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * `clipboard` is the register shared by `CUT`/`PASTE` ops. Pass the batch
	 * register when preparing several sections so content can move across files.
	 *
	 * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
	 * tag mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection, clipboard?: Clipboard): Promise<PreparedSection> {
		const parsed = await this.#parseWithRangeDiagnostics(section);
		const parseWarnings = [...parsed.warnings];
		const fileOp = parsed.fileOp;
		assertSectionHashPresent(section.path, section.fileHash);

		let target = section;
		let canonicalPath = this.fs.canonicalPath(target.path);
		let read = await this.#tryRead(target.path);

		// Path recovery: the authored path doesn't exist on disk, but its
		// filename + snapshot tag may name a file the model read this session
		// (it supplied a bare filename, or the wrong directory). Rebind to that
		// file so the edit lands where the tag points, and warn. This runs
		// before the write gate so a recoverable bare/mis-typed path is rebound
		// to its real (writable) location instead of being rejected against the
		// literal — possibly read-only — path it was authored as.
		if (!read.exists) {
			const recovered = this.#recoverSectionPathFromTag(target, canonicalPath);
			if (recovered && this.fs.allowTagPathRecovery(target.path, recovered.section.path)) {
				parseWarnings.push(
					pathRecoveredFromTagMessage(target.path, recovered.section.path, target.fileHash as string),
				);
				target = recovered.section;
				canonicalPath = recovered.canonicalPath;
				read = await this.#tryRead(target.path);
			}
		}

		// Gate the final (possibly recovered) target before any write work, so
		// an unrecoverable read-only target (e.g. a plan-mode working-tree path)
		// fails with the write guard rather than a misleading "file not found".
		await this.fs.preflightWrite(target.path, { fileOp });

		if (!read.exists) {
			throw new Error(`File not found: ${target.path}. Use the write tool to create new files.`);
		}

		if (fileOp?.kind === "move" && this.fs.canonicalPath(fileOp.dest) === canonicalPath) {
			throw new Error(`MV destination is the same as ${target.path}.`);
		}

		const { bom: bomFromText, text } = stripBom(read.rawContent);
		const bom = bomFromText || (await this.#readBinaryBom(target.path));
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const register = clipboard ?? {};
		const applyResult =
			fileOp?.kind === "rem"
				? this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: [],
						clipboard: register,
					})
				: this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: parsed.edits,
						clipboard: register,
					});

		return new PreparedSection(
			target,
			canonicalPath,
			read.exists,
			read.rawContent,
			bom,
			lineEnding,
			normalized,
			applyResult,
			parseWarnings,
			fileOp,
		);
	}

	/**
	 * Resolve a missing authored path to a file read this session by matching
	 * its filename and snapshot tag. Returns the section rebound to that file's
	 * canonical path, or `null` when no unique filename+tag match exists.
	 *
	 * Resolution requires BOTH the bare filename (basename) and the section tag
	 * to match a single retained file: a whole-file content hash plus an exact
	 * filename is a strong identity signal, so the model almost certainly meant
	 * that file but gave the wrong directory (or only the filename). A tie — two
	 * retained files sharing the filename and tag — declines recovery. The
	 * recorded path of the authored file itself is excluded so a deleted file
	 * does not "recover" onto its own stale snapshot.
	 */
	#recoverSectionPathFromTag(
		section: PatchSection,
		originalCanonicalPath: string,
	): { section: PatchSection; canonicalPath: string } | null {
		if (section.fileHash === undefined) return null;
		const authoredName = path.basename(section.path);
		const candidates = [
			...new Set(
				this.snapshots
					.findByHash(section.fileHash)
					.filter(snapshot => path.basename(snapshot.path) === authoredName)
					.map(snapshot => snapshot.path),
			),
		].filter(candidate => this.fs.canonicalPath(candidate) !== originalCanonicalPath);
		if (candidates.length !== 1) return null;
		const resolved = candidates[0];
		return { section: section.withPath(resolved), canonicalPath: this.fs.canonicalPath(resolved) };
	}

	/**
	 * Commit a previously {@link prepare}d section to the filesystem.
	 * Restores line endings and BOM, writes via the {@link Filesystem}, and
	 * records a fresh snapshot in the {@link SnapshotStore} keyed by the
	 * filesystem-canonical path.
	 */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath, fileOp } =
			prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);
		const moveDest = fileOp?.kind === "move" ? fileOp.dest : undefined;
		const resultPath = moveDest ?? section.path;

		if (fileOp?.kind === "rem") {
			await this.fs.delete(section.path);
			this.snapshots.invalidate(canonicalPath);
			return {
				path: section.path,
				canonicalPath,
				op: "delete",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: computeFileHash(normalized),
				header: formatHashlineHeader(section.path, computeFileHash(normalized)),
				warnings,
			};
		}

		if (after === normalized && moveDest === undefined) {
			const hash = this.#recordFullSnapshot(canonicalPath, normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "noop",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: hash,
				header: formatHashlineHeader(section.path, hash),
				warnings,
			};
		}

		const persisted = bom + restoreLineEndings(after, lineEnding);

		if (moveDest !== undefined) {
			const destCanonical = this.fs.canonicalPath(moveDest);
			this.snapshots.relocate(canonicalPath, destCanonical);
			await this.fs.move(section.path, moveDest, persisted);
			const fileHash = this.#recordFullSnapshot(destCanonical, after);
			return {
				path: resultPath,
				canonicalPath: destCanonical,
				op: "update",
				before: normalized,
				after,
				persisted,
				written: persisted,
				fileHash,
				header: formatHashlineHeader(moveDest, fileHash),
				firstChangedLine: applyResult.firstChangedLine,
				blockResolutions: applyResult.blockResolutions,
				moveDest,
				warnings,
			};
		}

		const write: WriteResult = await this.fs.writeText(section.path, persisted);
		const op = exists ? "update" : "create";

		// `write.text` is the FS adapter's report of what actually landed on
		// disk (see `WriteResult`), which for an ACP-bridge write can diverge
		// from `after` when the client transforms content on save (e.g.
		// format-on-save reformatting indentation the tool never touched).
		// Keying the snapshot on `after` unconditionally would record a hash
		// for content that no longer exists on disk: the next `read` sees the
		// drifted file, tag validation misses, and hunk resolution proceeds
		// against a baseline the file has already left — the mechanism behind
		// "single-line edit reformats the whole file". Re-derive the recorded
		// text from what was actually persisted and hash THAT.
		//
		// Deliberately does NOT touch `after` (or the diff/`newText` derived
		// from it downstream): `after` stays the content this section asked
		// for, so the model-visible diff stays scoped to the intended hunk
		// instead of ballooning to a whole-file diff against a formatter's
		// output on every drifted write. The drift itself is a warning, not a
		// diff — an O(1) signal instead of an O(file-size) one. Comparing the
		// normalized forms (rather than raw `write.text`/`persisted`) avoids a
		// false "drift" purely from BOM/line-ending restoration asymmetry.
		const recorded = normalizeToLF(stripBom(write.text).text);
		const driftedOnWrite = recorded !== after;
		const fileHash = this.#recordFullSnapshot(canonicalPath, recorded);
		const allWarnings = driftedOnWrite ? [...warnings, writeDriftWarning(section.path)] : warnings;

		return {
			path: section.path,
			canonicalPath,
			op,
			before: normalized,
			after,
			persisted,
			written: write.text,
			fileHash,
			header: formatHashlineHeader(section.path, fileHash),
			firstChangedLine: applyResult.firstChangedLine,
			blockResolutions: applyResult.blockResolutions,
			warnings: allWarnings,
		};
	}

	async #readBinaryBom(path: string): Promise<string> {
		if (!this.fs.readBinary) return "";
		const bytes = await this.fs.readBinary(path);
		return hasUtf8Bom(bytes) ? "\uFEFF" : "";
	}

	async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
		try {
			const content = await this.fs.readText(path);
			return { exists: true, rawContent: content };
		} catch (error) {
			if (isNotFound(error)) return { exists: false, rawContent: "" };
			throw error;
		}
	}

	#recordFullSnapshot(canonicalPath: string, normalized: string): string {
		return this.snapshots.record(canonicalPath, normalized);
	}

	/**
	 * Reject an anchored edit that references a line the read which minted
	 * `expected` never displayed. `matchedSnapshot` is the store version whose
	 * text equals the live normalized content — the exact snapshot the model
	 * anchored against. Absent means no provenance was recorded (the tag was
	 * externally minted or aged out), so the edit applies as before. Only runs
	 * on the no-drift path, where anchor line numbers index the tagged content
	 * 1:1.
	 *
	 * The rejection inlines the actual file content at the unseen anchor lines
	 * (from `matchedSnapshot.text`, which by definition equals the live
	 * normalized content) so the model can verify what it was about to touch.
	 * When the reveal covers EVERY unseen anchor line in full width
	 * (`truncated === false`) those lines also merge into the snapshot's
	 * seen-line set, so a straight retry with the same `[path#tag]` header
	 * succeeds without a follow-up range read — the content the model
	 * received in the error IS proof it has now seen those lines. When the
	 * anchor range exceeds {@link SEEN_LINE_REVEAL_CAP} lines OR any
	 * revealed line exceeds {@link SEEN_LINE_REVEAL_MAX_COLUMNS} characters
	 * (`truncated === true`), NO lines merge: the message keeps the
	 * range-re-read guidance intact and the model cannot piecewise-reveal
	 * its way past the guard across multiple retries
	 * (over-cap retry → tail reveal → next retry applies), nor coax the tool
	 * into dumping a minified megabyte-wide line into the error preview.
	 */
	#assertSeenLines(section: PatchSection, expected: string, matchedSnapshot: Snapshot | null): void {
		const seen = matchedSnapshot?.seenLines;
		if (!seen || seen.size === 0) return;
		const unseen = section.collectAnchorLines().filter(line => !seen.has(line));
		if (unseen.length === 0) return;
		const sourceLines = matchedSnapshot?.text.split("\n") ?? [];
		const revealed: RevealedLine[] = [];
		const revealCount = Math.min(unseen.length, SEEN_LINE_REVEAL_CAP);
		let columnTruncated = false;
		for (let i = 0; i < revealCount; i++) {
			const line = unseen[i];
			// Out-of-range anchors are caught by parse/apply with a better
			// message; skip them here so they never join the revealed set.
			if (line < 1 || line > sourceLines.length) continue;
			const source = sourceLines[line - 1] ?? "";
			if (source.length > SEEN_LINE_REVEAL_MAX_COLUMNS) {
				revealed.push({ line, text: `${source.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS)}…` });
				columnTruncated = true;
			} else {
				revealed.push({ line, text: source });
			}
		}
		const truncated = unseen.length > revealed.length || columnTruncated;
		// Only merge when the reveal covered every unseen anchor line in full
		// width. A prefix-truncated reveal would let the model split a blind
		// edit into <=cap-line retries and land it without ever running the
		// required range re-read; a column-clipped reveal would leave part of
		// each line unseen while the model receives an "ok to retry" signal.
		if (!truncated) {
			for (const { line } of revealed) seen.add(line);
		}
		throw new Error(unseenLinesMessage(section.path, unseen, expected, { lines: revealed, truncated }));
	}
	#mismatchError(
		section: PatchSection,
		canonicalPath: string,
		normalized: string,
		expected: string,
		hashRecognized: boolean,
	): MismatchError {
		const actualFileHash = this.#recordFullSnapshot(canonicalPath, normalized);
		return new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash,
			fileLines: normalized.split("\n"),
			anchorLines: section.collectAnchorLines(),
			hashRecognized,
		});
	}

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
		clipboard: Clipboard;
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits, clipboard } = args;
		const expected = exists ? section.fileHash : undefined;
		// The 4-hex tag is content-derived: when the live text hashes to it,
		// trust the match and apply directly. `storedSnapshotForTag` feeds the
		// drift paths below (block resolution, anchor remapping); on a 16-bit
		// tag collision it resolves to the most-recently recorded text.
		const storedSnapshotForTag = expected === undefined ? null : this.snapshots.byHash(canonicalPath, expected);
		const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;
		const matchedSnapshot = liveMatches ? this.snapshots.byContent(canonicalPath, normalized) : null;

		// Resolve `replace_block N:` edits to concrete ranges before recovery
		// runs. Block anchors are expressed against the snapshot the section tag
		// names, so resolve against that exact text:
		//   - live content matches the tag (or there is no tag) → resolve against
		//     the live, normalized content;
		//   - the file drifted → resolve against the tagged snapshot's text so the
		//     resulting ranges can be mapped to unchanged live lines below.
		// When a block edit needs the tagged snapshot but it is unavailable, the
		// range cannot be placed safely — reject with a MismatchError (re-read).
		const blockResolutions: BlockResolution[] = [];
		const resolveWarnings: string[] = [];
		let resolved: readonly Edit[] = edits;
		if (hasBlockEdit(edits)) {
			const baseText = expected === undefined || liveMatches ? normalized : storedSnapshotForTag?.text;
			if (baseText === undefined) {
				throw this.#mismatchError(section, canonicalPath, normalized, expected ?? "", false);
			}
			resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
				onUnresolved: "throw",
				onResolved: resolution => blockResolutions.push(resolution),
				onWarning: warning => resolveWarnings.push(warning),
			});
		}
		// Surface clipboard sequencing mistakes (`PASTE` before any capture,
		// capturing over un-pasted `CUT` content) with their targeted message
		// before the recovery path below, which swallows apply failures and
		// re-surfaces them as tag-mismatch errors.
		validateClipboardSequence(resolved, clipboard);
		const withResolveWarnings = (result: ApplyResult): ApplyResult =>
			resolveWarnings.length === 0
				? result
				: { ...result, warnings: [...resolveWarnings, ...(result.warnings ?? [])] };

		// No tag, or the tag still names the live content: an edit anchored at any
		// line is safe to apply, and the resolved block spans line up with what
		// the caller read, so echo them back. (A drifted file falls through to
		// recovery below, where line numbers shift, so resolutions are dropped.)
		if (expected === undefined || liveMatches) {
			// The line numbers in `edits` index the exact content the tag names.
			// Reject any anchor the read never displayed: editing lines the model
			// has not seen is the off-by-memory mistake that mangles files.
			if (expected !== undefined && this.#enforceSeenLines) {
				this.#assertSeenLines(section, expected, matchedSnapshot);
			}
			const result = applyEdits(normalized, resolved, { clipboard, path: canonicalPath });
			return withResolveWarnings(blockResolutions.length > 0 ? { ...result, blockResolutions } : result);
		}
		// Head/tail-only inserts are position-stable: "start"/"end" cannot move
		// with content drift, so a stale tag is non-fatal. Apply onto the live
		// content and warn instead of hard-failing — unlike an anchored
		// mismatch, which cannot be safely relocated and must reject.
		if (!hasAnchorScopedEdit(resolved)) {
			const result = applyEdits(normalized, resolved, { clipboard, path: canonicalPath });
			return withResolveWarnings({ ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] });
		}
		// File drifted: map every anchor from the tagged snapshot to unchanged
		// live lines. Recovery refuses changed or ambiguous targets.
		const recovered = this.recovery.tryRecover({
			path: canonicalPath,
			currentText: normalized,
			fileHash: expected,
			edits: resolved,
			clipboard,
		});
		if (recovered) return withResolveWarnings(recoveryToApplyResult(recovered));
		const hashRecognized = this.snapshots.byHash(canonicalPath, expected) !== null;
		throw this.#mismatchError(section, canonicalPath, normalized, expected, hashRecognized);
	}
}
