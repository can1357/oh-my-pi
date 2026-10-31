import { useMemo } from "react";
import { formatCompact, formatTimestamp } from "../../data/formatters";
import type { ContextOverview } from "../../types";
import { denseHeatmap } from "./view-models";

export function ContextHeatmap({
	overview,
	metric = "requests",
}: {
	overview: ContextOverview;
	metric?: "requests" | "promptTokens";
}) {
	const dense = useMemo(() => denseHeatmap(overview), [overview]);
	const values = metric === "requests" ? dense.requests : dense.promptTokens;
	const max = Math.max(1, ...values);
	return (
		<div className="context-heatmap" aria-label={`${metric} heatmap`}>
			{values.map((value, index) => (
				<div
					className="context-heatmap-cell"
					key={dense.buckets[index]}
					data-level={value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4))}
					title={`${formatTimestamp(dense.buckets[index]!)} · ${formatCompact(value)} ${metric}`}
				/>
			))}
		</div>
	);
}
