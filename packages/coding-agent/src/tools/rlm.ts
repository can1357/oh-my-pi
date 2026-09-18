import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { rlmQuery } from "../rlm/query";
import { parseGrantRanges, selectGrantsFromSearch } from "../rlm/select-grants";
import { getRlmRuntime, rlmEnabled } from "../rlm/session";
import { parseRlmGrants, rlmSubcall } from "../rlm/subcall";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const rlmSchema = type({
	op: type
		.enumerated("peek", "search", "query", "subcall", "status", "select")
		.describe(
			"peek a handle, search, select grants from search, query a slice (or search-selected ranges), depth-1 subcall, or status",
		),
	"handle?": type("string").describe("rlm://h/<id> from a spilled stub — also readable via read/grep rlm://h/<id>"),
	"handles?": type("string").describe("comma/space-separated handles for subcall multi-hop grants"),
	"start?": type("number").describe("peek/query/subcall start offset (primary handle); ignored when pattern/ranges select grants"),
	"end?": type("number").describe("peek/query/subcall end offset (primary handle)"),
	"pattern?": type("string").describe("search needle; with op=query|select drives grant selection instead of first 8KiB"),
	"mode?": type.enumerated("literal", "regex").describe("search mode; default literal"),
	"question?": type("string").describe("query question"),
	"task?": type("string").describe("subcall worker task (depth-1)"),
	"limit?": type("number").describe("search hit cap / select maxMatches"),
	"ranges?": type("string").describe("explicit grants on handle as start:end,start:end (char offsets)"),
	"contextChars?": type("number").describe("select/query: ± context around each match (default 512)"),
	"maxTotalBytes?": type("number").describe("select/query: hard total grant byte cap (default 8192)"),
	"+": "reject",
});

type RlmParams = typeof rlmSchema.infer;

export interface RlmToolDetails {
	op: string;
	handle?: string;
	failOpen?: boolean;
	meta?: OutputMeta;
}

/** RLM: inspect spilled corpus; depth-1 subcall when rlm.maxDepth ≥ 1. */
export class RlmTool implements AgentTool<typeof rlmSchema, RlmToolDetails> {
	readonly name = "rlm";
	readonly approval = "read" as const;
	readonly label = "RLM";
	readonly summary = "Peek, search, select grants, query, or depth-1 subcall over spilled long context";
	readonly description =
		"Inspect spilled evidence that is not in the neural context. " +
		"op=peek|search|select|query|subcall|status. Handles look like rlm://h/<id> " +
		"(also ordinary `read` / `grep` on rlm://h/<id>). " +
		"For query: pass pattern (or ranges) so the worker sees search-selected slices — not the first fixed 8KiB. " +
		"subcall requires rlm.maxDepth≥1 and a task over one or more granted handles.";
	readonly parameters = rlmSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RlmTool | null {
		return rlmEnabled(session) ? new RlmTool(session) : null;
	}

	async execute(_toolCallId: string, params: RlmParams): Promise<AgentToolResult<RlmToolDetails>> {
		const runtime = getRlmRuntime(this.session);
		const store = runtime.store;
		if (params.op === "status") {
			return toolResult<RlmToolDetails>({ op: "status" }).text(runtime.status()).done();
		}

		if (params.op === "subcall") {
			const grants = parseRlmGrants(params.handle, params.handles, params.start, params.end);
			const task = params.task ?? params.question ?? "";
			if (!grants.length) {
				return toolResult<RlmToolDetails>({ op: "subcall" })
					.error()
					.text("handle or handles is required for subcall")
					.done();
			}
			if (!task.trim()) {
				return toolResult<RlmToolDetails>({ op: "subcall", handle: grants[0]?.handle })
					.error()
					.text("task (or question) is required for subcall")
					.done();
			}
			const result = await rlmSubcall(runtime, grants, task, this.session.rlmComplete, 1);
			return toolResult<RlmToolDetails>({
				op: "subcall",
				handle: grants[0]?.handle,
				failOpen: result.failOpen,
			})
				.text(result.citation ? `${result.citation}\n${result.text}` : result.text)
				.done();
		}

		if (!params.handle) {
			return toolResult<RlmToolDetails>({ op: params.op })
				.error()
				.text("handle is required for peek/search/select/query")
				.done();
		}
		try {
			if (params.op === "peek") {
				const peek = store.peek(params.handle, params.start ?? 0, params.end);
				return toolResult<RlmToolDetails>({ op: "peek", handle: peek.handle })
					.text(`${peek.citation}\n${peek.text}`)
					.done();
			}
			if (params.op === "search") {
				if (!params.pattern) {
					return toolResult<RlmToolDetails>({ op: "search", handle: params.handle })
						.error()
						.text("pattern is required")
						.done();
				}
				const mode = params.mode === "regex" ? "regex" : "literal";
				const hits = store.search(params.handle, params.pattern, params.limit ?? 8, mode);
				const text =
					hits.length === 0
						? "no matches"
						: hits.map(hit => `${hit.citation}\n${hit.text}`).join("\n---\n");
				return toolResult<RlmToolDetails>({ op: "search", handle: params.handle }).text(text).done();
			}
			if (params.op === "select") {
				if (!params.pattern) {
					return toolResult<RlmToolDetails>({ op: "select", handle: params.handle })
						.error()
						.text("pattern is required for select")
						.done();
				}
				const selected = selectGrantsFromSearch(store, params.handle, params.pattern, {
					maxMatches: params.limit ?? 4,
					contextChars: params.contextChars,
					maxTotalBytes: params.maxTotalBytes,
					mode: params.mode === "regex" ? "regex" : "literal",
				});
				if (selected.empty) {
					return toolResult<RlmToolDetails>({ op: "select", handle: params.handle })
						.text("no matches — no grants")
						.done();
				}
				const text = [
					`grantedBytes=${selected.grantedBytes}${selected.truncated ? " truncated" : ""}`,
					...selected.grants.map(g => `${g.handle}[${g.start ?? 0}:${g.end ?? "?"}]`),
					"--- hits ---",
					...selected.hits.map(h => `${h.citation} pattern=${h.pattern}\n${h.text}`),
				].join("\n");
				return toolResult<RlmToolDetails>({ op: "select", handle: params.handle }).text(text).done();
			}
			if (!params.question) {
				return toolResult<RlmToolDetails>({ op: "query", handle: params.handle })
					.error()
					.text("question is required")
					.done();
			}

			const rangeGrants = parseGrantRanges(params.handle, params.ranges);
			const result = await rlmQuery(runtime, {
				handle: params.handle,
				question: params.question,
				complete: this.session.rlmComplete,
				start: params.start ?? 0,
				end: params.end,
				grants: rangeGrants.length > 0 ? rangeGrants : undefined,
				patterns: rangeGrants.length === 0 && params.pattern ? params.pattern : undefined,
				selectPolicy: params.pattern
					? {
							maxMatches: params.limit ?? 4,
							contextChars: params.contextChars,
							maxTotalBytes: params.maxTotalBytes,
							mode: params.mode === "regex" ? "regex" : "literal",
						}
					: undefined,
			});
			const header = result.grantedBytes !== undefined ? `grantedBytes=${result.grantedBytes}\n` : "";
			return toolResult<RlmToolDetails>({
				op: "query",
				handle: params.handle,
				failOpen: result.failOpen,
			})
				.text(`${header}${result.citation}\n${result.text}`)
				.done();
		} catch (error) {
			return toolResult<RlmToolDetails>({ op: params.op, handle: params.handle, failOpen: true })
				.error()
				.text(`${error instanceof Error ? error.message : String(error)} (fail-open)`)
				.done();
		}
	}
}
