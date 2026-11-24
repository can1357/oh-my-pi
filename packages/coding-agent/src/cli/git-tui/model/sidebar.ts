import type { ChangedFile } from "./state";

/** Generated conventional commit fields shown in the commit form. */
export interface GitCommitMessage {
	type: string;
	scope?: string | null;
	summary: string;
	body: readonly string[];
}

/** Actions the sidebar raises to the root component. */
export type SidebarAction =
	/** `selection` omitted → whole tree; `label` names the target for the status line. */
	| { type: "stage"; selection?: { files: ChangedFile[]; label: string } }
	| { type: "unstage"; selection?: { files: ChangedFile[]; label: string } }
	/** `delete`: throw away the row's changes (a dir batches every file underneath). */
	| { type: "discard"; selection: { files: ChangedFile[]; label: string } }
	| { type: "generate" }
	/** Wand pill: AI-filter the unstaged tree against a natural-language prompt. */
	| { type: "stage-ai"; prompt: string }
	| { type: "commit"; message: string; amend: boolean; stageAll: boolean };
