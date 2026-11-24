/** @jsxImportSource @oh-my-pi/pi-tui */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

/** Draws a muted note under every assistant thinking block (display only). */
const extension: ExtensionFactory = pi => {
	pi.setLabel("Thinking note");
	pi.registerAssistantThinkingRenderer(context => (
		<text spans={[{ t: `thinking chars: ${context.text.length}`, s: "dim" }]} />
	));
};

export default extension;
