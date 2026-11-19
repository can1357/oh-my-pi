/** `fetch` — reader-mode URL fetch; output is markdown with a metadata header. */
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
					<Badge>raw</Badge>
				</>
			)}
			{details?.truncated && (
				<>
					{" "}
					<Badge tone="warn">truncated</Badge>
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
				<Kv k="method">{method && method !== "GET" && <Badge tone="accent">{method}</Badge>}</Kv>
				<Kv k="raw">{args.raw === true && <Badge>raw</Badge>}</Kv>
				<Kv k="timeout">{timeout != null && `${timeout}s`}</Kv>
				<Kv k="final url">{redirected && details?.finalUrl}</Kv>
				<Kv k="content-type">{details?.contentType}</Kv>
				<Kv k="via">{details?.method}</Kv>
				<Kv k="notes">{details && details.notes.length > 0 && details.notes.join("; ")}</Kv>
				<Kv k="truncated">{details?.truncated && <Badge tone="warn">output truncated</Badge>}</Kv>
			</KvGrid>
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

export const fetchRenderer: ToolRenderer = { Summary, Body };
