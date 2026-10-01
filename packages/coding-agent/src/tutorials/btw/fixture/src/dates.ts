// textkit: date helpers. All dates are treated as UTC.

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
	return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

export function isWeekend(date: Date): boolean {
	const day = date.getUTCDay();
	return day === 0 || day === 6;
}

export function formatDuration(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	let rest = Math.abs(Math.round(ms / 1000));
	const hours = Math.floor(rest / 3600);
	rest -= hours * 3600;
	const minutes = Math.floor(rest / 60);
	const seconds = rest - minutes * 60;
	if (hours > 0) return `${sign}${hours}h${minutes}m`;
	if (minutes > 0) return `${sign}${minutes}m${seconds}s`;
	return `${sign}${seconds}s`;
}
