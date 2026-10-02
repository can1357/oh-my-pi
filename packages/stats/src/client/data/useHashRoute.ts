import { useCallback, useEffect, useState } from "react";
import { type DashboardSection, SECTIONS } from "../app/nav";
import type { TimeRange } from "../types";
import { TIME_RANGES } from "./range";

export interface HashRoute {
	section: DashboardSection;
	range: TimeRange;
	/** Deep-linked trace session file (traces only). */
	session: string | null;
}

export function parseHash(hash: string): HashRoute {
	const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
	const section = (SECTIONS as readonly string[]).includes(pathPart) ? (pathPart as DashboardSection) : "overview";
	const params = new URLSearchParams(queryPart ?? "");
	const rangeParam = params.get("range");
	const range = (TIME_RANGES as readonly string[]).includes(rangeParam ?? "") ? (rangeParam as TimeRange) : "24h";
	return { section, range, session: params.get("s") };
}

export function buildHash({ section, range, session }: HashRoute): string {
	const sessionPart = session ? `&s=${encodeURIComponent(session)}` : "";
	return `#/${section}?range=${range}${sessionPart}`;
}

/**
 * Dashboard location in the URL hash (`#/models?range=7d`). Setters update
 * state synchronously and push a history entry, so the UI never waits on the
 * `hashchange` round trip.
 */
export function useHashRoute() {
	const [route, setRoute] = useState(() => parseHash(window.location.hash));

	useEffect(() => {
		const onHashChange = () => setRoute(parseHash(window.location.hash));
		window.addEventListener("hashchange", onHashChange);
		window.addEventListener("popstate", onHashChange);
		// Canonicalize a missing/partial hash without adding a history entry.
		const canonical = buildHash(parseHash(window.location.hash));
		if (window.location.hash !== canonical) history.replaceState(null, "", canonical);
		return () => {
			window.removeEventListener("hashchange", onHashChange);
			window.removeEventListener("popstate", onHashChange);
		};
	}, []);

	const navigate = useCallback((next: HashRoute) => {
		setRoute(next);
		const hash = buildHash(next);
		if (window.location.hash !== hash) history.pushState(null, "", hash);
	}, []);

	const setSection = useCallback(
		(section: DashboardSection) =>
			// The deep-linked session only applies to the traces view.
			navigate({ ...route, section, session: section === "traces" ? route.session : null }),
		[route, navigate],
	);
	const setRange = useCallback((range: TimeRange) => navigate({ ...route, range }), [route, navigate]);
	const setSession = useCallback((session: string | null) => navigate({ ...route, session }), [route, navigate]);

	return { ...route, setSection, setRange, setSession };
}
