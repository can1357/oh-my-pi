import { formatCompact, formatPercent } from "../../data/formatters";
import type { ContextCategoryTokens } from "../../types";
import { CATEGORY_KEYS, CATEGORY_STYLE } from "./view-models";

export function ContextCategoryRows({
	composition,
	promptTokens,
}: {
	composition: ContextCategoryTokens | undefined;
	promptTokens: number;
}) {
	if (!composition) return null;
	const categorySum = CATEGORY_KEYS.reduce((sum, key) => sum + Math.max(0, composition[key]), 0);
	const shareDenominator = categorySum > promptTokens ? categorySum : promptTokens;
	return (
		<div className="context-category-rows">
			{CATEGORY_KEYS.map(key => {
				const tokens = Math.max(0, composition[key]);
				const share = shareDenominator > 0 ? tokens / shareDenominator : 0;
				return (
					<div className="context-category-row" key={key}>
						<i style={{ background: CATEGORY_STYLE[key].color }} aria-hidden="true" />
						<span>{CATEGORY_STYLE[key].label}</span>
						<span className="context-category-track" aria-hidden="true">
							<i style={{ width: `${Math.min(100, share * 100)}%`, background: CATEGORY_STYLE[key].color }} />
						</span>
						<b>{formatCompact(tokens)}</b>
						<small>{formatPercent(share, 0)}</small>
					</div>
				);
			})}
		</div>
	);
}
