/** `bash` — shell command execution: prompt line with env prefix, badges, output tail. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, ResultImages, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, display, isRecord, normalizeWs, num, resultTextOf, shortenPath, str, truncate } from "../util";

/** Values safe to show unquoted in a `NAME=value` shell prefix. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Footer appended by the bash tool when long output was spilled to an artifact. */
const ARTIFACT_NOTICE = /\[raw output: artifact:\/\/([\w-]+)\]/;

function envPrefix(env: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const k in env) {
		const v = display(env[k]);
		parts.push(`${k}=${SHELL_SAFE.test(v) ? v : JSON.stringify(v)}`);
	}
	return parts.join(" ");
}

interface BashAsyncDetails {
	state: string;
	jobId: string | null;
}

function asyncDetailsOf(details: Record<string, unknown> | null): BashAsyncDetails | null {
	if (!details || !isRecord(details.async)) return null;
	const state = str(details.async.state);
	return state ? { state, jobId: str(details.async.jobId) } : null;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	if (command === null) return <InvalidArg what="command" />;
	const text = truncate(normalizeWs(command) || "…", 80);
	return result?.isError ? <span className="tv-err-text">{text}</span> : <span>{text}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const command = args.command === undefined ? "…" : str(args.command);
	const prefix = isRecord(args.env) ? envPrefix(args.env) : "";
	const cwd = str(args.cwd);
	const head = num(args.head);
	const tail = num(args.tail);

	const details = detailsRecord(result);
	const exitCode = num(details?.exitCode);
	const wallTimeMs = num(details?.wallTimeMs);
	const timeoutSeconds = num(args.timeout) ?? num(details?.timeoutSeconds);
	const requestedTimeoutSeconds = num(details?.requestedTimeoutSeconds);
	const job = asyncDetailsOf(details);
	const artifactId = ARTIFACT_NOTICE.exec(resultTextOf(result))?.[1] ?? null;

	const stats: string[] = [];
	if (wallTimeMs !== null) {
		stats.push(wallTimeMs < 1000 ? `wall ${Math.round(wallTimeMs)}ms` : `wall ${(wallTimeMs / 1000).toFixed(1)}s`);
	}
	if (requestedTimeoutSeconds !== null && requestedTimeoutSeconds !== timeoutSeconds) {
		stats.push(`requested timeout ${requestedTimeoutSeconds}s clamped`);
	}
	if (job?.jobId) stats.push(`job ${job.jobId}`);
	if (artifactId) stats.push(`artifact ${artifactId}`);

	return (
		<>
			<div className="tv-cmd">
				<span className="tv-cmd-prompt">$</span>
				<span className="tv-cmd-text">
					{prefix && <span className="tv-cmd-env">{`${prefix} `}</span>}
					{command ?? <InvalidArg what="command" />}
				</span>
			</div>
			<Badges
				items={[
					cwd && <Badge>cwd={shortenPath(cwd)}</Badge>,
					timeoutSeconds !== null && <Badge>timeout={timeoutSeconds}s</Badge>,
					args.pty === true && <Badge tone="accent">pty</Badge>,
					!job && args.async === true && <Badge tone="accent">async</Badge>,
					head !== null && <Badge>head={head}</Badge>,
					tail !== null && <Badge>tail={tail}</Badge>,
					exitCode !== null && <Badge tone="err">exit {exitCode}</Badge>,
					job && (
						<Badge tone={job.state === "failed" ? "err" : job.state === "running" ? "accent" : "ok"}>
							async {job.state}
						</Badge>
					),
				]}
			/>
			<ResultImages result={result} />
			<ResultText result={result} maxLines={12} />
			{stats.length > 0 && <Row>{stats.join(" · ")}</Row>}
		</>
	);
}

export const bashRenderer: ToolRenderer = { Summary, Body };
