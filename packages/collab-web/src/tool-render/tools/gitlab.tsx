/** `gitlab` — glab CLI dispatch: projects, files, MRs, discussions, search, checkout/push, CI pipelines. */
import type { ReactNode } from "react";
import { Badge, InvalidArg, Kv, KvGrid, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, shortenPath, str, truncate } from "../util";

const SUCCESS_STATUSES: Record<string, true> = { success: true, skipped: true, manual: true };
const FAILURE_STATUSES: Record<string, true> = { failed: true, canceled: true };
const RUNNING_STATUSES: Record<string, true> = { running: true };

function mrId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const direct = /^!?(\d+)$/.exec(trimmed);
	if (direct) return `!${direct[1]}`;
	const match = /\/merge_requests\/(\d+)/.exec(trimmed);
	if (match) return `!${match[1]}`;
	return truncate(trimmed, 40);
}

function formatMr(mr: unknown): string | null {
	if (typeof mr === "string") return mrId(mr);
	if (!Array.isArray(mr)) return null;
	const parts: string[] = [];
	for (const item of mr) {
		if (typeof item !== "string") continue;
		const id = mrId(item);
		if (id) parts.push(id);
	}
	if (parts.length === 0) return null;
	if (parts.length > 3) return `${parts.slice(0, 3).join(", ")}, +${parts.length - 3} more`;
	return parts.join(", ");
}

function shortSha(sha: string): string {
	return /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

function Salient({ args }: { args: Record<string, unknown> }): ReactNode {
	const op = str(args.op) ?? "";
	const repo = str(args.repo) ?? str(args.group);
	if (op.startsWith("search_")) {
		const query = str(args.query);
		return (
			<>
				{query && <span className="tv-pattern">{truncate(normalizeWs(query), 60)}</span>}
				{repo && <span className="tv-muted">{repo}</span>}
			</>
		);
	}
	if (
		op === "mr_checkout" ||
		op === "mr_push" ||
		op === "mr_update" ||
		op === "mr_discussions" ||
		op === "mr_note" ||
		op === "mr_discussion_resolve"
	) {
		const target = formatMr(args.mr) ?? str(args.ref);
		return (
			<>
				{target && <span>{target}</span>}
				{repo && <span className="tv-muted">{repo}</span>}
			</>
		);
	}
	if (op === "mr_create") {
		const title = str(args.title);
		if (title) return <span>{truncate(normalizeWs(title), 60)}</span>;
		return args.fill === true ? <span className="tv-muted">fill from commits</span> : null;
	}
	if (op === "pipeline_watch" || op === "pipeline_view") {
		const pipeline = str(args.pipeline);
		const mr = formatMr(args.mr);
		const ref = str(args.ref);
		if (pipeline) return <span>pipeline {truncate(pipeline, 50)}</span>;
		if (mr) return <span>{mr} pipeline</span>;
		return <span className="tv-muted">{ref ?? "current branch"} pipeline</span>;
	}
	if (op === "job_log" || op === "job_retry") {
		const job = str(args.job);
		return (
			<>
				{job && <span>{truncate(job, 50)}</span>}
				{repo && <span className="tv-muted">{repo}</span>}
			</>
		);
	}
	const path = str(args.path);
	const ref = str(args.ref);
	return (
		<>
			{path && <span>{truncate(path, 50)}</span>}
			{repo && <span className="tv-muted">{repo}</span>}
			{ref && <span className="tv-muted">{ref}</span>}
		</>
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const op = str(props.args.op);
	return (
		<>
			{op ? <Badge tone="accent">{op}</Badge> : <Badge tone="warn">no op</Badge>} <Salient args={props.args} />
		</>
	);
}

function argValue(value: unknown): ReactNode {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			if (typeof item === "string" || typeof item === "number") parts.push(String(item));
		}
		return parts.join(", ");
	}
	return <InvalidArg />;
}

function ArgsGrid({ args }: { args: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key in args) {
		if (key === "op" || key === "body") continue;
		const value = args[key];
		if (value === undefined || value === null) continue;
		rows.push(
			<Kv k={key} key={key}>
				{argValue(value)}
			</Kv>,
		);
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function jobVisual(job: Record<string, unknown>): { icon: string; cls: string } {
	const status = str(job.status) ?? "";
	if (SUCCESS_STATUSES[status]) return { icon: "✓", cls: "tv-ok-text" };
	if (FAILURE_STATUSES[status]) {
		return job.allowFailure === true ? { icon: "!", cls: "tv-warn-text" } : { icon: "✕", cls: "tv-err-text" };
	}
	if (RUNNING_STATUSES[status]) return { icon: "●", cls: "tv-warn-text" };
	return { icon: "○", cls: "tv-faint" };
}

function WatchView({ watch }: { watch: Record<string, unknown> }): ReactNode {
	const repo = str(watch.repo) ?? "";
	const watching = str(watch.state) === "watching";
	const pipelineId = num(watch.pipelineId);
	const ref = str(watch.ref);
	const sha = str(watch.headSha);
	const status = str(watch.status);
	const target = pipelineId !== null ? `pipeline #${pipelineId}` : "pipeline";
	const header = `${watching ? "watching " : ""}${target}${ref ? ` (${ref})` : ""}${sha ? ` ${shortSha(sha)}` : ""} on ${repo}`;
	const note = str(watch.note);
	const jobs = Array.isArray(watch.jobs) ? watch.jobs : [];
	const failedLogs = Array.isArray(watch.failedLogs) ? watch.failedLogs : [];
	const tone =
		status && SUCCESS_STATUSES[status]
			? ("ok" as const)
			: status && FAILURE_STATUSES[status]
				? ("err" as const)
				: status && RUNNING_STATUSES[status]
					? ("warn" as const)
					: undefined;

	return (
		<>
			<div className="tv-muted">
				{header} {status && <Badge tone={tone}>{status}</Badge>}
			</div>
			{note && <div className="tv-faint">{note}</div>}
			<div className="tv-list">
				{jobs.length === 0 && (
					<Row>
						<span className="tv-faint">waiting for pipeline jobs…</span>
					</Row>
				)}
				{jobs.map((job, index) => {
					if (!isRecord(job)) return null;
					const visual = jobVisual(job);
					const duration = num(job.durationSeconds);
					const stage = str(job.stage);
					return (
						<Row key={num(job.id) ?? index}>
							<span className={visual.cls}>{visual.icon}</span>{" "}
							{stage && <span className="tv-muted">{stage}: </span>}
							<span>{str(job.name) ?? "job"}</span>
							{job.allowFailure === true && <span className="tv-faint"> (allowed to fail)</span>}
							{duration !== null && <span className="tv-faint"> {duration}s</span>}
						</Row>
					);
				})}
			</div>
			{failedLogs.map((entry, index) => {
				if (!isRecord(entry)) return null;
				const jobName = str(entry.jobName) ?? "job";
				const stage = str(entry.stage);
				const jobId = num(entry.jobId);
				const title = `${jobName}${stage ? ` — ${stage}` : ""}${jobId !== null ? ` #${jobId}` : ""}`;
				const tail = str(entry.tail);
				if (!tail || entry.available === false) {
					return (
						<Note tone="warn" key={index}>
							{title}: log tail unavailable
						</Note>
					);
				}
				return <Output text={tail} maxLines={12} error title={title} key={index} />;
			})}
		</>
	);
}

function CheckoutRows({ checkouts }: { checkouts: readonly unknown[] }): ReactNode {
	return (
		<div className="tv-list">
			{checkouts.map((entry, index) => {
				if (!isRecord(entry)) return null;
				const mrIid = num(entry.mrIid);
				const worktree = str(entry.worktreePath);
				return (
					<Row k={mrIid !== null ? `!${mrIid}` : "MR"} key={mrIid ?? index}>
						<span>{str(entry.branch) ?? ""}</span>
						{worktree && <span className="tv-muted"> {shortenPath(worktree)}</span>}
						{entry.reused === true && <Badge>reused</Badge>}
					</Row>
				);
			})}
		</div>
	);
}

const DETAIL_KEYS = [
	"repo",
	"branch",
	"worktreePath",
	"remote",
	"remoteBranch",
	"headSha",
	"pipelineId",
	"jobId",
	"status",
];

function DetailsGrid({ details }: { details: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key of DETAIL_KEYS) {
		const value = details[key];
		if (typeof value === "number") {
			rows.push(
				<Kv k={key} key={key}>
					{String(value)}
				</Kv>,
			);
		} else if (typeof value === "string" && value) {
			const text = key === "worktreePath" ? shortenPath(value) : key === "headSha" ? shortSha(value) : value;
			rows.push(
				<Kv k={key} key={key}>
					{text}
				</Kv>,
			);
		}
	}
	if (Array.isArray(details.failedJobs)) {
		const jobs: string[] = [];
		for (const job of details.failedJobs) {
			if (typeof job === "string") jobs.push(job);
		}
		if (jobs.length > 0) {
			rows.push(
				<Kv k="failedJobs" key="failedJobs">
					<span className="tv-err-text">{jobs.join(", ")}</span>
				</Kv>,
			);
		}
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const watch = details && isRecord(details.watch) ? details.watch : null;
	const checkouts = details && Array.isArray(details.checkouts) ? details.checkouts : null;
	const bodyText = str(args.body);
	return (
		<>
			<ArgsGrid args={args} />
			{bodyText && <Output text={bodyText} maxLines={8} title="body" />}
			{watch && <WatchView watch={watch} />}
			{checkouts && checkouts.length > 0 && <CheckoutRows checkouts={checkouts} />}
			{details && !watch && <DetailsGrid details={details} />}
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

export const gitlabRenderer: ToolRenderer = { Summary, Body };
