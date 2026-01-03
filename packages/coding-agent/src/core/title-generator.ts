/**
 * Generate session titles using a small, fast model.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "./model-registry.js";

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
 * Prefers small, fast models in this order:
 * 1. Claude Haiku (anthropic)
 * 2. GPT-4o-mini (openai)
 * 3. Gemini Flash (google)
 * 4. Any available model
 */
export async function findTitleModel(registry: ModelRegistry): Promise<Model<any> | null> {
	const preferences = [
		{ provider: "anthropic", pattern: /haiku/i },
		{ provider: "openai", pattern: /gpt-4o-mini|gpt-4\.1-mini/i },
		{ provider: "google", pattern: /flash/i },
		{ provider: "anthropic", pattern: /sonnet/i },
	];

	for (const pref of preferences) {
		const models = registry.getAll().filter((m) => m.provider === pref.provider && pref.pattern.test(m.id));
		for (const model of models) {
			if (await registry.getApiKey(model)) {
				return model;
			}
		}
	}

	// Fallback to any available model
	for (const model of registry.getAll()) {
		if (await registry.getApiKey(model)) {
			return model;
		}
	}

	return null;
}

/**
 * Generate a title for a session based on the first user message.
 */
export async function generateSessionTitle(firstMessage: string, registry: ModelRegistry): Promise<string | null> {
	const model = await findTitleModel(registry);
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
