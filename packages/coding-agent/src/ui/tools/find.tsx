/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Find (semantic search): `Find “retry budget”  12 hits · 2 files`, then the
 * hits by relevance: a score bar, the file, how much was judged, and the
 * best passages as numbered excerpts. Collapsed shows five hits with their
 * best passage; failures and keywords follow.
 *
 * Terminal look: `find` (`src/ui/styles/tools/find.ts`).
 */
import * as nodePath from "node:path";
import type { TspText, TspTone } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { fileHref } from "./file-common";
import { countText, inlineErrorView, pathSpans } from "./search-common";

/** The args find shows. */
export interface FindArgs {
	readonly query?: string;
	readonly grep_keywords?: readonly string[];
	readonly path?: string;
}

/** One judged passage. */
export interface FindRange {
	readonly start: number;
	readonly end: number;
	readonly p: number;
	readonly snippet: string;
}

/** One relevant file. */
export interface FindHit {
	readonly rel: string;
	readonly contentScore: number;
	readonly linesSeen: number;
	readonly truncated?: boolean;
	readonly ranges: readonly FindRange[];
}

/** Search statistics. */
export interface FindStats {
	readonly requests: number;
	readonly failed: number;
	readonly filesRead: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
	readonly failures?: readonly string[];
}

/** Result details find reports. */
export interface FindDetails {
	readonly query?: string;
	readonly keywords?: readonly string[];
	readonly threshold?: number;
	readonly cwd?: string;
	readonly elapsedMs?: number;
	readonly hits?: readonly FindHit[];
	readonly coverage?: "complete" | "partial";
	readonly stats?: FindStats;
	readonly scopePath?: string;
	readonly timeout?: { readonly verified: number; readonly passages: number };
	readonly lexicalFallback?: readonly {
		readonly rel: string;
		readonly line: number;
		readonly snippet: string;
	}[];
}

/** Hits listed while collapsed. */
const COLLAPSED_HITS = 5;
/** Passages per hit while expanded (collapsed: the best one). */
const EXPANDED_RANGES = 3;
/** Body rows shown while collapsed. */
const PREVIEW_LINES = 12;

/** Terminal facts of the `find` look. */
export type FindTerm = {
	readonly look: "find";
	/** The view is a final result. */
	readonly result?: boolean;
	/** The query searched (the result's own, else the args'). */
	readonly query?: string;
	/** Head facts: hit count, scope, statistics (plain). */
	readonly facts?: readonly string[];
	/** Head warnings (failed requests, timeouts). */
	readonly warnings?: readonly string[];
	/** Hits not listed. */
	readonly more?: number;
	readonly keywords?: string;
	readonly failures?: readonly string[];
	/** Why there are no hits. */
	readonly empty?: string;
	/** Unranked literal matches. */
	readonly lexical?: readonly {
		readonly label: string;
		readonly text: string;
	}[];
	readonly error?: string;
	/** The checkout hit paths are relative to: hits and passages link to their files. */
	readonly cwd?: string;
};

/** A relevance score's tone. */
export function scoreTone(score: number): TspTone {
	if (score >= 0.7) return "success";
	if (score >= 0.4) return "warning";
	return "muted";
}

/** `1.2K`, `950`, `3.4M`. */
function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
	return String(count);
}

function findHead(query: string | undefined, meta: readonly TspText[]): ToolHead {
	return { title: "Find", target: query ?? "", targetKind: "query", meta };
}

function callView(args: FindArgs | undefined, meta?: readonly TspText[]): ToolView {
	const keywords = args?.grep_keywords ?? [];
	const facts: string[] = [];
	if (keywords.length > 0) facts.push(keywords.join(" "));
	if (args?.path) facts.push(`in ${args.path}`);
	return {
		head: findHead(args?.query, meta ?? facts),
		term: { look: "find", query: args?.query, facts } satisfies FindTerm,
	};
}

function Hit(props: { readonly hit: FindHit; readonly cwd?: string; readonly ranges: number }): JSXNode {
	const { hit } = props;
	const tone = scoreTone(hit.contentScore);
	const score = hit.contentScore.toFixed(2);
	// `scheme://` hits (virtual documents) are not files under the cwd.
	const href =
		props.cwd !== undefined && splitUrlScheme(hit.rel) === undefined
			? fileHref(nodePath.join(props.cwd, hit.rel))
			: undefined;
	const spans = pathSpans(hit.rel, href);
	return (
		<col key={hit.rel} role="omp.tool.find.hit" gap="xs">
			<row key="hit" role="omp.tool.file">
				<progress value={hit.contentScore} tone={tone} title={`score ${score}`} max={{ w: 40 }} />
				<text spans={spans} title={hit.rel} truncate="middle" lines={1} shrink={1} />
				<text
					spans={[
						{ s: tone, t: score },
						{
							s: "muted",
							t: ` · ${hit.linesSeen} lines judged${hit.truncated ? ", partial" : ""}`,
						},
					]}
					truncate="end"
					lines={1}
					shrink={1}
				/>
			</row>
			{hit.ranges.slice(0, props.ranges).map(range => (
				<code
					key={`${range.start}-${range.end}`}
					text={range.snippet}
					path={hit.rel}
					start={range.start}
					numbers
					title={range.p.toFixed(2)}
				/>
			))}
		</col>
	);
}

export const findPresenter: ToolPresenter<FindArgs, FindDetails> = {
	inline: true,
	merge: true,
	call: args => callView(args),
	result(result, state, args): ToolView {
		const details = result.details;
		if (result.isError) {
			const message = resultText(result) || "Unknown error";
			return inlineErrorView(findHead(args?.query, []), message, {
				term: { look: "find", result: true, error: message } satisfies FindTerm,
			});
		}
		if (!details?.hits) {
			const progress = resultText(result);
			if (state.isPartial || !progress) {
				return callView(args, progress ? [[{ s: "muted", t: progress, fx: "shimmer" }]] : undefined);
			}
			return callView(args);
		}
		if (state.isPartial) return callView(args, []);
		const hits = details.hits;
		const stats = details.stats;
		const warnings: string[] = [];
		if (stats && stats.failed > 0) warnings.push(`${stats.failed}/${stats.requests} requests failed`);
		if (details.timeout)
			warnings.push(`timed out, ${details.timeout.verified}/${details.timeout.passages} passages verified`);
		const warningMeta = warnings.map((text): TspText => [{ s: "warning", t: text }]);
		const failures = stats?.failures ?? [];
		const failureNodes = failures.map((failure, i) => (
			<text key={`fail${i}`} role="omp.tool.notice" spans={[{ s: "warning", t: failure }]} wrap="word" />
		));
		const cost = stats ? `$${stats.cost.toFixed(4)}` : undefined;
		const took = details.elapsedMs !== undefined ? `${(details.elapsedMs / 1000).toFixed(1)}s` : undefined;
		const keywords = details.keywords?.length ? `keywords: ${details.keywords.join(", ")}` : undefined;
		const base = {
			look: "find" as const,
			result: true,
			query: details.query ?? args?.query,
			warnings,
			failures,
		};
		if (hits.length === 0) {
			const lexical = details.lexicalFallback ?? [];
			return {
				head: findHead(args?.query, [countText(0, "hit"), ...warningMeta]),
				tone: "warning",
				body: [
					lexical.map((match, i) => (
						<text
							key={`lex${i}`}
							spans={[{ s: "muted", t: `${match.rel}:${match.line}` }, { t: ` ${replaceTabs(match.snippet)}` }]}
							wrap="word"
						/>
					)),
					failureNodes,
				],
				term: {
					...base,
					facts: [countText(0, "hit"), ...[cost, took].filter((fact): fact is string => fact !== undefined)],
					empty:
						lexical.length > 0
							? "Unranked literal keyword matches (not semantically judged)"
							: "No relevant passages found",
					lexical: lexical.map(match => ({
						label: `${match.rel}:${match.line}`,
						text: match.snippet,
					})),
				} satisfies FindTerm,
			};
		}
		const statsText = [
			stats ? `${countText(stats.filesRead, "file")} read` : undefined,
			details.threshold !== undefined ? `τ ${details.threshold.toFixed(2)}` : undefined,
			stats ? `${formatTokens(stats.inputTokens + stats.outputTokens)} tokens` : undefined,
			cost,
			took,
		].filter((fact): fact is string => fact !== undefined);
		const expanded = state.expanded;
		const shown = expanded ? hits : hits.slice(0, COLLAPSED_HITS);
		const more = hits.length - shown.length;
		const footText = [more > 0 ? `${more} more hits` : undefined, keywords].filter(Boolean).join(" · ");
		const scope = details.scopePath ? `in ${details.scopePath}` : undefined;
		const meta: TspText[] = [`${countText(hits.length, "hit")} · ${countText(stats?.filesRead ?? 0, "file")}`];
		if (scope) meta.push(scope);
		return {
			head: findHead(args?.query, [...meta, ...warningMeta]),
			preview: { lines: PREVIEW_LINES },
			body: [
				shown.map(hit => <Hit hit={hit} cwd={details.cwd} ranges={expanded ? EXPANDED_RANGES : 1} />),
				failureNodes,
				footText ? (
					<text
						key="foot"
						role="omp.tool.stats"
						spans={[{ s: "muted", t: footText }]}
						title={statsText.join(" · ")}
						wrap="word"
					/>
				) : undefined,
			],
			term: {
				...base,
				facts: [countText(hits.length, "hit"), ...(scope ? [scope] : []), ...statsText],
				more,
				keywords,
				...(details.cwd !== undefined ? { cwd: details.cwd } : {}),
			} satisfies FindTerm,
		};
	},
};

registerToolPresenter("find", findPresenter);
