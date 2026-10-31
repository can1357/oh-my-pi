import { useEffect, useRef } from "react";
import { formatCompact } from "../../data/formatters";
import { Badge, Card } from "../../ui";
import type { ContextStep, ContextTimeline } from "../../types";
import { ContextCategoryRows } from "./ContextCategoryRows";

export function CompositionTab({
	timeline,
	selected,
	onSelect,
}: {
	timeline: ContextTimeline;
	selected: number;
	onSelect: (index: number) => void;
}) {
	const steps = timeline.steps;
	const step = steps[selected] ?? steps.at(-1);
	const selectedRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		const element = selectedRef.current;
		const strip = element?.parentElement;
		if (!element || !strip) return;
		const stripRect = strip.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		strip.scrollLeft += elementRect.left - stripRect.left - strip.clientWidth / 2 + elementRect.width / 2;
	}, [selected]);
	if (!step)
		return (
			<Card title="Composition">
				<p className="dim">No steps in this session.</p>
			</Card>
		);
	return (
		<div className="context-tab-stack">
			<Card
				title="Prompt composition"
				description={`Step #${step.index} · ${formatCompact(step.promptTokens)} prompt tokens`}
			>
				<div className="context-step-select">
					{steps.map((candidate, index) => (
						<button
							type="button"
							ref={element => {
								if (index === selected) selectedRef.current = element;
							}}
							className={index === selected ? "context-step active" : "context-step"}
							key={candidate.id}
							onClick={() => onSelect(index)}
						>
							#{candidate.index}
							<span>{formatCompact(candidate.promptTokens)}</span>
						</button>
					))}
				</div>
				{step.composition === undefined ? (
					<p className="context-notice">Composition unavailable for this legacy step.</p>
				) : (
					<ContextCategoryRows composition={step.composition} promptTokens={step.promptTokens} />
				)}
				{step.compositionEstimated && <Badge>current estimate</Badge>}
				{(step.unattributed ?? 0) < 0 && <Badge tone="warn">estimate overshoot</Badge>}
				{step.composition && (
					<p className="micro">
						Unattributed: <span className="num">{formatCompact(step.unattributed ?? 0)}</span>
					</p>
				)}
			</Card>
			{step.details === undefined ? (
				<Card title="Details">
					<p className="context-notice">Details unavailable for this step.</p>
				</Card>
			) : (
				<DetailsCards step={step} />
			)}
		</div>
	);
}

function DetailsCards({ step }: { step: ContextStep }) {
	const details = step.details!;
	return (
		<div className="context-detail-grid">
			<DetailList title="Tools" items={details.toolSchemas} omitted={details.omittedToolSchemas} />
			<DetailList title="Skills" items={details.skills} omitted={details.omittedSkills} />
			<Card title="System parts">
				<div className="context-token-list">
					{(details.systemPromptParts ?? []).map((tokens, index) => (
						<div key={index}>
							<span>Part {index + 1}</span>
							<strong className="num">{formatCompact(tokens)}</strong>
						</div>
					))}
					{details.systemPromptPartsOmitted ? (
						<p className="micro">+{details.systemPromptPartsOmitted} parts merged</p>
					) : null}
				</div>
			</Card>
		</div>
	);
}

function DetailList({
	title,
	items,
	omitted,
}: {
	title: string;
	items?: { name: string; tokens: number }[];
	omitted?: number;
}) {
	return (
		<Card title={title}>
			<div className="context-token-list">
				{items?.map(item => (
					<div key={item.name}>
						<span className="mono truncate">{item.name}</span>
						<strong className="num">{formatCompact(item.tokens)}</strong>
					</div>
				))}
				{omitted ? <p className="micro">+{omitted} omitted</p> : null}
				{!items?.length && !omitted ? <span className="dim">None recorded</span> : null}
			</div>
		</Card>
	);
}
