/** `glob` (legacy `find`) — glob-based file finder; results are paths sorted by mtime. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, display, isRecord, num, shortenPath, str, truncate } from "../util";

/** `args.paths` accepts one glob or an array; anything else is invalid. */
function joinedGlobs(paths: unknown): string | null {
	if (typeof paths === "string") return shortenPath(paths);
	if (Array.isArray(paths)) return paths.map(p => shortenPath(display(p))).join(", ");
	return null;
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const globs = joinedGlobs(args.paths);
	if (globs === null && args.paths !== undefined) return <InvalidArg what="paths" />;
	return <span className="tv-pattern">{truncate(globs || "*", 120)}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const limit = num(args.limit);
	const timeout = num(args.timeout);
	const fileCount = num(details?.fileCount);
	const resultLimit = num(details?.resultLimitReached);
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const meta = details && isRecord(details.meta) ? details.meta : null;
	const limits = meta && isRecord(meta.limits) ? meta.limits : null;
	const truncated =
		Boolean(details?.truncated) ||
		resultLimit !== null ||
		(details !== null && isRecord(details.truncation)) ||
		(meta !== null && isRecord(meta.truncation)) ||
		Boolean(limits?.resultLimit);
	const missing = Array.isArray(details?.missingPaths)
		? details.missingPaths.filter((p): p is string => typeof p === "string")
		: [];

	return (
		<>
			<Badges
				items={[
					limit !== null && <Badge>limit {limit}</Badge>,
					args.gitignore === false && <Badge>no-gitignore</Badge>,
					args.hidden === false && <Badge>no-hidden</Badge>,
					timeout !== null && <Badge>timeout {timeout}s</Badge>,
					fileCount !== null && (
						<Badge tone="accent">
							{fileCount} file{fileCount === 1 ? "" : "s"}
						</Badge>
					),
					scopePath !== null && <Badge>in {shortenPath(scopePath)}</Badge>,
					truncated && (
						<Badge tone="warn">{resultLimit !== null ? `truncated at ${resultLimit}` : "truncated"}</Badge>
					),
				]}
			/>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.map(shortenPath).join(", ")}</Note>}
			{error !== null && !result?.isError && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={12} />
		</>
	);
}

export const globRenderer: ToolRenderer = { Summary, Body };
