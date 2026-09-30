import type { DesktopWindow } from "@oh-my-pi/pi-natives";
import { truncate } from "@oh-my-pi/pi-utils/format";

/** Apps listed in a miss, candidates first; the rest are counted. */
const MAX_APPS = 12;
/** Titled windows named per app in a miss; the rest are counted. */
const WINDOWS_PER_APP = 3;
/** Titled windows named for an app the selector's `app` matched: those are the likely candidates. */
const WINDOWS_PER_MATCHED_APP = 10;
/** Characters of a window title shown in a miss. */
const MAX_TITLE_CHARS = 80;

/**
 * What a window selector that matched nothing could have meant: the apps with
 * an open window and the windows they have, apps matching the selector's `app`
 * first, so the next call can name an exact id (or conclude the app has no
 * window yet) without listing windows first.
 */
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
		const titled = group.filter(window => window.title.trim() !== "");
		const limit = matched(name) ? WINDOWS_PER_MATCHED_APP : WINDOWS_PER_APP;
		const entries = titled
			.slice(0, limit)
			.map(window => `${window.id} ${JSON.stringify(truncate(window.title, MAX_TITLE_CHARS))}`);
		if (titled.length > limit) entries.push(`${titled.length - limit} more`);
		if (group.length > titled.length) entries.push(`${group.length - titled.length} untitled`);
		// App names come from the OS: a newline in one must not start a row of its own.
		return `- ${name.replace(/[\s\p{Cc}]+/gu, " ")}: ${entries.join(", ")}`;
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
