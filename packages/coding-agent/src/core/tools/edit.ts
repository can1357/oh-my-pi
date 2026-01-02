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
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
	fuzzy: Type.Optional(
		Type.Boolean({
			description:
				"Enable fuzzy matching when oldText differs only in whitespace or indentation (high-confidence only)",
		}),
	),
});

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export function createEditTool(cwd: string): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Set fuzzy=true to accept high-confidence fuzzy matches.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText, fuzzy }: { path: string; oldText: string; newText: string; fuzzy?: boolean },
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
							allowFuzzy: fuzzy ?? false,
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
										allowFuzzy: fuzzy ?? false,
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
