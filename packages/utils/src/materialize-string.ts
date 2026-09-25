/**
 * Copy text into independent UTF-16 backing storage before a bounded substring outlives its source.
 *
 * The UTF-16 round trip preserves every JavaScript code unit, including lone
 * surrogates that a UTF-8 round trip would replace.
 */
export function materializeString(text: string): string {
	if (text.length === 0) return "";
	return Buffer.from(text, "utf16le").toString("utf16le");
}
