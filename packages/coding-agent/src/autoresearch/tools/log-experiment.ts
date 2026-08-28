import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Text } from "@oh-my-pi/pi-tui";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { computeRunModifiedPaths, getCurrentAutoresearchBranch, parseWorkDirDirtyPaths } from "../git";
import {
	ensureNumericMetricMap,
	formatNum,
	mergeAsi,
	pathMatchesSpec,
	sanitizeAsi,
	tryGitPrefix,
	tryGitStatus,
} from "../helpers";
import {
	buildExperimentState,
	computeConfidence,
	currentResults,
	findBaselineSecondary,
	findBestKeptMetric,
} from "../state";
import { openAutoresearchStorageIfExists, type SessionRow } from "../storage";
import type {
	ASIData,
	AutoresearchToolFactoryOptions,
	ExperimentResult,
	ExperimentState,
	LogDetails,
	NumericMetricMap,
} from "../types";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

const logExperimentSchema = type({
	metric: type("number").describe("primary metric value"),
	status: type("'keep'|'discard'|'crash'|'checks_failed'").describe("run outcome"),
	description: type("string").describe("short run description"),
	"metrics?": type({ "[string]": "number" }).describe("secondary metrics"),
	"asi?": type({ "[string]": "unknown" }).describe("free-form structured metadata"),
	"commit?": type("string").describe("override recorded commit hash"),
	"justification?": type("string").describe("required when keeping a scope-deviating run"),
	"flag_runs?": type({
		run_id: type("number.integer").describe("run id to flag"),
		reason: type("string").describe("why this run is suspect"),
	})
		.array()
		.describe("flag earlier runs as suspect"),
});

export function createLogExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof logExperimentSchema, LogDetails> {
	return {
		name: "log_experiment",
		label: "Log Experiment",
		description:
			"Log the result of the latest run_experiment. Records the metric, optional ASI metadata, modified paths, and scope deviations. On `keep`, modified files are committed; on `discard`/`crash`/`checks_failed`, the worktree is reverted. Pass `flag_runs` to mark earlier runs as suspect; flagged runs are excluded from baseline and best-metric math.",
		parameters: logExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await vcs.git(ctx.cwd)?.currentBranch()) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
						},
					],
				};
			}
			const pendingRun = storage.getPendingRun(session.id);
			if (!pendingRun) {
				return {
					content: [{ type: "text", text: "Error: no pending run available. Run run_experiment first." }],
				};
			}

			const runtime = options.getRuntime(ctx);

			const flaggedRuns: LogDetails["flaggedRuns"] = [];
			for (const flag of params.flag_runs ?? []) {
				const target = storage.getRunById(flag.run_id);
				if (!target || target.sessionId !== session.id) continue;
				storage.flagRun(flag.run_id, flag.reason);
				flaggedRuns.push({ runId: flag.run_id, reason: flag.reason });
			}

			const branchName = await getCurrentAutoresearchBranch(options.pi, ctx.cwd);
			const onAutoresearchBranch = branchName !== null;

			let allModified: string[];
			if (onAutoresearchBranch) {
				// On a dedicated autoresearch branch every iteration starts from a clean
				// worktree (init_experiment baseline + previous keep commit / discard reset),
				// so any currently-dirty path is the agent's iteration change. Off-branch we
				// can't tell user dirt apart from agent edits, so we keep the (lossy)
				// preRunDirtyPaths filter.
				const statusText = await tryGitStatus(ctx.cwd);
				const workDirPrefix = await tryGitPrefix(ctx.cwd);
				allModified = parseWorkDirDirtyPaths(statusText, workDirPrefix);
			} else {
				const { modifiedTracked, modifiedUntracked } = await detectModifiedPaths(
					ctx.cwd,
					pendingRun.preRunDirtyPaths,
				);
				allModified = [...modifiedTracked, ...modifiedUntracked];
			}
			const scopeDeviations = computeScopeDeviations(allModified, session);

			const justification = params.justification?.trim() || null;
			const warnings: string[] = [];

			const headSha = await tryReadHeadSha(ctx.cwd);
			const explicitCommit = params.commit?.trim();
			let commitHash = explicitCommit && explicitCommit.length > 0 ? explicitCommit : headSha;

			let gitNote: string | null = null;
			if (params.status === "keep") {
				if (onAutoresearchBranch && allModified.length > 0) {
					const commitResult = await commitKeptExperiment(
						ctx.cwd,
						params.description,
						params.status,
						params.metric,
						params.metrics ?? {},
						allModified,
						session.primaryMetric,
					);
					if (commitResult.error) {
						return {
							content: [{ type: "text", text: `Error: ${commitResult.error}` }],
						};
					}
					gitNote = commitResult.note ?? null;
					const newSha = await tryReadHeadSha(ctx.cwd);
					if (newSha) commitHash = newSha;
				} else if (!onAutoresearchBranch) {
					warnings.push(
						"Auto-commit skipped: not on a dedicated autoresearch branch. Modified files remain in the worktree.",
					);
				} else if (allModified.length === 0) {
					gitNote = "nothing to commit";
				}
				if (scopeDeviations.length > 0) {
					if (justification === null) {
						warnings.push(
							`Kept with unjustified scope deviations: ${scopeDeviations.join(", ")}. Pass \`justification\` next time or \`flag_runs\` this entry on a future log_experiment if it was a mistake.`,
						);
					} else {
						warnings.push(`Kept with scope deviations (justified): ${scopeDeviations.join(", ")}`);
					}
				}
			} else {
				const revertResult = await revertFailedExperiment(
					ctx.cwd,
					pendingRun.preRunDirtyPaths,
					onAutoresearchBranch,
				);
				if (revertResult.error) {
					return {
						content: [{ type: "text", text: `Error: ${revertResult.error}` }],
					};
				}
				gitNote = revertResult.note ?? null;
			}

			const metric = params.metric;
			const secondaryMetrics: NumericMetricMap = mergeMetrics(
				pendingRun.parsedMetrics,
				params.metrics,
				session.primaryMetric,
			);
			const asi: ASIData | undefined = mergeAsi(pendingRun.parsedAsi, sanitizeAsi(params.asi));

			if (pendingRun.parsedPrimary !== null && metric !== pendingRun.parsedPrimary) {
				warnings.push(
					`Logged metric ${metric} differs from parsed primary ${pendingRun.parsedPrimary}. Both values stored.`,
				);
			}

			const loggedAt = Date.now();
			const tentativeRun = storage.markRunLogged({
				runId: pendingRun.id,
				status: params.status,
				description: params.description,
				metric,
				metrics: secondaryMetrics,
				asi: asi ?? null,
				commitHash,
				confidence: null,
				modifiedPaths: allModified,
				scopeDeviations,
				justification,
				loggedAt,
			});

			// Recompute confidence with this run included
			const refreshedSession = storage.getSessionById(session.id) ?? session;
			const loggedRuns = storage.listLoggedRuns(session.id);
			const stateForConfidence = buildExperimentState(refreshedSession, loggedRuns);
			const confidence = computeConfidence(
				stateForConfidence.results,
				stateForConfidence.currentSegment,
				stateForConfidence.bestDirection,
			);
			storage.updateRunConfidence(tentativeRun.id, confidence);

			const finalState = buildExperimentState(refreshedSession, storage.listLoggedRuns(session.id));
			runtime.state = finalState;
			runtime.runningExperiment = null;
			runtime.lastRunSummary = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;

			const experiment: ExperimentResult = {
				runNumber: tentativeRun.id,
				commit: (commitHash ?? "").slice(0, 12),
				metric,
				metrics: secondaryMetrics,
				status: params.status,
				description: params.description,
				timestamp: loggedAt,
				segment: pendingRun.segment,
				confidence,
				asi,
				modifiedPaths: allModified,
				scopeDeviations,
				justification,
				flagged: false,
				flaggedReason: null,
			};

			const segmentRunCount = currentResults(finalState.results, finalState.currentSegment).length;
			if (finalState.maxExperiments !== null && segmentRunCount >= finalState.maxExperiments) {
				runtime.autoresearchMode = false;
				options.pi.appendEntry(
					"autoresearch-control",
					runtime.goal ? { mode: "off", goal: runtime.goal } : { mode: "off" },
				);
				await options.pi.setActiveTools(
					options.pi.getActiveTools().filter(name => !EXPERIMENT_TOOL_NAMES.includes(name)),
				);
			}

			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const wallClockSeconds = pendingRun.durationMs !== null ? pendingRun.durationMs / 1000 : null;
			const text = buildLogText(
				finalState,
				experiment,
				segmentRunCount,
				wallClockSeconds,
				gitNote,
				warnings,
				flaggedRuns,
			);

			return {
				content: [{ type: "text", text }],
				details: {
					experiment,
					state: finalState,
					wallClockSeconds,
					scopeDeviations,
					justification,
					flaggedRuns,
				},
			};
		},
		renderCall(args, _options, theme): Text {
			const color = args.status === "keep" ? "success" : args.status === "discard" ? "warning" : "error";
			const description = truncateToWidth(replaceTabs(args.description), 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(color, args.status)} ${theme.fg("muted", description)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme): Text {
			const details = result.details;
			if (!details) {
				return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
			}
			return new Text(renderSummary(details, theme), 0, 0);
		},
	};
}

interface KeepCommitResult {
	error?: string;
	note?: string;
}

async function commitKeptExperiment(
	cwd: string,
	description: string,
	status: ExperimentResult["status"],
	metric: number,
	metrics: NumericMetricMap,
	files: string[],
	primaryMetric: string,
): Promise<KeepCommitResult> {
	if (files.length === 0) return { note: "nothing to commit" };
	const repository = vcs.requireGit(cwd);
	try {
		await repository.stageFiles(files);
	} catch (err) {
		return { error: `git add failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!(await repository.hasDiff({ cached: true, files }))) {
		return { note: "nothing to commit" };
	}
	const payload: { [key: string]: string | number } = {
		status,
		[primaryMetric]: metric,
	};
	for (const [name, value] of Object.entries(metrics)) {
		payload[name] = value;
	}
	const commitMessage = `${description}\n\nResult: ${JSON.stringify(payload)}`;
	try {
		const commitSha = await repository.commitCreate(commitMessage, { files });
		return { note: `committed ${commitSha.slice(0, 12)}` };
	} catch (err) {
		return { error: `git commit failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

async function revertFailedExperiment(
	cwd: string,
	preRunDirtyPaths: string[],
	onAutoresearchBranch: boolean,
): Promise<KeepCommitResult> {
	if (onAutoresearchBranch) {
		// Discard reverts only the current iteration's uncommitted changes — never
		// rewinds prior `keep` commits. Reset to HEAD so any kept improvements
		// already on the branch survive.
		try {
			const repository = vcs.requireGit(cwd);
			await repository.reset("hard", "HEAD");
			await repository.clean({});
			return { note: "worktree reset to HEAD" };
		} catch (err) {
			return { error: `git reset/clean failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const statusText = await tryGitStatus(cwd);
	const workDirPrefix = await tryGitPrefix(cwd);
	const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
	const total = tracked.length + untracked.length;
	if (total === 0) return { note: "nothing to revert" };
	if (tracked.length > 0) {
		try {
			await vcs.requireGit(cwd).restore({ files: tracked, source: "HEAD", staged: true, worktree: true });
		} catch (err) {
			return { error: `git restore failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	for (const filePath of untracked) {
		try {
			fs.rmSync(path.join(cwd, filePath), { force: true, recursive: true });
		} catch {
			// best effort
		}
	}
	return { note: `reverted ${total} file${total === 1 ? "" : "s"}` };
}

async function detectModifiedPaths(
	cwd: string,
	preRunDirtyPaths: string[],
): Promise<{ modifiedTracked: string[]; modifiedUntracked: string[] }> {
	const statusText = await tryGitStatus(cwd);
	const workDirPrefix = await tryGitPrefix(cwd);
	const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
	return { modifiedTracked: tracked, modifiedUntracked: untracked };
}

function computeScopeDeviations(modifiedPaths: string[], session: SessionRow): string[] {
	const deviations: string[] = [];
	for (const filePath of modifiedPaths) {
		if (session.offLimits.some(spec => pathMatchesSpec(filePath, spec))) {
			deviations.push(filePath);
			continue;
		}
		if (session.scopePaths.length > 0 && !session.scopePaths.some(spec => pathMatchesSpec(filePath, spec))) {
			deviations.push(filePath);
		}
	}
	return deviations;
}

function mergeMetrics(
	parsed: NumericMetricMap | null,
	overrides: NumericMetricMap | undefined,
	primaryMetricName: string,
): NumericMetricMap {
	const merged: NumericMetricMap = {};
	for (const [name, value] of Object.entries(parsed ?? {})) {
		if (name === primaryMetricName) continue;
		merged[name] = value;
	}
	for (const [name, value] of Object.entries(ensureNumericMetricMap(overrides))) {
		merged[name] = value;
	}
	return merged;
}

async function tryReadHeadSha(cwd: string): Promise<string | null> {
	try {
		return (await vcs.git(cwd)?.headSha()) ?? null;
	} catch {
		return null;
	}
}

function buildLogText(
	state: ExperimentState,
	experiment: ExperimentResult,
	segmentRunCount: number,
	wallClockSeconds: number | null,
	gitNote: string | null,
	warnings: string[],
	flaggedRuns: LogDetails["flaggedRuns"],
): string {
	const displayRunNumber = experiment.runNumber ?? state.results.length;
	const lines = [`Logged run #${displayRunNumber}: ${experiment.status} - ${experiment.description}`];
	if (wallClockSeconds !== null) {
		lines.push(`Wall clock: ${wallClockSeconds.toFixed(1)}s`);
	}
	if (state.bestMetric !== null) {
		lines.push(`Baseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`);
	}
	if (segmentRunCount > 1 && state.bestMetric !== null && experiment.metric !== state.bestMetric) {
		const delta = ((experiment.metric - state.bestMetric) / state.bestMetric) * 100;
		const sign = delta > 0 ? "+" : "";
		lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)} (${sign}${delta.toFixed(1)}%)`);
	} else {
		lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)}`);
	}
	if (Object.keys(experiment.metrics).length > 0) {
		const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
		const parts = Object.entries(experiment.metrics).map(([name, value]) => {
			const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? "";
			const baseline = baselineSecondary[name];
			if (baseline === undefined || baseline === 0 || segmentRunCount === 1) {
				return `${name}: ${formatNum(value, unit)}`;
			}
			const delta = ((value - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			return `${name}: ${formatNum(value, unit)} (${sign}${delta.toFixed(1)}%)`;
		});
		lines.push(`Secondary metrics: ${parts.join("  ")}`);
	}
	const bestKept = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
	if (bestKept !== null && state.bestMetric !== null && bestKept !== state.bestMetric) {
		lines.push(`Best kept ${state.metricName}: ${formatNum(bestKept, state.metricUnit)}`);
	}
	if (experiment.asi) {
		const asiSummary = Object.entries(experiment.asi)
			.map(([key, value]) => `${key}: ${truncateAsiValue(value)}`)
			.join(" | ");
		lines.push(`ASI: ${asiSummary}`);
	}
	if (state.confidence !== null) {
		const status = state.confidence >= 2 ? "likely real" : state.confidence >= 1 ? "marginal" : "within noise";
		lines.push(`Confidence: ${state.confidence.toFixed(1)}x noise floor (${status})`);
	}
	if (gitNote) {
		lines.push(`Git: ${gitNote}`);
	}
	if (state.maxExperiments !== null) {
		lines.push(`Progress: ${segmentRunCount}/${state.maxExperiments} runs in current segment`);
		if (segmentRunCount >= state.maxExperiments) {
			lines.push(`Maximum experiments reached (${state.maxExperiments}). Autoresearch mode is now off.`);
		}
	}
	if (flaggedRuns.length > 0) {
		const formatted = flaggedRuns.map(({ runId, reason }) => `#${runId} (${reason})`).join(", ");
		lines.push(`Flagged: ${formatted}`);
	}
	for (const warning of warnings) {
		lines.push(`Warning: ${warning}`);
	}
	return lines.join("\n");
}

function truncateAsiValue(value: ASIData[string]): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function renderSummary(details: LogDetails, theme: Theme): string {
	const { experiment, state } = details;
	const color = experiment.status === "keep" ? "success" : experiment.status === "discard" ? "warning" : "error";
	let summary = `${theme.fg(color, experiment.status.toUpperCase())} ${theme.fg("muted", truncateToWidth(replaceTabs(experiment.description), 100))}`;
	summary += ` ${theme.fg("accent", `${state.metricName}=${formatNum(experiment.metric, state.metricUnit)}`)}`;
	if (state.bestMetric !== null) {
		summary += ` ${theme.fg("dim", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`)}`;
	}
	if (state.confidence !== null) {
		summary += ` ${theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`)}`;
	}
	if (details.scopeDeviations.length > 0) {
		summary += ` ${theme.fg("warning", `deviations:${details.scopeDeviations.length}`)}`;
	}
	return summary;
}
