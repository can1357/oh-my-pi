import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Tool as AiTool } from "@pk-nerdsaver-ai/pi-ai";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";

// ─── Generic Tool Discovery Types ────────────────────────────────────────────

export type DiscoverableToolSource = "builtin" | "mcp" | "extension" | "custom";

export interface DiscoverableTool {
	name: string;
	label: string;
	/** Short BM25 corpus entry; falls back to description first 200 chars */
	summary: string;
	source: DiscoverableToolSource;
	/** MCP only */
	serverName?: string;
	/** MCP only */
	mcpToolName?: string;
	schemaKeys: string[];
	/** Compact parameter signatures: `key?` plus inline string enums, e.g.
	 * `op(send|wait|inbox|list|complete)`. Optional — populated for builtins. */
	signature?: string[];
}

export interface DiscoverableToolServerSummary {
	name: string;
	toolCount: number;
}

export interface DiscoverableToolSummary {
	servers: DiscoverableToolServerSummary[];
	toolCount: number;
}

export interface DiscoverableToolSearchDocument {
	tool: DiscoverableTool;
	termFrequencies: Map<string, number>;
	length: number;
}

export interface DiscoverableToolSearchIndex {
	documents: DiscoverableToolSearchDocument[];
	averageLength: number;
	documentFrequencies: Map<string, number>;
}

export interface DiscoverableToolSearchResult {
	tool: DiscoverableTool;
	score: number;
}

// ─── BM25 Constants ───────────────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 1.0;
const FIELD_WEIGHTS = {
	name: 6,
	label: 4,
	serverName: 2,
	mcpToolName: 4,
	summary: 2,
	schemaKey: 1,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

function resolveWireSchema(
	tool: Pick<AiTool, "name" | "description" | "parameters">,
): { properties: Record<string, unknown>; required: ReadonlySet<string> } | undefined {
	let parameters: unknown = tool.parameters;
	try {
		parameters = toolWireSchema(tool as AiTool);
	} catch {
		// Schema may contain functions or cycles; fall back to the raw shape.
	}
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
	const schema = parameters as { properties?: unknown; required?: unknown };
	if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
		return undefined;
	}
	const required = Array.isArray(schema.required)
		? new Set(schema.required.filter((key): key is string => typeof key === "string"))
		: new Set<string>();
	return { properties: schema.properties as Record<string, unknown>, required };
}

function getSchemaPropertyKeys(tool: Pick<AiTool, "name" | "description" | "parameters">): string[] {
	return Object.keys(resolveWireSchema(tool)?.properties ?? {}).sort();
}

const SIGNATURE_ENUM_VALUE_CAP = 8;

/** Parameter signatures for discovery results: optionality marker plus inline
 * string-enum values (`op(send|wait)`), so a match carries its call shape. */
function getSchemaPropertySignatures(tool: Pick<AiTool, "name" | "description" | "parameters">): string[] {
	const resolved = resolveWireSchema(tool);
	if (!resolved) return [];
	const signatures: string[] = [];
	for (const key of Object.keys(resolved.properties).sort()) {
		const property = resolved.properties[key];
		const enumValues =
			property && typeof property === "object" && !Array.isArray(property)
				? (property as { enum?: unknown }).enum
				: undefined;
		let signature = key + (resolved.required.has(key) ? "" : "?");
		if (Array.isArray(enumValues)) {
			const values = enumValues.filter((value): value is string => typeof value === "string");
			if (values.length > 0) {
				const shown = values.slice(0, SIGNATURE_ENUM_VALUE_CAP);
				signature += `(${shown.join("|")}${values.length > shown.length ? "|…" : ""})`;
			}
		}
		signatures.push(signature);
	}
	return signatures;
}

function tokenize(value: string): string[] {
	return (
		value
			.normalize("NFKD")
			// Drop combining marks (accents) so "café" → "cafe".
			.replace(/\p{M}+/gu, "")
			// Split ACRONYMBoundary: "MCPTool" → "MCP Tool".
			.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
			// Split camelCase / digit→letter: "fooBar" → "foo Bar", "v2Beta" → "v2 Beta".
			.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
			// Everything that isn't a letter or digit becomes a separator. This subsumes markdown
			// punctuation (`|*_`#-~>[]()`), box-drawing glyphs (─│┌), em/en dashes, smart quotes,
			// zero-width spaces, NBSPs, etc.
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.toLowerCase()
			.trim()
			.split(/\s+/)
			.filter(token => token.length > 0)
	);
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): void {
	if (!value) return;
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
	}
}

function buildSearchDocument(tool: DiscoverableTool): DiscoverableToolSearchDocument {
	const termFrequencies = new Map<string, number>();
	addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
	addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
	addWeightedTokens(termFrequencies, tool.serverName, FIELD_WEIGHTS.serverName);
	addWeightedTokens(termFrequencies, tool.mcpToolName, FIELD_WEIGHTS.mcpToolName);
	addWeightedTokens(termFrequencies, tool.summary, FIELD_WEIGHTS.summary);
	for (const schemaKey of tool.schemaKeys) {
		addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
	}
	const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
	return { tool, termFrequencies, length };
}

// ─── Generic Tool Discovery Functions ────────────────────────────────────────

/**
 * Convert a raw AgentTool into a DiscoverableTool generic descriptor.
 * source: "mcp" if name starts with "mcp__", else "builtin" (caller may override).
 */
export function getDiscoverableTool(
	tool: AgentTool,
	overrides?: { source?: DiscoverableToolSource; summary?: string },
): DiscoverableTool | null {
	const toolRecord = tool as AgentTool & {
		label?: string;
		description?: string;
		mcpServerName?: string;
		summary?: string;
		mcpToolName?: string;
		parameters?: unknown;
	};
	const source: DiscoverableToolSource = overrides?.source ?? (isMCPToolName(tool.name) ? "mcp" : "builtin");
	const rawSummary =
		typeof overrides?.summary === "string"
			? overrides.summary
			: typeof toolRecord.summary === "string"
				? toolRecord.summary
				: undefined;
	const rawDescription = typeof toolRecord.description === "string" ? toolRecord.description : "";
	const summary = rawSummary ?? rawDescription.slice(0, 200);
	return {
		name: tool.name,
		label: typeof toolRecord.label === "string" ? toolRecord.label : tool.name,
		summary,
		source,
		serverName: typeof toolRecord.mcpServerName === "string" ? toolRecord.mcpServerName : undefined,
		mcpToolName: typeof toolRecord.mcpToolName === "string" ? toolRecord.mcpToolName : undefined,
		schemaKeys:
			toolRecord.parameters === undefined
				? []
				: getSchemaPropertyKeys({
						name: tool.name,
						description: rawDescription,
						parameters: toolRecord.parameters as AiTool["parameters"],
					}),
		signature:
			toolRecord.parameters === undefined
				? []
				: getSchemaPropertySignatures({
						name: tool.name,
						description: rawDescription,
						parameters: toolRecord.parameters as AiTool["parameters"],
					}),
	};
}

/** Collect all DiscoverableTools from a tool iterable. Skips tools that return null. */
export function collectDiscoverableTools(
	tools: Iterable<AgentTool>,
	options?: { source?: DiscoverableToolSource; summaryMap?: Map<string, string> },
): DiscoverableTool[] {
	const discoverable: DiscoverableTool[] = [];
	for (const tool of tools) {
		const summary = options?.summaryMap?.get(tool.name);
		const meta = getDiscoverableTool(tool, { source: options?.source, summary });
		if (meta) {
			discoverable.push(meta);
		}
	}
	return discoverable;
}

/** Filter discoverable tools by source */
export function filterBySource(tools: DiscoverableTool[], source: DiscoverableToolSource): DiscoverableTool[] {
	return tools.filter(t => t.source === source);
}

export function formatDiscoverableToolServerSummary(server: DiscoverableToolServerSummary): string {
	const toolLabel = server.toolCount === 1 ? "tool" : "tools";
	return `${server.name} (${server.toolCount} ${toolLabel})`;
}

export function selectDiscoverableToolNamesByServer(
	tools: Iterable<DiscoverableTool>,
	serverNames: ReadonlySet<string>,
): string[] {
	if (serverNames.size === 0) return [];
	return Array.from(tools)
		.filter(tool => tool.serverName !== undefined && serverNames.has(tool.serverName))
		.map(tool => tool.name);
}

export function summarizeDiscoverableTools(tools: DiscoverableTool[]): DiscoverableToolSummary {
	const serverToolCounts = new Map<string, number>();
	for (const tool of tools) {
		if (!tool.serverName) continue;
		serverToolCounts.set(tool.serverName, (serverToolCounts.get(tool.serverName) ?? 0) + 1);
	}
	const servers = Array.from(serverToolCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, toolCount]) => ({ name, toolCount }));
	return {
		servers,
		toolCount: tools.length,
	};
}

export function buildDiscoverableToolSearchIndex(tools: Iterable<DiscoverableTool>): DiscoverableToolSearchIndex {
	const documents = Array.from(tools, buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(document.termFrequencies.keys())) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}
	return {
		documents,
		averageLength,
		documentFrequencies,
	};
}

export function searchDiscoverableTools(
	index: DiscoverableToolSearchIndex,
	query: string,
	limit: number,
): DiscoverableToolSearchResult[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) {
		throw new Error("Query must contain at least one letter or number.");
	}
	if (index.documents.length === 0) {
		return [];
	}

	const queryTermCounts = new Map<string, number>();
	for (const token of queryTokens) {
		queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
	}

	return index.documents
		.map(document => {
			let score = 0;
			for (const [token, queryTermCount] of queryTermCounts) {
				const termFrequency = document.termFrequencies.get(token) ?? 0;
				if (termFrequency === 0) continue;
				const documentFrequency = index.documentFrequencies.get(token) ?? 0;
				const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
				const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
				score +=
					queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
			}
			return { tool: document.tool, score };
		})
		.filter(result => result.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit);
}
