import type { AvatarSource } from "./avatar";
import { type GitCommitMessage } from "./sidebar";
import type { ChangedFile, GitTuiModel } from "./state";

/** AI staging counts displayed after filtering the working tree. */
export interface AiStageOutcome {
	matchedFiles: number;
	totalFiles: number;
	stagedHunks: number;
	totalHunks: number;
	wholeFiles: number;
}

/** Repository, avatar, and generation capabilities owned by the command host. */
export interface GitTuiHost {
	model: GitTuiModel;
	createAvatarSource(onReady: () => void): AvatarSource;
	aiStage(options: {
		cwd: string;
		instruction: string;
		files: readonly Pick<ChangedFile, "path" | "kind">[];
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	}): Promise<AiStageOutcome>;
	generateCommitMessage(options: {
		cwd: string;
		stageIfEmpty: boolean;
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	}): Promise<{ commit: GitCommitMessage; validationError?: string | null; stagedAll: boolean }>;
}
