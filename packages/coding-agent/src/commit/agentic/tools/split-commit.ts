import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { CommitAgentState, SplitCommitGroup, SplitCommitPlan } from "../../../commit/agentic/state";
import { computeDependencyOrder } from "../../../commit/agentic/topo-sort";
import {
	capDetails,
	MAX_DETAIL_ITEMS,
	normalizeSummary,
	SUMMARY_MAX_CHARS,
	validateSummaryRules,
	validateTypeConsistency,
} from "../../../commit/agentic/validation";
import { validateScope } from "../../../commit/analysis/validation";
import { normalizeDetails } from "../../../commit/utils";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { commitTypeSchema, detailSchema } from "./schemas.js";

const fileChangeSchema = type({ path: "string", kind: "'all'" })
	.or({ path: "string", kind: "'indices'", indices: "number[]" })
	.or({ path: "string", kind: "'lines'", start: "number", end: "number" });

const commitItemSchema = type({
	changes: fileChangeSchema.array(),
	type: commitTypeSchema,
	scope: type("string").or("null"),
	summary: "string",
	"details?": detailSchema.array(),
	"issue_refs?": "string[]",
	"rationale?": "string",
	"dependencies?": "number[]",
});

const splitCommitSchema = type({
	commits: commitItemSchema.array(),
});

interface SplitCommitResponse {
	valid: boolean;
	errors: string[];
	warnings: string[];
	proposal?: SplitCommitPlan;
}

export function createSplitCommitTool(
	cwd: string,
	state: CommitAgentState,
	changelogTargets: string[],
): CustomTool<typeof splitCommitSchema> {
	const repo = vcs.requireGit(cwd);
	return {
		name: "split_commit",
		label: "Split Commit",
		description: "Propose multiple atomic commits for unrelated changes.",
		parameters: splitCommitSchema,
		async execute(_toolCallId, params) {
			const stagedFiles = state.overview?.files ?? (await repo.changedFiles({ cached: true }));
			const stagedSet = new Set(stagedFiles);
			const changelogSet = new Set(changelogTargets);
			const usedFiles = new Set<string>();
			const errors: string[] = [];
			const warnings: string[] = [];
			const diffText = await repo.diffText({ cached: true });

			const commits: SplitCommitGroup[] = params.commits.map((commit, index) => {
				const scope = commit.scope?.trim() || null;
				const summary = normalizeSummary(commit.summary, commit.type, scope);
				const detailInput = normalizeDetails(commit.details ?? []);
				const detailResult = capDetails(detailInput);
				warnings.push(...detailResult.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
				const issueRefs = commit.issue_refs ?? [];
				const dependencies = (commit.dependencies ?? []).map(dep => Math.floor(dep));
				const changes = commit.changes.map(change => ({
					path: change.path,
					kind: change.kind,
					indices: change.kind === "indices" ? change.indices : undefined,
					start: change.kind === "lines" ? change.start : undefined,
					end: change.kind === "lines" ? change.end : undefined,
				}));
				const files = changes.map(change => change.path);

				const summaryValidation = validateSummaryRules(summary);
				const scopeValidation = validateScope(scope);
				const typeValidation = validateTypeConsistency(commit.type, files, {
					diffText,
					summary,
					details: detailResult.details,
				});

				if (summaryValidation.errors.length > 0) {
					errors.push(...summaryValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
				}
				if (!scopeValidation.valid) {
					errors.push(...scopeValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
				}
				if (typeValidation.errors.length > 0) {
					errors.push(...typeValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
				}
				warnings.push(...summaryValidation.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
				warnings.push(...typeValidation.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
				const hunkValidation = validateHunkSelectors(index, changes, files, diffText);
				warnings.push(...hunkValidation.warnings);
				errors.push(...hunkValidation.errors);
				errors.push(...validateDependencies(index, dependencies, params.commits.length));

				return {
					changes,
					type: commit.type,
					scope,
					summary,
					details: detailResult.details,
					issueRefs,
					rationale: commit.rationale?.trim() || undefined,
					dependencies,
				};
			});

			for (const commit of commits) {
				const seen = new Set<string>();
				for (const change of commit.changes) {
					const file = change.path;
					if (!stagedSet.has(file) && !changelogSet.has(file)) {
						errors.push(`File not staged: ${file}`);
						continue;
					}
					if (seen.has(file)) {
						errors.push(`File listed multiple times in commit ${commit.summary}: ${file}`);
						continue;
					}
					if (usedFiles.has(file)) {
						errors.push(`File appears in multiple commits: ${file}`);
						continue;
					}
					seen.add(file);
					usedFiles.add(file);
				}
			}

			for (const file of stagedFiles) {
				if (!usedFiles.has(file)) {
					errors.push(`Staged file missing from split plan: ${file}`);
				}
			}

			const dependencyCheck = computeDependencyOrder(commits);
			if ("error" in dependencyCheck) {
				errors.push(dependencyCheck.error);
			}

			const response: SplitCommitResponse = {
				valid: errors.length === 0,
				errors,
				warnings,
			};

			if (response.valid) {
				response.proposal = { commits, warnings };
				state.splitProposal = response.proposal;
			}

			const text = JSON.stringify(
				{
					...response,
					constraints: {
						maxSummaryChars: SUMMARY_MAX_CHARS,
						maxDetailItems: MAX_DETAIL_ITEMS,
					},
				},
				null,
				2,
			);

			return {
				content: [{ type: "text", text }],
				details: response,
			};
		},
	};
}

function validateHunkSelectors(
	commitIndex: number,
	changes: SplitCommitGroup["changes"],
	files: string[],
	rawDiff: string,
): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const prefix = `Commit ${commitIndex + 1}`;
	if (files.length === 0) {
		errors.push(`${prefix}: no files specified`);
		return { errors, warnings };
	}
	for (const change of changes) {
		if (change.kind === "indices") {
			const invalid =
				change.indices?.filter(value => !Number.isFinite(value) || Math.floor(value) !== value || value < 1) ?? [];
			if (invalid.length > 0) {
				errors.push(`${prefix}: invalid hunk indices for ${change.path}`);
			}
			continue;
		}
		if (change.kind === "lines") {
			const { start, end } = change;
			if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
				errors.push(`${prefix}: invalid line range for ${change.path}`);
				continue;
			}
			if (Math.floor(start) !== start || Math.floor(end) !== end || start < 1 || end < start) {
				errors.push(`${prefix}: invalid line range for ${change.path}`);
			}
		}
	}
	if (errors.length === 0) {
		for (const error of vcs.validateHunkSelections(rawDiff, changes)) {
			errors.push(`${prefix}: ${error.message}`);
		}
	}
	return { errors, warnings };
}

function validateDependencies(commitIndex: number, dependencies: number[], totalCommits: number): string[] {
	const errors: string[] = [];
	const prefix = `Commit ${commitIndex + 1}`;
	for (const dependency of dependencies) {
		if (!Number.isFinite(dependency) || Math.floor(dependency) !== dependency) {
			errors.push(`${prefix}: dependency index must be an integer`);
			continue;
		}
		if (dependency === commitIndex) {
			errors.push(`${prefix}: cannot depend on itself`);
			continue;
		}
		if (dependency < 0 || dependency >= totalCommits) {
			errors.push(`${prefix}: dependency index out of range (${dependency})`);
		}
	}
	return errors;
}
