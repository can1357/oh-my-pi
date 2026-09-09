/** `web_search` — provider-backed web search with synthesized answer and sources. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Kv, KvGrid, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, resultTextOf, str, truncate } from "../util";

function getDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function formatAge(seconds: unknown): string {
	const s = num(seconds);
	if (s === null || s < 0) return "";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 365) return `${d}d ago`;
	return `${Math.floor(d / 365)}y ago`;
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	return (
		<>
			{query === null ? (
				<InvalidArg what="query" />
			) : (
				<span className="tv-pattern">{truncate(normalizeWs(query), 80)}</span>
			)}
			{recency && <Badge>{recency}</Badge>}
		</>
	);
}

function SourceRow({ source, index }: { source: Record<string, unknown>; index: number }): ReactNode {
	const url = str(source.url) ?? "";
	const title = str(source.title)?.trim() || url || "Untitled";
	const domain = url ? getDomain(url) : "";
	const age = formatAge(source.ageSeconds) || (str(source.publishedDate) ?? "");
	return (
		<Row k={String(index + 1)}>
			{url ? (
				<a href={url} rel="noreferrer" target="_blank">
					{title}
				</a>
			) : (
				title
			)}
			{domain && <span className="tv-faint"> ({domain})</span>}
			{age && <span className="tv-muted"> · {age}</span>}
		</Row>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	const limit = num(args.limit);
	const numResults = num(args.num_search_results);

	const details = detailsRecord(result);
	const response = details && isRecord(details.response) ? details.response : null;
	const errorMsg = details ? str(details.error) : null;
	const provider = response ? str(response.provider) : null;
	const model = response ? str(response.model) : null;
	const authMode = response ? str(response.authMode) : null;
	const sources: Record<string, unknown>[] =
		response && Array.isArray(response.sources) ? response.sources.filter(isRecord) : [];

	let providerInfo = model && provider ? `${model} @ ${provider}` : (model ?? provider ?? "");
	if (providerInfo && authMode) {
		providerInfo += ` (${authMode === "oauth" ? "OAuth" : authMode === "api_key" ? "API" : authMode})`;
	}

	const usage = response && isRecord(response.usage) ? response.usage : null;
	const usageParts: string[] = [];
	if (usage) {
		const inTok = num(usage.inputTokens);
		const outTok = num(usage.outputTokens);
		const totalTok = num(usage.totalTokens);
		const searchReqs = num(usage.searchRequests);
		if (inTok !== null) usageParts.push(`in ${inTok}`);
		if (outTok !== null) usageParts.push(`out ${outTok}`);
		if (totalTok !== null) usageParts.push(`total ${totalTok}`);
		if (searchReqs !== null) usageParts.push(`search ${searchReqs}`);
	}

	return (
		<>
			<Badges
				items={[
					recency && `recency=${recency}`,
					limit !== null && `limit=${limit}`,
					numResults !== null && `results=${numResults}`,
					response && `${sources.length} source${sources.length === 1 ? "" : "s"}`,
				]}
			/>
			{(query !== null || providerInfo || usageParts.length > 0) && (
				<KvGrid>
					{query !== null && <Kv k="query">{query}</Kv>}
					{providerInfo && <Kv k="provider">{providerInfo}</Kv>}
					{usageParts.length > 0 && <Kv k="usage">{usageParts.join(" · ")}</Kv>}
				</KvGrid>
			)}
			{errorMsg && !resultTextOf(result) && <Note tone="err">{errorMsg}</Note>}
			<ResultText result={result} maxLines={14} lang="markdown" />
			{sources.length > 0 && (
				<div className="tv-list">
					{sources.map((source, i) => (
						<SourceRow key={str(source.url) ?? i} source={source} index={i} />
					))}
				</div>
			)}
		</>
	);
}

export const webSearchRenderer: ToolRenderer = { Summary, Body };
