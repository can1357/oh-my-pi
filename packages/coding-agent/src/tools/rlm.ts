import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { rlmQuery } from "../rlm/query";
import { getRlmStore, rlmEnabled } from "../rlm/session";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";


const rlmSchema = type({
	op: type.enumerated("peek", "search", "query", "status").describe("peek a handle, search, query a slice, or status"),
	"handle?": type("string").describe("rlm://h/<id> from a spilled stub"),
	"start?": type("number").describe("peek/query start offset"),
	"end?": type("number").describe("peek/query end offset"),
	"pattern?": type("string").describe("search needle (literal by default; set mode=regex for RegExp)"),
	"mode?": type.enumerated("literal", "regex").describe("search mode; default literal"),
	"question?": type("string").describe("query question"),
	"limit?": type("number").describe("search hit cap"),
	"+": "reject",
});

type RlmParams = typeof rlmSchema.infer;

export interface RlmToolDetails {
	op: string;
	handle?: string;
	failOpen?: boolean;
	meta?: OutputMeta;
}


/** Depth-0 RLM: inspect spilled corpus without injecting it into the root prompt. */
export class RlmTool implements AgentTool<typeof rlmSchema, RlmToolDetails> {
	readonly name = "rlm";
	readonly approval = "read" as const;
	readonly label = "RLM";
	readonly summary = "Peek, search, or query spilled long context";
	readonly description =
		"Inspect spilled evidence that is not in the neural context. op=peek|search|query|status. Handles look like rlm://h/<id>.";
	readonly parameters = rlmSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RlmTool | null {
		return rlmEnabled(session) ? new RlmTool(session) : null;
	}

	async execute(_toolCallId: string, params: RlmParams): Promise<AgentToolResult<RlmToolDetails>> {
		const store = getRlmStore(this.session);
		if (params.op === "status") {
			return toolResult<RlmToolDetails>({ op: "status" }).text(store.status()).done();
		}
		if (!params.handle) {
			return toolResult<RlmToolDetails>({ op: params.op })
				.error()
				.text("handle is required for peek/search/query")
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
			if (!params.question) {
				return toolResult<RlmToolDetails>({ op: "query", handle: params.handle })
					.error()
					.text("question is required")
					.done();
			}
			const result = await rlmQuery(
				store,
				params.handle,
				params.question,
				this.session.rlmComplete,
				params.start ?? 0,
				params.end,
			);
			return toolResult<RlmToolDetails>({
				op: "query",
				handle: params.handle,
				failOpen: result.failOpen,
			})
				.text(`${result.citation}\n${result.text}`)
				.done();
		} catch (error) {
			return toolResult<RlmToolDetails>({ op: params.op, handle: params.handle, failOpen: true })
				.error()
				.text(`${error instanceof Error ? error.message : String(error)} (fail-open)`)
				.done();
		}
	}
}
