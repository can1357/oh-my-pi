/**
 * Debug script to reproduce streaming rendering issues.
 * Uses real fixture data that caused the bug.
 * Run with: npx tsx test/streaming-render-debug.ts
 */
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { sleep } from "bun";

// Initialize dark theme with full color support
Bun.env.COLORTERM = "truecolor";
initTheme();

async function main() {
	// Load the real fixture that caused the bug
	const fixtureMessage: AssistantMessage = JSON.parse(
		await Bun.file(path.join(import.meta.dir, "fixtures/assistant-message-with-thinking-code.json")).text(),
	);

	// Extract thinking and text content
	const thinkingContent = fixtureMessage.content.find(c => c.type === "thinking");
	const textContent = fixtureMessage.content.find(c => c.type === "text");

	if (thinkingContent?.type !== "thinking") {
		console.error("No thinking content in fixture");
		process.exit(1);
	}

	const fullThinkingText = thinkingContent.thinking;
	const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// Start with empty message
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	// Simulate streaming thinking content
	let thinkingBuffer = "";
	const chunkSize = 10; // characters per "token"

	for (let i = 0; i < fullThinkingText.length; i += chunkSize) {
		thinkingBuffer += fullThinkingText.slice(i, i + chunkSize);

		// Update message content
		const updatedMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: thinkingBuffer }],
		} as AssistantMessage;

		component.updateContent(updatedMessage);
		tui.requestRender();

		await sleep(15); // Simulate token delay
	}

	// Now add the text content
	await sleep(500);

	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: fullThinkingText },
			{ type: "text", text: fullTextContent },
		],
	} as AssistantMessage;

	component.updateContent(finalMessage);
	tui.requestRender();

	// Keep alive for a moment to see the result
	await sleep(3000);

	tui.stop();
	process.exit(0);
}

main().catch(console.error);
