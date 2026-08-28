import type { ToolEntry } from "../rpc/transcript";
import { writeClipboard } from "../shell/clipboard";
import type { MenuItem } from "../shell/contextMenu";

/**
 * What a tool card can hand you.
 *
 * Built from the entry, not the rendered card: the card is thirty renderers
 * deep and its DOM is not a stable interface. Every field here is one the RPC
 * frame already carries.
 *
 * Only what this tool actually has: a `read` has no command, a running tool has
 * no output. An entry that lists neither gets no menu at all, and the caller
 * falls through to the message underneath.
 */
export function toolMenuItems(entry: ToolEntry, report: (cause: unknown) => void): MenuItem[] {
	const copy = (value: string) => () => void writeClipboard(value).catch(report);
	const items: MenuItem[] = [];

	const command = stringArg(entry.args, "command");
	if (command) items.push({ kind: "action", id: "copy-command", label: "Copy the command", run: copy(command) });

	const path = stringArg(entry.args, "path") ?? stringArg(entry.args, "file_path");
	if (path) items.push({ kind: "action", id: "copy-path", label: "Copy the path", run: copy(path) });

	const output = resultText(entry.result);
	if (output) items.push({ kind: "action", id: "copy-output", label: "Copy the output", run: copy(output) });

	if (items.length > 0) {
		items.push({ kind: "separator", id: "sep" });
		items.push({
			kind: "action",
			id: "copy-args",
			label: "Copy the arguments",
			run: copy(JSON.stringify(entry.args ?? {}, null, 2)),
		});
	}
	return items;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** The text blocks of a tool result, joined — which is what you see on the card. */
function resultText(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map(block =>
			block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.join("")
		.trim();
	return text || undefined;
}
