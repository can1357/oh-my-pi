/** Parses the v1 export format's `YYYY-M-D` dates (months and days may be one digit). */
export function parseLegacyDate(text: string): Date {
	const [year, month, day] = text.split("-").map(Number);
	return new Date(Date.UTC(year, month, day));
}
