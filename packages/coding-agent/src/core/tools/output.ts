/**
 * Output tool for reading agent/task outputs by ID.
 *
 * Resolves IDs like "reviewer_0" to artifact paths in the current session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import type { SessionContext } from "./index";
import { getArtifactsDir } from "./task/artifacts";

const outputSchema = Type.Object({
	ids: Type.Array(Type.String(), {
		description: "Agent output IDs to read (e.g., ['reviewer_0', 'explore_1'])",
		minItems: 1,
	}),
	format: Type.Optional(
		Type.Union([Type.Literal("raw"), Type.Literal("json"), Type.Literal("stripped")], {
			description: "Output format: raw (default), json (structured), stripped (no ANSI)",
		}),
	),
});

/** Metadata for a single output file */
interface OutputEntry {
	id: string;
	path: string;
	lineCount: number;
	charCount: number;
}

export interface OutputToolDetails {
	outputs: OutputEntry[];
	notFound?: string[];
	availableIds?: string[];
}

/** Strip ANSI escape codes from text */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** List available output IDs in artifacts directory */
function listAvailableOutputs(artifactsDir: string): string[] {
	try {
		const files = fs.readdirSync(artifactsDir);
		return files.filter((f) => f.endsWith(".out.md")).map((f) => f.replace(".out.md", ""));
	} catch {
		return [];
	}
}

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export function createOutputTool(
	_cwd: string,
	sessionContext?: SessionContext,
): AgentTool<typeof outputSchema, OutputToolDetails> {
	return {
		name: "output",
		label: "Output",
		description: `Read full agent/task output by ID.

Use when the Task tool's truncated preview isn't sufficient for your needs.
The Task tool already returns summaries with line/char counts in its result.

Parameters:
- ids: Array of output IDs (e.g., ["reviewer_0", "explore_1"])
- format: "raw" (default), "json" (structured object), or "stripped" (no ANSI codes)

Returns the full output content. For unknown IDs, returns an error with available IDs.

Example: { "ids": ["reviewer_0"] }`,
		parameters: outputSchema,
		execute: async (
			_toolCallId: string,
			params: { ids: string[]; format?: "raw" | "json" | "stripped" },
		): Promise<{ content: TextContent[]; details: OutputToolDetails }> => {
			const sessionFile = sessionContext?.getSessionFile();

			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "No session - output artifacts unavailable" }],
					details: { outputs: [], notFound: params.ids },
				};
			}

			const artifactsDir = getArtifactsDir(sessionFile);
			if (!artifactsDir || !fs.existsSync(artifactsDir)) {
				return {
					content: [{ type: "text", text: "No artifacts directory found" }],
					details: { outputs: [], notFound: params.ids },
				};
			}

			const outputs: OutputEntry[] = [];
			const notFound: string[] = [];
			const format = params.format ?? "raw";

			for (const id of params.ids) {
				const outputPath = path.join(artifactsDir, `${id}.out.md`);

				if (!fs.existsSync(outputPath)) {
					notFound.push(id);
					continue;
				}

				const content = fs.readFileSync(outputPath, "utf-8");
				outputs.push({
					id,
					path: outputPath,
					lineCount: content.split("\n").length,
					charCount: content.length,
				});
			}

			// Error case: some IDs not found
			if (notFound.length > 0) {
				const available = listAvailableOutputs(artifactsDir);
				const errorMsg =
					available.length > 0
						? `Not found: ${notFound.join(", ")}\nAvailable: ${available.join(", ")}`
						: `Not found: ${notFound.join(", ")}\nNo outputs available in current session`;

				return {
					content: [{ type: "text", text: errorMsg }],
					details: { outputs, notFound, availableIds: available },
				};
			}

			// Success: build response based on format
			let contentText: string;

			if (format === "json") {
				const jsonData = outputs.map((o) => ({
					id: o.id,
					lineCount: o.lineCount,
					charCount: o.charCount,
					content: fs.readFileSync(o.path, "utf-8"),
				}));
				contentText = JSON.stringify(jsonData, null, 2);
			} else {
				// raw or stripped
				const parts = outputs.map((o) => {
					let content = fs.readFileSync(o.path, "utf-8");
					if (format === "stripped") {
						content = stripAnsi(content);
					}
					// Add header for multiple outputs
					if (outputs.length > 1) {
						return `=== ${o.id} (${o.lineCount} lines, ${formatBytes(o.charCount)}) ===\n${content}`;
					}
					return content;
				});
				contentText = parts.join("\n\n");
			}

			return {
				content: [{ type: "text", text: contentText }],
				details: { outputs },
			};
		},
	};
}

/** Default output tool using process.cwd() - for backwards compatibility */
export const outputTool = createOutputTool(process.cwd());
