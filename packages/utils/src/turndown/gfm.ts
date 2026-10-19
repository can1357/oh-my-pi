import type { TurndownNode, TurndownPlugin, TurndownServiceLike } from "./types";

/** Elements named `name` below `node` in document order, not descending into nested tables. */
function descendantElements(node: TurndownNode, name: string, limit = Number.POSITIVE_INFINITY): TurndownNode[] {
	const matches: TurndownNode[] = [];
	const stack: TurndownNode[] = [];
	const pushChildren = (parent: TurndownNode): void => {
		const children = parent.children;
		for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
	};
	pushChildren(node);
	while (stack.length > 0 && matches.length < limit) {
		const child = stack.pop()!;
		if (child.nodeName === name) matches.push(child);
		if (child.nodeName !== "TABLE") pushChildren(child);
	}
	return matches;
}

function isHeadingTable(node: TurndownNode): boolean {
	if (node.nodeName !== "TABLE") return false;
	const firstRow = descendantElements(node, "TR", 1)[0];
	if (!firstRow) return false;
	const cells = Array.from(firstRow.children);
	return cells.length > 0 && cells.every(cell => cell.nodeName === "TH");
}

function cellAlignment(cell: TurndownNode): "left" | "center" | "right" | undefined {
	const explicit = cell.getAttribute("align")?.toLowerCase();
	if (explicit === "left" || explicit === "center" || explicit === "right") return explicit;
	const style = cell.getAttribute("style") ?? "";
	const styled = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(style)?.[1]?.toLowerCase();
	return styled === "left" || styled === "center" || styled === "right" ? styled : undefined;
}

function alignmentMarker(cell: TurndownNode): string {
	const alignment = cellAlignment(cell);
	if (alignment === "left") return ":--";
	if (alignment === "center") return ":-:";
	if (alignment === "right") return "--:";
	return "---";
}

function renderTable(service: TurndownServiceLike, table: TurndownNode): string {
	const rows = descendantElements(table, "TR");
	const rendered: string[] = [];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex];
		if (!row) continue;
		const cells = Array.from(row.children).filter(cell => cell.nodeName === "TH" || cell.nodeName === "TD");
		const values = cells.map(cell => service.convertChildren(cell).trim());
		rendered.push(`| ${values.join(" | ")} |`);
		if (rowIndex === 0) rendered.push(`| ${cells.map(alignmentMarker).join(" | ")} |`);
	}
	return `\n\n${rendered.join("\n")}\n\n`;
}

/** Install GitHub fenced code blocks selected by `highlight-source-*` wrappers. */
export const highlightedCodeBlock: TurndownPlugin = service => {
	service.addRule("highlightedCodeBlock", {
		skipContent: true,
		filter(node) {
			return node.nodeName === "DIV" && /(?:^|\s)highlight-source-([^\s]+)/.test(node.getAttribute("class") ?? "");
		},
		replacement(_content, node, options) {
			const language = /(?:^|\s)highlight-source-([^\s]+)/.exec(node.getAttribute("class") ?? "")?.[1] ?? "";
			const text = descendantElements(node, "PRE", 1)[0]?.textContent ?? "";
			return `\n\n${options.fence}${language}\n${text}\n${options.fence}\n\n`;
		},
	});
};

/** Install GFM strikethrough conversion. */
export const strikethrough: TurndownPlugin = service => {
	service.addRule("strikethrough", {
		filter: ["del", "s", "strike"],
		replacement(content) {
			return `~${content}~`;
		},
	});
};

/** Install GFM task-list checkbox conversion. */
export const taskListItems: TurndownPlugin = service => {
	service.addRule("taskListItems", {
		skipContent: true,
		filter(node) {
			return (
				node.nodeName === "INPUT" &&
				node.parentNode?.nodeName === "LI" &&
				(node.getAttribute("type") ?? "").toLowerCase() === "checkbox"
			);
		},
		replacement(_content, node) {
			return node.hasAttribute("checked") ? "[x] " : "[ ] ";
		},
	});
};

/** Install GFM table conversion for tables with a heading row. */
export const tables: TurndownPlugin = service => {
	service.addRule("table", {
		skipContent: true,
		filter: isHeadingTable,
		replacement(_content, node) {
			return renderTable(service, node);
		},
	});
};

/** Install every GFM rule used by the coding agent. */
export const gfm: TurndownPlugin = service => {
	highlightedCodeBlock(service);
	strikethrough(service);
	tables(service);
	taskListItems(service);
};
