/**
 * Generate session titles using a smol, fast model.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "./model-registry.js";
import { findSmolModel } from "./model-resolver.js";

const TITLE_SYSTEM_PROMPT = `Generate a very short title (3-6 words) for a coding session based on the user's first message. The title should capture the main task or topic. Output ONLY the title, nothing else. No quotes, no punctuation at the end.

Examples:
- "Fix TypeScript compilation errors"
- "Add user authentication"
- "Refactor database queries"
- "Debug payment webhook"
- "Update React components"`;

const MAX_INPUT_CHARS = 2000;

/**
 * Find the best available model for title generation.
 * Uses the configured smol model if set, otherwise auto-discovers using priority chain.
 *
 * @param registry Model registry
 * @param savedSmolModel Optional saved smol model from settings (provider/modelId format)
 */
export async function findTitleModel(registry: ModelRegistry, savedSmolModel?: string): Promise<Model<any> | null> {
	const model = await findSmolModel(registry, savedSmolModel);
	return model ?? null;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param savedSmolModel Optional saved smol model from settings (provider/modelId format)
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	savedSmolModel?: string,
): Promise<string | null> {
	const model = await findTitleModel(registry, savedSmolModel);
	if (!model) return null;

	const apiKey = await registry.getApiKey(model);
	if (!apiKey) return null;

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}...` : firstMessage;

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: truncatedMessage, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens: 30,
			},
		);

		// Extract title from response text content
		let title = "";
		for (const content of response.content) {
			if (content.type === "text") {
				title += content.text;
			}
		}
		title = title.trim();

		if (!title || title.length > 60) {
			return null;
		}

		// Clean up: remove quotes, trailing punctuation
		return title.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
	} catch {
		return null;
	}
}

/**
 * Set the terminal title using ANSI escape sequences.
 */
export function setTerminalTitle(title: string): void {
	// OSC 2 sets the window title
	process.stdout.write(`\x1b]2;${title}\x07`);
}
