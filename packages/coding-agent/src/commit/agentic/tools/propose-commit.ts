import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { CommitAgentState } from "../../../commit/agentic/state";
import {
	capDetails,
	MAX_DETAIL_ITEMS,
	normalizeSummary,
	SUMMARY_MAX_CHARS,
	validateSummaryRules,
	validateTypeConsistency,
} from "../../../commit/agentic/validation";
import { validateAnalysis } from "../../../commit/analysis/validation";
import type { CommitType, ConventionalAnalysis, ConventionalDetail } from "../../../commit/types";
import { normalizeDetails } from "../../../commit/utils";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { commitTypeSchema, detailSchema } from "./schemas.js";

const proposeCommitSchema = type({
	type: commitTypeSchema,
	scope: type("string").or("null"),
	summary: "string",
	details: detailSchema.array(),
	issue_refs: "string[]",
});

interface ProposalResponse {
	valid: boolean;
	errors: string[];
	warnings: string[];
	proposal?: {
		type: CommitType;
		scope: string | null;
		summary: string;
		details: ConventionalDetail[];
		issue_refs: string[];
	};
}

export function createProposeCommitTool(cwd: string, state: CommitAgentState): CustomTool<typeof proposeCommitSchema> {
	const repo = vcs.requireGit(cwd);
	return {
		name: "propose_commit",
		label: "Propose Commit",
		description: "Submit the final conventional commit proposal.",
		parameters: proposeCommitSchema,
		async execute(_toolCallId, params) {
			const scope = params.scope?.trim() || null;
			const summary = normalizeSummary(params.summary, params.type, scope);
			const details = normalizeDetails(params.details);
			const { details: cappedDetails, warnings: detailWarnings } = capDetails(details);
			const analysis: ConventionalAnalysis = {
				type: params.type,
				scope,
				details: cappedDetails,
				issueRefs: params.issue_refs ?? [],
			};

			const summaryValidation = validateSummaryRules(summary);
			const analysisValidation = validateAnalysis(analysis);
			const stagedFiles = state.overview?.files ?? (await repo.changedFiles({ cached: true }));
			const diffText = state.diffText ?? (await repo.diffText({ cached: true }));
			const typeValidation = validateTypeConsistency(params.type, stagedFiles, {
				diffText,
				summary,
				details: cappedDetails,
			});

			const errors = [...summaryValidation.errors, ...analysisValidation.errors, ...typeValidation.errors];
			const warnings = [...summaryValidation.warnings, ...detailWarnings, ...typeValidation.warnings];

			const response: ProposalResponse = {
				valid: errors.length === 0,
				errors,
				warnings,
			};

			if (response.valid) {
				response.proposal = {
					type: analysis.type,
					scope: analysis.scope,
					summary,
					details: analysis.details,
					issue_refs: analysis.issueRefs,
				};
				state.proposal = {
					analysis,
					summary,
					warnings,
				};
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
