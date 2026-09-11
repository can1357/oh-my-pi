import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenEmbeddedPaths } from "../tools/render-utils";

/** Unwrap transport-only task results for existing transcript preview renderers. */
export function formatTaskResultPreview(text: string, includeStatus = true): string {
	let body = text;
	let abortReason: string | undefined;
	let fullOutput: string | undefined;
	let status: string | undefined;
	if (text.trimStart().startsWith("<task-result ")) {
		const attributes = /^\s*<task-result\b([^>]*)>/.exec(text)?.[1] ?? "";
		status = /\bstatus="([^"]+)"/.exec(attributes)?.[1];
		const output = /<(output|preview)(\s[^>]*)?>\n?([\s\S]*)\n?<\/\1>/.exec(text);
		if (output) {
			body = output[3].trim();
			if (output[1] === "preview") fullOutput = /\bfull-output="([^"]+)"/.exec(output[2] ?? "")?.[1];
			abortReason = /<abort-reason>([\s\S]*)<\/abort-reason>/.exec(text.slice(0, output.index))?.[1].trim();
		}
	}
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value === "string") body = value;
		else if (value && typeof value === "object" && !Array.isArray(value)) {
			const entries = Object.entries(value);
			if (entries.length === 1 && entries[0][0] === "summary" && typeof entries[0][1] === "string")
				body = entries[0][1];
		}
	} catch {
		// Prose, incomplete previews and arbitrary tool data retain their contents.
	}
	if (fullOutput) body = `${body}\n\nFull output: ${fullOutput}`;
	if (abortReason) body = `${abortReason}\n\n${body}`;
	if (includeStatus && status && status !== "completed") body = `Task ${status}\n\n${body}`;
	return replaceTabs(shortenEmbeddedPaths(sanitizeText(body)));
}
