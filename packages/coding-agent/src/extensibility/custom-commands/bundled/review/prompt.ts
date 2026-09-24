import { prompt } from "@oh-my-pi/pi-utils";
import annotationsTemplate from "./prompts/annotations.md" with { type: "text" };
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import type { CodeReviewAnnotation, ReviewDiffFile } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { getRecommendedReviewAgentCount, getReviewDiffPreview } from "./diff";
import type { ResolvedReviewTarget } from "./target";

const LARGE_DIFF_CHARACTER_LIMIT = 50_000;
const LARGE_DIFF_FILE_LIMIT = 20;

export interface FormatCodeReviewAnnotationsOptions {
	forReviewer: boolean;
	supplementalInstructions?: string;
}

type RenderedAnnotation = CodeReviewAnnotation & {
	pathLabel: string;
	lineLabel?: string;
	isLine: boolean;
};

interface ReviewPromptFile {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	ext: string;
	hunksPreview: string;
}

function formatPathLabel(annotation: CodeReviewAnnotation): string {
	return annotation.occurrence > 1 ? `${annotation.path} (${annotation.occurrence})` : annotation.path;
}

function formatLineLabel(annotation: Extract<CodeReviewAnnotation, { scope: "line" }>): string {
	if (annotation.oldLine !== undefined && annotation.newLine !== undefined) {
		return `old ${annotation.oldLine}, new ${annotation.newLine}`;
	}
	if (annotation.newLine !== undefined) return `new ${annotation.newLine}`;
	if (annotation.oldLine !== undefined) return `old ${annotation.oldLine}`;
	return "hunk";
}

function renderReviewPromptFile(file: ReviewDiffFile, previewLines: number): ReviewPromptFile {
	return {
		path: file.path,
		linesAdded: file.linesAdded,
		linesRemoved: file.linesRemoved,
		ext: file.path.match(/\.([^.]+)$/)?.[1] ?? "",
		hunksPreview: previewLines > 0 ? getReviewDiffPreview(file.rawDiff, previewLines) : "",
	};
}

/** Formats exact annotations for a reviewer prompt or editor paste. */
export function formatCodeReviewAnnotations(
	annotations: readonly CodeReviewAnnotation[],
	options: FormatCodeReviewAnnotationsOptions,
): string | undefined {
	const supplementalInstructions = options.supplementalInstructions?.trim();
	if (annotations.length === 0 && !supplementalInstructions) return undefined;
	const renderedAnnotations: RenderedAnnotation[] = annotations.map(annotation =>
		annotation.scope === "line"
			? {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					lineLabel: formatLineLabel(annotation),
					isLine: true,
				}
			: {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					isLine: false,
				},
	);
	return prompt.render(annotationsTemplate, {
		forReviewer: options.forReviewer,
		annotations: renderedAnnotations,
		supplementalInstructions,
	});
}

/** Renders a review request from one frozen target snapshot. */
export function buildReviewPrompt(target: ResolvedReviewTarget, additionalInstructions?: string): string {
	const skipDiff =
		target.rawDiff.length > LARGE_DIFF_CHARACTER_LIMIT || target.snapshot.files.length > LARGE_DIFF_FILE_LIMIT;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / target.snapshot.files.length)) : 0;
	const files = target.snapshot.files.map(file => renderReviewPromptFile(file, linesPerFile));
	const agentCount = getRecommendedReviewAgentCount(target.snapshot);
	return prompt.render(reviewRequestTemplate, {
		mode: target.mode,
		files,
		excluded: target.snapshot.excluded,
		totalAdded: target.snapshot.totalAdded,
		totalRemoved: target.snapshot.totalRemoved,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		linesPerFile,
		rawDiff: target.rawDiff.trim(),
		diffInstruction: target.diffInstruction,
		contextInstruction: target.contextInstruction,
		additionalInstructions: additionalInstructions?.trim(),
	});
}
