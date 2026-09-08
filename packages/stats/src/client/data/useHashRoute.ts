import { useCallback, useEffect, useState } from "react";
import type { DashboardSection } from "../app/routes";
import type { TimeRange } from "../types";

const VALID_SECTIONS: DashboardSection[] = [
	"overview",
	"requests",
	"traces",
	"errors",
	"models",
	"providers",
	"tools",
	"costs",
	"behavior",
	"projects",
	"gain",
];

const VALID_RANGES: TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

function parseHash(hash: string): { section: DashboardSection; range: TimeRange; session: string | null } {
	const cleanHash = hash.replace(/^#\/?/, "");
	const [pathPart, queryPart] = cleanHash.split("?");

	const section: DashboardSection = (VALID_SECTIONS as string[]).includes(pathPart)
		? (pathPart as DashboardSection)
		: "overview";

	let range: TimeRange = "24h";
	let session: string | null = null;
	if (queryPart) {
		const params = new URLSearchParams(queryPart);
		const rangeParam = params.get("range") as TimeRange;
		if (VALID_RANGES.includes(rangeParam)) {
			range = rangeParam;
		}
		session = params.get("s");
	}

	return { section, range, session };
}

function buildHash(section: string, range: TimeRange, session?: string | null): string {
	const sessionPart = session ? `&s=${encodeURIComponent(session)}` : "";
	return `/${section}?range=${range}${sessionPart}`;
}

export function useHashRoute() {
	const [route, setRouteState] = useState(() => parseHash(window.location.hash));

	useEffect(() => {
		const handleHashChange = () => {
			setRouteState(parseHash(window.location.hash));
		};

		window.addEventListener("hashchange", handleHashChange);
		return () => {
			window.removeEventListener("hashchange", handleHashChange);
		};
	}, []);

	const updateHash = useCallback((section: string, range: TimeRange, session?: string | null) => {
		window.location.hash = buildHash(section, range, session);
	}, []);

	const setSection = useCallback(
		(newSection: DashboardSection) => {
			// The deep-linked session only applies to the traces view.
			updateHash(newSection, route.range, newSection === "traces" ? route.session : null);
		},
		[route.range, route.session, updateHash],
	);

	const setRange = useCallback(
		(newRange: string) => {
			const nextRange = VALID_RANGES.includes(newRange as TimeRange) ? (newRange as TimeRange) : "24h";
			updateHash(route.section, nextRange, route.session);
		},
		[route.section, route.session, updateHash],
	);

	const setSession = useCallback(
		(file: string | null) => {
			updateHash(route.section, route.range, file);
		},
		[route.section, route.range, updateHash],
	);

	useEffect(() => {
		const currentHash = window.location.hash;
		const parsed = parseHash(currentHash);
		const expectedHash = `#${buildHash(parsed.section, parsed.range, parsed.session)}`;
		if (currentHash !== expectedHash) {
			window.location.hash = buildHash(parsed.section, parsed.range, parsed.session);
		}
	}, []);

	return {
		section: route.section,
		setSection,
		range: route.range,
		setRange,
		session: route.session,
		setSession,
	};
}
