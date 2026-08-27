/**
 * Git data model for the `omp git` fullscreen TUI.
 *
 * Owns porcelain status parsing into staged/unstaged file lists, HEAD commit
 * metadata for the clean-tree view, per-file old/new content resolution for
 * the split diff pane, and the staging/commit actions the sidebar triggers.
 */
import * as path from "node:path";
import {
	DiffSide,
	DiffStream,
	type DiffStreamProgress,
	type DiffStreamResult,
	rasterizeSvg,
} from "@oh-my-pi/pi-natives";
import { BINARY_SNIFF_BYTES, isEnoent, isProbablyBinaryHeader } from "@oh-my-pi/pi-utils";
import { parseNumstat } from "../../commit/git/diff";
import type { NumstatEntry } from "../../commit/types";
import * as git from "../../utils/git";

/** SHA of git's canonical empty tree: diff base for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Files larger than this render as a placeholder instead of a diff. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Maximum canonical Git LFS pointer size. */
const LFS_POINTER_MAX_BYTES = 1024;
/** Pixel bounds for a terminal SVG preview. */
const SVG_PREVIEW_MAX_PX = 2048;
/** Decode guard for raster images before terminal handoff. */
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const LFS_VERSION = "version https://git-lfs.github.com/spec/v1";
const LFS_VERSION_BYTES = new TextEncoder().encode(LFS_VERSION);
const IMAGE_EXTENSIONS: Record<string, true> = {
	".avif": true,
	".bmp": true,
	".gif": true,
	".heic": true,
	".heif": true,
	".jpeg": true,
	".jpg": true,
	".png": true,
	".svg": true,
	".svgz": true,
	".tif": true,
	".tiff": true,
	".webp": true,
};
/** Context lines retained around each exact streamed hunk. */
export const DIFF_CONTEXT_LINES = 3;

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
export type ChangeArea = "unstaged" | "staged" | "commit";

/** One changed path shown in the sidebar file lists. */
export interface ChangedFile {
	readonly path: string;
	/** Pre-rename path for renames/copies. */
	readonly origPath?: string;
	readonly kind: ChangeKind;
	readonly area: ChangeArea;
	readonly additions?: number;
	readonly deletions?: number;
}

/** HEAD commit metadata for the clean-tree sidebar view. */
export interface HeadCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly subject: string;
	readonly body: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly parents: readonly string[];
	/** Changed paths once their numstats have loaded. */
	readonly files: readonly ChangedFile[];
	/** Whether {@link files} contains the complete commit file list. */
	readonly filesLoaded: boolean;
}

/** A terminal-ready image decoded from one Git file side. */
export interface ReviewImage {
	readonly data: string;
	readonly mimeType: "image/png";
	readonly sourceMimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly byteLength: number;
	/** Stable content identity for terminal graphics placement. */
	readonly key: string;
	/** Git LFS object id when the preview came from local LFS storage. */
	readonly lfsOid?: string;
}

/** One side of a media or binary Git change. */
export type FileAssetSide =
	| { readonly kind: "empty" }
	| { readonly kind: "text"; readonly byteLength: number; readonly lfsOid?: string }
	| { readonly kind: "image"; readonly image: ReviewImage }
	| { readonly kind: "binary"; readonly byteLength?: number; readonly lfsOid?: string }
	| { readonly kind: "tooLarge"; readonly byteLength?: number; readonly lfsOid?: string }
	| { readonly kind: "lfsMissing"; readonly oid: string; readonly byteLength: number };

/** Diffable UTF-8 content for both sides of a file. */
export interface TextFileContents {
	readonly kind: "text";
	readonly oldText: string;
	readonly newText: string;
	readonly streamResult: DiffStreamResult;
}

/** Non-text sides rendered as previews or explicit placeholders. */
export interface AssetFileContents {
	readonly kind: "asset";
	readonly old: FileAssetSide;
	readonly new: FileAssetSide;
}

/** Loaded file content selected for text diffing or asset preview. */
export type FileContents = TextFileContents | AssetFileContents;

/** Newly completed lines and state emitted while a file pair streams. */
export interface FileStreamUpdate {
	readonly oldLineOffset: number;
	readonly oldLines: readonly string[];
	readonly newLineOffset: number;
	readonly newLines: readonly string[];
	readonly progress: DiffStreamProgress;
}
interface LfsPointer {
	readonly oid: string;
	readonly size: number;
}

type LfsObject =
	| { readonly kind: "loaded"; readonly bytes: Uint8Array }
	| { readonly kind: "tooLarge"; readonly byteLength: number; readonly lfsOid: string }
	| { readonly kind: "lfsMissing"; readonly oid: string; readonly byteLength: number };

function concatChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
	const first = chunks[0];
	if (first && first.byteLength >= byteLength) return first.subarray(0, byteLength);
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, byteLength - offset);
		bytes.set(chunk.subarray(0, take), offset);
		offset += take;
		if (offset === byteLength) break;
	}
	return bytes;
}

function pathLooksLikeImage(filePath: string): boolean {
	return IMAGE_EXTENSIONS[path.extname(filePath).toLowerCase()] === true;
}

function couldBeLfsPointer(bytes: Uint8Array): boolean {
	if (bytes.byteLength > LFS_POINTER_MAX_BYTES) return false;
	const compared = Math.min(bytes.byteLength, LFS_VERSION_BYTES.byteLength);
	for (let index = 0; index < compared; index++) {
		if (bytes[index] !== LFS_VERSION_BYTES[index]) return false;
	}
	return true;
}

function parseLfsPointer(bytes: Uint8Array): LfsPointer | null {
	if (bytes.byteLength > LFS_POINTER_MAX_BYTES) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const lines = text.split(/\r?\n/);
	if (lines[0] !== LFS_VERSION) return null;
	let oid: string | undefined;
	let size: number | undefined;
	for (const line of lines.slice(1)) {
		const oidMatch = /^oid sha256:([0-9a-f]{64})$/.exec(line);
		if (oidMatch) {
			oid = oidMatch[1];
			continue;
		}
		const sizeMatch = /^size ([0-9]+)$/.exec(line);
		if (sizeMatch) size = Number(sizeMatch[1]);
	}
	return oid && Number.isSafeInteger(size) ? { oid, size: size ?? 0 } : null;
}

function looksLikeSvg(bytes: Uint8Array, filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".svg" || extension === ".svgz") return true;
	if (isProbablyBinaryHeader(bytes)) return false;
	try {
		return /<svg(?:\\s|>)/i.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }));
	} catch {
		return false;
	}
}

function imageMimeType(format: Bun.Image.Format): string {
	switch (format) {
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "heic":
			return "image/heic";
		case "avif":
			return "image/avif";
		case "bmp":
			return "image/bmp";
		case "tiff":
			return "image/tiff";
		case "gif":
			return "image/gif";
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

async function decodeReviewImage(
	bytes: Uint8Array,
	options: { filePath: string; lfsOid?: string },
): Promise<ReviewImage | null> {
	const key = options.lfsOid ?? Bun.hash.xxHash64(bytes).toString(16);
	if (looksLikeSvg(bytes.subarray(0, BINARY_SNIFF_BYTES), options.filePath)) {
		try {
			const png = await rasterizeSvg(bytes, SVG_PREVIEW_MAX_PX, SVG_PREVIEW_MAX_PX);
			const metadata = await new Bun.Image(png, { maxPixels: MAX_IMAGE_PIXELS }).metadata();
			return {
				data: bytesToBase64(png),
				mimeType: "image/png",
				sourceMimeType: "image/svg+xml",
				widthPx: metadata.width,
				heightPx: metadata.height,
				byteLength: bytes.byteLength,
				key,
				lfsOid: options.lfsOid,
			};
		} catch {
			return null;
		}
	}
	try {
		const image = new Bun.Image(bytes, { maxPixels: MAX_IMAGE_PIXELS });
		const metadata = await image.metadata();
		return {
			data: metadata.format === "png" ? bytesToBase64(bytes) : await image.png().toBase64(),
			mimeType: "image/png",
			sourceMimeType: imageMimeType(metadata.format),
			widthPx: metadata.width,
			heightPx: metadata.height,
			byteLength: bytes.byteLength,
			key,
			lfsOid: options.lfsOid,
		};
	} catch {
		return null;
	}
}

function kindFromLetter(letter: string): ChangeKind {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		case "U":
			return "conflicted";
		default:
			return "modified";
	}
}

const CONFLICT_STATES: Record<string, true> = { DD: true, AU: true, UD: true, UA: true, DU: true, AA: true, UU: true };

/**
 * Repository state backing the git TUI. `refresh()` re-reads everything and
 * returns whether the observable state changed since the previous refresh.
 */
export class GitModel {
	readonly cwd: string;
	/** Resolved SHA when the TUI is pinned to one commit (`omp git <rev>`). */
	readonly pinnedSha: string | null;
	branch: string | null = null;
	unstaged: ChangedFile[] = [];
	staged: ChangedFile[] = [];
	headCommit: HeadCommit | null = null;
	#fingerprint = "";
	#statusStatsLoad: Promise<boolean> | null = null;
	#headFilesLoad: Promise<boolean> | null = null;
	#lfsMediaDir: Promise<string | null> | null = null;

	constructor(cwd: string, options: { pinnedSha?: string } = {}) {
		this.cwd = cwd;
		this.pinnedSha = options.pinnedSha ?? null;
	}

	/** True when the working tree and index carry no changes. */
	get clean(): boolean {
		return this.unstaged.length === 0 && this.staged.length === 0;
	}

	/** Re-read fast repository state; expensive numstats load separately. */
	async refresh(): Promise<boolean> {
		if (this.pinnedSha) {
			if (this.#fingerprint === this.pinnedSha) return false;
			this.#fingerprint = this.pinnedSha;
			this.#headFilesLoad = null;
			this.headCommit = await this.#loadHeadMetadata(this.pinnedSha);
			return true;
		}
		const [statusText, branchName, headSha] = await Promise.all([
			git.status(this.cwd, { porcelainV1: true, z: true, untrackedFiles: "all" }).catch(() => null),
			git.branch.current(this.cwd).catch(() => null),
			git.head.sha(this.cwd).catch(() => null),
		]);
		if (statusText === null) throw new Error("Not a git repository");
		const fingerprint = `${headSha ?? ""}\u0000${statusText}`;
		if (fingerprint === this.#fingerprint) {
			this.branch = branchName;
			return false;
		}
		this.#fingerprint = fingerprint;
		this.#statusStatsLoad = null;
		this.branch = branchName;
		this.#setChanges(statusText);
		if (headSha !== this.headCommit?.sha) {
			this.#headFilesLoad = null;
			this.headCommit = headSha ? await this.#loadHeadMetadata(headSha) : null;
		}
		return true;
	}

	/** Populate changed-line counts after the file list is already interactive. */
	async loadChangeStats(): Promise<boolean> {
		if (this.clean) return false;
		if (this.#statusStatsLoad) return await this.#statusStatsLoad;
		const fingerprint = this.#fingerprint;
		const load = (async (): Promise<boolean> => {
			const [unstagedStat, stagedStat] = await Promise.all([
				git.diff(this.cwd, { numstat: true, allowFailure: true }).then(parseNumstat),
				git.diff(this.cwd, { numstat: true, cached: true, allowFailure: true }).then(parseNumstat),
			]);
			if (fingerprint !== this.#fingerprint) return false;
			const unstagedCounts = new Map(unstagedStat.map(entry => [entry.path, entry]));
			const stagedCounts = new Map(stagedStat.map(entry => [entry.path, entry]));
			this.unstaged = this.#withCounts(this.unstaged, unstagedCounts);
			this.staged = this.#withCounts(this.staged, stagedCounts);
			return true;
		})();
		this.#statusStatsLoad = load;
		try {
			return await load;
		} finally {
			if (this.#statusStatsLoad === load) this.#statusStatsLoad = null;
		}
	}

	/** Load changed-file details for the clean commit view without delaying initial paint. */
	async loadHeadFiles(): Promise<boolean> {
		const head = this.headCommit;
		if (!head || !this.clean || head.filesLoaded) return false;
		if (this.#headFilesLoad) return await this.#headFilesLoad;
		const load = (async (): Promise<boolean> => {
			const base = head.parents[0] ?? EMPTY_TREE;
			const numstat = parseNumstat(
				await git.diff(this.cwd, { numstat: true, base, head: head.sha, allowFailure: true }),
			);
			if (this.headCommit?.sha !== head.sha) return false;
			this.headCommit = {
				...head,
				files: numstat.map(entry => ({
					path: entry.path,
					kind: entry.additions > 0 && entry.deletions === 0 ? "added" : "modified",
					area: "commit" as const,
					additions: entry.additions,
					deletions: entry.deletions,
				})),
				filesLoaded: true,
			};
			return true;
		})();
		this.#headFilesLoad = load;
		try {
			return await load;
		} finally {
			if (this.#headFilesLoad === load) this.#headFilesLoad = null;
		}
	}

	#setChanges(statusText: string): void {
		const unstaged: ChangedFile[] = [];
		const staged: ChangedFile[] = [];
		const tokens = statusText.split("\0");
		for (let i = 0; i < tokens.length; i++) {
			const record = tokens[i];
			if (record.length < 4) continue;
			const x = record[0];
			const y = record[1];
			const filePath = record.slice(3);
			// In `-z` output a rename/copy record is followed by the original path
			// as its own NUL-separated token.
			const origPath = x === "R" || x === "C" ? tokens[++i] : undefined;
			if (x === "?" && y === "?") {
				unstaged.push({ path: filePath, kind: "untracked", area: "unstaged" });
				continue;
			}
			if (CONFLICT_STATES[`${x}${y}`]) {
				unstaged.push({ path: filePath, kind: "conflicted", area: "unstaged" });
				continue;
			}
			if (x !== " ") staged.push({ path: filePath, origPath, kind: kindFromLetter(x), area: "staged" });
			if (y !== " ") unstaged.push({ path: filePath, kind: kindFromLetter(y), area: "unstaged" });
		}
		this.unstaged = unstaged;
		this.staged = staged;
	}

	#withCounts(files: readonly ChangedFile[], counts: ReadonlyMap<string, NumstatEntry>): ChangedFile[] {
		return files.map(file => {
			const count = counts.get(file.path);
			return count ? { ...file, additions: count.additions, deletions: count.deletions } : file;
		});
	}

	async #loadHeadMetadata(sha: string): Promise<HeadCommit | null> {
		try {
			const details = await git.commitDetails(this.cwd, sha);
			const [subject = "", ...bodyLines] = details.message.split("\n");
			return {
				sha,
				shortSha: sha.slice(0, 8),
				subject,
				body: bodyLines.join("\n").trim(),
				authorName: details.author.name,
				authorEmail: details.author.email,
				authorDate: details.author.date ?? "",
				parents: details.parents,
				files: [],
				filesLoaded: false,
			};
		} catch {
			return null;
		}
	}
	/** Stream old/new sources concurrently, emitting complete lines as they arrive. */
	async streamContents(
		file: ChangedFile,
		onProgress: (update: FileStreamUpdate) => void,
		signal?: AbortSignal,
	): Promise<FileContents> {
		const stream = new DiffStream();
		let oldLineOffset = 0;
		let newLineOffset = 0;
		let lastProgress: DiffStreamProgress | null = null;
		const emit = (): void => {
			const progress = stream.progress();
			const oldLines = stream.lines(DiffSide.Old, oldLineOffset, progress.oldLines - oldLineOffset);
			const newLines = stream.lines(DiffSide.New, newLineOffset, progress.newLines - newLineOffset);
			const stateChanged =
				lastProgress === null ||
				progress.stableCommonLines !== lastProgress.stableCommonLines ||
				progress.oldDone !== lastProgress.oldDone ||
				progress.newDone !== lastProgress.newDone ||
				progress.binary !== lastProgress.binary ||
				progress.tooLarge !== lastProgress.tooLarge;
			if (oldLines.length > 0 || newLines.length > 0 || stateChanged) {
				onProgress({ oldLineOffset, oldLines, newLineOffset, newLines, progress });
			}
			oldLineOffset = progress.oldLines;
			newLineOffset = progress.newLines;
			lastProgress = progress;
		};
		const empty = (side: DiffSide): Promise<FileAssetSide> => {
			stream.finishSide(side);
			emit();
			return Promise.resolve({ kind: "empty" });
		};

		let oldSource: Promise<FileAssetSide>;
		let newSource: Promise<FileAssetSide>;
		switch (file.area) {
			case "unstaged":
				oldSource =
					file.kind === "untracked"
						? empty(DiffSide.Old)
						: this.#streamGitSide(stream, DiffSide.Old, `:0:${file.path}`, file.path, emit, signal);
				newSource =
					file.kind === "deleted"
						? empty(DiffSide.New)
						: this.#streamFileSide(stream, DiffSide.New, path.join(this.cwd, file.path), file.path, emit, signal);
				break;
			case "staged":
				oldSource = this.#streamGitSide(
					stream,
					DiffSide.Old,
					`HEAD:${file.origPath ?? file.path}`,
					file.origPath ?? file.path,
					emit,
					signal,
				);
				newSource = this.#streamGitSide(stream, DiffSide.New, `:0:${file.path}`, file.path, emit, signal);
				break;
			case "commit": {
				const head = this.headCommit;
				const base = head?.parents[0];
				oldSource = base
					? this.#streamGitSide(
							stream,
							DiffSide.Old,
							`${base}:${file.origPath ?? file.path}`,
							file.origPath ?? file.path,
							emit,
							signal,
						)
					: empty(DiffSide.Old);
				newSource = head
					? this.#streamGitSide(stream, DiffSide.New, `${head.sha}:${file.path}`, file.path, emit, signal)
					: empty(DiffSide.New);
				break;
			}
		}
		const [oldSide, newSide] = await Promise.all([oldSource, newSource]);
		const oldDiffable = oldSide.kind === "empty" || oldSide.kind === "text";
		const newDiffable = newSide.kind === "empty" || newSide.kind === "text";
		if (oldDiffable && newDiffable) {
			return {
				kind: "text",
				oldText: stream.text(DiffSide.Old),
				newText: stream.text(DiffSide.New),
				streamResult: await stream.finish(DIFF_CONTEXT_LINES),
			};
		}
		return { kind: "asset", old: oldSide, new: newSide };
	}

	async #streamGitSide(
		stream: DiffStream,
		side: DiffSide,
		spec: string,
		filePath: string,
		emit: () => void,
		signal?: AbortSignal,
	): Promise<FileAssetSide> {
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		let streaming = false;
		try {
			for await (const chunk of git.show.stream(this.cwd, spec, { maxOutputBytes: MAX_FILE_BYTES, signal })) {
				byteLength += chunk.byteLength;
				if (streaming) {
					const progress = stream.pushBytes(side, chunk);
					emit();
					if (progress.binary) {
						stream.finishSide(side);
						emit();
						return { kind: "binary" };
					}
					continue;
				}

				chunks.push(chunk);
				const header = concatChunks(chunks, Math.min(byteLength, BINARY_SNIFF_BYTES));
				const keepBuffered =
					pathLooksLikeImage(filePath) ||
					couldBeLfsPointer(header) ||
					looksLikeSvg(header, filePath) ||
					isProbablyBinaryHeader(header);
				if (keepBuffered || byteLength < BINARY_SNIFF_BYTES) continue;

				streaming = true;
				for (const buffered of chunks) stream.pushBytes(side, buffered);
				chunks.length = 0;
				emit();
			}

			if (!streaming) {
				return await this.#finishBufferedSide(
					stream,
					side,
					concatChunks(chunks, byteLength),
					filePath,
					emit,
					signal,
				);
			}
			stream.finishSide(side);
			emit();
			return { kind: "text", byteLength };
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof git.GitOutputTruncatedError) {
				stream.markTooLarge(side);
				emit();
				return { kind: "tooLarge" };
			}
			if (error instanceof git.GitCommandError) {
				stream.finishSide(side);
				emit();
				return { kind: "empty" };
			}
			throw error;
		}
	}

	async #streamFileSide(
		stream: DiffStream,
		side: DiffSide,
		filePath: string,
		displayPath: string,
		emit: () => void,
		signal?: AbortSignal,
	): Promise<FileAssetSide> {
		signal?.throwIfAborted();
		const file = Bun.file(filePath);
		const byteLength = file.size;
		if (byteLength > MAX_FILE_BYTES) {
			stream.markTooLarge(side);
			emit();
			return { kind: "tooLarge", byteLength };
		}
		const header = await file.slice(0, BINARY_SNIFF_BYTES).bytes();
		signal?.throwIfAborted();
		if (
			pathLooksLikeImage(displayPath) ||
			couldBeLfsPointer(header) ||
			looksLikeSvg(header, displayPath) ||
			isProbablyBinaryHeader(header)
		) {
			const bytes = header.byteLength === byteLength ? header : await file.bytes();
			signal?.throwIfAborted();
			if (bytes.byteLength > MAX_FILE_BYTES) {
				stream.markTooLarge(side);
				emit();
				return { kind: "tooLarge", byteLength: bytes.byteLength };
			}
			return await this.#finishBufferedSide(stream, side, bytes, displayPath, emit, signal);
		}

		let done = false;
		const reading = stream.openFile(side, filePath, MAX_FILE_BYTES, signal);
		reading.then(
			() => {
				done = true;
			},
			() => {
				done = true;
			},
		);
		while (!done) {
			await Bun.sleep(4);
			emit();
		}
		const progress = await reading;
		emit();
		return progress.binary ? { kind: "binary", byteLength } : { kind: "text", byteLength };
	}

	async #finishBufferedSide(
		stream: DiffStream,
		side: DiffSide,
		bytes: Uint8Array,
		filePath: string,
		emit: () => void,
		signal?: AbortSignal,
		lfsOid?: string,
	): Promise<FileAssetSide> {
		signal?.throwIfAborted();
		if (!lfsOid) {
			const pointer = parseLfsPointer(bytes);
			if (pointer) {
				const object = await this.#loadLfsObject(pointer, signal);
				if (object.kind !== "loaded") {
					stream.finishSide(side);
					emit();
					return object;
				}
				return await this.#finishBufferedSide(stream, side, object.bytes, filePath, emit, signal, pointer.oid);
			}
		}

		const header = bytes.subarray(0, BINARY_SNIFF_BYTES);
		if (pathLooksLikeImage(filePath) || looksLikeSvg(header, filePath) || isProbablyBinaryHeader(header)) {
			const image = await decodeReviewImage(bytes, { filePath, lfsOid });
			signal?.throwIfAborted();
			if (image) {
				stream.finishSide(side);
				emit();
				return { kind: "image", image };
			}
		}
		if (isProbablyBinaryHeader(header)) {
			stream.finishSide(side);
			emit();
			return { kind: "binary", byteLength: bytes.byteLength, lfsOid };
		}

		const progress = stream.pushBytes(side, bytes);
		stream.finishSide(side);
		emit();
		return progress.binary
			? { kind: "binary", byteLength: bytes.byteLength, lfsOid }
			: { kind: "text", byteLength: bytes.byteLength, lfsOid };
	}

	async #loadLfsObject(pointer: LfsPointer, signal?: AbortSignal): Promise<LfsObject> {
		if (pointer.size > MAX_FILE_BYTES) {
			return { kind: "tooLarge", byteLength: pointer.size, lfsOid: pointer.oid };
		}
		this.#lfsMediaDir ??= git.lfs.mediaDir(this.cwd);
		const mediaDir = await this.#lfsMediaDir;
		if (!mediaDir) return { kind: "lfsMissing", oid: pointer.oid, byteLength: pointer.size };
		const objectPath = path.join(mediaDir, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
		try {
			const bytes = await Bun.file(objectPath).bytes();
			signal?.throwIfAborted();
			if (bytes.byteLength !== pointer.size) {
				return { kind: "lfsMissing", oid: pointer.oid, byteLength: pointer.size };
			}
			return { kind: "loaded", bytes };
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { kind: "lfsMissing", oid: pointer.oid, byteLength: pointer.size };
		}
	}

	/** Stage the given files (or everything when omitted). */
	async stage(files?: readonly ChangedFile[]): Promise<void> {
		await git.stage.files(this.cwd, files?.map(file => file.path) ?? []);
	}

	/** Unstage the given files (or everything when omitted). */
	async unstage(files?: readonly ChangedFile[]): Promise<void> {
		await git.stage.reset(this.cwd, files?.map(file => file.path) ?? []);
	}

	/** Create (or amend) a commit from the staged changes. */
	async commit(message: string, options: { amend?: boolean } = {}): Promise<void> {
		await git.commit(this.cwd, message, { amend: options.amend });
	}
	/** Apply a patch to the index (`cached`) and/or worktree; `reverse` undoes it. */
	async applyPatch(patchText: string, options: { cached?: boolean; reverse?: boolean } = {}): Promise<void> {
		await git.patch.applyText(this.cwd, patchText, options);
	}
}
