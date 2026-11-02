import { useMemo, useState } from "react";
import { Chart } from "../../charts";
import type { ChartSeries } from "../../charts/types";
import { formatCompact, formatTimestamp } from "../../data/formatters";
import { Segmented } from "../../ui";
import type { ContextEvent, ContextTimeline } from "../../types";
import { ContextEventPins } from "./ContextEventPins";
import { ContextOverviewRibbon } from "./ContextOverviewRibbon";
import { ContextStepBrief } from "./ContextStepBrief";
import { CATEGORY_KEYS, CATEGORY_STYLE } from "./view-models";

const WINDOW_OPTIONS = [
	{ value: "50", label: "50" },
	{ value: "100", label: "100" },
	{ value: "200", label: "200" },
	{ value: "0", label: "All" },
] as const;

export function TrendTab({
	timeline,
	selected,
	onSelect,
	onOpenBrowser,
	onOpenEvent,
}: {
	timeline: ContextTimeline;
	selected: number;
	onSelect: (index: number) => void;
	onOpenBrowser: () => void;
	onOpenEvent: (event: ContextEvent) => void;
}) {
	const [mode, setMode] = useState<"prompt" | "delta">("prompt");
	const [windowSize, setWindowSize] = useState("100");
	const steps = timeline.steps.slice(windowSize === "0" ? 0 : -Number(windowSize));
	const offset = timeline.steps.length - steps.length;
	const series = useMemo<ChartSeries[]>(() => {
		const composition = CATEGORY_KEYS.map(key => ({
			key,
			label: CATEGORY_STYLE[key].label,
			color: CATEGORY_STYLE[key].color,
			values: steps.map(step => step.composition?.[key] ?? null),
		}));
		return [
			...composition,
			{
				key: "total",
				label: "Total",
				color: "var(--ink-1)",
				kind: "line" as const,
				values: steps.map(step => step.promptTokens),
				tooltip: false,
			},
		];
	}, [steps]);
	const briefStep = timeline.steps[selected] ?? steps.at(-1);
	const latestWindow = timeline.steps.at(-1)?.contextWindow ?? timeline.contextWindow;
	const contextWindow = latestWindow && latestWindow > 0 ? latestWindow : undefined;
	return (
		<section className="card context-trend">
			<header className="card-header">
				<div className="card-titles">
					<h2 className="card-title">Trend</h2>
					<p className="card-description">
						Last {steps.length} steps · selected #{timeline.steps[selected]?.index ?? steps.at(-1)?.index ?? "-"}
					</p>
				</div>
				<div className="context-toolbar">
					<Segmented
						aria-label="Trend metric"
						value={mode}
						onChange={setMode}
						options={[
							{ value: "prompt", label: "Composition" },
							{ value: "delta", label: "Δ" },
						]}
						size="sm"
					/>
					<Segmented
						aria-label="Trend window"
						value={windowSize}
						onChange={setWindowSize}
						options={WINDOW_OPTIONS.map(option => ({ ...option }))}
						size="sm"
					/>
				</div>
			</header>
			<div className="card-body">
				<ContextEventPins events={timeline.events} steps={timeline.steps} onSelect={index => onSelect(index)} />
				<div className="context-trend-body">
					<div className="context-trend-main">
						<div className="context-marker-strip">
							{steps.map(step => (
								<button
									type="button"
									key={step.id}
									className={
										timeline.steps[selected]?.id === step.id ? "context-marker selected" : "context-marker"
									}
									title={`${formatTimestamp(step.timestamp)} · ${step.deltaKind}`}
									aria-label={`Step ${step.index}, ${step.promptTokens} prompt tokens`}
									onClick={() => onSelect(offset + steps.indexOf(step))}
								/>
							))}
						</div>
						{mode === "delta" ? (
							<DeltaList
								steps={steps}
								offset={offset}
								selected={selected}
								timeline={timeline}
								onSelect={onSelect}
							/>
						) : (
							<Chart
								slots={steps.length}
								tickLabel={index => `#${steps[index]?.index ?? ""}`}
								series={series}
								references={contextWindow ? [{ value: contextWindow, label: "window" }] : undefined}
								onSelect={index => onSelect(offset + index)}
								format={formatCompact}
								tooltipExtra={index => (
									<span>
										{formatTimestamp(steps[index]!.timestamp)} · step #{steps[index]!.index}
									</span>
								)}
								emptyLabel="Composition unavailable"
							/>
						)}
						<ContextOverviewRibbon steps={timeline.steps} selected={selected} onSelect={onSelect} />
					</div>
					<ContextStepBrief
						step={briefStep}
						events={timeline.events}
						onOpenBrowser={onOpenBrowser}
						onOpenEvent={onOpenEvent}
					/>
				</div>
			</div>
		</section>
	);
}

function DeltaList({
	steps,
	offset,
	selected,
	timeline,
	onSelect,
}: {
	steps: ContextTimeline["steps"];
	offset: number;
	selected: number;
	timeline: ContextTimeline;
	onSelect: (index: number) => void;
}) {
	const max = Math.max(1, ...steps.map(step => Math.abs(step.deltaTokens ?? 0)));
	return (
		<div className="context-delta-list" role="list" aria-label="Prompt delta by step">
			{steps.map((step, index) => {
				const value = step.deltaTokens;
				if (value === undefined) {
					return (
						<button
							type="button"
							role="listitem"
							className="context-delta-row"
							key={step.id}
							onClick={() => onSelect(offset + index)}
						>
							<span>#{step.index}</span>
							<span className="num">n/a</span>
						</button>
					);
				}
				const pct = (Math.abs(value) / max) * 50;
				return (
					<button
						type="button"
						role="listitem"
						className={
							timeline.steps[selected]?.id === step.id ? "context-delta-row active" : "context-delta-row"
						}
						key={step.id}
						title={`${formatTimestamp(step.timestamp)} · ${step.deltaKind}`}
						onClick={() => onSelect(offset + index)}
					>
						<span>#{step.index}</span>
						<span className="num">
							{value > 0 ? "+" : ""}
							{formatCompact(value)}
						</span>
						<span className="context-delta-track" aria-hidden="true">
							<span
								className={value < 0 ? "context-delta-fill negative" : "context-delta-fill"}
								style={value < 0 ? { right: "50%", width: `${pct}%` } : { left: "50%", width: `${pct}%` }}
							/>
						</span>
					</button>
				);
			})}
		</div>
	);
}
