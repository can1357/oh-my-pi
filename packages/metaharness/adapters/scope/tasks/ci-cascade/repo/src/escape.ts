/** Makes text safe for HTML content and double-quoted attribute values. */
export function escape(text: string): string {
	return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("&", "&amp;");
}
