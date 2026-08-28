import { useCallback, useEffect, useState } from "react";
import { clampPanel, clampSidebar, PANEL_DEFAULT, SIDEBAR_DEFAULT } from "./panelWidths";

const KEY = "omp.panelWidths";

/**
 * Column widths, remembered between launches.
 *
 * `localStorage` and not the app's own state file: this is a per-window
 * preference with no consequence if it comes back empty, and every access is
 * wrapped because a webview can refuse it by throwing rather than returning
 * null (private window, cleared site data).
 */
function load(): { sidebar: number; panel: number } {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return { sidebar: SIDEBAR_DEFAULT, panel: PANEL_DEFAULT };
		const parsed = JSON.parse(raw) as { sidebar?: unknown; panel?: unknown };
		return {
			sidebar: typeof parsed.sidebar === "number" ? parsed.sidebar : SIDEBAR_DEFAULT,
			panel: typeof parsed.panel === "number" ? parsed.panel : PANEL_DEFAULT,
		};
	} catch {
		return { sidebar: SIDEBAR_DEFAULT, panel: PANEL_DEFAULT };
	}
}

function useViewportWidth(): number {
	const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
	useEffect(() => {
		const onResize = () => setWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		onResize();
		return () => window.removeEventListener("resize", onResize);
	}, []);
	return width;
}

export function usePanelWidths({ sidebarOpen, panelOpen }: { sidebarOpen: boolean; panelOpen: boolean }) {
	/**
	 * What the user asked for — not what currently fits.
	 *
	 * The distinction is the whole design. Storing the fitted width instead meant
	 * a window that was briefly narrow (or a webview that reported zero before
	 * first paint) wrote the minimum to disk, and widening the window afterwards
	 * never brought the columns back: it was measured starting at 180/220 rather
	 * than the 260/420 defaults, with no way to tell that had happened.
	 */
	const [desired, setDesired] = useState(load);
	const viewport = useViewportWidth();

	useEffect(() => {
		try {
			localStorage.setItem(KEY, JSON.stringify(desired));
		} catch {
			// Not worth surfacing: the layout works, it just forgets.
		}
	}, [desired]);

	// Fitted at render, never written back. Widen the window and they return.
	const sidebar = clampSidebar(desired.sidebar, { viewport, panel: desired.panel, panelOpen });
	const panel = clampPanel(desired.panel, { viewport, sidebar, sidebarOpen });

	const setSidebar = useCallback(
		(wanted: number) =>
			setDesired(current => ({
				...current,
				sidebar: clampSidebar(wanted, { viewport, panel: current.panel, panelOpen }),
			})),
		[panelOpen, viewport],
	);

	const setPanel = useCallback(
		(wanted: number) =>
			setDesired(current => ({
				...current,
				panel: clampPanel(wanted, { viewport, sidebar: current.sidebar, sidebarOpen }),
			})),
		[sidebarOpen, viewport],
	);

	return {
		sidebar,
		panel,
		setSidebar,
		setPanel,
		resetSidebar: useCallback(() => setDesired(current => ({ ...current, sidebar: SIDEBAR_DEFAULT })), []),
		resetPanel: useCallback(() => setDesired(current => ({ ...current, panel: PANEL_DEFAULT })), []),
	};
}
