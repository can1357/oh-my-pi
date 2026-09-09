/**
 * Incremental JSONL parsing for streamed subagent transcripts.
 *
 * Transcript bytes arrive in arbitrary chunks; the trailing partial line is
 * returned as `carry` and prepended to the next chunk by the caller.
 * Unparseable complete lines are skipped (tolerant decode).
 */
export function parseJsonl(text: string, carry: string): { items: unknown[]; carry: string } {
	const lines = (carry + text).split("\n");
	const nextCarry = lines.pop() ?? "";
	const items: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			items.push(JSON.parse(trimmed));
		} catch {
			// skip unparseable line
		}
	}
	return { items, carry: nextCarry };
}
