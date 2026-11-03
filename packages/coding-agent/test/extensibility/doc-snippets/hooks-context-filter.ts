// Type-checked copy of block 1 under "### Modify model context per LLM call" in docs/hooks.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// ---- documented snippet below, verbatim ----
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
	pi.on("context", async event => {
		const filtered = event.messages.filter(msg => !(msg.role === "custom" && msg.customType === "debug-only"));
		return { messages: filtered };
	});
}
