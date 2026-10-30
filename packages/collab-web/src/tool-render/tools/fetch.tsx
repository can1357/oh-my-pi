/** `fetch` — reader-mode URL fetch; output is markdown with a metadata header. */
import { t as ___ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import type { ReactNode } from "react";
import { Badge, InvalidArg, Kv, KvGrid, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, str, truncate } from "../util";

/** Subset of the tool's `ReadUrlToolDetails` we render. */
interface FetchDetails {
	url: string | null;
	finalUrl: string | null;
	contentType: string | null;
	method: string | null;
	truncated: boolean;
	notes: string[];
}

function fetchDetails(record: Record<string, unknown> | null): FetchDetails | null {
	if (!record) return null;
	const notes: string[] = [];
	if (Array.isArray(record.notes)) {
		for (const note of record.notes) {
			const text = str(note);
			if (text) notes.push(text);
		}
	}
	return {
		url: str(record.url),
		finalUrl: str(record.finalUrl),
		contentType: str(record.contentType),
		method: str(record.method),
		truncated: record.truncated === true,
		notes,
	};
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const url = str(args.url) ?? str(args.path);
	const method = (str(args.method) ?? "").toUpperCase();
	const details = fetchDetails(detailsRecord(result));
	return (
		<>
			{url ? <span className="tv-path">{truncate(url, 90)}</span> : <InvalidArg what="url" />}
			{method && method !== "GET" && (
				<>
					{" "}
					<Badge tone="accent">{method}</Badge>
				</>
			)}
			{args.raw === true && (
				<>
					{" "}
					<Badge>{___ompTranslate("raw")}</Badge>
				</>
			)}
			{details?.truncated && (
				<>
					{" "}
					<Badge tone="warn">{___ompTranslate("truncated")}</Badge>
				</>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const url = str(args.url) ?? str(args.path);
	const method = (str(args.method) ?? "").toUpperCase();
	const timeout = num(args.timeout);
	const details = fetchDetails(detailsRecord(result));
	const redirected = Boolean(details?.finalUrl && details.url && details.finalUrl !== details.url);
	return (
		<>
			<KvGrid>
				<Kv k="url">{url ?? <InvalidArg what="url" />}</Kv>
				<Kv k={__ompTranslate("method")}>{method && method !== "GET" && <Badge tone="accent">{method}</Badge>}</Kv>
				<Kv k={__ompTranslate("raw")}>{args.raw === true && <Badge>{__ompTranslate("raw")}</Badge>}</Kv>
				<Kv k={__ompTranslate("timeout")}>{timeout != null && `${timeout}s`}</Kv>
				<Kv k={__ompTranslate("final url")}>{redirected && details?.finalUrl}</Kv>
				<Kv k="content-type">{details?.contentType}</Kv>
				<Kv k={__ompTranslate("via")}>{details?.method}</Kv>
				<Kv k={__ompTranslate("notes")}>{details && details.notes.length > 0 && details.notes.join("; ")}</Kv>
				<Kv k={__ompTranslate("truncated\u0004tool.fetch.truncated")}>
					{details?.truncated && <Badge tone="warn">{__ompTranslate("output truncated")}</Badge>}
				</Kv>
			</KvGrid>
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

export const fetchRenderer: ToolRenderer = { Summary, Body };
