import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import {
	DEFAULT_FUZZY_THRESHOLD,
	detectLineEnding,
	findEditMatch,
	formatEditMatchError,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { resolveToCwd } from "./path-utils.js";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description: "Text to find and replace (high-confidence fuzzy matching for whitespace/indentation is always on)",
	}),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export interface EditToolOptions {
	/** Whether to accept high-confidence fuzzy matches for whitespace/indentation (default: true) */
	fuzzyMatch?: boolean;
}

export function createEditTool(cwd: string, options: EditToolOptions = {}): AgentTool<typeof editSchema> {
	const allowFuzzy = options.fuzzyMatch ?? true;
	return {
		name: "edit",
		label: "Edit",
		description: `Performs string replacements in files with fuzzy whitespace matching. 

Usage:
- You must use your read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- Fuzzy matching handles minor whitespace/indentation differences automatically - you don't need to match indentation exactly.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string. 
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { path: string; oldText: string; newText: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				// Check if already aborted
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;

				// Set up abort handler
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// Perform the edit operation
				(async () => {
					try {
						// Check if file exists
						try {
							await access(absolutePath, constants.R_OK | constants.W_OK);
						} catch {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(new Error(`File not found: ${path}`));
							return;
						}

						// Check if aborted before reading
						if (aborted) {
							return;
						}

						// Read the file
						const rawContent = await readFile(absolutePath, "utf-8");

						// Check if aborted after reading
						if (aborted) {
							return;
						}

						// Strip BOM before matching (LLM won't include invisible BOM in oldText)
						const { bom, text: content } = stripBom(rawContent);

						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);
						const normalizedOldText = normalizeToLF(oldText);
						const normalizedNewText = normalizeToLF(newText);

						const matchOutcome = findEditMatch(normalizedContent, normalizedOldText, {
							allowFuzzy,
							similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
						});

						if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`Found ${matchOutcome.occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
								),
							);
							return;
						}

						if (!matchOutcome.match) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									formatEditMatchError(path, normalizedOldText, matchOutcome.closest, {
										allowFuzzy,
										similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
										fuzzyMatches: matchOutcome.fuzzyMatches,
									}),
								),
							);
							return;
						}

						const match = matchOutcome.match;

						// Check if aborted before writing
						if (aborted) {
							return;
						}

						const normalizedNewContent =
							normalizedContent.substring(0, match.startIndex) +
							normalizedNewText +
							normalizedContent.substring(match.startIndex + match.actualText.length);

						// Verify the replacement actually changed something
						if (normalizedContent === normalizedNewContent) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
								),
							);
							return;
						}

						const finalContent = bom + restoreLineEndings(normalizedNewContent, originalEnding);
						await writeFile(absolutePath, finalContent, "utf-8");

						// Check if aborted after writing
						if (aborted) {
							return;
						}

						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						const diffResult = generateDiffString(normalizedContent, normalizedNewContent);
						resolve({
							content: [
								{
									type: "text",
									text: `Successfully replaced text in ${path}.`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: any) {
						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						if (!aborted) {
							reject(error);
						}
					}
				})();
			});
		},
	};
}

/** Default edit tool using process.cwd() - for backwards compatibility */
export const editTool = createEditTool(process.cwd());
