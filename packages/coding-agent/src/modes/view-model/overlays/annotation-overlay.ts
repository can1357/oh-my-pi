/** Splits a text source into the overlay's 1-based annotatable lines. */
export function splitTextLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}
