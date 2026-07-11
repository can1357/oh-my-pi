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
import { computeFileHash, formatHashlineHeader } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import {
	HEADTAIL_DRIFT_WARNING,
	missingSnapshotTagMessage,
	pathRecoveredFromTagMessage,
	unseenLinesMessage,
} from "./messages";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { Recovery, type RecoveryResult } from "./recovery";
import type { SnapshotStore } from "./snapshots";
import type { ApplyResult, BlockResolution, BlockResolver, Edit, FileOp } from "./types";

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
	/** 4-hex content-hash tag for `after`. Use to anchor follow-up edits. */
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
	 * Resolved spans for any `replace_block`/`delete_block` ops, present when the
	 * apply matched the tagged content. Undefined for patches with no block ops
	 * (and for resolutions routed through drift recovery, where numbers shift).
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
		if (edit.kind === "delete") return true;
		// A `replace_block N:` edit anchors to concrete content on line N.
		if (edit.kind === "block") return true;
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

	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
		this.blockResolver = options.blockResolver;
	}

	/**
	 * Apply every section in `patch`. `prepare` runs the full apply for each
	 * section in memory before any write hits the filesystem, so a
	 * multi-section batch is naturally all-or-nothing. Returns one
	 * {@link PatchSectionResult} per section in the original patch order.
	 */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		// Single-section fast path.
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0]);
			return { sections: [await this.commit(prepared)] };
		}

		// Prepare every section first so any failure (stale hash, missing
		// file, parse error, in-memory no-op) surfaces before any write.
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
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
		}
		return { sections: results };
	}

	/**
	 * Run the preflight pass only: read, parse, validate, apply-in-memory.
	 * No writes hit the filesystem. Use for CI checks and dry runs.
	 */
	async preflight(patch: Patch): Promise<void> {
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the snapshot
	 * tag (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
	 * tag mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection): Promise<PreparedSection> {
		const parsed = section.parse();
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

		const { bom, text } = stripBom(read.rawContent);
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const applyResult =
			fileOp?.kind === "rem"
				? this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: [],
					})
				: this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: parsed.edits,
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
		const fileHash = this.#recordFullSnapshot(canonicalPath, after);
		const op = exists ? "update" : "create";

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
			warnings,
		};
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
	 * `expected` never displayed. The snapshot's `seenLines` is the set of
	 * 1-indexed lines a producer (read/search) actually showed under that tag;
	 * absent or empty means no provenance was recorded, so the edit applies as
	 * before. Only runs on the no-drift path, where anchor line numbers index
	 * the tagged content 1:1.
	 */
	#assertSeenLines(section: PatchSection, canonicalPath: string, expected: string): void {
		const seen = this.snapshots.byHash(canonicalPath, expected)?.seenLines;
		if (!seen || seen.size === 0) return;
		const unseen = section.collectAnchorLines().filter(line => !seen.has(line));
		if (unseen.length === 0) return;
		throw new Error(unseenLinesMessage(section.path, unseen, expected));
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
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits } = args;
		const expected = exists ? section.fileHash : undefined;
		const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;

		// Resolve `replace_block N:` edits to concrete ranges before recovery
		// runs. Block anchors are expressed against the snapshot the section tag
		// names, so resolve against that exact text:
		//   - live content matches the tag (or there is no tag) → resolve against
		//     the live, normalized content;
		//   - the file drifted → resolve against the tagged snapshot's text so the
		//     resulting ranges flow through the 3-way-merge recovery below.
		// When a block edit needs the tagged snapshot but it is unavailable, the
		// range cannot be placed safely — reject with a MismatchError (re-read).
		const blockResolutions: BlockResolution[] = [];
		const resolveWarnings: string[] = [];
		let resolved: readonly Edit[] = edits;
		if (hasBlockEdit(edits)) {
			const baseText =
				expected === undefined || liveMatches ? normalized : this.snapshots.byHash(canonicalPath, expected)?.text;
			if (baseText === undefined) {
				throw this.#mismatchError(section, canonicalPath, normalized, expected ?? "", false);
			}
			resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
				onUnresolved: "throw",
				onResolved: resolution => blockResolutions.push(resolution),
				onWarning: warning => resolveWarnings.push(warning),
			});
		}
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
			if (expected !== undefined) this.#assertSeenLines(section, canonicalPath, expected);
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings(blockResolutions.length > 0 ? { ...result, blockResolutions } : result);
		}
		// Head/tail-only inserts are position-stable: "start"/"end" cannot move
		// with content drift, so a stale tag is non-fatal. Apply onto the live
		// content and warn instead of hard-failing — unlike an anchored
		// mismatch, which cannot be safely relocated and must reject.
		if (!hasAnchorScopedEdit(resolved)) {
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings({ ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] });
		}
		// File drifted: try to replay the edit against the version the tag
		// names and 3-way-merge it onto the live content.
		const recovered = this.recovery.tryRecover({
			path: canonicalPath,
			currentText: normalized,
			fileHash: expected,
			edits: resolved,
		});
		if (recovered) return withResolveWarnings(recoveryToApplyResult(recovered));
		const hashRecognized = this.snapshots.byHash(canonicalPath, expected) !== null;
		throw this.#mismatchError(section, canonicalPath, normalized, expected, hashRecognized);
	}
}
