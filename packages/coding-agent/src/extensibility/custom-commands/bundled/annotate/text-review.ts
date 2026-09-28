import { prompt } from "@oh-my-pi/pi-utils";
import textReviewTemplate from "./prompts/text-review.md" with { type: "text" };
import type { TextReviewAnnotation, TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";

const SHORT_SOURCE_CHARACTER_LIMIT = 1000;

/** Pick a Markdown fence that cannot occur in the supplied exact value. */
export function markdownFenceFor(value: string): string {
	let longestRun = 0;
	let run = 0;
	for (const character of value) {
		if (character === "`") {
			run++;
			if (run > longestRun) longestRun = run;
		} else {
			run = 0;
		}
	}
	return "`".repeat(Math.max(3, longestRun + 1));
}

function shouldIncludeSource(source: TextReviewSource): boolean {
	if (source.kind === "code" || source.kind === "command" || source.kind === "file" || source.kind === "prompt") {
		return true;
	}
	if (source.provenance?.kind === "latest-assistant") return false;
	return source.text.length <= SHORT_SOURCE_CHARACTER_LIMIT;
}

export function shouldSummarizeTextReviewSource(source: TextReviewSource): boolean {
	return source.provenance?.kind === "session" && !shouldIncludeSource(source);
}

export function normalizeTextReviewContextSummary(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 0 && trimmed.length <= 999 ? trimmed : "";
}

function sanitizePreviewLabel(value: string, maxLength = 96): string {
	const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
	const oneLine = withoutAnsi
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

interface RenderedTextAnnotation {
	number: number;
	isLine: boolean;
	quote?: string;
	note: string;
	quoteIsInline?: boolean;
	quoteFence?: string;
}

function exactPlaceholder(label: string, index: number, values: readonly string[]): string {
	let suffix = 0;
	let placeholder = `__OMP_ANNOTATE_${label}_${index}_${suffix}__`;
	while (values.some(value => value.includes(placeholder))) {
		placeholder = `__OMP_ANNOTATE_${label}_${index}_${++suffix}__`;
	}
	return placeholder;
}

/** Restore caller text after the prompt renderer has normalized its static template. */
function restoreExactValues(rendered: string, replacements: readonly (readonly [string, string])[]): string {
	let result = rendered;
	for (const [placeholder, value] of replacements) {
		if (result.includes(placeholder)) result = result.replace(placeholder, () => value);
	}
	return result;
}

/** Build one paste-only text feedback prompt; empty annotations produce no prompt. */
export function buildTextReviewPrompt(
	source: TextReviewSource,
	annotations: readonly TextReviewAnnotation[],
	contextSummary?: string,
): string | undefined {
	if (annotations.length === 0) return undefined;
	const summary = shouldSummarizeTextReviewSource(source)
		? normalizeTextReviewContextSummary(contextSummary ?? "")
		: "";
	const sourceLabel =
		source.kind === "message" && source.provenance?.kind === "latest-assistant"
			? "your last reply"
			: sanitizePreviewLabel(source.label) || `${source.kind} source`;
	const exactValues = [
		source.text,
		summary,
		source.label,
		sourceLabel,
		...annotations.flatMap(annotation =>
			annotation.scope === "line" ? [annotation.quote, annotation.note] : [annotation.note],
		),
	];
	const replacements: Array<readonly [string, string]> = [];
	let placeholderIndex = 0;
	const exact = (label: string, value: string): string => {
		const placeholder = exactPlaceholder(label, placeholderIndex++, exactValues);
		replacements.push([placeholder, value]);
		return placeholder;
	};
	const sourceText = exact("SOURCE", source.text);
	const summaryText = summary ? exact("SUMMARY", summary) : "";
	const renderedAnnotations: RenderedTextAnnotation[] = annotations.map((annotation, index) => {
		const note = exact("NOTE", annotation.note);
		if (annotation.scope === "text") {
			return { number: index + 1, isLine: false, note };
		}
		const quoteIsInline = !/[\r\n`]/.test(annotation.quote);
		return {
			number: index + 1,
			isLine: true,
			quote: exact("QUOTE", annotation.quote),
			note,
			quoteIsInline,
			quoteFence: quoteIsInline ? undefined : markdownFenceFor(annotation.quote),
		};
	});
	const rendered = prompt.render(textReviewTemplate, {
		sourceLabel,
		includeSource: shouldIncludeSource(source) || (shouldSummarizeTextReviewSource(source) && !summary),
		sourceFence: markdownFenceFor(source.text),
		sourceText,
		contextSummary: summaryText,
		summaryFence: summary ? markdownFenceFor(summary) : "```",
		annotations: renderedAnnotations,
	});
	return restoreExactValues(rendered, replacements);
}
