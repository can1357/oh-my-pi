/** Parses RFC 4180 CSV: quoted fields may hold commas, line breaks, and doubled quotes. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	for (const line of text.split("\n")) {
		const fields: string[] = [];
		let field = "";
		let quoted = false;
		for (const char of line) {
			if (char === '"') quoted = !quoted;
			else if (char === "," && !quoted) {
				fields.push(field);
				field = "";
			} else field += char;
		}
		fields.push(field);
		rows.push(fields);
	}
	return rows;
}
