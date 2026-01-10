import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { getLanguageFromPath, type Theme } from "../../modes/interactive/theme/theme";
import editDescription from "../../prompts/tools/edit.md" with { type: "text" };
import type { RenderResultOptions } from "../custom-tools/types";
import {
	DEFAULT_FUZZY_THRESHOLD,
	detectLineEnding,
	type EditDiffError,
	type EditDiffResult,
	EditMatchError,
	findEditMatch,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff";
import type { ToolSession } from "./index";
import { createLspWritethrough, type FileDiagnosticsResult } from "./lsp/index";
import { resolveToCwd } from "./path-utils";
import { createToolUIKit, getDiffStats, shortenPath, truncateDiffByHunk } from "./render-utils";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description: "Text to find and replace (high-confidence fuzzy matching for whitespace/indentation is always on)",
	}),
	newText: Type.String({ description: "New text to replace the old text with" }),
	all: Type.Optional(Type.Boolean({ description: "Replace all occurrences instead of requiring unique match" })),
});

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
}

export function createEditTool(session: ToolSession): AgentTool<typeof editSchema> {
	const allowFuzzy = session.settings?.getEditFuzzyMatch() ?? true;
	const enableDiagnostics = session.settings?.getLspDiagnosticsOnEdit() ?? false;
	const enableFormat = session.settings?.getLspFormatOnWrite() ?? true;
	const writethrough = createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics });
	return {
		name: "edit",
		label: "Edit",
		description: editDescription,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText, all }: { path: string; oldText: string; newText: string; all?: boolean },
			signal?: AbortSignal,
		) => {
			// Reject .ipynb files - use NotebookEdit tool instead
			if (path.endsWith(".ipynb")) {
				throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
			}

			const absolutePath = resolveToCwd(path, session.cwd);

			const file = Bun.file(absolutePath);
			if (!(await file.exists())) {
				throw new Error(`File not found: ${path}`);
			}

			const rawContent = await file.text();

			// Strip BOM before matching (LLM won't include invisible BOM in oldText)
			const { bom, text: content } = stripBom(rawContent);

			const originalEnding = detectLineEnding(content);
			const normalizedContent = normalizeToLF(content);
			const normalizedOldText = normalizeToLF(oldText);
			const normalizedNewText = normalizeToLF(newText);

			let normalizedNewContent: string;
			let replacementCount = 0;

			if (all) {
				// Replace all occurrences mode with fuzzy matching
				normalizedNewContent = normalizedContent;

				// First check: if exact matches exist, use simple replaceAll
				const exactCount = normalizedContent.split(normalizedOldText).length - 1;
				if (exactCount > 0) {
					normalizedNewContent = normalizedContent.split(normalizedOldText).join(normalizedNewText);
					replacementCount = exactCount;
				} else {
					// No exact matches - try fuzzy matching iteratively
					while (true) {
						const matchOutcome = findEditMatch(normalizedNewContent, normalizedOldText, {
							allowFuzzy,
							similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
						});

						// In all mode, use closest match if it passes threshold (even with multiple matches)
						const match =
							matchOutcome.match ||
							(allowFuzzy && matchOutcome.closest && matchOutcome.closest.confidence >= DEFAULT_FUZZY_THRESHOLD
								? matchOutcome.closest
								: undefined);

						if (!match) {
							if (replacementCount === 0) {
								throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
									allowFuzzy,
									similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
									fuzzyMatches: matchOutcome.fuzzyMatches,
								});
							}
							break;
						}

						normalizedNewContent =
							normalizedNewContent.substring(0, match.startIndex) +
							normalizedNewText +
							normalizedNewContent.substring(match.startIndex + match.actualText.length);
						replacementCount++;
					}
				}
			} else {
				// Single replacement mode with fuzzy matching
				const matchOutcome = findEditMatch(normalizedContent, normalizedOldText, {
					allowFuzzy,
					similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
				});

				if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
					throw new Error(
						`Found ${matchOutcome.occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique, or use all: true to replace all.`,
					);
				}

				if (!matchOutcome.match) {
					throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
						allowFuzzy,
						similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
						fuzzyMatches: matchOutcome.fuzzyMatches,
					});
				}

				const match = matchOutcome.match;
				normalizedNewContent =
					normalizedContent.substring(0, match.startIndex) +
					normalizedNewText +
					normalizedContent.substring(match.startIndex + match.actualText.length);
				replacementCount = 1;
			}

			// Verify the replacement actually changed something
			if (normalizedContent === normalizedNewContent) {
				throw new Error(
					`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
				);
			}

			const finalContent = bom + restoreLineEndings(normalizedNewContent, originalEnding);
			const diagnostics = await writethrough(absolutePath, finalContent, signal, file);

			const diffResult = generateDiffString(normalizedContent, normalizedNewContent);

			// Build result text
			let resultText =
				replacementCount > 1
					? `Successfully replaced ${replacementCount} occurrences in ${path}.`
					: `Successfully replaced text in ${path}.`;

			const messages = diagnostics?.messages;
			if (messages && messages.length > 0) {
				resultText += `\n\nLSP Diagnostics (${diagnostics.summary}):\n`;
				resultText += messages.map((d) => `  ${d}`).join("\n");
			}

			return {
				content: [
					{
						type: "text",
						text: resultText,
					},
				],
				details: {
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
					diagnostics: diagnostics,
				},
			};
		},
	};
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface EditRenderArgs {
	path?: string;
	file_path?: string;
	oldText?: string;
	newText?: string;
	all?: boolean;
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: EditDiffResult | EditDiffError;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_DIFF_PREVIEW_HUNKS = 2;
const EDIT_DIFF_PREVIEW_LINES = 24;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

export const editToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: EditRenderArgs, uiTheme: Theme): Component {
		const ui = createToolUIKit(uiTheme);
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const editLanguage = getLanguageFromPath(rawPath) ?? "text";
		const editIcon = uiTheme.fg("muted", uiTheme.getLangIcon(editLanguage));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", uiTheme.format.ellipsis);

		const text = `${ui.title("Edit")} ${editIcon} ${pathDisplay}`;
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		const ui = createToolUIKit(uiTheme);
		const { expanded, renderContext } = options;
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const editLanguage = getLanguageFromPath(rawPath) ?? "text";
		const editIcon = uiTheme.fg("muted", uiTheme.getLangIcon(editLanguage));
		const editDiffPreview = renderContext?.editDiffPreview;
		const renderDiffFn = renderContext?.renderDiff ?? ((t: string) => t);

		// Build path display with line number if available
		let pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", uiTheme.format.ellipsis);
		const firstChangedLine =
			(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
			(result.details && !result.isError ? result.details.firstChangedLine : undefined);
		if (firstChangedLine) {
			pathDisplay += uiTheme.fg("warning", `:${firstChangedLine}`);
		}

		let text = `${uiTheme.fg("toolTitle", uiTheme.bold("Edit"))} ${editIcon} ${pathDisplay}`;

		const editLineCount = countLines(args?.newText ?? args?.oldText ?? "");
		text += `\n${formatMetadataLine(editLineCount, editLanguage, uiTheme)}`;

		if (result.isError) {
			// Show error from result
			const errorText = result.content?.find((c) => c.type === "text")?.text ?? "";
			if (errorText) {
				text += `\n\n${uiTheme.fg("error", errorText)}`;
			}
		} else if (editDiffPreview) {
			// Use cached diff preview (works both before and after execution)
			if ("error" in editDiffPreview) {
				text += `\n\n${uiTheme.fg("error", editDiffPreview.error)}`;
			} else if (editDiffPreview.diff) {
				const diffStats = getDiffStats(editDiffPreview.diff);
				text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${ui.formatDiffStats(
					diffStats.added,
					diffStats.removed,
					diffStats.hunks,
				)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;

				const {
					text: diffText,
					hiddenHunks,
					hiddenLines,
				} = expanded
					? { text: editDiffPreview.diff, hiddenHunks: 0, hiddenLines: 0 }
					: truncateDiffByHunk(editDiffPreview.diff, EDIT_DIFF_PREVIEW_HUNKS, EDIT_DIFF_PREVIEW_LINES);

				text += `\n\n${renderDiffFn(diffText, { filePath: rawPath })}`;
				if (!expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
					const remainder: string[] = [];
					if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
					if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
					text += uiTheme.fg(
						"toolOutput",
						`\n${uiTheme.format.ellipsis} (${remainder.join(", ")}) ${ui.wrapBrackets("Ctrl+O to expand")}`,
					);
				}
			}
		}

		// Show LSP diagnostics if available
		if (result.details?.diagnostics) {
			text += ui.formatDiagnostics(result.details.diagnostics, expanded, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
		}

		return new Text(text, 0, 0);
	},
};
