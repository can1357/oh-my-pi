export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<{ description: string; name: string }>;
	/** Tools mounted as commands, listed after the active set. */
	mountedCommands?: ReadonlyArray<{ name: string; summary: string }>;
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0 && !bindings.mountedCommands?.length) {
		return "No tools are currently visible to the agent.";
	}

	const rows: string[] = [];
	for (const tool of bindings.tools) {
		const description = escapeTableCell(tool.description) || "No description provided.";
		rows.push(`| \`${tool.name}\` | ${description} |`);
	}
	for (const mounted of bindings.mountedCommands ?? []) {
		rows.push(`| \`${mounted.name}\` | ${escapeTableCell(mounted.summary) || "No description provided."} |`);
	}

	return ["| Tool | Description |", "|------|-------------|", ...rows].join("\n");
}
