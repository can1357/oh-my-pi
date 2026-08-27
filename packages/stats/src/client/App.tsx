import { useCallback, useEffect, useRef, useState } from "react";
import { AppLayout } from "./app/AppLayout";
import { CommandPalette } from "./app/CommandPalette";
import type { DashboardSection } from "./app/routes";
import { useHashRoute } from "./data/useHashRoute";
import {
	BehaviorRoute,
	CostsRoute,
	ErrorsRoute,
	GainRoute,
	ModelsRoute,
	OverviewRoute,
	ProjectsRoute,
	ProvidersRoute,
	RequestsRoute,
	ToolsRoute,
} from "./routes";
import type { TimeRange } from "./types";
import { RequestDrawer } from "./ui/RequestDrawer";

export default function App() {
	const { section, setSection, range, setRange } = useHashRoute();
	const [refreshTrigger, setRefreshTrigger] = useState(0);
	const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(() => Date.now());
	const [paletteOpen, setPaletteOpen] = useState(false);

	const handleSyncComplete = useCallback((result: { success: boolean }) => {
		if (result.success) {
			setRefreshTrigger(prev => prev + 1);
			setUpdatedAt(Date.now());
		}
	}, []);

	const closeDrawer = useCallback(() => setSelectedRequestId(null), []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen(o => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const handlePaletteNav = useCallback(
		(sectionArg: string, rangeArg?: TimeRange) => {
			if (rangeArg) setRange(rangeArg);
			if (sectionArg) setSection(sectionArg as DashboardSection);
		},
		[setRange, setSection],
	);

	const active = section;

	const mountedRef = useRef<Set<DashboardSection>>(new Set());
	mountedRef.current.add(active);

	const renderRoute = (target: DashboardSection) => {
		const isActive = target === active;
		switch (target) {
			case "overview":
				return (
					<OverviewRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "requests":
				return (
					<RequestsRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "errors":
				return (
					<ErrorsRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "models":
				return <ModelsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "providers":
				return <ProvidersRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "tools":
				return <ToolsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "costs":
				return <CostsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "behavior":
				return <BehaviorRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "projects":
				return <ProjectsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "gain":
				return <GainRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
		}
	};

	return (
		<>
			<AppLayout
				activeSection={active}
				onSectionChange={setSection}
				range={range}
				onRangeChange={setRange}
				updatedAt={updatedAt}
				onSyncComplete={handleSyncComplete}
			>
				{[...mountedRef.current].map(target => (
					<div key={target} hidden={target !== active}>
						{renderRoute(target)}
					</div>
				))}
			</AppLayout>

			<RequestDrawer id={selectedRequestId} onClose={closeDrawer} />
			<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={handlePaletteNav} />
		</>
	);
}
