import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { buildRlmSessionAccounting, formatRlmAccountingSummary, exportRlmExperimentRecord } from "../rlm/accounting";
import { rlmEvidenceQuery } from "../rlm/evidence-query";
import { rlmQuery } from "../rlm/query";
import { parseGrantRanges, selectGrantsFromSearch } from "../rlm/select-grants";
import {
	formatWorkerModeDecisionLine,
	resolveEffectiveWorkerMode,
	workerModeInputFromSelection,
} from "../rlm/worker-mode-policy";
import { getRlmRuntime, rlmEnabled, rlmWorkerModeOverride, rlmWorkerModeSetting } from "../rlm/session";
import { parseRlmGrants, rlmSubcall } from "../rlm/subcall";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const rlmSchema = type({
	op: type
		.enumerated("peek", "search", "query", "subcall", "status", "select", "export")
		.describe(
			"peek/search/select/query/subcall/status, or export session accounting JSONL",
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
		"op=peek|search|select|query|subcall|status|export. Handles look like rlm://h/<id> " +
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
			const lines = [runtime.status()];
			try {
				const sm = (this.session as { sessionManager?: { getBranch?: () => unknown[]; getSessionId?: () => string; getUsageStatistics?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number } } }).sessionManager;
				const accounting = buildRlmSessionAccounting({
					sessionId: sm?.getSessionId?.() ?? (this.session as { sessionId?: string }).sessionId,
					branch: (sm?.getBranch?.() ?? []) as never,
					sessionRaw: sm?.getUsageStatistics?.(),
					runtime,
					store: store,
					config: {
						contextEngine: this.session.settings?.get?.("context.engine") as string | undefined,
						rlmEnabled: this.session.settings?.get?.("rlm.enabled") === true,
						rlmMaxDepth: this.session.settings?.get?.("rlm.maxDepth") as number | undefined,
					},
				});
				lines.push(formatRlmAccountingSummary(accounting));
				if (!accounting.doubleCountCheck.ok) lines.push(`accounting_warn: ${accounting.doubleCountCheck.detail}`);
			} catch (err) {
				lines.push(`accounting_unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				const tok = (this.session as { getTokenomicsStatusLine?: () => string }).getTokenomicsStatusLine?.();
				if (tok) lines.push(tok);
			} catch {
				/* fail-open */
			}
			return toolResult<RlmToolDetails>({ op: "status" }).text(lines.join("\n")).done();
		}
		if (params.op === "export") {
			const sm = (this.session as { sessionManager?: { getBranch?: () => unknown[]; getSessionId?: () => string; getUsageStatistics?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number } } }).sessionManager;
			const accounting = buildRlmSessionAccounting({
				sessionId: sm?.getSessionId?.() ?? (this.session as { sessionId?: string }).sessionId,
				branch: (sm?.getBranch?.() ?? []) as never,
				sessionRaw: sm?.getUsageStatistics?.(),
				runtime,
				store,
				config: {
					contextEngine: this.session.settings?.get?.("context.engine") as string | undefined,
					rlmEnabled: true,
				},
			});
			const sess = this.session as {
				exportRlmExperimentRecord?: (o?: {
					evidenceQuality?: never;
				}) => Promise<{
					accounting: typeof accounting;
					jsonlPath: string;
					snapshotPath?: string;
					tokenomicsLine?: string;
					tokenomicsPath?: string;
				}>;
				getTokenomicsStatusLine?: () => string;
			};
			// Prefer session export (flushes Tokenomics) when available
			if (typeof sess.exportRlmExperimentRecord === "function") {
				const full = await sess.exportRlmExperimentRecord({});
				const lines = [
					formatRlmAccountingSummary(full.accounting),
					`jsonl=${full.jsonlPath}${full.snapshotPath ? `\nsnapshot=${full.snapshotPath}` : ""}`,
				];
				if (full.tokenomicsLine) lines.push(full.tokenomicsLine);
				if (full.tokenomicsPath) lines.push(`tokenomics_jsonl=${full.tokenomicsPath}`);
				return toolResult<RlmToolDetails>({ op: "export" }).text(lines.join("\n")).done();
			}
			const paths = exportRlmExperimentRecord(accounting);
			const lines = [
				formatRlmAccountingSummary(accounting),
				`jsonl=${paths.jsonlPath}${paths.snapshotPath ? `\nsnapshot=${paths.snapshotPath}` : ""}`,
			];
			const tok = sess.getTokenomicsStatusLine?.();
			if (tok) lines.push(tok);
			return toolResult<RlmToolDetails>({ op: "export" }).text(lines.join("\n")).done();
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
					store.metrics.workerCallsAvoided += 1;
					return toolResult<RlmToolDetails>({ op: "select", handle: params.handle })
						.text("no matches — no grants")
						.done();
				}
				store.metrics.grantsSelected += selected.grants.length;
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
			const queryArgs = {
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
			};
			const workerModeSetting = rlmWorkerModeSetting(this.session);
			let useEvidence = workerModeSetting === "evidence-packet";
			let autoDecisionHeader = "";
			if (workerModeSetting === "auto") {
				let policyInput;
				if (rangeGrants.length > 0) {
					const grantedBytes = rangeGrants.reduce((acc, g) => {
						const rec = store.get(g.handle.replace(/^rlm:\/\/h\//, ""));
						if (!rec) return acc;
						const start = g.start ?? 0;
						const end = g.end ?? rec.text.length;
						return acc + Math.max(0, end - start);
					}, 0);
					policyInput = {
						grantedBytes,
						grantCount: rangeGrants.length,
						patternCount: params.pattern ? 1 : 0,
						patterns: params.pattern ? [params.pattern] : [],
						question: params.question,
					};
				} else if (params.pattern) {
					const selected = selectGrantsFromSearch(store, params.handle, params.pattern, queryArgs.selectPolicy);
					const sample = selected.hits.map(h => h.text).join("\n").slice(0, 4096);
					policyInput = workerModeInputFromSelection(
						selected,
						params.question,
						Array.isArray(params.pattern) ? params.pattern : [params.pattern],
						sample,
					);
				} else {
					const peek = store.peek(params.handle, params.start ?? 0, params.end);
					policyInput = {
						grantedBytes: Buffer.byteLength(peek.text, "utf8"),
						grantCount: 1,
						patternCount: 0,
						patterns: [],
						question: params.question,
						grantTextSample: peek.text.slice(0, 4096),
					};
				}
				const decision = resolveEffectiveWorkerMode(
					workerModeSetting,
					policyInput,
					rlmWorkerModeOverride(this.session),
				);
				useEvidence = decision.mode === "evidence-packet";
				autoDecisionHeader = `${formatWorkerModeDecisionLine(decision)}\n`;
				store.note("worker-mode-auto", decision.reason, false);
			}
			const result = useEvidence
				? await rlmEvidenceQuery(runtime, queryArgs)
				: await rlmQuery(runtime, queryArgs);
			const headerParts: string[] = [];
			if (autoDecisionHeader) headerParts.push(autoDecisionHeader.trimEnd());
			if (result.grantedBytes !== undefined) headerParts.push(`grantedBytes=${result.grantedBytes}`);
			if ("packet" in result && result.packet) {
				headerParts.push(`packet.status=${result.packet.status}`);
				if (result.packetBytes !== undefined) headerParts.push(`packetBytes=${result.packetBytes}`);
				if ("workerSkipped" in result && result.workerSkipped) headerParts.push("workerSkipped=true");
			}
			const header = headerParts.length > 0 ? `${headerParts.join(" ")}\n` : "";
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
