/**
 * `job` — async job control: poll running background jobs, cancel them, or
 * list everything in flight. Aliases: `await`, `poll`, `cancel_job`.
 *
 * The TUI renders `details.jobs` as a status tree (running first, then failed,
 * then cancelled/completed) with type badge, label, duration, and a one-line
 * result preview; we mirror that as rows plus the raw snapshot text.
 */
import type { ReactNode } from "react";
import type { Tone } from "../parts";
import { Badge, Badges, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface JobSnapshotLike {
	id: string;
	/** "bash" | "task" upstream; untrusted, so plain string. */
	type: string;
	/** "running" | "completed" | "failed" | "cancelled" upstream. */
	status: string;
	label: string;
	durationMs: number;
	resultText: string;
	errorText: string;
}

interface CancelOutcomeLike {
	id: string;
	/** "cancelled" | "not_found" | "already_completed" upstream. */
	status: string;
}

function idList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const id = str(item);
		if (id) out.push(id);
	}
	return out;
}

/** `poll` (+ legacy `jobs`/`jobIds`) job ids. */
function pollIds(args: Record<string, unknown>): string[] {
	const poll = idList(args.poll);
	if (poll.length > 0) return poll;
	const jobs = idList(args.jobs);
	return jobs.length > 0 ? jobs : idList(args.jobIds);
}

/** `cancel` (+ legacy single `jobId`) job ids. */
function cancelIds(args: Record<string, unknown>): string[] {
	const cancel = idList(args.cancel);
	if (cancel.length > 0) return cancel;
	const single = str(args.jobId);
	return single ? [single] : [];
}

/** "poll a1b2" / "poll a1b2, c3d4" when few ids, "poll 5" otherwise. */
function groupLabel(verb: string, ids: string[]): string {
	return ids.length <= 2 ? `${verb} ${ids.join(", ")}` : `${verb} ${ids.length}`;
}

function jobOf(value: unknown): JobSnapshotLike | null {
	if (!isRecord(value)) return null;
	const id = str(value.id);
	if (!id) return null;
	return {
		id,
		type: str(value.type) ?? "",
		status: str(value.status) ?? "",
		label: str(value.label) ?? "",
		durationMs: num(value.durationMs) ?? 0,
		resultText: str(value.resultText) ?? "",
		errorText: str(value.errorText) ?? "",
	};
}

function jobsOf(details: Record<string, unknown> | null): JobSnapshotLike[] {
	const raw = details?.jobs;
	if (!Array.isArray(raw)) return [];
	const out: JobSnapshotLike[] = [];
	for (const item of raw) {
		const job = jobOf(item);
		if (job) out.push(job);
	}
	return out;
}

function cancelOutcomesOf(details: Record<string, unknown> | null): CancelOutcomeLike[] {
	const raw = details?.cancelled;
	if (!Array.isArray(raw)) return [];
	const out: CancelOutcomeLike[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const id = str(item.id);
		if (id) out.push({ id, status: str(item.status) ?? "" });
	}
	return out;
}

function statusTone(status: string): Tone | undefined {
	switch (status) {
		case "completed":
			return "ok";
		case "failed":
			return "err";
		case "cancelled":
			return "warn";
		case "running":
			return "accent";
		default:
			return undefined;
	}
}

// Running first (what the user is waiting on), then failed, then the rest.
const STATUS_ORDER: Record<string, number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${Math.round(s % 60)}s`;
}

/**
 * Task job results arrive in the model-facing `<task-result>` envelope; the
 * wrapper markup is noise to a human — preview the inner body instead.
 */
function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

function JobRow({ job }: { job: JobSnapshotLike }): ReactNode {
	const tone = statusTone(job.status);
	const label = normalizeWs(job.label) || "(no label)";
	// Task jobs label themselves with their agent id — drop the id column
	// instead of stuttering it twice.
	const showId = label !== job.id;
	const rawPreview = job.errorText.trim() || job.resultText.trim();
	const preview = rawPreview ? truncate(normalizeWs(stripTaskResultEnvelope(rawPreview)), 160) : "";
	return (
		<Row k={<Badge tone={tone}>{job.status || "?"}</Badge>}>
			{job.type && <Badge tone={tone}>{job.type}</Badge>}
			{showId && <span className="tv-path"> {job.id}</span>}
			<span> {truncate(label, 80)}</span>
			{job.durationMs > 0 && <span className="tv-faint"> {formatDuration(job.durationMs)}</span>}
			{preview && <span className={job.errorText ? "tv-err-text" : "tv-faint"}> — {preview}</span>}
		</Row>
	);
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const poll = pollIds(args);
	const cancel = cancelIds(args);
	const items: ReactNode[] = [];
	if (args.list === true) {
		items.push(
			<Badge key="list" tone="accent">
				list
			</Badge>,
		);
	}
	if (cancel.length > 0) {
		items.push(
			<Badge key="cancel" tone="warn">
				{groupLabel("cancel", cancel)}
			</Badge>,
		);
	}
	if (poll.length > 0) {
		items.push(
			<Badge key="poll" tone="accent">
				{groupLabel("poll", poll)}
			</Badge>,
		);
	}
	if (items.length === 0) return <span className="tv-muted">all running jobs</span>;
	return <Badges items={items} />;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const poll = pollIds(args);
	const cancel = cancelIds(args);
	const details = detailsRecord(result);
	const jobs = jobsOf(details);
	const badOutcomes = cancelOutcomesOf(details).filter(o => o.status !== "cancelled" && o.status !== "");

	// Settled/running tallies, mirroring the TUI header meta.
	let running = 0;
	let completed = 0;
	let failed = 0;
	let cancelledCount = 0;
	for (const job of jobs) {
		if (job.status === "running") running++;
		else if (job.status === "completed") completed++;
		else if (job.status === "failed") failed++;
		else if (job.status === "cancelled") cancelledCount++;
	}

	const sorted = [...jobs].sort((a, b) => {
		const diff = (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
		return diff !== 0 ? diff : b.durationMs - a.durationMs;
	});

	return (
		<>
			{(args.list === true || poll.length > 0 || cancel.length > 0) && (
				<div className="tv-list">
					{args.list === true && <Row k="list">all jobs</Row>}
					{poll.length > 0 && <Row k="poll">{poll.join(", ")}</Row>}
					{cancel.length > 0 && <Row k="cancel">{cancel.join(", ")}</Row>}
				</div>
			)}
			{jobs.length > 0 && (
				<>
					<Badges
						items={[
							running > 0 && (
								<Badge key="running" tone="accent">
									{running === jobs.length
										? `waiting on ${running}`
										: `waiting on ${running} of ${jobs.length}`}
								</Badge>
							),
							completed > 0 && (
								<Badge key="done" tone="ok">
									{completed} done
								</Badge>
							),
							failed > 0 && (
								<Badge key="failed" tone="err">
									{failed} failed
								</Badge>
							),
							cancelledCount > 0 && (
								<Badge key="cancelled" tone="warn">
									{cancelledCount} cancelled
								</Badge>
							),
						]}
					/>
					<div className="tv-list">
						{sorted.map(job => (
							<JobRow key={job.id} job={job} />
						))}
					</div>
				</>
			)}
			{badOutcomes.length > 0 && (
				<Note tone="warn">{badOutcomes.map(o => `${o.id}: ${o.status.replace(/_/g, " ")}`).join(" · ")}</Note>
			)}
			<ResultText result={result} maxLines={10} title={jobs.length > 0 ? "snapshot" : undefined} />
		</>
	);
}

export const jobRenderer: ToolRenderer = { Summary, Body };
