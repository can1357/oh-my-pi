/** Text block of an ask tool result, if it has one. */
export function askResultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	const block = result.content[0];
	return block?.type === "text" ? block.text : undefined;
}

/**
 * JSON payload an ask tool result embeds for the model, parsed.
 *
 * The payload is `JSON.stringify(data, null, 2)` inside the prose of
 * `prompts/tools/ask-result.md`; no code parses that prose, so tests compare the
 * payload instead of pinning the template's wording.
 */
export function askResultPayload(result: { content: Array<{ type: string; text?: string }> }): unknown {
	const content = askResultText(result);
	if (content === undefined) throw new Error("ask result has no text content");
	for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
		const end = jsonObjectEnd(content, start);
		if (end === undefined) continue;
		try {
			return JSON.parse(content.slice(start, end));
		} catch {
			// Prose can hold braces too; keep looking for the payload.
		}
	}
	throw new Error(`ask result text has no JSON payload: ${JSON.stringify(content)}`);
}

/** Index just past the balanced object that starts at `start`, or undefined when it never closes. */
function jsonObjectEnd(content: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return index + 1;
	}
	return undefined;
}
