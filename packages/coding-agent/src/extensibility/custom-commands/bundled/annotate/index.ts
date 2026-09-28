import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandContext,
} from "../../../../extensibility/custom-commands/types";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import type { CodeReviewOverlayResult, TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import {
	extractReviewPrRefFromArgs,
	liveCommandCwd,
	resolvePrReviewTarget,
	ReviewCommand,
	selectReviewChoice,
	type ReviewPrRef,
} from "../review";
import { buildReviewPrompt, formatCodeReviewAnnotations } from "../review/prompt";
import {
	getReviewTargetIssue,
	type LocalReviewKind,
	type ResolvedReviewTarget,
	resolveLocalReviewTarget,
	type ReviewTargetUI,
} from "../review/target";
import { acquireFileTextReviewSource, createPromptTextReviewSource } from "./direct-source";
import { showCodeReviewOverlay, showTextReviewOverlay } from "./fullscreen";
import { selectAnnotationSourceKind, selectSessionTextReviewSource, type AnnotationSourceKind } from "./text-source";
import {
	buildTextReviewPrompt,
	normalizeTextReviewContextSummary,
	shouldSummarizeTextReviewSource,
} from "./text-review";
import { generateTextReviewContextSummary } from "./text-summary";

interface CodeReviewDependencies {
	resolveLocalReviewTarget(
		kind: LocalReviewKind,
		cwd: string,
		ui: ReviewTargetUI,
	): Promise<ResolvedReviewTarget | undefined>;
	resolvePrReviewTarget(
		cwd: string,
		ctx: CustomCommandContext,
		ref: ReviewPrRef,
	): Promise<ResolvedReviewTarget | undefined>;
	showCodeReviewOverlay(
		ctx: CustomCommandContext,
		target: ResolvedReviewTarget,
	): Promise<CodeReviewOverlayResult | undefined>;
}

interface TextAnnotationDependencies {
	selectAnnotationSourceKind: typeof selectAnnotationSourceKind;
	selectSessionTextReviewSource: typeof selectSessionTextReviewSource;
	acquireFileTextReviewSource: typeof acquireFileTextReviewSource;
	createPromptTextReviewSource: typeof createPromptTextReviewSource;
	showTextReviewOverlay: typeof showTextReviewOverlay;
	generateTextReviewContextSummary: typeof generateTextReviewContextSummary;
}

const defaultCodeReviewDependencies: CodeReviewDependencies = {
	resolveLocalReviewTarget,
	resolvePrReviewTarget,
	showCodeReviewOverlay,
};

const defaultTextAnnotationDependencies: TextAnnotationDependencies = {
	selectAnnotationSourceKind,
	selectSessionTextReviewSource,
	acquireFileTextReviewSource,
	createPromptTextReviewSource,
	showTextReviewOverlay,
	generateTextReviewContextSummary,
};

function parseCodeReviewFocus(args: string): string | undefined {
	const match = args.trim().match(/^code-review(?:\s+([\s\S]*))?$/);
	return match ? (match[1]?.trim() ?? "") : undefined;
}

function parseAnnotationSourceKind(args: string): AnnotationSourceKind | undefined {
	const trimmed = args.trim();
	if (trimmed === "last" || trimmed === "session") return trimmed;
	return undefined;
}

function splitReviewArgs(args: string): string[] {
	return args.trim() ? args.trim().split(/\s+/) : [];
}

const ANNOTATE_MODE_COMPLETIONS: readonly AutocompleteItem[] = [
	{
		value: "last ",
		label: "last",
		description: "Annotate the latest assistant reply",
	},
	{
		value: "session ",
		label: "session",
		description: "Annotate a message or code block from this session",
	},
	{
		value: "code-review ",
		label: "code-review",
		description: "Annotate local changes or a GitHub pull request",
	},
];

const ANNOTATE_GUIDANCE_COMPLETIONS: readonly AutocompleteItem[] = [
	{
		value: "./",
		label: "<file path>",
		description: "Annotate a file by path",
		hint: "Annotate a file; paths with spaces stay unquoted",
	},
	{
		value: '"',
		label: '"prompt text"',
		description: "Annotate literal prompt text",
		hint: "Wrap literal prompt text in matching quotes",
	},
];

function buildUnclosedLiteralCompletion(argumentPrefix: string, quote: '"' | "'"): AutocompleteItem {
	const value = `${argumentPrefix}${quote}`;
	return {
		value,
		label: value,
		hint: "Finish with the matching quote to annotate literal prompt text",
	};
}

async function getAnnotateArgumentCompletions(
	argumentPrefix: string,
	fileProvider: CombinedAutocompleteProvider,
): Promise<AutocompleteItem[] | null> {
	const trimmed = argumentPrefix.trim();
	if (trimmed.length === 0) {
		return [...ANNOTATE_MODE_COMPLETIONS, ...ANNOTATE_GUIDANCE_COMPLETIONS];
	}

	const first = trimmed[0];
	if (first === '"' || first === "'") {
		if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) {
			// Keep the generic provider from treating an unfinished literal as a
			// quoted filename and offer the matching closing quote instead.
			return [buildUnclosedLiteralCompletion(argumentPrefix, first)];
		}
		return null;
	}

	if (!/\s/.test(trimmed) && !/\s$/.test(argumentPrefix)) {
		const lower = trimmed.toLowerCase();
		const modes = ANNOTATE_MODE_COMPLETIONS.filter(item => item.label.toLowerCase().startsWith(lower));
		if (modes.length > 0) return modes;
	}

	if (/^(?:last|session|code-review)$/i.test(trimmed) && /\s$/.test(argumentPrefix)) return null;

	// Code-review's remainder is free-form focus/PR text, not a file path.
	if (/^code-review(?:\s|$)/i.test(trimmed)) return null;

	// Quote the synthetic path only while querying the shared provider. This
	// preserves spaces in the complete path token; returned values are unquoted
	// because annotate treats any user-entered quotes as literal prompt syntax.
	const syntheticLine = `/annotate "${trimmed}`;
	const result = await fileProvider.getForceFileSuggestions([syntheticLine], 0, syntheticLine.length);
	if (!result) return null;
	const items = result.items.map(item => ({
		...item,
		value: item.value.startsWith('"')
			? item.value.endsWith('"')
				? item.value.slice(1, -1)
				: item.value.slice(1)
			: item.value,
	}));
	return items.length > 0 ? items : null;
}

async function finishCodeReview(
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
	focus: string | undefined,
	showOverlay: CodeReviewDependencies["showCodeReviewOverlay"],
): Promise<string | undefined> {
	const issue = getReviewTargetIssue(target);
	if (issue) {
		ctx.ui.notify(issue, "warning");
		return undefined;
	}
	const result = await showOverlay(ctx, target);
	if (!result) return undefined;
	const annotations = formatCodeReviewAnnotations(result.annotations, {
		forReviewer: result.action === "review",
		supplementalInstructions: focus,
	});
	if (result.action === "review") return buildReviewPrompt(target, annotations);
	if (annotations) ctx.ui.pasteToEditor(annotations);
	return undefined;
}

/** Run `/annotate code-review`, freezing one target before the overlay opens. */
export async function runCodeReviewCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<CodeReviewDependencies> = {},
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return new ReviewCommand(api).execute(splitReviewArgs(args), ctx);
	}
	const resolved = { ...defaultCodeReviewDependencies, ...dependencies };
	const cwd = liveCommandCwd(api, ctx);
	const parsed = extractReviewPrRefFromArgs(splitReviewArgs(args));
	const focus = parsed.extraInstructions || undefined;
	const choice = parsed.prRef ? { kind: "pr" as const, ref: parsed.prRef } : await selectReviewChoice(ctx);
	if (!choice) return undefined;
	const target =
		choice.kind === "pr"
			? await resolved.resolvePrReviewTarget(cwd, ctx, choice.ref)
			: await resolved.resolveLocalReviewTarget(choice.kind, cwd, ctx.ui);
	return target ? finishCodeReview(ctx, target, focus, resolved.showCodeReviewOverlay) : undefined;
}

/** Run `/annotate` text sources; all resulting feedback is pasted, never submitted. */
export async function runAnnotateCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<TextAnnotationDependencies & CodeReviewDependencies> = {},
): Promise<string | undefined> {
	const codeReviewFocus = parseCodeReviewFocus(args);
	if (codeReviewFocus !== undefined) {
		return runCodeReviewCommand(api, codeReviewFocus, ctx, dependencies);
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Text annotation requires the interactive UI. Re-run /annotate from an interactive session; no message was sent.",
			"error",
		);
		return undefined;
	}
	const textDependencies = { ...defaultTextAnnotationDependencies, ...dependencies };
	const trimmed = args.trim();
	let kind: AnnotationSourceKind | undefined;
	let source: TextReviewSource | undefined;
	if (trimmed.length === 0) {
		kind = await textDependencies.selectAnnotationSourceKind(ctx.ui);
	} else {
		const first = trimmed[0];
		const isQuoted = (first === '"' || first === "'") && trimmed.length >= 2 && trimmed[trimmed.length - 1] === first;
		if (isQuoted) {
			source = textDependencies.createPromptTextReviewSource(ctx, trimmed.slice(1, -1));
		} else {
			kind = parseAnnotationSourceKind(trimmed);
			if (!kind) source = await textDependencies.acquireFileTextReviewSource(ctx, trimmed);
		}
	}
	if (kind) {
		switch (kind) {
			case "code-review":
				return runCodeReviewCommand(api, "", ctx, dependencies);
			case "last":
				source = await textDependencies.selectSessionTextReviewSource(ctx, { autoSelect: "latest-assistant" });
				break;
			case "session":
				source = await textDependencies.selectSessionTextReviewSource(ctx);
				break;
			case "file": {
				const filePath = await ctx.ui.input("File path to annotate");
				if (filePath !== undefined) source = await textDependencies.acquireFileTextReviewSource(ctx, filePath);
				break;
			}
			case "prompt": {
				const text = await ctx.ui.editor("Text prompt to annotate");
				if (text !== undefined) source = textDependencies.createPromptTextReviewSource(ctx, text);
				break;
			}
		}
	}
	if (!source) return undefined;
	const result = await textDependencies.showTextReviewOverlay(ctx, source);
	if (!result || result.annotations.length === 0) return undefined;
	let contextSummary: string | undefined;
	if (shouldSummarizeTextReviewSource(source)) {
		ctx.ui.setStatus("annotate-summary", "Rephrasing annotation source with the session model…");
		try {
			const generated = await textDependencies.generateTextReviewContextSummary(ctx, source.text);
			contextSummary =
				typeof generated === "string" ? normalizeTextReviewContextSummary(generated) || undefined : undefined;
			if (!contextSummary) {
				ctx.ui.notify(
					"Source summary unavailable; including the full source verbatim beyond the normal 999-character context limit.",
					"warning",
				);
			}
		} catch {
			ctx.ui.notify(
				"Source summary failed; including the full source verbatim beyond the normal 999-character context limit.",
				"warning",
			);
		} finally {
			ctx.ui.setStatus("annotate-summary", undefined);
		}
	}
	const prompt = buildTextReviewPrompt(source, result.annotations, contextSummary);
	if (prompt) ctx.ui.pasteToEditor(prompt);
	return undefined;
}

export class AnnotateCommand implements CustomCommand {
	name = "annotate";
	description = "Annotate a diff or text from a file, prompt, latest reply, or session";
	#fileCompletionProvider: CombinedAutocompleteProvider | undefined;
	#fileCompletionCwd: string | undefined;

	constructor(private readonly api: CustomCommandAPI) {}

	getArgumentCompletions(argumentPrefix: string, cwd: string): Promise<AutocompleteItem[] | null> {
		if (!this.#fileCompletionProvider || this.#fileCompletionCwd !== cwd) {
			this.#fileCompletionProvider = new CombinedAutocompleteProvider([], cwd);
			this.#fileCompletionCwd = cwd;
		}
		return getAnnotateArgumentCompletions(argumentPrefix, this.#fileCompletionProvider);
	}

	execute(args: string[], ctx: CustomCommandContext, rawArgs?: string): Promise<string | undefined> {
		return runAnnotateCommand(this.api, rawArgs ?? args.join(" "), ctx);
	}
}

export default AnnotateCommand;
