import TurndownService, { gfm } from "@oh-my-pi/pi-utils/turndown";

type TurndownListParent = {
	nodeName: string;
	getAttribute(name: string): string | null;
	children: ArrayLike<unknown>;
};

/**
 * Build a Turndown instance configured for GFM with the fixes omp relies on:
 * `~~strikethrough~~`, unescaped heading periods, and single-space list markers.
 *
 * Shared by the web scrapers (HTML → markdown) and the markit document engine
 * (`src/markit`). The rule set must stay identical across both call sites.
 */
export function createTurndown(): TurndownService {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.use(gfm);
	// GFM spec uses ~~ (double tilde), not ~ (single)
	turndown.addRule("strikethrough", {
		filter: ["del", "s", "strike"],
		replacement(content) {
			return `~~${content}~~`;
		},
	});
	// Unescape the backslash turndown inserts before periods in headings ("1." -> "1\.")
	turndown.addRule("heading", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const level = Number(node.nodeName.charAt(1));
			const prefix = "#".repeat(level);
			const cleaned = content.replace(/\\([.])/g, "$1").trim();
			return `\n\n${prefix} ${cleaned}\n\n`;
		},
	});
	// Single space after the marker (turndown hardcodes three)
	turndown.addRule("listItem", {
		filter: "li",
		replacement(content, node, options) {
			const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
			const parent = node.parentNode as unknown as TurndownListParent | null;
			let prefix = `${options.bulletListMarker} `;
			if (parent?.nodeName === "OL") {
				const start = parent.getAttribute("start");
				const index = Array.prototype.indexOf.call(parent.children, node);
				prefix = `${(start ? Number(start) : 1) + index}. `;
			}
			return prefix + body + (node.nextSibling ? "\n" : "");
		},
	});
	return turndown;
}

/**
 * Normalize HTML tables so turndown-plugin-gfm can render them:
 * - strip `<p>` tags inside `<td>`/`<th>` cells (joining paragraphs with a space)
 * - wrap the first row in `<thead>` when missing
 */
export function normalizeTablesHtml(html: string): string {
	let result = html.replace(
		/<(td|th)([^>]*)>([\s\S]*?)<\/(td|th)>/gi,
		(_match, tag: string, attrs: string, inner: string, closeTag: string) => {
			const stripped = inner
				.replace(/^\s*<p>/i, "")
				.replace(/<\/p>\s*$/i, "")
				.replace(/<\/p>\s*<p>/gi, " ");
			return `<${tag}${attrs}>${stripped}</${closeTag}>`;
		},
	);
	result = result.replace(
		/<table([^>]*)>\s*(?:<tbody>\s*)?(<tr[\s\S]*?<\/tr>)([\s\S]*?)<\/(?:tbody>\s*<\/)?table>/gi,
		(_match, attrs: string, firstRow: string, rest: string) => {
			const theadRow = firstRow.replace(/<td/gi, "<th").replace(/<\/td>/gi, "</th>");
			return `<table${attrs}><thead>${theadRow}</thead><tbody>${rest}</tbody></table>`;
		},
	);
	return result;
}
