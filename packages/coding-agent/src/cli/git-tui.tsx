/** @jsxImportSource @oh-my-pi/pi-tui */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createRoot, effect, runWithOwner } from "@oh-my-pi/pi-tui";
import { generateGitCommit } from "../commit/conventional/service";
import type { ModelUsageLedger } from "../session/model-usage-journal";
import { type FullscreenShell, presentFullscreen, withStandaloneShell } from "../ui/apps/fullscreen";
import { GitApp, GitAppModel, GitHelp, gitHelpSheet } from "../ui/apps/git";
import type { OverlayHandle } from "../ui/shell/overlays";
import { findNode } from "../ui/styles/panels/common";
import { aiStage } from "./git-tui/ai-stage";
import { AvatarLoader } from "./git-tui/avatar";
import type { GitTuiHost } from "./git-tui/model/git-tui";
import { GitModel } from "./git-tui/state";

/** Repository selection for the git command and overlay. */
export interface GitTuiOptions {
	cwd?: string;
	/** Pin the view to one commit (any rev-parse-able revision). */
	revision?: string;
	/** Session the overlay opened on; generated commit messages are journaled there. */
	usageLedger?: Partial<ModelUsageLedger>;
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
		generateCommitMessage: request => generateGitCommit({ ...request, usageLedger: options.usageLedger }),
	};
}

/** The git app on `shell` until the user closes it, with the `?` sheet over it while open. */
export function presentGitApp(shell: FullscreenShell, host: GitTuiHost): Promise<void> {
	return presentFullscreen(shell, screen => {
		const app = new GitAppModel(host, { columns: screen.columns });
		let help: OverlayHandle | undefined;
		const openHelp = (): OverlayHandle =>
			shell.overlays.show(
				() => (
					<overlay key="git-help" {...gitHelpSheet(shell.native(), screen.columns)}>
						<GitHelp onClose={() => app.toggleHelp()} />
					</overlay>
				),
				{
					focus: root => root.children()[0] ?? root,
					mouse: "off",
					onClose: () => {
						help = undefined;
						if (app.helpOpen.peek()) app.toggleHelp();
					},
				},
			);
		// The sheet's root must outlive this effect's reruns: mount it unowned.
		const stopHelp = createRoot(dispose => {
			effect(() => {
				const open = app.helpOpen();
				runWithOwner(null, () => {
					if (open) help ??= openHelp();
					else help?.close();
				});
			});
			return dispose;
		});
		return {
			view: () => <GitApp app={app} media={() => shell.native()} />,
			focus: root => findNode(root, node => node.key() === "main") ?? root,
			done: app.run(),
			mouse: "drag",
			dispose: () => {
				stopHelp();
				help?.close();
				app.dispose();
			},
		};
	});
}

/** Open repository review on an interactive session's shell; resolves when the user closes it. */
export async function showGitOverlay(shell: FullscreenShell, options: GitTuiOptions = {}): Promise<void> {
	await presentGitApp(shell, await createHost(options));
}

/** Run standalone repository review (`omp git`) until the user quits. */
export async function runGitTui(options: GitTuiOptions = {}): Promise<void> {
	const host = await createHost(options);
	await withStandaloneShell({ title: "omp git" }, shell => presentGitApp(shell, host));
}
