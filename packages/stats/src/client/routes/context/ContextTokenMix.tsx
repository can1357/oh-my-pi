import { formatCompact, formatCost } from "../../data/formatters";
import type { ContextStep } from "../../types";
import { Card } from "../../ui";
import { ContextDonut, type ContextDonutSegment } from "./ContextDonut";
import { ContextNotice } from "./ContextNotice";

export function ContextTokenMix({
	steps,
	omittedSteps,
	costTotal,
}: {
	steps: readonly ContextStep[];
	omittedSteps: number;
	costTotal: number;
}) {
	const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let usageSteps = 0;
	for (const step of steps) {
		if (!step.usage) continue;
		usageSteps++;
		sums.input += step.usage.input;
		sums.output += step.usage.output;
		sums.cacheRead += step.usage.cacheRead;
		sums.cacheWrite += step.usage.cacheWrite;
	}
	const segments: ContextDonutSegment[] = [
		{ key: "input", label: "Input", value: sums.input, color: "var(--ctx-token-input)" },
		{ key: "output", label: "Output", value: sums.output, color: "var(--ctx-token-output)" },
		{ key: "cacheRead", label: "Cache read", value: sums.cacheRead, color: "var(--ctx-token-cache-read)" },
		{ key: "cacheWrite", label: "Cache write", value: sums.cacheWrite, color: "var(--ctx-token-cache-write)" },
	];
	const total = segments.reduce((sum, segment) => sum + segment.value, 0);
	return (
		<Card title="Token mix" description={`${usageSteps} steps with usage`} className="context-stat-card">
			{total > 0 ? (
				<ContextDonut
					segments={segments}
					centerLabel="tokens"
					centerValue={formatCompact(total)}
					ariaLabel="Token mix by input, output and cache"
				/>
			) : (
				<ContextNotice>No token usage recorded for returned steps.</ContextNotice>
			)}
			<p className="context-card-foot">
				<span>{formatCost(costTotal)} recorded step cost</span>
				{omittedSteps > 0 && <span>+{omittedSteps} steps omitted</span>}
			</p>
		</Card>
	);
}
