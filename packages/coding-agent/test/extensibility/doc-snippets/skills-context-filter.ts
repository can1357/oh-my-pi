// Type-checked copy of block 1 under "### 3. Context filter" in docs/skills/authoring-hooks.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// ---- documented snippet below, verbatim ----
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function contextFilter(omp: HookAPI): void {
	omp.on("context", async event => {
		const MAX_TOOL_OUTPUT_CHARS = 8_000;

		const trimmed = event.messages.map(msg => {
			// Truncate very large tool results to keep context manageable
			if (msg.role !== "toolResult") return msg;
			const content = msg.content.map(chunk => {
				if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
				return {
					...chunk,
					text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated by context-filter hook]",
				};
			});
			return { ...msg, content };
		});

		return { messages: trimmed };
	});
}
