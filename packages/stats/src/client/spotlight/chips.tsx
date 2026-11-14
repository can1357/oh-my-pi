import type { SpotlightCutGroup, SpotlightRecoveryKind } from "../types";
import { CUT_GROUP, RECOVERY_KIND } from "./meta";

/** Key to the fetch-back groups: each group's mark shape and color, its rule on hover. */
export function GroupLegend({ groups }: { groups: readonly SpotlightCutGroup[] }) {
	return (
		<div className="legend spot-group-legend">
			{groups.map(group => (
				<span
					key={group}
					className="legend-item"
					title={CUT_GROUP[group].rule}
					style={{ "--dot": CUT_GROUP[group].color }}
				>
					<span className="spot-group-mark" data-shape={CUT_GROUP[group].shape} aria-hidden="true" />
					{CUT_GROUP[group].label}
				</span>
			))}
		</div>
	);
}

/** Shows or hides the tools a card folded away (see `foldTools`). */
export function MoreTools({
	hidden,
	expanded,
	onToggle,
}: {
	hidden: readonly string[];
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className="btn spot-more-tools"
			data-variant="ghost"
			data-size="sm"
			aria-expanded={expanded}
			title={expanded ? undefined : hidden.join(", ")}
			onClick={onToggle}
		>
			{expanded ? "Show fewer tools" : `Show ${hidden.length} more tools`}
		</button>
	);
}

/** Recovery kind pill: icon, label (or a count) in the kind's color. */
export function KindBadge({ kind, count }: { kind: SpotlightRecoveryKind; count?: number }) {
	const meta = RECOVERY_KIND[kind];
	const Icon = meta.icon;
	return (
		<span
			className="spot-kind"
			style={{ "--kind": meta.color }}
			title={count === undefined ? meta.rule : `${count} × ${meta.label.toLowerCase()}: ${meta.rule}`}
		>
			<Icon size={12} aria-hidden="true" />
			{count === undefined ? meta.label : <span className="num">{count}</span>}
			{count !== undefined && <span className="sr-only">{meta.plural}</span>}
		</span>
	);
}
