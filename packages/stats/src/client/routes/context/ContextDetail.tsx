import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getSessionContext } from "../../api";
import { formatCompact, formatCost, formatInteger } from "../../data/formatters";
import { useQuery } from "../../data/query";
import type { ContextEvent, ContextTimeline } from "../../types";
import { Badge, Card, ErrorState, PageHeader, QueryView, TableSkeleton } from "../../ui";
import { BrowserTab } from "./BrowserTab";
import { CompositionTab } from "./CompositionTab";
import { ContextCurrentBar } from "./ContextCurrentBar";
import { ContextTokenMix } from "./ContextTokenMix";
import { EventsTab } from "./EventsTab";
import { FilesTab } from "./FilesTab";
import { FleetTab } from "./FleetTab";
import { TrendTab } from "./TrendTab";

export type ContextTab = "composition" | "trend" | "browser" | "events" | "files" | "fleet";
const TABS: readonly ContextTab[] = ["composition", "trend", "browser", "events", "files", "fleet"];

export function ContextDetail({
	file,
	active,
	onBack,
	onOpenTrace,
}: {
	file: string;
	active: boolean;
	onBack: () => void;
	onOpenTrace: (file: string) => void;
}) {
	const [tab, setTab] = useState<ContextTab>("composition");
	const [selected, setSelected] = useState(-1);
	const [eventsKindFilter, setEventsKindFilter] = useState<string[]>([]);
	const [selectionStatus, setSelectionStatus] = useState("");
	const [rootFile, setRootFile] = useState(file);
	const [displayFile, setDisplayFile] = useState(file);
	const query = useQuery<ContextTimeline>(
		["context-session", displayFile],
		({ signal }, previous) => getSessionContext(displayFile, signal, previous),
		{ pollMs: 15000, enabled: active },
	);
	const timeline = query.stale || rootFile !== file ? null : query.data;
	useEffect(() => {
		setSelected(-1);
		setTab("composition");
		setEventsKindFilter([]);
	}, [displayFile]);
	useEffect(() => {
		setRootFile(file);
		setDisplayFile(file);
	}, [file]);
	const tabs = useMemo(() => TABS.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), []);
	if (timeline && timeline.schemaVersion !== 1) {
		return (
			<div className="stack context-detail">
				<PageHeader title="Context detail" />
				<ErrorState
					error={`Unsupported context timeline schemaVersion ${String(timeline.schemaVersion)}; this dashboard only reads version 1.`}
				/>
			</div>
		);
	}
	const latestStep = timeline?.steps.at(-1);
	const currentStep = timeline
		? Math.min(selected < 0 ? timeline.steps.length - 1 : selected, Math.max(0, timeline.steps.length - 1))
		: 0;
	const child = displayFile !== rootFile;
	const selectAgent = (agent: ContextTimeline["agents"][number]) => {
		if (agent.status !== "subagent" || !agent.file) return;
		setDisplayFile(agent.file);
	};
	const selectStep = (index: number) => {
		const step = timeline?.steps[index];
		setSelected(index);
		if (step) setSelectionStatus(`Step ${step.index} selected, prompt ${formatCompact(step.promptTokens)} tokens`);
	};
	const openEvent = (event: ContextEvent) => {
		if (timeline && event.stepIndex !== undefined) {
			const index = timeline.steps.findIndex(step => step.index === event.stepIndex);
			if (index >= 0) selectStep(index);
		}
		setTab("events");
		setEventsKindFilter([event.kind]);
	};
	return (
		<div className="stack context-detail">
			<div className="context-sr-only" role="status" aria-live="polite" aria-atomic="true">
				{selectionStatus}
			</div>
			<PageHeader
				title={child ? "Viewing subagent" : "Context detail"}
				description={
					<span className="mono truncate" title={displayFile}>
						{displayFile}
					</span>
				}
				actions={
					<button
						type="button"
						className="btn"
						data-variant="ghost"
						onClick={child ? () => setDisplayFile(rootFile) : onBack}
					>
						<ArrowLeft size={14} /> {child ? "Root session" : "Back"}
					</button>
				}
			/>
			{timeline && (
				<div className="context-detail-header">
					<span>
						<strong data-testid="context-detail-requests">
							{formatInteger(timeline.steps.length + timeline.omittedSteps)}
						</strong>{" "}
						requests
					</span>
					<span>
						<strong data-testid="context-detail-peak">{formatCompact(timeline.peakTokens)}</strong> peak prompt
					</span>
					<span>
						<strong>{formatCost(timeline.costTotal)}</strong> recorded cost
					</span>
					{timeline.legacySteps > 0 && <Badge>legacy</Badge>}
					{timeline.truncated && <Badge tone="warn">truncated</Badge>}
					{timeline.detailsOmittedSteps > 0 && <Badge tone="warn">details omitted</Badge>}
				</div>
			)}
			{timeline && <ContextCurrentBar step={latestStep} />}
			{timeline && (
				<div className="context-detail-stats">
					<ContextStatsCard timeline={timeline} />
					<ContextTokenMix
						steps={timeline.steps}
						omittedSteps={timeline.omittedSteps}
						costTotal={timeline.costTotal}
					/>
					<TurnStatsCard timeline={timeline} />
				</div>
			)}
			{timeline && (
				<nav className="context-tabs" aria-label="Context detail tabs">
					{tabs.map(({ value, label }) => (
						<button
							type="button"
							data-testid={`context-tab-${value}`}
							className={tab === value ? "context-tab active" : "context-tab"}
							aria-selected={tab === value}
							key={value}
							onClick={() => setTab(value)}
						>
							{label}
						</button>
					))}
				</nav>
			)}
			<QueryView
				query={{ ...query, data: timeline }}
				skeleton={
					<Card title="Loading context">
						<TableSkeleton rows={5} />
					</Card>
				}
			>
				{data =>
					tab === "composition" ? (
						<CompositionTab timeline={data} selected={currentStep} onSelect={selectStep} />
					) : tab === "trend" ? (
						<TrendTab
							timeline={data}
							selected={currentStep}
							onSelect={selectStep}
							onOpenBrowser={() => setTab("browser")}
							onOpenEvent={openEvent}
						/>
					) : tab === "browser" ? (
						<BrowserTab
							timeline={data}
							selected={currentStep}
							onSelect={selectStep}
							onOpenTrend={index => {
								selectStep(index);
								setTab("trend");
							}}
						/>
					) : tab === "events" ? (
						<EventsTab
							timeline={data}
							onSelect={selectStep}
							kindFilter={eventsKindFilter}
							onKindFilterChange={setEventsKindFilter}
						/>
					) : tab === "files" ? (
						<FilesTab timeline={data} onOpenTrace={() => onOpenTrace(displayFile)} />
					) : (
						<FleetTab timeline={data} onOpenAgent={selectAgent} />
					)
				}
			</QueryView>
		</div>
	);
}

function ContextStatsCard({ timeline }: { timeline: ContextTimeline }) {
	const steps = timeline.steps;
	const avg = steps.length > 0 ? steps.reduce((sum, step) => sum + step.promptTokens, 0) / steps.length : 0;
	const latest = steps.at(-1);
	return (
		<Card title="Context stats" className="context-stat-card">
			<dl className="context-stat-list">
				<div>
					<dt>Latest prompt</dt>
					<dd>{latest ? formatCompact(latest.promptTokens) : "—"}</dd>
				</div>
				<div>
					<dt>Peak</dt>
					<dd>{formatCompact(timeline.peakTokens)}</dd>
				</div>
				<div>
					<dt>Average</dt>
					<dd>{formatCompact(avg)}</dd>
				</div>
				<div>
					<dt>Window</dt>
					<dd>{timeline.contextWindow ? formatCompact(timeline.contextWindow) : "unknown"}</dd>
				</div>
			</dl>
		</Card>
	);
}

function TurnStatsCard({ timeline }: { timeline: ContextTimeline }) {
	const largest = timeline.steps.reduce<{ value: number; index: number } | null>((best, step) => {
		const value = Math.abs(step.deltaTokens ?? 0);
		return best === null || value > best.value ? { value, index: step.index } : best;
	}, null);
	const totalRequests = timeline.steps.length + timeline.omittedSteps;
	return (
		<Card title="Turn stats" className="context-stat-card">
			<dl className="context-stat-list">
				<div>
					<dt>Steps</dt>
					<dd>{formatInteger(totalRequests)}</dd>
				</div>
				<div>
					<dt>Largest jump</dt>
					<dd>{largest ? `${formatCompact(largest.value)} (#${largest.index})` : "—"}</dd>
				</div>
				<div>
					<dt>Cost / request</dt>
					<dd>{totalRequests > 0 ? formatCost(timeline.costTotal / totalRequests) : "—"}</dd>
				</div>
				<div>
					<dt>Compactions</dt>
					<dd>{timeline.events.filter(event => event.kind === "compact").length}</dd>
				</div>
			</dl>
		</Card>
	);
}
