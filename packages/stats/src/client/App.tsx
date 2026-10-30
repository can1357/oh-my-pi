import { useCallback, useRef, useState } from "react";
import type { DashboardSection } from "./app/nav";
import { Shell } from "./app/Shell";
import { LiveProvider } from "./data/live";
import { useHashRoute } from "./data/useHashRoute";
import {
	CostsRoute,
	ErrorsRoute,
	FrustrationRoute,
	GainRoute,
	ModelsRoute,
	OverviewRoute,
	ProjectsRoute,
	ProvidersRoute,
	RequestsRoute,
	ToolsRoute,
	TracesRoute,
} from "./routes";
import { RequestDrawer } from "./ui/RequestDrawer";

export default function App() {
	return (
		<LiveProvider>
			<Dashboard />
		</LiveProvider>
	);
}

function Dashboard() {
	const { section, setSection, range, setRange, session, setSession } = useHashRoute();
	const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
	// Stable identity so the drawer's effects don't tear down on every render.
	const closeDrawer = useCallback(() => setSelectedRequestId(null), []);

	// Visited pages stay mounted (hidden) so revisits are instant and keep their
	// scroll-independent UI state; only the active page fetches (`active`).
	const mounted = useRef(new Set<DashboardSection>());
	mounted.current.add(section);

	const render = (target: DashboardSection) => {
		const active = target === section;
		switch (target) {
			case "overview":
				return <OverviewRoute active={active} range={range} onRequestClick={setSelectedRequestId} />;
			case "requests":
				return <RequestsRoute active={active} range={range} onRequestClick={setSelectedRequestId} />;
			case "errors":
				return <ErrorsRoute active={active} range={range} onRequestClick={setSelectedRequestId} />;
			case "traces":
				return <TracesRoute active={active} session={session} onOpenSession={setSession} />;
			case "models":
				return <ModelsRoute active={active} range={range} />;
			case "providers":
				return <ProvidersRoute active={active} range={range} />;
			case "costs":
				return <CostsRoute active={active} range={range} />;
			case "tools":
				return <ToolsRoute active={active} range={range} />;
			case "frustration":
				return <FrustrationRoute active={active} range={range} />;
			case "projects":
				return <ProjectsRoute active={active} range={range} />;
			case "gain":
				return <GainRoute active={active} range={range} />;
		}
	};

	return (
		<>
			<Shell section={section} onSectionChange={setSection} range={range} onRangeChange={setRange}>
				{[...mounted.current].map(target => (
					<div key={target} hidden={target !== section}>
						{render(target)}
					</div>
				))}
			</Shell>
			<RequestDrawer id={selectedRequestId} onClose={closeDrawer} />
		</>
	);
}
