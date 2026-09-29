/** Count elements matching a CSS selector in an HTML string. */
export function countElements(html: string, selector: string): number {
	let total = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				total++;
			},
		})
		.transform(html);
	return total;
}
