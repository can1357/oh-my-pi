import type { DiffStreamProgress, DiffStreamResult } from "@oh-my-pi/pi-natives";

/** Context lines retained around each exact streamed hunk. */
export const DIFF_CONTEXT_LINES = 3;

/** Change classification shown beside a file path. */
export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
/** Repository area represented by a file list. */
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

/** Repository values read by the sidebar. */
export interface GitViewState {
	readonly cwd: string;
	readonly branch: string | null;
	readonly clean: boolean;
	readonly unstaged: readonly ChangedFile[];
	readonly staged: readonly ChangedFile[];
	readonly headCommit: HeadCommit | null;
}

/** Repository operations supplied by the command host. */
export interface GitTuiModel extends GitViewState {
	refresh(): Promise<boolean>;
	loadChangeStats(): Promise<boolean>;
	loadHeadFiles(): Promise<boolean>;
	streamContents(
		file: ChangedFile,
		onProgress: (update: FileStreamUpdate) => void,
		signal?: AbortSignal,
	): Promise<FileContents>;
	stage(files?: readonly ChangedFile[]): Promise<void>;
	unstage(files?: readonly ChangedFile[]): Promise<void>;
	discard(files: readonly ChangedFile[]): Promise<void>;
	commit(message: string, options?: { amend?: boolean }): Promise<void>;
	applyPatch(patchText: string, options?: { cached?: boolean; reverse?: boolean }): Promise<void>;
}
