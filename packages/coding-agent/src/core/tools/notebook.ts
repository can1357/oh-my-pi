import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";

const notebookSchema = Type.Object({
	action: Type.Union([Type.Literal("edit"), Type.Literal("insert"), Type.Literal("delete")], {
		description: "Action to perform on the notebook cell",
	}),
	notebook_path: Type.String({ description: "Path to the .ipynb file (relative or absolute)" }),
	cell_index: Type.Number({ description: "0-based index of the cell to operate on" }),
	content: Type.Optional(Type.String({ description: "New cell content (required for edit/insert)" })),
	cell_type: Type.Optional(
		Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
			description: "Cell type for insert (default: code)",
		}),
	),
});

export interface NotebookToolDetails {
	/** Action performed */
	action: "edit" | "insert" | "delete";
	/** Cell index operated on */
	cellIndex: number;
	/** Cell type */
	cellType?: string;
	/** Total cell count after operation */
	totalCells: number;
}

interface NotebookCell {
	cell_type: "code" | "markdown" | "raw";
	source: string[];
	metadata: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
}

interface Notebook {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
}

function splitIntoLines(content: string): string[] {
	return content.split("\n").map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line));
}

export function createNotebookTool(cwd: string): AgentTool<typeof notebookSchema> {
	return {
		name: "notebook",
		label: "notebook",
		description:
			"Edit Jupyter notebook (.ipynb) cells. Actions: edit (replace cell content), insert (add new cell), delete (remove cell). Cell indices are 0-based.",
		parameters: notebookSchema,
		execute: async (
			_toolCallId: string,
			{
				action,
				notebook_path,
				cell_index,
				content,
				cell_type,
			}: { action: string; notebook_path: string; cell_index: number; content?: string; cell_type?: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(notebook_path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: NotebookToolDetails | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;

				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				(async () => {
					try {
						// Check if file exists
						const file = Bun.file(absolutePath);
						if (!(await file.exists())) {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`Notebook not found: ${notebook_path}`));
							return;
						}

						if (aborted) return;

						// Read and parse notebook
						let notebook: Notebook;
						try {
							notebook = await file.json();
						} catch {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`Invalid JSON in notebook: ${notebook_path}`));
							return;
						}

						if (aborted) return;

						// Validate notebook structure
						if (!notebook.cells || !Array.isArray(notebook.cells)) {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`Invalid notebook structure (missing cells array): ${notebook_path}`));
							return;
						}

						const cellCount = notebook.cells.length;

						// Validate cell_index based on action
						if (action === "insert") {
							if (cell_index < 0 || cell_index > cellCount) {
								if (signal) signal.removeEventListener("abort", onAbort);
								reject(
									new Error(
										`Cell index ${cell_index} out of range for insert (0-${cellCount}) in ${notebook_path}`,
									),
								);
								return;
							}
						} else {
							if (cell_index < 0 || cell_index >= cellCount) {
								if (signal) signal.removeEventListener("abort", onAbort);
								reject(
									new Error(`Cell index ${cell_index} out of range (0-${cellCount - 1}) in ${notebook_path}`),
								);
								return;
							}
						}

						// Validate content for edit/insert
						if ((action === "edit" || action === "insert") && content === undefined) {
							if (signal) signal.removeEventListener("abort", onAbort);
							reject(new Error(`Content is required for ${action} action`));
							return;
						}

						if (aborted) return;

						// Perform the action
						let resultMessage: string;
						let finalCellType: string | undefined;

						switch (action) {
							case "edit": {
								const sourceLines = splitIntoLines(content!);
								notebook.cells[cell_index].source = sourceLines;
								finalCellType = notebook.cells[cell_index].cell_type;
								resultMessage = `Replaced cell ${cell_index} (${finalCellType})`;
								break;
							}
							case "insert": {
								const sourceLines = splitIntoLines(content!);
								const newCellType = (cell_type as "code" | "markdown") || "code";
								const newCell: NotebookCell = {
									cell_type: newCellType,
									source: sourceLines,
									metadata: {},
								};
								if (newCellType === "code") {
									newCell.execution_count = null;
									newCell.outputs = [];
								}
								notebook.cells.splice(cell_index, 0, newCell);
								finalCellType = newCellType;
								resultMessage = `Inserted ${newCellType} cell at position ${cell_index}`;
								break;
							}
							case "delete": {
								finalCellType = notebook.cells[cell_index].cell_type;
								notebook.cells.splice(cell_index, 1);
								resultMessage = `Deleted cell ${cell_index} (${finalCellType})`;
								break;
							}
							default: {
								if (signal) signal.removeEventListener("abort", onAbort);
								reject(new Error(`Invalid action: ${action}`));
								return;
							}
						}

						if (aborted) return;

						// Write back with single-space indentation
						await Bun.write(absolutePath, JSON.stringify(notebook, null, 1));

						if (aborted) return;

						if (signal) signal.removeEventListener("abort", onAbort);

						const newCellCount = notebook.cells.length;
						resolve({
							content: [
								{
									type: "text",
									text: `${resultMessage}. Notebook now has ${newCellCount} cells.`,
								},
							],
							details: {
								action: action as "edit" | "insert" | "delete",
								cellIndex: cell_index,
								cellType: finalCellType,
								totalCells: newCellCount,
							},
						});
					} catch (error: any) {
						if (signal) signal.removeEventListener("abort", onAbort);
						if (!aborted) reject(error);
					}
				})();
			});
		},
	};
}

/** Default notebook tool using process.cwd() */
export const notebookTool = createNotebookTool(process.cwd());
