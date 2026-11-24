/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * MCP tools: the server/tool label as the title, a one-line args summary as
 * the target; the result's JSON as a tree, other output as raw text, the
 * args in a folded section below.
 *
 * MCP tools are registered per server, so this is a factory: the transcript
 * builds one presenter per tool label. Terminal look: `mcp`
 * (`src/ui/styles/tools/mcp.ts`).
 */

import { argsSummaryChars, visibleArgKeys } from "./args";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";

/** Character budget of the head's args summary. */
const SUMMARY_CHARS = 160;
/** Body rows shown while collapsed. */
const PREVIEW_LINES = 4;

/** Terminal facts of the `mcp` look. */
export type McpTerm = {
	readonly look: "mcp";
	/** The call's part: in a transcript block the call and result views combine, and both parts draw. */
	readonly call?: boolean;
	/** The call part's title (the tool's label; a result names the answering tool instead). */
	readonly callTitle?: string;
	readonly result?: boolean;
	/** The call's args (summarized on the pending call, listed when expanded). */
	readonly args?: Readonly<Record<string, unknown>>;
	/** Parsed JSON output. */
	readonly json?: unknown;
	/** Raw text output. */
	readonly text?: string;
	/** Draw the text output as Markdown (`mcp.renderMarkdownResults`). */
	readonly markdown?: boolean;
	readonly error?: string;
};

function argsRecord(args: unknown): Record<string, unknown> | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return visibleArgKeys(record).length > 0 ? record : undefined;
}

function argsValue(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of visibleArgKeys(record)) out[key] = record[key];
	return out;
}

function mcpHead(label: string, args: Record<string, unknown> | undefined): ToolHead {
	return {
		title: label,
		...(args ? { target: argsSummaryChars(args, SUMMARY_CHARS) } : {}),
		targetKind: "text",
	};
}

function ArgsSection(props: { readonly args: Readonly<Record<string, unknown>> }) {
	return (
		<section key="args" head={[{ s: "muted", t: "Args" }]} collapsible collapsed>
			<json value={argsValue(props.args)} />
		</section>
	);
}

/** Parse output that is one JSON object or array. */
function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

/** The presenter of the MCP tool `label` (`server/tool`). */
/** What an MCP result reports about the tool that answered. */
export type McpDetails = {
	readonly serverName?: string;
	readonly mcpToolName?: string;
};

/** Options of {@link mcpPresenter}. */
export interface McpPresenterOptions {
	/** Draw non-JSON text results as Markdown (`mcp.renderMarkdownResults`). */
	readonly markdown?: boolean;
}

export function mcpPresenter(
	label: string,
	options: McpPresenterOptions = {},
): ToolPresenter<Record<string, unknown>, McpDetails> {
	const markdown = options.markdown === true;
	return {
		// The result's header (server/tool) replaces the call's once it lands; both draw frameless.
		merge: true,
		inline: true,
		call(args) {
			const record = argsRecord(args);
			return {
				head: mcpHead(label, record),
				body: record ? <ArgsSection args={record} /> : undefined,
				term: {
					look: "mcp",
					call: true,
					callTitle: label,
					args: record,
				} satisfies McpTerm,
			};
		},
		result(result, _state, args): ToolView {
			const record = argsRecord(args);
			const text = resultText(result);
			// A result names the server tool that answered; one without details is just "MCP".
			const details = result.details;
			const answered =
				details?.serverName && details.mcpToolName ? `${details.serverName}/${details.mcpToolName}` : "MCP";
			const base = {
				head: mcpHead(answered, record),
				preview: { lines: PREVIEW_LINES },
			};
			if (result.isError) {
				const message = text || "Unknown error";
				return {
					...base,
					tone: "error",
					body: [
						<text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
						record ? <ArgsSection args={record} /> : undefined,
					],
					term: {
						look: "mcp",
						result: true,
						args: record,
						error: message,
					} satisfies McpTerm,
				};
			}
			if (!text.trim()) {
				return {
					...base,
					body: [
						<text spans={[{ s: "muted", t: "(no output)" }]} wrap="word" />,
						record ? <ArgsSection args={record} /> : undefined,
					],
					term: { look: "mcp", result: true, args: record } satisfies McpTerm,
				};
			}
			const json = parseJson(text);
			return {
				...base,
				body: [
					json !== undefined ? <json value={json} /> : markdown ? <md text={text} /> : <ansi text={text} />,
					record ? <ArgsSection args={record} /> : undefined,
				],
				term: {
					look: "mcp",
					result: true,
					args: record,
					...(json !== undefined ? { json } : markdown ? { text, markdown } : { text }),
				} satisfies McpTerm,
			};
		},
	};
}
