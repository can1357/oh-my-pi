import { useCallback, useEffect, useState } from "react";
import type { DashboardSection } from "../app/routes";
import type { TimeRange } from "../types";

const VALID_SECTIONS: DashboardSection[] = [
	"overview",
	"requests",
	"errors",
	"models",
	"costs",
	"behavior",
	"projects",
	"gain",
];

const VALID_RANGES: TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

function parseHash(hash: string): { section: DashboardSection; range: TimeRange } {
	const cleanHash = hash.replace(/^#\/?/, "");
	const [pathPart, queryPart] = cleanHash.split("?");

	const section: DashboardSection = (VALID_SECTIONS as string[]).includes(pathPart)
		? (pathPart as DashboardSection)
		: "overview";

	let range: TimeRange = "24h";
	if (queryPart) {
		const params = new URLSearchParams(queryPart);
		const rangeParam = params.get("range") as TimeRange;
		if (VALID_RANGES.includes(rangeParam)) {
			range = rangeParam;
		}
	}

	return { section, range };
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

	const updateHash = useCallback((section: string, range: TimeRange) => {
		window.location.hash = `/${section}?range=${range}`;
	}, []);

	const setSection = useCallback(
		(newSection: DashboardSection) => {
			updateHash(newSection, route.range);
		},
		[route.range, updateHash],
	);

	const setRange = useCallback(
		(newRange: string) => {
			const nextRange = VALID_RANGES.includes(newRange as TimeRange) ? (newRange as TimeRange) : "24h";
			updateHash(route.section, nextRange);
		},
		[route.section, updateHash],
	);

	useEffect(() => {
		const currentHash = window.location.hash;
		const parsed = parseHash(currentHash);
		const expectedHash = `#/${parsed.section}?range=${parsed.range}`;
		if (currentHash !== expectedHash) {
			window.location.hash = `/${parsed.section}?range=${parsed.range}`;
		}
	}, []);

	return {
		section: route.section,
		setSection,
		range: route.range,
		setRange,
	};
}
