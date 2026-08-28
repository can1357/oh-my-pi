import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { runAgenticCommit } from "./agentic";
import { runChangelogFlow } from "./changelog";
import { formatConventionalCommit } from "./conventional/normalization";
import { type GeneratedGitCommit, generateGitCommit } from "./conventional/service";
import { abortOnGitFailure, pushOrAbort } from "./execute";
import { resolvePrimaryModel } from "./model-selection";
import type { CommitCommandArgs } from "./types";

/** Execute the agentic commit flow or the exact deterministic legacy flow. */
export async function runCommitCommand(args: CommitCommandArgs): Promise<{ usedFallback: boolean }> {
	if (!args.legacy) return runAgenticCommit(args);
	await runLegacyCommitCommand(args);
	return { usedFallback: false };
}

async function runLegacyCommitCommand(args: CommitCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	let generated: GeneratedGitCommit;
	try {
		generated = await generateGitCommit({
			cwd,
			modelOverride: args.model,
			stageIfEmpty: true,
			onProgress: message => process.stdout.write(`${message}\n`),
		});
	} catch (error) {
		if (vcs.isVcsError(error)) abortOnGitFailure("Commit generation failed", error);
		if (error instanceof Error && error.message === "No staged changes to analyze") {
			if (args.push) {
				process.stdout.write("No changes to commit; pushing existing commits...\n");
				await pushOrAbort(cwd);
				return;
			}
			process.stderr.write("No changes to commit.\n");
			return;
		}
		throw error;
	}

	const commitMessage = formatConventionalCommit(generated.commit);
	if (args.dryRun) {
		process.stdout.write("\nGenerated commit message:\n");
		process.stdout.write(`${commitMessage}\n`);
		if (generated.validationError) {
			process.stderr.write(`Warning: generated message requires manual correction: ${generated.validationError}\n`);
		}
		return;
	}
	if (generated.validationError) {
		throw new Error(`Generated commit message failed validation: ${generated.validationError}`);
	}

	if (!args.noChangelog) await updateChangelog(cwd, args);
	try {
		await vcs.requireGit(cwd).commitCreate(commitMessage, {});
	} catch (error) {
		if (vcs.isVcsError(error)) abortOnGitFailure("Commit failed", error);
		throw error;
	}
	process.stdout.write("Commit created.\n");
	if (args.push) await pushOrAbort(cwd);
}

async function updateChangelog(cwd: string, args: CommitCommandArgs): Promise<void> {
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	const registry = new ModelRegistry(authStorage);
	await registry.refresh();
	await loadCliExtensionProviders(registry, settings, cwd);
	const primary = await resolvePrimaryModel(args.model, settings, registry);
	const commitSettings = settings.getGroup("commit");
	await runChangelogFlow({
		cwd,
		model: primary.model,
		apiKey: primary.apiKey,
		thinkingLevel: primary.thinkingLevel,
		stagedFiles: await vcs.requireGit(cwd).changedFiles({ cached: true }),
		dryRun: false,
		maxDiffChars: commitSettings.changelogMaxDiffChars,
		onProgress: message => process.stdout.write(`${message}\n`),
	});
}
