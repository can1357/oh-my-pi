import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { type DashboardSection, routes } from "./routes";

export interface NavRailProps {
	activeSection: DashboardSection;
	onSectionChange: (section: DashboardSection) => void;
	collapsed?: boolean;
	onCollapsedChange?: (next: boolean) => void;
	className?: string;
}

export function NavRail({
	activeSection,
	onSectionChange,
	collapsed = false,
	onCollapsedChange,
	className = "",
}: NavRailProps) {
	return (
		<aside className={`stats-nav-rail ${className}`} data-collapsed={collapsed ? "true" : "false"}>
			<div className="stats-nav-rail-header">
				<div className="stats-logo-mark" aria-hidden>
					π
				</div>
				<div className="stats-logo-container">
					<span className="stats-logo-text">OH MY PI</span>
					<span className="stats-logo-subtext">Observability</span>
				</div>
				{onCollapsedChange && (
					<button
						type="button"
						className="stats-nav-collapse-btn"
						aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
						onClick={() => onCollapsedChange(!collapsed)}
					>
						{collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
					</button>
				)}
			</div>

			<nav className="stats-nav-rail-menu">
				{routes.map(route => {
					const isActive = route.id === activeSection;
					const Icon = route.icon;
					return (
						<button
							key={route.id}
							type="button"
							onClick={() => onSectionChange(route.id)}
							className="stats-nav-rail-item"
							data-active={isActive ? "true" : "false"}
							aria-current={isActive ? "page" : undefined}
							title={collapsed ? route.label : undefined}
						>
							<Icon size={16} className="stats-nav-rail-item-icon" />
							<span className="stats-nav-rail-item-label">{route.label}</span>
						</button>
					);
				})}
			</nav>

			<div className="stats-nav-rail-footer">
				<span className="stats-nav-rail-footer-label" style={{ fontSize: 11 }}>
					Local • 127.0.0.1
				</span>
				<span className="stats-version-tag">v1</span>
			</div>
		</aside>
	);
}
