import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<{ description: string; name: string }>;
	/** Tools mounted under `xd://` URLs, listed after the active set. */
	xdevTools?: ReadonlyArray<{ name: string; summary: string }>;
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0 && !bindings.xdevTools?.length) {
		return __ompTranslate("No tools are currently visible to the agent.");
	}

	const rows: string[] = [];
	for (const tool of bindings.tools) {
		const description = escapeTableCell(tool.description) || __ompTranslate("No description provided.");
		rows.push(`| \`${tool.name}\` | ${description} |`);
	}
	for (const mounted of bindings.xdevTools ?? []) {
		rows.push(
			`| \`xd://${mounted.name}\` | ${escapeTableCell(mounted.summary) || __ompTranslate("No description provided.")} |`,
		);
	}

	return [__ompTranslate("| Tool | Description |"), "|------|-------------|", ...rows].join("\n");
}
