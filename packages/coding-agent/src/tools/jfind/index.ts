/**
 * `find`: semantic grep over the workspace, driven by the session's judge
 * role. The exploration (lexical prior, filename ranking, sketch routing,
 * passage verification) lives in {@link runCascade}; this file is the tool
 * contract and the model-facing report.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { sessionResolveContext } from "../../internal-urls/context";
import { InternalUrlFilesystem } from "../../internal-urls/url-filesystem";
import { hasNativeJudge, journalJudgmentUsage, resolveJudge } from "../../judgment";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import type { ToolSession } from "..";
import { formatPathRelativeToCwd, normalizePathLikeInput, resolveSearchResultPath } from "../path-utils";
import { toolResult } from "../tool-result";
import { runCascade } from "./cascade";
import { rankedHeat } from "./passages";
import { resolveSearchRoot } from "./tree";

import { cfgFindEnabled } from "../settings";

const findSchema = type({
	query: "string",
	grep_keywords: "string[]",
	"path?": "string",
});

export type FindToolInput = typeof findSchema.infer;

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

/**
 * Resolve `find.enabled` for a session: `auto` enables `find` only when the
 * judge role is backed by a native System One model ({@link hasNativeJudge})
 * rather than a prompted small model. Gates tool creation and the `find` hints
 * in sibling tool prompts.
 */
export function isFindEnabled(session: ToolSession): boolean {
	const mode = cfgFindEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	return session.modelRegistry !== undefined && hasNativeJudge(session.settings, session.modelRegistry);
}

/** Semantic search tool: describe a behavior, get files and line ranges that implement it. */
export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Find";
	readonly summary = "Semantic grep: find files and line ranges by describing what they do";
	readonly description = findDescription;
	readonly parameters = findSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: FindToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
	): Promise<AgentToolResult<FindToolDetails>> {
		const query = params.query.trim();
		if (query.length === 0) throw new ToolError("`query` must be a non-empty description");
		const cwd = this.session.cwd;
		const rawScopeInput = params.path === undefined ? "" : normalizePathLikeInput(params.path);
		// Host paths stay native; internal URLs (`local://`, `omp://`, …) are
		// listed, scanned, and read in place through the URL filesystem.
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(this.session, { signal }),
			tier: this.approval,
		});
		const root = await resolveSearchRoot(filesystem, rawScopeInput, cwd);
		const scopePath =
			root.path === path.resolve(cwd)
				? undefined
				: formatPathRelativeToCwd(root.path, cwd, { trailingSlash: root.type === "directory" });
		const registry = this.session.modelRegistry;
		if (!registry) throw new ToolError("find has no model registry to resolve a judge from");
		const judge = resolveJudge({
			settings: this.session.settings,
			registry,
			sessionId: this.session.getSessionId?.() ?? undefined,
			onUsage: journalJudgmentUsage(this.session.sessionManager, "find"),
		});
		const started = performance.now();
		const result = await runCascade({
			root,
			filesystem,
			query,
			extraKeywords: params.grep_keywords,
			judge,
			includeHidden: false,
			signal,
			onProgress: message => onUpdate?.({ content: [{ type: "text", text: message }] }),
		});
		const elapsedMs = performance.now() - started;
		const { stats, threshold, keywords } = result;
		// Cascade paths are root-relative; the model and renderer want paths
		// `read` resolves (cwd-relative files, URLs under URL scopes, including
		// with `:start-end` selectors) without knowing the scope.
		const hits = result.hits.map(hit => ({
			...hit,
			rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
		}));
		const details: FindToolDetails = { query, keywords, threshold, hits, stats, elapsedMs, cwd, scopePath };
		const where = scopePath === undefined ? "" : ` in ${scopePath}`;
		const out: string[] = [];
		if (hits.length === 0) {
			out.push(`no hits for "${query}"${where} (τ ${threshold.toFixed(2)})`);
		} else {
			out.push(`${hits.length} hit(s) for "${query}"${where} (τ ${threshold.toFixed(2)}), strongest first`, "");
			for (const hit of hits) {
				const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
				out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`);
				for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
					const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
					out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
				}
			}
		}
		out.push(
			"",
			`listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
		);
		if (stats.failures.length > 0) {
			out.push(
				`${stats.errors} of ${stats.requests} requests failed:`,
				...stats.failures.map(failure => `  ${failure}`),
			);
		}
		const builder = toolResult(details).text(out.join("\n"));
		if (stats.requests > 0 && stats.errors === stats.requests) builder.error();
		else if (hits.length === 0) builder.useless();
		return builder.done();
	}
}
