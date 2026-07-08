import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { SessionEntry } from "./session-entries";

export const OFFLOAD_TRACE_VERSION = 1;

export type OffloadTraceNodeKind = "message" | "tool" | "artifact" | "wiki" | "source" | "summary";
export type OffloadTraceNodeStatus = "resolved" | "unresolved";
export type OffloadTraceEdgeKind = "contains" | "references" | "derived_from" | "follows";

export interface OffloadTraceNode {
	id: string;
	kind: OffloadTraceNodeKind;
	title: string;
	summary: string;
	status: OffloadTraceNodeStatus;
	artifactId?: string;
	entryId?: string;
	wikigraphNodeId?: string;
	sourcePath?: string;
	lineStart?: number;
	lineEnd?: number;
	createdAt: string;
}

export interface OffloadTraceEdge {
	from: string;
	to: string;
	kind: OffloadTraceEdgeKind;
	label?: string;
}

export interface OffloadTraceCanvas {
	version: typeof OFFLOAD_TRACE_VERSION;
	sessionId?: string;
	nodes: OffloadTraceNode[];
	edges: OffloadTraceEdge[];
	tokensSavedEstimate?: number;
}

export interface OffloadTraceSettings {
	enabled: boolean;
	maxCanvasChars: number;
	maxNodes: number;
	rawArtifactMinChars: number;
}

export interface BuildOffloadTraceOptions {
	sessionId?: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages?: AgentMessage[];
	summary: string;
	shortSummary?: string;
	createdAt?: string;
	settings: OffloadTraceSettings;
	artifactManager?: { save(content: string, toolType: string): Promise<string> } | null;
}

interface TextEvidence {
	title: string;
	text: string;
	entryId?: string;
}

export function isOffloadTraceCanvas(value: unknown): value is OffloadTraceCanvas {
	if (!value || typeof value !== "object") return false;
	if (!("version" in value) || value.version !== OFFLOAD_TRACE_VERSION) return false;
	if (!("nodes" in value) || !Array.isArray(value.nodes)) return false;
	if (!("edges" in value) || !Array.isArray(value.edges)) return false;
	return true;
}

export function getPreservedOffloadTrace(
	preserveData: Record<string, unknown> | undefined,
): OffloadTraceCanvas | undefined {
	if (!preserveData || !("offloadTrace" in preserveData)) return undefined;
	return isOffloadTraceCanvas(preserveData.offloadTrace) ? preserveData.offloadTrace : undefined;
}
export interface RenderOffloadTraceOptions {
	maxCanvasChars: number;
	maxNodes: number;
}

export function renderOffloadTraceCanvasMarkdown(
	canvas: OffloadTraceCanvas,
	options: RenderOffloadTraceOptions,
): string {
	const maxNodes = Math.max(1, Math.trunc(options.maxNodes));
	const visibleNodes = canvas.nodes.slice(0, maxNodes);
	const visibleNodeIds = new Set(visibleNodes.map(node => node.id));
	const visibleEdges = canvas.edges.filter(edge => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));
	const omittedNodes = Math.max(0, canvas.nodes.length - visibleNodes.length);
	const lines: string[] = ["## Trace", "", "```mermaid", "graph TD"];

	for (const node of visibleNodes) {
		lines.push(`  ${mermaidId(node.id)}["${escapeMermaidLabel(node.title)}"]`);
	}
	for (const edge of visibleEdges) {
		const label = edge.label ?? edge.kind;
		lines.push(`  ${mermaidId(edge.from)} -->|${escapeMermaidLabel(label)}| ${mermaidId(edge.to)}`);
	}
	lines.push("```", "", "|ID|Status|Ref|Summary|", "|-|-|-|-|");
	for (const node of visibleNodes) {
		lines.push(
			`|${escapeTable(node.id)}|${escapeTable(node.status)}|${escapeTable(nodeRef(node))}|${escapeTable(node.summary)}|`,
		);
	}
	if (omittedNodes > 0) lines.push(`|omitted|unresolved||${omittedNodes} additional trace nodes omitted|`);
	if (typeof canvas.tokensSavedEstimate === "number")
		lines.push("", `Tokens saved estimate: ${canvas.tokensSavedEstimate}`);

	return boundMarkdown(lines.join("\n"), Math.max(0, Math.trunc(options.maxCanvasChars)));
}

export function renderPreservedOffloadTraceMarkdown(
	preserveData: Record<string, unknown> | undefined,
	options: RenderOffloadTraceOptions,
): string | undefined {
	const trace = getPreservedOffloadTrace(preserveData);
	return trace ? renderOffloadTraceCanvasMarkdown(trace, options) : undefined;
}

export async function buildOffloadTraceCanvas(
	options: BuildOffloadTraceOptions,
): Promise<OffloadTraceCanvas | undefined> {
	if (!options.settings.enabled) return undefined;

	const createdAt = options.createdAt ?? new Date().toISOString();
	const maxNodes = Math.max(1, Math.trunc(options.settings.maxNodes));
	const candidates = collectTextEvidence(options.messagesToSummarize, options.turnPrefixMessages ?? []);
	const nodes: OffloadTraceNode[] = [
		{
			id: "trace-summary",
			kind: "summary",
			title: options.shortSummary || "Compaction summary",
			summary: summarizeText(options.summary, 280),
			status: "unresolved",
			createdAt,
		},
	];
	const edges: OffloadTraceEdge[] = [];
	let tokensSavedEstimate = 0;

	for (const candidate of candidates) {
		if (nodes.length >= maxNodes) break;
		if (candidate.text.length < options.settings.rawArtifactMinChars) continue;

		let artifactId: string | undefined;
		if (options.artifactManager) {
			try {
				artifactId = await options.artifactManager.save(candidate.text, "offload");
			} catch {
				artifactId = undefined;
			}
		}

		const id = `trace-${nodes.length}`;
		nodes.push({
			id,
			kind: artifactId ? "artifact" : "tool",
			title: candidate.title,
			summary: summarizeText(candidate.text, 360),
			status: artifactId ? "resolved" : "unresolved",
			artifactId,
			entryId: candidate.entryId,
			createdAt,
		});
		edges.push({ from: "trace-summary", to: id, kind: "references" });
		tokensSavedEstimate += Math.max(0, Math.ceil((candidate.text.length - 360) / 4));
	}

	if (nodes.length === 1) return undefined;
	return {
		version: OFFLOAD_TRACE_VERSION,
		sessionId: options.sessionId,
		nodes,
		edges,
		tokensSavedEstimate,
	};
}

function collectTextEvidence(messagesToSummarize: AgentMessage[], turnPrefixMessages: AgentMessage[]): TextEvidence[] {
	const evidence: TextEvidence[] = [];
	let index = 0;
	for (const message of [...turnPrefixMessages, ...messagesToSummarize]) {
		const text = messageText(message);
		if (!text) continue;
		evidence.push({ title: messageTitle(message, index), text, entryId: messageEntryId(message) });
		index++;
	}
	return evidence;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
		if ("content" in part && typeof part.content === "string") parts.push(part.content);
	}
	return parts.join("\n");
}

function messageTitle(message: AgentMessage, index: number): string {
	if ("role" in message && typeof message.role === "string") return `${message.role} evidence ${index + 1}`;
	return `evidence ${index + 1}`;
}

function messageEntryId(message: AgentMessage): string | undefined {
	if ("entryId" in message && typeof message.entryId === "string") return message.entryId;
	return undefined;
}

function summarizeText(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function nodeRef(node: OffloadTraceNode): string {
	if (node.artifactId) return `artifact://${node.artifactId}`;
	if (node.wikigraphNodeId) return `wikigraph://node/${node.wikigraphNodeId}`;
	if (node.sourcePath) {
		const range =
			typeof node.lineStart === "number" && typeof node.lineEnd === "number"
				? `#L${node.lineStart}-L${node.lineEnd}`
				: "";
		return `wikigraph://path/${node.sourcePath}${range}`;
	}
	if (node.entryId) return `entry:${node.entryId}`;
	return "summary-only";
}

function mermaidId(id: string): string {
	return `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function escapeMermaidLabel(value: string): string {
	return value.replace(/["<>]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeTable(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function boundMarkdown(markdown: string, maxChars: number): string {
	if (maxChars === 0 || markdown.length <= maxChars) return markdown;
	const suffix = "\n\nTrace truncated.";
	return `${markdown.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}

export function latestOffloadTrace(entries: SessionEntry[]): OffloadTraceCanvas | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const trace = getPreservedOffloadTrace(entry.preserveData);
		if (trace) return trace;
	}
	return undefined;
}
