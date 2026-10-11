import type { DesktopWindow } from "@oh-my-pi/pi-natives";
import { truncate } from "@oh-my-pi/pi-utils/format";

const MAX_APPS = 12;
const WINDOWS_PER_APP = 3;
const WINDOWS_PER_MATCHED_APP = 10;
const MAX_TITLE_CHARS = 80;

/** Lists the open windows by app, apps matching `app` first, for a selector that matched nothing. */
export function describeWindowMiss(windows: readonly DesktopWindow[], app: string | undefined): string {
	if (windows.length === 0) return "No windows are open.";
	// An empty `app` filters nothing in `matchesFilter`, so it matches no app here either.
	const needle = app?.toLocaleLowerCase() || undefined;
	const matched = (name: string): boolean => needle !== undefined && name.toLocaleLowerCase().includes(needle);
	const byApp = Map.groupBy(windows, window => window.app);
	const focusedApp = windows.find(window => window.focused)?.app;
	const rank = (name: string): number => (matched(name) ? 0 : name === focusedApp ? 1 : 2);
	const apps = [...byApp.keys()].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
	const lines = apps.slice(0, MAX_APPS).map(name => {
		const group = byApp.get(name)!;
		// Titled windows first; untitled ones still list their ids, since macOS without Screen Recording blanks other apps' titles.
		const ordered = group.toSorted((left, right) => Number(!left.title.trim()) - Number(!right.title.trim()));
		const limit = matched(name) ? WINDOWS_PER_MATCHED_APP : WINDOWS_PER_APP;
		const entries = ordered
			.slice(0, limit)
			.map(window => `${window.id} ${JSON.stringify(truncate(window.title, MAX_TITLE_CHARS))}`);
		if (ordered.length > limit) entries.push(`${ordered.length - limit} more`);
		return `- ${name}: ${entries.join(", ")}`;
	});
	const omitted = apps.slice(MAX_APPS);
	if (omitted.length > 0) {
		const count = omitted.reduce((sum, name) => sum + byApp.get(name)!.length, 0);
		lines.push(`- ${omitted.length} more ${omitted.length === 1 ? "app" : "apps"} with ${count} windows`);
	}
	const note =
		needle !== undefined && !apps.some(matched)
			? `No open window belongs to an app matching ${JSON.stringify(app)}.\n`
			: "";
	return `${note}Open windows by app (id "title"):\n${lines.join("\n")}`;
}
