import { GitBranch } from "lucide-react";
import { getRequestDetails } from "../api";
import {
	formatCost,
	formatDurationMs,
	formatFolder,
	formatInteger,
	formatMessageCost,
	formatRelativeTime,
	formatTimestamp,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { buildHash, parseHash } from "../data/useHashRoute";
import { type RequestStatus, requestStatus } from "../data/view-models";
import type { RequestDetails } from "../types";
import { Badge, type Tone } from "./Badge";
import { Drawer, KeyValues } from "./Drawer";
import { JsonBlock } from "./JsonBlock";
import { ErrorState, Skeleton } from "./States";
import "./request-drawer.css";

/** Label and tone for each request outcome; shared by the request tables. */
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
	ok: { label: "OK", tone: "ok" },
	aborted: { label: "Aborted", tone: "warn" },
	failed: { label: "Failed", tone: "bad" },
};

export interface RequestDrawerProps {
	id: number | null;
	onClose: () => void;
}

/** Full detail sheet for one model request: timing, tokens, cost, ids, error, and the raw session entry. */
export function RequestDrawer({ id, onClose }: RequestDrawerProps) {
	const query = useQuery(["request", id], () => getRequestDetails(id ?? 0), { enabled: id !== null });
	// Never show the previous request's payload under a new id.
	const details = query.stale ? null : query.data;
	const status = details ? REQUEST_STATUS[requestStatus(details)] : null;

	return (
		<Drawer
			open={id !== null}
			onClose={onClose}
			width={620}
			title={details ? <span className="mono">{details.model}</span> : "Request"}
			subtitle={
				details ? (
					<>
						{details.provider} ·{" "}
						<span title={formatTimestamp(details.timestamp)}>{formatRelativeTime(details.timestamp)}</span>
					</>
				) : id !== null ? (
					<span className="mono">#{id}</span>
				) : undefined
			}
			actions={
				details && status ? (
					<div className="row" style={{ gap: 6 }}>
						<a
							className="btn"
							data-size="sm"
							data-variant="ghost"
							href={buildHash({
								...parseHash(window.location.hash),
								section: "traces",
								session: details.sessionFile,
							})}
							onClick={onClose}
							title="Open this request's session in the trace view"
						>
							<GitBranch size={13} /> Trace
						</a>
						<Badge tone={status.tone}>{status.label}</Badge>
					</div>
				) : undefined
			}
		>
			{details ? (
				<RequestDetailsBody details={details} aborted={requestStatus(details) === "aborted"} />
			) : query.error ? (
				<ErrorState error={query.error} onRetry={query.refetch} />
			) : (
				<div className="stack" style={{ gap: 12 }}>
					<Skeleton height={56} />
					<Skeleton height={120} />
					<Skeleton height={120} />
					<Skeleton height={220} />
				</div>
			)}
		</Drawer>
	);
}

function RequestDetailsBody({ details, aborted }: { details: RequestDetails; aborted: boolean }) {
	const { usage } = details;
	const throughput =
		details.duration !== null && details.duration > 0 && usage.output > 0
			? (usage.output * 1000) / details.duration
			: null;
	// The stats row as ingested, without the session payload shown separately below.
	const { messages, output, ...row } = details;

	return (
		<>
			{details.errorMessage && (
				<section className="request-drawer-error" data-tone={aborted ? "warn" : "bad"} role="note">
					<div className="request-drawer-error-label">{aborted ? "Aborted" : "Error"}</div>
					<pre className="request-drawer-error-text">{details.errorMessage}</pre>
				</section>
			)}

			<section>
				<div className="section-label">Timing</div>
				<KeyValues
					items={[
						{ key: "at", label: "Started", value: formatTimestamp(details.timestamp) },
						{ key: "duration", label: "Duration", value: formatDurationMs(details.duration) },
						{ key: "ttft", label: "Time to first token", value: formatDurationMs(details.ttft) },
						{ key: "tps", label: "Output tokens/s", value: formatTokensPerSecond(throughput) },
					]}
				/>
			</section>

			<section>
				<div className="section-label">Tokens</div>
				<KeyValues
					items={[
						{ key: "input", label: "Uncached input", value: formatInteger(usage.input) },
						{ key: "cacheRead", label: "Cache read", value: formatInteger(usage.cacheRead) },
						{ key: "cacheWrite", label: "Cache write", value: formatInteger(usage.cacheWrite) },
						{ key: "output", label: "Output", value: formatInteger(usage.output) },
						{ key: "total", label: "Total", value: formatInteger(usage.totalTokens) },
						{
							key: "premium",
							label: "Premium requests",
							value: formatInteger(Math.round((usage.premiumRequests ?? 0) * 100) / 100),
						},
					]}
				/>
			</section>

			<section>
				<div className="section-label">API-equivalent cost</div>
				<KeyValues
					items={[
						{ key: "total", label: "Total", value: formatMessageCost(details, 4) },
						{ key: "input", label: "Input", value: formatCost(usage.cost.input, 4) },
						{ key: "cacheRead", label: "Cache read", value: formatCost(usage.cost.cacheRead, 4) },
						{ key: "cacheWrite", label: "Cache write", value: formatCost(usage.cost.cacheWrite, 4) },
						{ key: "output", label: "Output", value: formatCost(usage.cost.output, 4) },
					]}
				/>
			</section>

			<section>
				<div className="section-label">Identity</div>
				<KeyValues
					items={[
						{ key: "id", label: "Request id", value: details.id ?? "–" },
						{ key: "entry", label: "Entry id", value: details.entryId },
						{ key: "stop", label: "Stop reason", value: details.stopReason },
						{ key: "api", label: "API", value: details.api },
						{
							key: "project",
							label: "Project",
							value: <span title={details.folder}>{formatFolder(details.folder)}</span>,
						},
					]}
				/>
				<div className="request-drawer-file">
					<span className="kv-key">Session file</span>
					<span className="kv-value">{details.sessionFile}</span>
				</div>
			</section>

			<JsonBlock data={output} title="Output message" />
			<JsonBlock data={messages} title="Session entry" initialCollapsed />
			<JsonBlock data={row} title="Stats row" initialCollapsed />
		</>
	);
}
