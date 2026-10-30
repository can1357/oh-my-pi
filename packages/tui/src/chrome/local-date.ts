/** formatLocalCalendarDate formats a Date as YYYY-MM-DD in the host local timezone. */
export function formatLocalCalendarDate(date: Date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Format a local date and minute with a compact numeric UTC offset. */
export function formatLocalDateTimeWithOffset(date: Date): string {
	const offsetMinutes = date.getTimezoneOffset();
	const offsetSign = offsetMinutes <= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absoluteOffset / 60);
	const offsetRemainderMinutes = absoluteOffset % 60;
	const pad2 = (value: number): string => String(value).padStart(2, "0");
	return `${formatLocalCalendarDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())} ${offsetSign}${pad2(
		offsetHours,
	)}:${pad2(offsetRemainderMinutes)}`;
}
