import { Menu } from "lucide-react";
import type { TimeRange } from "../types";
import { RangeControl } from "./RangeControl";
import type { DashboardSection } from "./routes";
import { routes } from "./routes";
import { SyncButton } from "./SyncButton";
import { ThemeToggle } from "./ThemeToggle";

export interface TopBarProps {
	activeSection: DashboardSection;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
	updatedAt: number | null;
	onSyncStart?: () => void;
	onSyncComplete?: (result: { success: boolean }) => void;
	onMenuToggle?: () => void;
	className?: string;
}

export function TopBar({
	activeSection,
	range,
	onRangeChange,
	updatedAt,
	onSyncStart,
	onSyncComplete,
	onMenuToggle,
	className = "",
}: TopBarProps) {
	const currentRoute = routes.find(r => r.id === activeSection);
	const title = currentRoute?.label || "Observability";

	const formatLastUpdated = (time: number | null) => {
		if (!time) return "Not updated";
		const date = new Date(time);
		return `Updated ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
	};

	return (
		<header className={`stats-top-bar ${className}`}>
			<div className="stats-top-bar-left">
				{onMenuToggle && (
					<button
						type="button"
						onClick={onMenuToggle}
						className="stats-mobile-menu-btn"
						aria-label="Open navigation menu"
					>
						<Menu size={20} />
					</button>
				)}
				<h1 className="stats-page-title">{title}</h1>
			</div>

			<div className="stats-top-bar-right">
				<div className="stats-top-bar-meta">
					<span
						className="stats-last-updated"
						title={updatedAt ? new Date(updatedAt).toLocaleString() : undefined}
					>
						{formatLastUpdated(updatedAt)}
					</span>
				</div>

				<RangeControl value={range} onChange={onRangeChange} />

				<ThemeToggle />

				<SyncButton onSyncStart={onSyncStart} onSyncComplete={onSyncComplete} />
			</div>
		</header>
	);
}
