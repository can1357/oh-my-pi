/**
 * Output tool for reading agent/task outputs by ID.
 *
 * Resolves IDs like "reviewer_0" to artifact paths in the current session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TextContent } from "@oh-my-pi/pi-ai";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme";
import outputDescription from "../../prompts/tools/output.md" with { type: "text" };
import type { RenderResultOptions } from "../custom-tools/types";
import type { ToolSession } from "./index";
import {
	formatCount,
	formatEmptyMessage,
	formatExpandHint,
	formatMeta,
	formatMoreItems,
	TRUNCATE_LENGTHS,
	truncate,
} from "./render-utils";
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
	query: Type.Optional(
		Type.String({
			description: "jq-like query for JSON outputs (e.g., .result.items[0].name). Requires JSON output.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed)",
			minimum: 1,
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of lines to read",
			minimum: 1,
		}),
	),
});

/** Metadata for a single output file */
interface OutputProvenance {
	agent: string;
	index: number;
}

interface OutputRange {
	startLine: number;
	endLine: number;
	totalLines: number;
}

interface OutputEntry {
	id: string;
	path: string;
	lineCount: number;
	charCount: number;
	provenance?: OutputProvenance;
	previewLines?: string[];
	range?: OutputRange;
	query?: string;
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

function parseQuery(query: string): Array<string | number> {
	let input = query.trim();
	if (!input) return [];
	if (input.startsWith(".")) input = input.slice(1);
	if (!input) return [];

	const tokens: Array<string | number> = [];
	let i = 0;

	const isIdentChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);

	while (i < input.length) {
		const ch = input[i];
		if (ch === ".") {
			i++;
			continue;
		}
		if (ch === "[") {
			const closeIndex = input.indexOf("]", i + 1);
			if (closeIndex === -1) {
				throw new Error(`Invalid query: missing ] in ${query}`);
			}
			const raw = input.slice(i + 1, closeIndex).trim();
			if (!raw) {
				throw new Error(`Invalid query: empty [] in ${query}`);
			}
			const quote = raw[0];
			if ((quote === '"' || quote === "'") && raw.endsWith(quote)) {
				let inner = raw.slice(1, -1);
				inner = inner.replace(/\\(["'\\])/g, "$1");
				tokens.push(inner);
			} else if (/^\d+$/.test(raw)) {
				tokens.push(Number(raw));
			} else {
				tokens.push(raw);
			}
			i = closeIndex + 1;
			continue;
		}

		const start = i;
		while (i < input.length && isIdentChar(input[i])) {
			i++;
		}
		if (start === i) {
			throw new Error(`Invalid query: unexpected token '${input[i]}' in ${query}`);
		}
		const ident = input.slice(start, i);
		tokens.push(ident);
	}

	return tokens;
}

function applyQuery(data: unknown, query: string): unknown {
	const tokens = parseQuery(query);
	let current: unknown = data;
	for (const token of tokens) {
		if (current === null || current === undefined) return undefined;
		if (typeof token === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[token];
			continue;
		}
		if (typeof current !== "object") return undefined;
		const record = current as Record<string, unknown>;
		current = record[token];
	}
	return current;
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

function parseOutputProvenance(id: string): OutputProvenance | undefined {
	const match = id.match(/^(.*)_(\d+)$/);
	if (!match) return undefined;
	const agent = match[1];
	const index = Number(match[2]);
	if (!agent || Number.isNaN(index)) return undefined;
	return { agent, index };
}

function extractPreviewLines(content: string, maxLines: number): string[] {
	const lines = content.split("\n");
	const preview: string[] = [];
	const structuralTokens = new Set(["{", "}", "[", "]"]);

	const isStructuralLine = (line: string): boolean => {
		const trimmed = line.trim();
		if (!trimmed) return true;
		const cleaned = trimmed.replace(/,+$/, "");
		return structuralTokens.has(cleaned);
	};

	const trimmedContent = content.trim();
	const firstMeaningful = lines.find((line) => line.trim());
	if (
		firstMeaningful &&
		isStructuralLine(firstMeaningful) &&
		(trimmedContent.startsWith("{") || trimmedContent.startsWith("[")) &&
		trimmedContent.length <= 200_000
	) {
		try {
			const parsed = JSON.parse(trimmedContent);
			const minified = JSON.stringify(parsed);
			if (minified) return [minified];
		} catch {
			// Fall back to line-based previews.
		}
	}

	for (const line of lines) {
		if (isStructuralLine(line)) continue;
		preview.push(line);
		if (preview.length >= maxLines) break;
	}

	if (preview.length === 0) {
		for (const line of lines) {
			if (!line.trim()) continue;
			preview.push(line);
			if (preview.length >= maxLines) break;
		}
	}

	return preview;
}

export function createOutputTool(session: ToolSession): AgentTool<typeof outputSchema, OutputToolDetails> {
	return {
		name: "output",
		label: "Output",
		description: outputDescription,
		parameters: outputSchema,
		execute: async (
			_toolCallId: string,
			params: {
				ids: string[];
				format?: "raw" | "json" | "stripped";
				query?: string;
				offset?: number;
				limit?: number;
			},
		): Promise<{ content: TextContent[]; details: OutputToolDetails }> => {
			const sessionFile = session.getSessionFile();

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
			const outputContentById = new Map<string, string>();
			const query = params.query?.trim();
			const wantsQuery = query !== undefined && query.length > 0;
			const format = params.format ?? (wantsQuery ? "json" : "raw");

			if (wantsQuery && (params.offset !== undefined || params.limit !== undefined)) {
				throw new Error("query cannot be combined with offset/limit");
			}

			const queryResults: Array<{ id: string; value: unknown }> = [];

			for (const id of params.ids) {
				const outputPath = path.join(artifactsDir, `${id}.out.md`);

				if (!fs.existsSync(outputPath)) {
					notFound.push(id);
					continue;
				}

				const rawContent = fs.readFileSync(outputPath, "utf-8");
				const rawLines = rawContent.split("\n");
				const totalLines = rawLines.length;
				const totalChars = rawContent.length;

				let selectedContent = rawContent;
				let range: OutputRange | undefined;

				if (wantsQuery && query) {
					let jsonValue: unknown;
					try {
						jsonValue = JSON.parse(rawContent);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`Output ${id} is not valid JSON: ${message}`);
					}
					const value = applyQuery(jsonValue, query);
					queryResults.push({ id, value });
					try {
						selectedContent = JSON.stringify(value, null, 2) ?? "null";
					} catch {
						selectedContent = String(value);
					}
				} else if (params.offset !== undefined || params.limit !== undefined) {
					const startLine = Math.max(1, params.offset ?? 1);
					if (startLine > totalLines) {
						throw new Error(
							`Offset ${params.offset ?? startLine} is beyond end of output (${totalLines} lines) for ${id}`,
						);
					}
					const effectiveLimit = params.limit ?? totalLines - startLine + 1;
					const endLine = Math.min(totalLines, startLine + effectiveLimit - 1);
					const selectedLines = rawLines.slice(startLine - 1, endLine);
					selectedContent = selectedLines.join("\n");
					range = { startLine, endLine, totalLines };
				}

				outputContentById.set(id, selectedContent);
				outputs.push({
					id,
					path: outputPath,
					lineCount: wantsQuery ? selectedContent.split("\n").length : totalLines,
					charCount: wantsQuery ? selectedContent.length : totalChars,
					provenance: parseOutputProvenance(id),
					previewLines: extractPreviewLines(selectedContent, 4),
					range,
					query: query,
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
				const jsonData = wantsQuery
					? queryResults
					: outputs.map((o) => ({
							id: o.id,
							lineCount: o.lineCount,
							charCount: o.charCount,
							provenance: o.provenance,
							previewLines: o.previewLines,
							range: o.range,
							content: outputContentById.get(o.id) ?? "",
						}));
				contentText = JSON.stringify(jsonData, null, 2);
			} else {
				// raw or stripped
				const parts = outputs.map((o) => {
					let content = outputContentById.get(o.id) ?? "";
					if (format === "stripped") {
						content = stripAnsi(content);
					}
					if (o.range && o.range.endLine < o.range.totalLines) {
						const nextOffset = o.range.endLine + 1;
						content += `\n\n[Showing lines ${o.range.startLine}-${o.range.endLine} of ${o.range.totalLines}. Use offset=${nextOffset} to continue]`;
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

// =============================================================================
// TUI Renderer
// =============================================================================

interface OutputRenderArgs {
	ids: string[];
	format?: "raw" | "json" | "stripped";
	query?: string;
	offset?: number;
	limit?: number;
}

type OutputEntryItem = OutputToolDetails["outputs"][number];

function formatOutputMeta(entry: OutputEntryItem, uiTheme: Theme): string {
	const metaParts: string[] = [];
	if (entry.range) {
		metaParts.push(`lines ${entry.range.startLine}-${entry.range.endLine} of ${entry.range.totalLines}`);
	} else {
		metaParts.push(formatCount("line", entry.lineCount));
	}
	metaParts.push(formatBytes(entry.charCount));
	if (entry.provenance) {
		metaParts.push(`agent ${entry.provenance.agent}(${entry.provenance.index})`);
	}
	return uiTheme.fg("dim", metaParts.join(uiTheme.sep.dot));
}

export const outputToolRenderer = {
	renderCall(args: OutputRenderArgs, uiTheme: Theme): Component {
		const ids = args.ids?.join(", ") ?? "?";
		const label = uiTheme.fg("toolTitle", uiTheme.bold("Output"));
		let text = `${label} ${uiTheme.fg("accent", ids)}`;

		const meta: string[] = [];
		if (args.format && args.format !== "raw") meta.push(`format:${args.format}`);
		if (args.query) meta.push(`query:${args.query}`);
		if (args.offset !== undefined) meta.push(`offset:${args.offset}`);
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);
		text += formatMeta(meta, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: OutputToolDetails },
		{ expanded }: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;

		if (details?.notFound?.length) {
			const icon = uiTheme.styledSymbol("status.error", "error");
			let text = `${icon} ${uiTheme.fg("error", `Error: Not found: ${details.notFound.join(", ")}`)}`;
			if (details.availableIds?.length) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", `Available: ${details.availableIds.join(", ")}`)}`;
			} else {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", "No outputs available in current session")}`;
			}
			return new Text(text, 0, 0);
		}

		const outputs = details?.outputs ?? [];

		if (outputs.length === 0) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			return new Text(formatEmptyMessage(textContent || "No outputs", uiTheme), 0, 0);
		}

		const icon = uiTheme.styledSymbol("status.success", "success");
		const summary = `read ${formatCount("output", outputs.length)}`;
		const previewLimit = expanded ? 3 : 1;
		const maxOutputs = expanded ? outputs.length : Math.min(outputs.length, 5);
		const hasMoreOutputs = outputs.length > maxOutputs;
		const hasMorePreview = outputs.some((o) => (o.previewLines?.length ?? 0) > previewLimit);
		const expandHint = formatExpandHint(expanded, hasMoreOutputs || hasMorePreview, uiTheme);
		let text = `${icon} ${uiTheme.fg("dim", summary)}${expandHint}`;

		for (let i = 0; i < maxOutputs; i++) {
			const o = outputs[i];
			const isLast = i === maxOutputs - 1 && !hasMoreOutputs;
			const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
			text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("accent", o.id)} ${formatOutputMeta(o, uiTheme)}`;

			const previewLines = o.previewLines ?? [];
			const shownPreview = previewLines.slice(0, previewLimit);
			if (shownPreview.length > 0) {
				const childPrefix = isLast ? "   " : ` ${uiTheme.fg("dim", uiTheme.tree.vertical)} `;
				for (const line of shownPreview) {
					const previewText = truncate(line, TRUNCATE_LENGTHS.CONTENT, uiTheme.format.ellipsis);
					text += `\n${childPrefix}${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
						"muted",
						"preview:",
					)} ${uiTheme.fg("toolOutput", previewText)}`;
				}
			}
		}

		if (hasMoreOutputs) {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
				"muted",
				formatMoreItems(outputs.length - maxOutputs, "output", uiTheme),
			)}`;
		}

		return new Text(text, 0, 0);
	},
};
