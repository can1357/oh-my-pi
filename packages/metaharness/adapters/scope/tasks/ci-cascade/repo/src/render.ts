import { escape } from "./escape";
import { renderInline } from "./inline";

type Block =
	| { kind: "paragraph"; lines: string[] }
	| { kind: "quote"; lines: string[] }
	| { kind: "list"; ordered: boolean; items: string[] };

function close(block: Block | null, html: string[]): void {
	if (!block) return;
	if (block.kind === "paragraph") {
		html.push(`<p>${renderInline(block.lines.join(" "))}</p>`);
	} else if (block.kind === "quote") {
		html.push(`<blockquote>${renderInline(block.lines.join(" "))}</blockquote>`);
	} else {
		const tag = block.ordered ? "ol" : "ul";
		html.push(`<${tag}>`, ...block.items.map(item => `<li>${renderInline(item)}</li>`), `</${tag}>`);
	}
}

/**
 * Renders the supported Markdown subset to HTML, one element per line: ATX headings (levels 1-6,
 * optional closing hashes), paragraphs, block quotes, `-`/`*` and `1.` lists, fenced code, and
 * `---` rules.
 */
export function renderMarkdown(source: string): string {
	const html: string[] = [];
	const lines = source.replaceAll("\r\n", "\n").split("\n");
	let open: Block | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const fence = /^```(\w*)$/.exec(line);
		if (fence) {
			close(open, html);
			open = null;
			const code: string[] = [];
			for (i++; i < lines.length && lines[i] !== "```"; i++) code.push(lines[i]);
			const language = fence[1] ? ` class="language-${fence[1]}"` : "";
			html.push(`<pre><code${language}>${code.join("\n")}</code></pre>`);
			continue;
		}

		const heading = /^(#+) +(.*)$/.exec(line);
		if (heading) {
			close(open, html);
			open = null;
			const level = heading[1].length;
			html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			continue;
		}

		if (/^-{3,}$/.test(line)) {
			close(open, html);
			open = null;
			html.push("<hr>");
			continue;
		}

		const item = /^(?:[-*]|(\d+)\.) +(.*)$/.exec(line);
		if (item) {
			if (open?.kind !== "list") {
				close(open, html);
				open = { kind: "list", ordered: item[1] !== undefined, items: [] };
			}
			open.items.push(item[2]);
			continue;
		}

		const quoted = /^> ?(.*)$/.exec(line);
		if (quoted) {
			if (open?.kind !== "quote") {
				close(open, html);
				open = { kind: "quote", lines: [] };
			}
			open.lines.push(quoted[1]);
			continue;
		}

		if (line.trim() === "") {
			close(open, html);
			open = null;
			continue;
		}

		if (open?.kind !== "paragraph") {
			close(open, html);
			open = { kind: "paragraph", lines: [] };
		}
		open.lines.push(line.trim());
	}
	close(open, html);
	return html.join("\n");
}
