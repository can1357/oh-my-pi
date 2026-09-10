/** formatLocalCalendarDate formats a Date as YYYY-MM-DD in the host local timezone. */
export function formatLocalCalendarDate(date: Date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Format a local date and minute with a compact numeric UTC offset. */
export function formatLocalDateTimeWithOffset(date: Date): string {
	const { clock, offset } = formatLocalClockAndOffset(date);
	return `${formatLocalCalendarDate(date)} ${clock} ${offset}`;
}

/** Local clock (`HH:MM`) and numeric UTC offset (`±HH:MM`) as structured parts. */
export function formatLocalClockAndOffset(date: Date): { clock: string; offset: string } {
	const pad2 = (value: number): string => String(value).padStart(2, "0");
	const offsetMinutes = date.getTimezoneOffset();
	const absoluteOffset = Math.abs(offsetMinutes);
	return {
		clock: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
		offset: `${offsetMinutes <= 0 ? "+" : "-"}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`,
	};
}

/** Format a Date's short timezone name (e.g. `CST`) in the host locale. */
export function formatLocalTimeZoneShortName(date: Date): string {
	const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
		.formatToParts(date)
		.find(part => part.type === "timeZoneName");
	return part?.value ?? "";
}
