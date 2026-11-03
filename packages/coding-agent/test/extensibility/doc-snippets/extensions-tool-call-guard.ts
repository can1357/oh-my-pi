// Type-checked copy of block 1 under "### Adding passive context after a tool call" in docs/extensions.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

declare const pi: ExtensionAPI;
// ---- documented snippet below, verbatim ----
pi.on("tool_call", async event => {
	if (event.toolName === "search") {
		return { additionalContext: "Use this result before searching again." };
	}
});
