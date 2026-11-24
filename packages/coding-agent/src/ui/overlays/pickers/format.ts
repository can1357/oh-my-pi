/** Picker fact formats shared by the screens: compact ages and their absolute times. */

/** A short node key for an arbitrary identity (ids with `/`, spaces or any length). */
export function stableKey(identity: string): string {
	return Bun.hash(identity).toString(36);
}

/** Compact age of `at` (`now`, `5m`, `3h`, `2d`, `1w`, `4mo`, `1y`). */
export function pickerAge(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The local time behind an age, for its tooltip (`28 Sep 2026, 18:02`). */
export function pickerDate(at: number): string {
	const d = new Date(at);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}
