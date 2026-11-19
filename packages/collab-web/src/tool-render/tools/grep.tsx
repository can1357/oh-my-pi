/** `grep` (legacy `search`) — ripgrep content search across workspace files. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, resultTextOf, scopePaths, shortenPath, str } from "../util";

/** Grep scope: current `path` (string, delimited, or JSON array) or legacy `paths`; defaults to workspace root. */
function pathsOf(args: Record<string, unknown>): string[] {
	const list = scopePaths(args).map(shortenPath);
	return list.length ? list : ["."];
}

/** Flag badges covering current and legacy arg dialects. */
function argBadges(args: Record<string, unknown>): ReactNode[] {
	const badges: ReactNode[] = [];
	const glob = str(args.glob);
	if (glob) badges.push(`glob=${glob}`);
	const type = str(args.type);
	if (type) badges.push(`type=${type}`);
	if (args.i === true) badges.push("i");
	if (args.multiline === true) badges.push("multiline");
	if (args.gitignore === false) badges.push("no-gitignore");
	const skip = num(args.skip);
	if (skip !== null && skip > 0) badges.push(`skip=${skip}`);
	return badges;
}

function Pattern({ args }: { args: Record<string, unknown> }): ReactNode {
	const pattern = str(args.pattern);
	if (pattern === null) return <InvalidArg what="pattern" />;
	return <span className="tv-pattern">/{pattern}/</span>;
}

function Summary({ args }: ToolRenderProps): ReactNode {
	return (
		<span>
			<Pattern args={args} /> <span className="tv-muted">in</span>{" "}
			<span className="tv-path">{pathsOf(args).join(", ")}</span> <Badges items={argBadges(args)} />
		</span>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const matchCount = num(details?.matchCount);
	const fileCount = num(details?.fileCount);
	const truncated = details?.truncated === true;
	const error = str(details?.error);
	const missing: string[] = [];
	if (details && Array.isArray(details.missingPaths)) {
		for (const p of details.missingPaths) {
			if (typeof p === "string") missing.push(shortenPath(p));
		}
	}
	const badges = argBadges(args);
	if (matchCount !== null) badges.push(`${matchCount} ${matchCount === 1 ? "match" : "matches"}`);
	if (fileCount !== null) badges.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`);
	return (
		<>
			<div>
				<Pattern args={args} /> <span className="tv-muted">in</span>{" "}
				<span className="tv-path">{pathsOf(args).join(", ")}</span> <Badges items={badges} />
				{truncated && (
					<>
						{" "}
						<Badge tone="warn">truncated</Badge>
					</>
				)}
			</div>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.join(", ")}</Note>}
			{error !== null && !resultTextOf(result).trim() && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={14} variant="code" />
		</>
	);
}

export const grepRenderer: ToolRenderer = { Summary, Body };
