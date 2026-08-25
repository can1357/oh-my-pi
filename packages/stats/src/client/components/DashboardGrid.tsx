import type { ReactNode } from "react";
import type { WidgetSize } from "../data/dashboard-prefs";

/**
 * 12-column customizable grid for the Overview route. Widgets are placed in
 * the persisted preference order; `data-size` maps to grid-column spans in
 * styles.css (small=4 / medium=6 / wide=12 at desktop, all full-width below).
 * Hidden widgets are simply not rendered — no placeholders.
 */
export function DashboardGrid({ children }: { children: ReactNode }) {
	return (
		<div className="stats-dashboard-grid" role="list">
			{children}
		</div>
	);
}

export interface GridWidgetProps {
	id: string;
	size: WidgetSize;
	children: ReactNode;
}

/** One widget cell inside the DashboardGrid. */
export function DashboardWidget({ id, size, children }: GridWidgetProps) {
	return (
		<div className="stats-widget" data-size={size} data-widget-id={id} role="listitem">
			{children}
		</div>
	);
}
