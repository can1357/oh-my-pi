import type { ContextStep } from "../../types";
import { CATEGORY_KEYS, CATEGORY_STYLE } from "./view-models";

export function ContextOverviewRibbon({
	steps,
	selected,
	onSelect,
}: {
	steps: readonly ContextStep[];
	selected: number;
	onSelect: (index: number) => void;
}) {
	const max = Math.max(1, ...steps.map(step => step.promptTokens));
	return (
		<div className="context-overview-ribbon" role="list" aria-label="Prompt composition overview">
			{steps.map((step, index) => (
				<button
					type="button"
					role="listitem"
					key={step.id}
					className={index === selected ? "context-ribbon-col active" : "context-ribbon-col"}
					aria-label={`Step ${step.index}, ${step.promptTokens} prompt tokens`}
					onClick={() => onSelect(index)}
				>
					<span style={{ height: `${(step.promptTokens / max) * 100}%` }}>
						{CATEGORY_KEYS.map(key =>
							step.composition && step.composition[key] > 0 ? (
								<i
									key={key}
									style={{
										background: CATEGORY_STYLE[key].color,
										flexGrow: step.composition[key],
									}}
								/>
							) : null,
						)}
					</span>
				</button>
			))}
		</div>
	);
}
