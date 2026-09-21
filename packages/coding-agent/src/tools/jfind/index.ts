/**
 * `find`: semantic grep over the workspace, driven by the session's judge
 * role. The exploration (lexical prior, filename ranking, sketch routing,
 * passage verification) lives in {@link runCascade}; this file is the tool
 * contract and the model-facing report.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber, isEnoent } from "@oh-my-pi/pi-utils";
import { journalJudgmentUsage, resolveJudge } from "../../judgment";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import type { ToolSession } from "..";
import { formatPathRelativeToCwd, normalizePathLikeInput, resolveToCwd } from "../path-utils";
import { toolResult } from "../tool-result";
import { runCascade } from "./cascade";
import { rankedHeat } from "./passages";

const findSchema = type({
	query: type("string").describe("what to find, in plain language (concept or behavior, not a regex)"),
	grep_keywords: type("string[]").describe(
		"identifiers or terms likely to appear verbatim in matching source; steer lexical pre-ranking. [] when unsure",
	),
	"path?": type("string").describe('directory to search. Omitted -> the workspace root (".")'),
});

export type FindToolInput = typeof findSchema.infer;

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

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

	readonly examples: readonly ToolExample<typeof findSchema.inferIn>[] = [
		{
			caption: "Find a behavior by description",
			call: { query: "where are request retries counted and reported?", grep_keywords: ["retry", "attempt"] },
		},
		{
			caption: "Locate an implementation without known symbol names",
			call: { query: "how is the database connection pooled?", grep_keywords: [] },
		},
		{
			caption: "Scope the search to one directory",
			call: { query: "where are tool renderers registered?", grep_keywords: ["renderer"], path: "packages/tui" },
		},
	];

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
		const root = await this.#resolveRoot(params.path, cwd);
		const scopePath =
			root === path.resolve(cwd) ? undefined : formatPathRelativeToCwd(root, cwd, { trailingSlash: true });
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
			query,
			extraKeywords: params.grep_keywords,
			judge,
			includeHidden: false,
			signal,
			onProgress: message => onUpdate?.({ content: [{ type: "text", text: message }] }),
		});
		const elapsedMs = performance.now() - started;
		const { stats, threshold, keywords } = result;
		// Cascade paths are root-relative; the model and renderer want cwd-relative
		// so `read` and hyperlinks resolve without knowing the scope.
		const hits = result.hits.map(hit => ({ ...hit, rel: formatPathRelativeToCwd(path.join(root, hit.rel), cwd) }));
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

	/** Absolute search root: `path` under cwd, which must be an existing directory. */
	async #resolveRoot(rawPath: string | undefined, cwd: string): Promise<string> {
		const input = rawPath === undefined ? "" : normalizePathLikeInput(rawPath);
		if (input.length === 0) return path.resolve(cwd);
		const root = resolveToCwd(input, cwd);
		try {
			if (!(await fs.stat(root)).isDirectory()) throw new ToolError(`Path is not a directory: ${input}`);
		} catch (error) {
			if (isEnoent(error)) throw new ToolError(`Path not found: ${input}`);
			throw error;
		}
		return root;
	}
}
