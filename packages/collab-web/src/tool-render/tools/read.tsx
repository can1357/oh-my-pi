/** `read` — file/URL/archive reads: path + selector summary, highlighted content, image thumbnails. */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, PathText, ResultImages, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, num, shortenPath, str } from "../util";

/** Fields of `ReadToolDetails` the web view surfaces (untrusted wire JSON). */
interface ReadDetails {
	resolvedPath: string | null;
	suffixTo: string | null;
	suffixFrom: string | null;
	elidedSpans: number | null;
	conflictCount: number | null;
	truncated: boolean;
}

function readDetails(details: Record<string, unknown> | null): ReadDetails {
	const suffix = details && isRecord(details.suffixResolution) ? details.suffixResolution : null;
	const summary = details && isRecord(details.summary) ? details.summary : null;
	return {
		resolvedPath: details ? str(details.resolvedPath) : null,
		suffixTo: suffix ? str(suffix.to) : null,
		suffixFrom: suffix ? str(suffix.from) : null,
		elidedSpans: summary ? num(summary.elidedSpans) : null,
		conflictCount: details ? num(details.conflictCount) : null,
		truncated: details ? isRecord(details.truncation) : false,
	};
}

/** A trailing `:chunk` that reads as a selector: line ranges, `raw`, `conflicts`. */
const SEL_CHUNK_RE = /^(raw|conflicts|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/i;

/** Split a `path:sel` argument (handles compound `:50-100:raw` selectors). */
function splitPathSel(rawPath: string): { path: string; sel: string | null } {
	let path = rawPath;
	const chunks: string[] = [];
	for (let i = 0; i < 2; i++) {
		const idx = path.lastIndexOf(":");
		if (idx <= 0 || !SEL_CHUNK_RE.test(path.slice(idx + 1))) break;
		chunks.unshift(path.slice(idx + 1));
		path = path.slice(0, idx);
	}
	return { path, sel: chunks.length > 0 ? chunks.join(":") : null };
}

interface ReadArgs {
	path: string;
	sel: string | null;
	from: number | null;
	to: number | null;
}

function readArgs(args: Record<string, unknown>): ReadArgs {
	const rawPath = str(args.path) ?? str(args.file_path) ?? "";
	const split = splitPathSel(rawPath);
	const sel = str(args.sel) ?? split.sel;
	const offset = num(args.offset);
	const limit = num(args.limit);
	const from = offset !== null || limit !== null ? (offset ?? 1) : null;
	const to = from !== null && limit !== null ? from + limit - 1 : null;
	return { path: split.path || rawPath, sel, from, to };
}

function Summary(props: ToolRenderProps): ReactNode {
	const { path, sel, from, to } = readArgs(props.args);
	return <PathText path={path || "…"} from={from} to={to} sel={sel} />;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const { path } = readArgs(args);
	const d = readDetails(detailsRecord(result));
	const conflictBadge = d.conflictCount !== null && d.conflictCount > 0 && (
		<Badge tone="warn">
			{d.conflictCount} conflict{d.conflictCount === 1 ? "" : "s"}
		</Badge>
	);
	const elidedBadge = d.elidedSpans !== null && d.elidedSpans > 0 && (
		<Badge>
			{d.elidedSpans} elided span{d.elidedSpans === 1 ? "" : "s"}
		</Badge>
	);
	const truncatedBadge = d.truncated && <Badge tone="warn">truncated</Badge>;
	const resolved = d.suffixTo ?? d.resolvedPath;
	return (
		<>
			{(resolved !== null || d.suffixFrom !== null) && (
				<KvGrid>
					{resolved !== null && (
						<Kv k="resolved">
							<PathText path={resolved} />
						</Kv>
					)}
					{d.suffixFrom !== null && <Kv k="corrected from">{shortenPath(d.suffixFrom)}</Kv>}
				</KvGrid>
			)}
			<Badges items={[conflictBadge, elidedBadge, truncatedBadge]} />
			<ResultImages result={result} />
			<ResultText result={result} maxLines={12} lang={languageFromPath(path)} variant="code" />
		</>
	);
}

export const readRenderer: ToolRenderer = { Summary, Body };
