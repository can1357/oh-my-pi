import { X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { setDensity, useDensity } from "../data/density";
import type { TimeRange } from "../types";
import { NavRail } from "./NavRail";
import type { DashboardSection } from "./routes";
import { TopBar } from "./TopBar";

const NAV_COLLAPSED_KEY = "omp-stats:nav-collapsed";

export interface AppLayoutProps {
	activeSection: DashboardSection;
	onSectionChange: (section: DashboardSection) => void;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
	updatedAt: number | null;
	onSyncStart?: () => void;
	onSyncComplete?: (result: { success: boolean }) => void;
	children: React.ReactNode;
}

export function AppLayout({
	activeSection,
	onSectionChange,
	range,
	onRangeChange,
	updatedAt,
	onSyncStart,
	onSyncComplete,
	children,
}: AppLayoutProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
		} catch {
			return false;
		}
	});
	const density = useDensity();
	useEffect(() => {
		try {
			localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
		} catch {}
	}, [collapsed]);

	const handleSectionChange = (section: DashboardSection) => {
		onSectionChange(section);
		setMenuOpen(false);
	};

	return (
		<div className="stats-app-container">
			<NavRail
				activeSection={activeSection}
				onSectionChange={handleSectionChange}
				collapsed={collapsed}
				onCollapsedChange={setCollapsed}
				className="stats-desktop-nav"
			/>

			{menuOpen && (
				<div className="stats-mobile-drawer-overlay" onClick={() => setMenuOpen(false)} role="presentation">
					<div
						className="stats-mobile-drawer"
						onClick={e => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-label="Navigation menu"
					>
						<div className="stats-mobile-drawer-header">
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<div className="stats-logo-mark" aria-hidden>
									π
								</div>
								<div className="stats-logo-container">
									<span className="stats-logo-text">OH MY PI</span>
									<span className="stats-logo-subtext">Observability</span>
								</div>
							</div>
							<button
								type="button"
								onClick={() => setMenuOpen(false)}
								className="stats-drawer-close-btn"
								aria-label="Close navigation menu"
							>
								<X size={18} />
							</button>
						</div>
						<NavRail
							activeSection={activeSection}
							onSectionChange={handleSectionChange}
							className="stats-mobile-nav"
						/>
					</div>
				</div>
			)}

			<div className="stats-main-pane">
				<TopBar
					activeSection={activeSection}
					range={range}
					onRangeChange={onRangeChange}
					updatedAt={updatedAt}
					onSyncStart={onSyncStart}
					onSyncComplete={onSyncComplete}
					onMenuToggle={() => setMenuOpen(true)}
					density={density}
					onDensityChange={setDensity}
				/>

				<main className="stats-content-area">
					<div className="stats-content-inner">{children}</div>
				</main>
			</div>
		</div>
	);
}
