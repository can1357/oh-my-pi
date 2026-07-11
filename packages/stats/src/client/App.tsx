import { useCallback, useRef, useState } from "react";
import { AppLayout } from "./app/AppLayout";
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
	RequestsRoute,
} from "./routes";
import { RequestDrawer } from "./ui/RequestDrawer";

export default function App() {
	const { section, setSection, range, setRange } = useHashRoute();
	const [refreshTrigger, setRefreshTrigger] = useState(0);
	const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(() => Date.now());

	const handleSyncComplete = useCallback((result: { success: boolean }) => {
		if (result.success) {
			setRefreshTrigger(prev => prev + 1);
			setUpdatedAt(Date.now());
		}
	}, []);

	// Stable identity so the drawer's effects don't tear down on every App render.
	const closeDrawer = useCallback(() => setSelectedRequestId(null), []);

	const active = section;

	// Keep every visited section mounted and just toggle visibility. Remounting a
	// route on each navigation replays the chart entry animations (a visible
	// flicker); keeping it alive makes revisits instant while the live chart
	// instances still animate in place on data/range updates. Only the active
	// route fetches/polls (enabled), so hidden routes don't keep hitting the API.
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
		</>
	);
}
