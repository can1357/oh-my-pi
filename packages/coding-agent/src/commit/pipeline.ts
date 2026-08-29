import * as path from "node:path";
import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { getProjectDir, logger, prompt } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { loadProjectContextFiles } from "../system-prompt";
import * as git from "../utils/git";
import { runAgenticCommit } from "./agentic";
import {
	extractScopeCandidates,
	generateConventionalAnalysis,
	generateSummary,
	validateAnalysis,
	validateSummary,
} from "./analysis";
import { runChangelogFlow } from "./changelog";
import { runMapReduceAnalysis, shouldUseMapReduce } from "./map-reduce";
import { formatCommitMessage } from "./message";
import { resolvePrimaryModel, resolveSmolModel } from "./model-selection";
import summaryRetryPrompt from "./prompts/summary-retry.md" with { type: "text" };
import typesDescriptionPrompt from "./prompts/types-description.md" with { type: "text" };
import type { CommitCommandArgs, ConventionalAnalysis } from "./types";

const SUMMARY_MAX_CHARS = 72;
const RECENT_COMMITS_COUNT = 8;
let typesDescription: string | undefined;
const TYPES_DESCRIPTION = (): string => (typesDescription ??= prompt.render(typesDescriptionPrompt));

/**
 * Execute the omp commit pipeline for staged changes.
 */
export async function runCommitCommand(args: CommitCommandArgs): Promise<void> {
	if (args.legacy) {
		return runLegacyCommitCommand(args);
	}
	return runAgenticCommit(args);
}

async function runLegacyCommitCommand(args: CommitCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init();
	const commitSettings = settings.getGroup("commit");
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();

	const {
		model: primaryModel,
		apiKey: primaryApiKey,
		thinkingLevel: primaryThinkingLevel,
		serviceTier: primaryServiceTier,
	} = await resolvePrimaryModel(args.model, settings, modelRegistry);
	const {
		model: smolModel,
		apiKey: smolApiKey,
		thinkingLevel: smolThinkingLevel,
		serviceTier: smolServiceTier,
	} = await resolveSmolModel(settings, modelRegistry, primaryModel, primaryApiKey);

	let stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	if (stagedFiles.length === 0) {
		process.stdout.write("No staged changes detected, staging all changes...\n");
		await git.stage.files(cwd);
		stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	}
	if (stagedFiles.length === 0) {
		process.stderr.write("No changes to commit.\n");
		return;
	}

	if (!args.noChangelog) {
		await runChangelogFlow({
			cwd,
			model: primaryModel,
			apiKey: primaryApiKey,
			thinkingLevel: primaryThinkingLevel,
			serviceTier: primaryServiceTier,
			stagedFiles,
			dryRun: args.dryRun,
			maxDiffChars: commitSettings.changelogMaxDiffChars,
		});
	}

	const diff = await git.diff(cwd, { cached: true });
	const stat = await git.diff(cwd, { stat: true, cached: true });
	const numstat = await git.diff.numstat(cwd, { cached: true });
	const scopeCandidates = extractScopeCandidates(numstat).scopeCandidates;
	const recentCommits = await git.log.subjects(cwd, RECENT_COMMITS_COUNT);
	const contextFiles = await loadProjectContextFiles({ cwd });
	const formattedContextFiles = contextFiles.map(file => ({
		path: path.relative(cwd, file.path),
		content: file.content,
	}));

	const analysis = await generateAnalysis({
		diff,
		stat,
		scopeCandidates,
		recentCommits,
		contextFiles: formattedContextFiles,
		userContext: args.context,
		primaryModel,
		primaryApiKey,
		primaryThinkingLevel,
		primaryServiceTier,
		smolModel,
		smolApiKey,
		smolThinkingLevel,
		smolServiceTier,
		commitSettings,
	});

	const analysisValidation = validateAnalysis(analysis);
	if (!analysisValidation.valid) {
		logger.warn("commit analysis validation failed", { errors: analysisValidation.errors });
	}

	const summary = await generateSummaryWithRetry({
		analysis,
		stat,
		model: primaryModel,
		apiKey: primaryApiKey,
		thinkingLevel: primaryThinkingLevel,
		serviceTier: primaryServiceTier,
		userContext: args.context,
	});

	const commitMessage = formatCommitMessage(analysis, summary.summary);

	if (args.dryRun) {
		process.stdout.write("\nGenerated commit message:\n");
		process.stdout.write(`${commitMessage}\n`);
		return;
	}

	await git.commit(cwd, commitMessage);
	process.stdout.write("Commit created.\n");
	if (args.push) {
		await git.push(cwd);
		process.stdout.write("Pushed to remote.\n");
	}
}

async function generateAnalysis(input: {
	diff: string;
	stat: string;
	scopeCandidates: string;
	recentCommits: string[];
	contextFiles: Array<{ path: string; content: string }>;
	userContext?: string;
	primaryModel: Model<Api>;
	primaryApiKey: ApiKey;
	primaryThinkingLevel?: ThinkingLevel;
	primaryServiceTier?: ServiceTier;
	smolModel: Model<Api>;
	smolApiKey: ApiKey;
	smolThinkingLevel?: ThinkingLevel;
	smolServiceTier?: ServiceTier;
	commitSettings: {
		mapReduceEnabled: boolean;
		mapReduceMinFiles: number;
		mapReduceMaxFileTokens: number;
		mapReduceTimeoutMs: number;
		mapReduceMaxConcurrency: number;
		changelogMaxDiffChars: number;
	};
}): Promise<ConventionalAnalysis> {
	if (
		shouldUseMapReduce(input.diff, {
			enabled: input.commitSettings.mapReduceEnabled,
			minFiles: input.commitSettings.mapReduceMinFiles,
			maxFileTokens: input.commitSettings.mapReduceMaxFileTokens,
		})
	) {
		process.stdout.write("Large diff detected, using map-reduce analysis...\n");
		return runMapReduceAnalysis({
			model: input.primaryModel,
			apiKey: input.primaryApiKey,
			thinkingLevel: input.primaryThinkingLevel,
			serviceTier: input.primaryServiceTier,
			smolModel: input.smolModel,
			smolApiKey: input.smolApiKey,
			smolThinkingLevel: input.smolThinkingLevel,
			smolServiceTier: input.smolServiceTier,
			diff: input.diff,
			stat: input.stat,
			scopeCandidates: input.scopeCandidates,
			typesDescription: TYPES_DESCRIPTION(),
			settings: {
				enabled: input.commitSettings.mapReduceEnabled,
				minFiles: input.commitSettings.mapReduceMinFiles,
				maxFileTokens: input.commitSettings.mapReduceMaxFileTokens,
				maxConcurrency: input.commitSettings.mapReduceMaxConcurrency,
				timeoutMs: input.commitSettings.mapReduceTimeoutMs,
			},
		});
	}

	return generateConventionalAnalysis({
		model: input.primaryModel,
		apiKey: input.primaryApiKey,
		thinkingLevel: input.primaryThinkingLevel,
		serviceTier: input.primaryServiceTier,
		contextFiles: input.contextFiles,
		userContext: input.userContext,
		typesDescription: TYPES_DESCRIPTION(),
		recentCommits: input.recentCommits,
		scopeCandidates: input.scopeCandidates,
		stat: input.stat,
		diff: input.diff,
	});
}

async function generateSummaryWithRetry(input: {
	analysis: ConventionalAnalysis;
	stat: string;
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	userContext?: string;
}): Promise<{ summary: string }> {
	let context = input.userContext;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const result = await generateSummary({
			model: input.model,
			apiKey: input.apiKey,
			thinkingLevel: input.thinkingLevel,
			serviceTier: input.serviceTier,
			commitType: input.analysis.type,
			scope: input.analysis.scope,
			details: input.analysis.details.map(detail => detail.text),
			stat: input.stat,
			maxChars: SUMMARY_MAX_CHARS,
			userContext: context,
		});
		const validation = validateSummary(result.summary, SUMMARY_MAX_CHARS);
		if (validation.valid) {
			return result;
		}
		if (attempt === 2) {
			return result;
		}
		context = buildRetryContext(input.userContext, validation.errors);
	}
	throw new Error("Summary generation failed");
}

function buildRetryContext(base: string | undefined, errors: string[]): string {
	return prompt.render(summaryRetryPrompt, {
		base_context: base,
		errors: errors.join("; "),
	});
}
