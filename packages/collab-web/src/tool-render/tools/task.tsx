/** `task` — spawn subagents: batch shape, streamed progress, per-agent results. */
import type { ReactNode } from "react";
import { AgentLink, Badge, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderHost, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

const MISSING_YIELD_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** One spawned unit of work, normalized across the batch and flat/legacy arg shapes. */
interface TaskItemView {
	id: string | null;
	description: string | null;
	assignment: string | null;
	isolated: boolean;
}

function taskItems(args: Record<string, unknown>): TaskItemView[] {
	const raw = args.tasks;
	if (Array.isArray(raw)) {
		const items: TaskItemView[] = [];
		for (const entry of raw) {
			if (!isRecord(entry)) continue;
			items.push({
				id: str(entry.id),
				description: str(entry.description),
				assignment: str(entry.assignment),
				isolated: entry.isolated === true,
			});
		}
		return items;
	}
	const flat: TaskItemView = {
		id: str(args.id),
		description: str(args.description),
		assignment: str(args.assignment),
		isolated: args.isolated === true,
	};
	return flat.id || flat.description || flat.assignment ? [flat] : [];
}

/** "Anna.Bob" nesting → "Anna>Bob" breadcrumb (mirrors the TUI's formatTaskId). */
function taskIdLabel(id: string): string {
	return id.includes(".") ? id.split(".").join(">") : id;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Outcome of one agent, mirroring the TUI's aborted / merge-failed / done / failed split. */
function resultStatus(res: Record<string, unknown>): { label: string; tone: "ok" | "err" | "warn" } {
	if (res.aborted === true) return { label: "aborted", tone: "err" };
	if (num(res.exitCode) === 0) {
		return str(res.error) ? { label: "merge failed", tone: "warn" } : { label: "done", tone: "ok" };
	}
	return { label: "failed", tone: "err" };
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const agent = str(args.agent);
	const resume = str(args.resume);
	const tasks = taskItems(args);
	const first = tasks.length > 0 ? tasks[0] : null;
	const label = first ? (first.description ?? first.id) : null;
	return (
		<>
			{agent && <Badge tone="accent">{agent}</Badge>}
			{!agent && resume && <Badge>resume {resume}</Badge>}
			{label && <span className="tv-muted">{truncate(normalizeWs(label), 72)}</span>}
			{tasks.length > 1 && <Badge>{tasks.length} tasks</Badge>}
		</>
	);
}

/** Final snapshot for one agent: status row, output preview, error/abort notes. */
function AgentResult({ res, host }: { res: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const { label, tone } = resultStatus(res);
	const id = str(res.id) ?? "agent";
	const description = str(res.description);
	const stats: string[] = [];
	const tokens = num(res.tokens);
	if (tokens) stats.push(`${fmtCount(tokens)} tok`);
	const requests = num(res.requests);
	if (requests) stats.push(`${requests} req`);
	const durationMs = num(res.durationMs);
	if (durationMs != null) stats.push(fmtDuration(durationMs));
	const model = str(res.resolvedModel);
	if (model) stats.push(model);

	// The runtime prepends a one-line warning when a subagent never called
	// yield; lift it out of the output preview like the TUI does.
	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	return (
		<>
			<Row
				k={
					<AgentLink id={id} host={host}>
						{taskIdLabel(id)}
					</AgentLink>
				}
			>
				<Badge tone={tone}>{label}</Badge> {res.truncated === true && <Badge tone="warn">truncated</Badge>}{" "}
				{description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
				{stats.length > 0 && <span className="tv-faint">{stats.join(" · ")}</span>}
			</Row>
			{warning && <Note tone="warn">{warning}</Note>}
			{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
			{output.trim() !== "" && <Output text={output} maxLines={6} error={tone === "err"} />}
			{error && !aborted && error !== abortReason && <Note tone={tone === "warn" ? "warn" : "err"}>{error}</Note>}
			{patchPath && <div className="tv-faint">patch: {patchPath}</div>}
			{!patchPath && branchName && <div className="tv-faint">branch: {branchName}</div>}
		</>
	);
}

/** Live (still-running) snapshot for one agent. */
function AgentProgressRow({ p, host }: { p: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const status = str(p.status) ?? "running";
	const tone =
		status === "completed"
			? ("ok" as const)
			: status === "failed" || status === "aborted"
				? ("err" as const)
				: status === "running"
					? ("accent" as const)
					: undefined;
	const id = str(p.id) ?? "agent";
	const description = str(p.description);
	const intent = str(p.lastIntent) ?? str(p.currentTool);
	const bits: string[] = [];
	const toolCount = num(p.toolCount);
	if (toolCount) bits.push(`${toolCount} tools`);
	const tokens = num(p.tokens);
	if (tokens) bits.push(`${fmtCount(tokens)} tok`);
	const durationMs = num(p.durationMs);
	if (durationMs) bits.push(fmtDuration(durationMs));
	return (
		<Row
			k={
				<AgentLink id={id} host={host}>
					{taskIdLabel(id)}
				</AgentLink>
			}
		>
			<Badge tone={tone}>{status}</Badge> {description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
			{intent && <span className="tv-muted">{truncate(normalizeWs(intent), 64)}</span>}{" "}
			{bits.length > 0 && <span className="tv-faint">{bits.join(" · ")}</span>}
		</Row>
	);
}

function Body({ args, result, host }: ToolRenderProps): ReactNode {
	const resume = str(args.resume);
	const context = str(args.context);
	const tasks = taskItems(args);
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const showProgress = results.length === 0 && progress.length > 0;

	// Run footer: outcome counts + total wall time (mirrors the TUI's bracket line).
	let footer: ReactNode = null;
	if (results.length > 0) {
		let ok = 0;
		let mergeFailed = 0;
		let aborted = 0;
		let failed = 0;
		for (const res of results) {
			const { label } = resultStatus(res);
			if (label === "done") ok++;
			else if (label === "merge failed") mergeFailed++;
			else if (label === "aborted") aborted++;
			else failed++;
		}
		const total = details ? num(details.totalDurationMs) : null;
		footer = (
			<Row>
				{ok > 0 && <Badge tone="ok">{ok} succeeded</Badge>}{" "}
				{mergeFailed > 0 && <Badge tone="warn">{mergeFailed} merge failed</Badge>}{" "}
				{failed > 0 && <Badge tone="err">{failed} failed</Badge>}{" "}
				{aborted > 0 && <Badge tone="err">{aborted} aborted</Badge>}{" "}
				{total != null && <span className="tv-faint">{fmtDuration(total)}</span>}
			</Row>
		);
	}

	// Finished agents first, by runtime ascending — same order as the TUI.
	const ordered = [...results].sort(
		(a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0),
	);

	return (
		<>
			{resume && <Badge>resume {resume}</Badge>}
			{context && <Output text={context} maxLines={4} title="context" />}
			{tasks.length > 0 && (
				<div className="tv-list">
					{tasks.map((t, i) => (
						<div key={t.id ?? i}>
							<Row
								k={
									t.id ? (
										<AgentLink id={t.id} host={host}>
											{taskIdLabel(t.id)}
										</AgentLink>
									) : (
										<Badge tone="accent">{`#${i + 1}`}</Badge>
									)
								}
							>
								{t.isolated && <Badge>isolated</Badge>}{" "}
								{t.description && <span>{truncate(normalizeWs(t.description), 120)}</span>}
							</Row>
							{t.assignment && <Output text={t.assignment} maxLines={6} title="assignment" />}
						</div>
					))}
				</div>
			)}
			{ordered.length > 0 && (
				<div className="tv-list">
					{ordered.map((res, i) => (
						<AgentResult key={str(res.id) ?? i} res={res} host={host} />
					))}
					{footer}
				</div>
			)}
			{showProgress && (
				<div className="tv-list">
					{progress.map((p, i) => (
						<AgentProgressRow key={str(p.id) ?? i} p={p} host={host} />
					))}
				</div>
			)}
			{ordered.length === 0 && !showProgress && <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const taskRenderer: ToolRenderer = { Summary, Body };
