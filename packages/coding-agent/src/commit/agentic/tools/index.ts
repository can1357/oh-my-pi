import type { CommitAgentState } from "../../../commit/agentic/state";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { createAnalyzeFileTool } from "./analyze-file";
import { createGitFileDiffTool } from "./git-file-diff";
import { createGitHunkTool } from "./git-hunk";
import { createGitOverviewTool } from "./git-overview";
import { createProposeChangelogTool } from "./propose-changelog";
import { createProposeCommitTool } from "./propose-commit";
import { createRecentCommitsTool } from "./recent-commits";
import { createSplitCommitTool } from "./split-commit";

export interface CommitToolOptions {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	spawns: string;
	state: CommitAgentState;
	changelogTargets: string[];
	enableAnalyzeFiles?: boolean;
}

export function createCommitTools(options: CommitToolOptions): Array<CustomTool<any, any>> {
	const tools: Array<CustomTool<any, any>> = [
		createGitOverviewTool(options.cwd, options.state),
		createGitFileDiffTool(options.cwd, options.state),
		createGitHunkTool(options.cwd),
		createRecentCommitsTool(options.cwd),
	];

	if (options.enableAnalyzeFiles ?? true) {
		tools.push(
			createAnalyzeFileTool({
				cwd: options.cwd,
				authStorage: options.authStorage,
				modelRegistry: options.modelRegistry,
				settings: options.settings,
				spawns: options.spawns,
				state: options.state,
			}),
		);
	}

	tools.push(
		createProposeChangelogTool(options.state, options.changelogTargets),
		createProposeCommitTool(options.cwd, options.state),
		createSplitCommitTool(options.cwd, options.state, options.changelogTargets),
	);

	return tools;
}
