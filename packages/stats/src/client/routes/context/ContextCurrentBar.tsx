import { formatCompact, formatPercent } from "../../data/formatters";
import type { ContextStep } from "../../types";
import { Badge, Card } from "../../ui";
import { ContextNotice } from "./ContextNotice";
import { CATEGORY_KEYS, CATEGORY_STYLE } from "./view-models";

export function ContextCurrentBar({ step }: { step: ContextStep | undefined }) {
	if (!step) {
		return (
			<Card title="Current context">
				<ContextNotice>No steps in this session.</ContextNotice>
			</Card>
		);
	}
	if (!step.composition) {
		return (
			<Card
				title="Current context"
				description={`Step #${step.index} · latest`}
				actions={step.compositionEstimated ? <Badge>estimate</Badge> : undefined}
			>
				<ContextNotice tone="info">Composition unavailable for this legacy step.</ContextNotice>
			</Card>
		);
	}

	const capacity = step.contextWindow !== undefined && step.contextWindow > 0 ? step.contextWindow : null;
	const prompt = step.promptTokens;
	const categorySum = CATEGORY_KEYS.reduce((sum, key) => sum + Math.max(0, step.composition![key]), 0);
	const segments: Array<{ key: string; label: string; tokens: number; color: string; width: number }> = [];
	let reserveExtent = 0;

	if (prompt <= 0) {
		reserveExtent = capacity ? 1 : 0;
	} else {
		const usedExtent = capacity ? Math.min(1, Math.max(0, prompt / capacity)) : 1;
		if (categorySum > prompt) {
			for (const key of CATEGORY_KEYS) {
				const tokens = Math.max(0, step.composition[key]);
				segments.push({
					key,
					label: CATEGORY_STYLE[key].label,
					tokens,
					color: CATEGORY_STYLE[key].color,
					width: categorySum > 0 ? (usedExtent * tokens) / categorySum : 0,
				});
			}
		} else {
			for (const key of CATEGORY_KEYS) {
				const tokens = Math.max(0, step.composition[key]);
				segments.push({
					key,
					label: CATEGORY_STYLE[key].label,
					tokens,
					color: CATEGORY_STYLE[key].color,
					width: (usedExtent * tokens) / prompt,
				});
			}
			const unattributed = Math.max(0, prompt - categorySum);
			if (unattributed > 0) {
				segments.push({
					key: "unattributed",
					label: "Unattributed",
					tokens: unattributed,
					color: "var(--ctx-unattributed)",
					width: (usedExtent * unattributed) / prompt,
				});
			}
		}
		reserveExtent = capacity ? Math.max(0, 1 - usedExtent) : 0;
	}

	const overCapacity = capacity !== null && prompt > capacity;
	const overshoot = categorySum > prompt;
	const shareDenominator = overshoot ? categorySum : prompt;
	const reserveTokens = capacity !== null ? Math.max(0, capacity - prompt) : 0;
	const usedLabel = capacity
		? `${formatCompact(prompt)} / ${formatCompact(capacity)}`
		: `${formatCompact(prompt)} tokens`;
	return (
		<Card
			title="Current context"
			description={`Step #${step.index} · latest`}
			actions={
				<div className="context-current-actions">
					{step.compositionEstimated && <Badge>estimate</Badge>}
					{overshoot && <Badge tone="warn">estimate overshoot</Badge>}
					{overCapacity && <Badge tone="warn">over capacity</Badge>}
				</div>
			}
			className="context-current-card"
		>
			<div className="context-current-head">
				<strong data-testid="context-current-used">{usedLabel}</strong>
				<span>{capacity ? formatPercent(prompt / capacity) : "window unknown"}</span>
			</div>
			<div
				className="context-current-track"
				role="img"
				aria-label={`Current context: ${usedLabel}${reserveTokens > 0 ? `, ${formatCompact(reserveTokens)} reserve` : ""}`}
				data-testid="context-current-bar"
			>
				{segments.map(segment =>
					segment.width > 0 ? (
						<span
							key={segment.key}
							className="context-current-seg"
							style={{ width: `${segment.width * 100}%`, background: segment.color }}
							title={`${segment.label}: ${formatCompact(segment.tokens)}`}
						/>
					) : null,
				)}
				{reserveExtent > 0 ? (
					<span
						className="context-current-seg context-current-reserve"
						style={{ width: `${reserveExtent * 100}%` }}
						data-testid="context-current-reserve"
						title={`Reserve: ${formatCompact(reserveTokens)}`}
					>
						{reserveExtent > 0.08 ? "reserve" : ""}
					</span>
				) : null}
			</div>
			<ul className="context-current-legend">
				{segments.map(segment => (
					<li key={segment.key}>
						<i style={{ background: segment.color }} aria-hidden="true" />
						<span>{segment.label}</span>
						<b>{formatCompact(segment.tokens)}</b>
						<small>{shareDenominator > 0 ? formatPercent(segment.tokens / shareDenominator, 0) : "0%"}</small>
					</li>
				))}
				{reserveExtent > 0 && (
					<li>
						<i className="context-current-legend-reserve" aria-hidden="true" />
						<span>Reserve</span>
						<b>{formatCompact(reserveTokens)}</b>
						<small>{formatPercent(reserveExtent, 0)}</small>
					</li>
				)}
			</ul>
			{prompt <= 0 && <ContextNotice>No prompt tokens recorded for this step.</ContextNotice>}
		</Card>
	);
}
