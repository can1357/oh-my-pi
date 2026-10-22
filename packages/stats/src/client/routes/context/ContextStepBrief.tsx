import { formatCompact, formatCost, formatPercent, formatTimestamp } from "../../data/formatters";
import type { ContextEvent, ContextStep } from "../../types";
import { Badge } from "../../ui";
import { ContextCategoryRows } from "./ContextCategoryRows";
import { ContextNotice } from "./ContextNotice";

function deltaTone(step: ContextStep): "grow" | "shrink" | "neutral" {
	if (step.deltaKind === "compaction" || step.deltaKind === "shrink") return "shrink";
	if ((step.deltaTokens ?? 0) > 0) return "grow";
	return "neutral";
}

export function ContextStepBrief({
	step,
	events,
	onOpenBrowser,
	onOpenEvent,
}: {
	step: ContextStep | undefined;
	events: readonly ContextEvent[];
	onOpenBrowser: () => void;
	onOpenEvent: (event: ContextEvent) => void;
}) {
	if (!step) {
		return <ContextNotice>Select a step to inspect it.</ContextNotice>;
	}
	const stepEvents = events.filter(event => step.eventIds.includes(event.id));
	return (
		<aside className="context-step-brief" aria-label={`Step ${step.index} brief`}>
			<header>
				<div>
					<strong>Step #{step.index}</strong>
					<span>{formatTimestamp(step.timestamp)}</span>
				</div>
				<Badge>{step.model ?? "model unknown"}</Badge>
			</header>
			<div className="context-step-brief-delta" data-tone={deltaTone(step)}>
				<strong>
					{step.deltaTokens === undefined
						? "—"
						: `${step.deltaTokens > 0 ? "+" : ""}${formatCompact(step.deltaTokens)}`}
				</strong>
				<span>{step.deltaKind}</span>
				<small>
					{formatPercent(step.promptTokens > 0 ? Math.abs(step.deltaTokens ?? 0) / step.promptTokens : 0)}
				</small>
			</div>
			<dl className="context-step-facts">
				<div>
					<dt>Prompt</dt>
					<dd>{formatCompact(step.promptTokens)}</dd>
				</div>
				<div>
					<dt>Window</dt>
					<dd>{step.contextWindow ? formatCompact(step.contextWindow) : "unknown"}</dd>
				</div>
				<div>
					<dt>Unattributed</dt>
					<dd>{step.unattributed === undefined ? "n/a" : formatCompact(step.unattributed)}</dd>
				</div>
			</dl>
			{step.composition ? (
				<ContextCategoryRows composition={step.composition} promptTokens={step.promptTokens} />
			) : (
				<ContextNotice tone="info">Composition unavailable for this legacy step.</ContextNotice>
			)}
			<details className="context-step-details">
				<summary>Usage</summary>
				{step.usage ? (
					<ul>
						<li>
							<span>Input</span>
							<b>{formatCompact(step.usage.input)}</b>
						</li>
						<li>
							<span>Output</span>
							<b>{formatCompact(step.usage.output)}</b>
						</li>
						<li>
							<span>Cache read</span>
							<b>{formatCompact(step.usage.cacheRead)}</b>
						</li>
						<li>
							<span>Cache write</span>
							<b>{formatCompact(step.usage.cacheWrite)}</b>
						</li>
						<li>
							<span>Cost</span>
							<b>{step.usage.costTotal === undefined ? "n/a" : formatCost(step.usage.costTotal)}</b>
						</li>
					</ul>
				) : (
					<ContextNotice>No usage recorded for this step.</ContextNotice>
				)}
			</details>
			<details className="context-step-details">
				<summary>Events</summary>
				{stepEvents.length > 0 ? (
					<div className="context-step-events">
						{stepEvents.map(event => (
							<button type="button" key={event.id} onClick={() => onOpenEvent(event)}>
								<Badge>{event.kind}</Badge> {event.label}
							</button>
						))}
					</div>
				) : (
					<ContextNotice>No events on this step.</ContextNotice>
				)}
			</details>
			<button type="button" className="btn context-brief-action" onClick={onOpenBrowser}>
				Open in Browser
			</button>
		</aside>
	);
}
