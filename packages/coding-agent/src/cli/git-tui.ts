import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	type GitTuiHost,
	runGitTui as runView,
	showGitOverlay as showOverlay,
} from "@oh-my-pi/pi-tui/apps/git/git-tui";
import { generateGitCommit } from "../commit/conventional/service";
import { aiStage } from "./git-tui/ai-stage";
import { AvatarLoader } from "./git-tui/avatar";
import { GitModel } from "./git-tui/state";

/** Repository selection for the git command and overlay. */
export interface GitTuiOptions {
	cwd?: string;
	/** Pin the view to one commit (any rev-parse-able revision). */
	revision?: string;
}

async function createHost(options: GitTuiOptions): Promise<GitTuiHost> {
	const cwd = options.cwd ?? process.cwd();
	const repo = vcs.git(cwd);
	const root = repo?.info().repoRoot ?? null;
	if (!root) throw new Error(`Not a git repository: ${cwd}`);
	let pinnedSha: string | undefined;
	if (options.revision) {
		pinnedSha = (await repo?.resolveRef(options.revision)) ?? undefined;
		if (!pinnedSha) throw new Error(`Cannot resolve revision: ${options.revision}`);
	}
	return {
		model: new GitModel(root, { pinnedSha }),
		createAvatarSource: onReady => new AvatarLoader(onReady),
		aiStage,
		generateCommitMessage: generateGitCommit,
	};
}

/** Open repository review on an existing interactive session. */
export async function showGitOverlay(ui: TUI, options: GitTuiOptions = {}): Promise<void> {
	await showOverlay(ui, await createHost(options));
}

/** Run standalone repository review with application-owned capabilities. */
export async function runGitTui(options: GitTuiOptions = {}): Promise<void> {
	await runView(await createHost(options));
}
