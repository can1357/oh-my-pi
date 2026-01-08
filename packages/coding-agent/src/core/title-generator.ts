/**
 * Generate session titles using a smol, fast model.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import titleSystemPrompt from "../prompts/title-system.md" with { type: "text" };
import { logger } from "./logger";
import type { ModelRegistry } from "./model-registry";
import { parseModelString, SMOL_MODEL_PRIORITY } from "./model-resolver";

const TITLE_SYSTEM_PROMPT = titleSystemPrompt;

const MAX_INPUT_CHARS = 2000;

function getTitleModelCandidates(registry: ModelRegistry, savedSmolModel?: string): Model<Api>[] {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return [];

	const candidates: Model<Api>[] = [];
	const addCandidate = (model?: Model<Api>): void => {
		if (!model) return;
		const exists = candidates.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
		if (!exists) {
			candidates.push(model);
		}
	};

	if (savedSmolModel) {
		const parsed = parseModelString(savedSmolModel);
		if (parsed) {
			const match = availableModels.find((model) => model.provider === parsed.provider && model.id === parsed.id);
			addCandidate(match);
		}
	}

	for (const pattern of SMOL_MODEL_PRIORITY) {
		const needle = pattern.toLowerCase();
		const exactMatch = availableModels.find((model) => model.id.toLowerCase() === needle);
		addCandidate(exactMatch);

		const fuzzyMatch = availableModels.find((model) => model.id.toLowerCase().includes(needle));
		addCandidate(fuzzyMatch);
	}

	for (const model of availableModels) {
		addCandidate(model);
	}

	return candidates;
}

/**
 * Find the best available model for title generation.
 * Uses the configured smol model if set, otherwise auto-discovers using priority chain.
 *
 * @param registry Model registry
 * @param savedSmolModel Optional saved smol model from settings (provider/modelId format)
 */
export async function findTitleModel(registry: ModelRegistry, savedSmolModel?: string): Promise<Model<Api> | null> {
	const candidates = getTitleModelCandidates(registry, savedSmolModel);
	return candidates[0] ?? null;
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
	const candidates = getTitleModelCandidates(registry, savedSmolModel);
	if (candidates.length === 0) {
		logger.debug("title-generator: no smol model found");
		return null;
	}

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}...` : firstMessage;
	const userMessage = `<user-message>\n${truncatedMessage}\n</user-message>`;

	for (const model of candidates) {
		const apiKey = await registry.getApiKey(model);
		if (!apiKey) {
			logger.debug("title-generator: no API key for model", { provider: model.provider, id: model.id });
			continue;
		}

		const request = {
			model: `${model.provider}/${model.id}`,
			systemPrompt: TITLE_SYSTEM_PROMPT,
			userMessage,
			maxTokens: 30,
		};
		logger.debug("title-generator: request", request);

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
				},
				{
					apiKey,
					maxTokens: 30,
				},
			);

			if (response.stopReason === "error") {
				logger.debug("title-generator: response error", {
					model: request.model,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
				continue;
			}

			// Extract title from response text content
			let title = "";
			for (const content of response.content) {
				if (content.type === "text") {
					title += content.text;
				}
			}
			title = title.trim();

			logger.debug("title-generator: response", {
				model: request.model,
				title,
				usage: response.usage,
				stopReason: response.stopReason,
			});

			if (!title) {
				continue;
			}

			// Clean up: remove quotes, trailing punctuation
			return title.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
		} catch (err) {
			logger.debug("title-generator: error", {
				model: request.model,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return null;
}

/**
 * Set the terminal title using ANSI escape sequences.
 */
export function setTerminalTitle(title: string): void {
	// OSC 2 sets the window title
	process.stdout.write(`\x1b]2;${title}\x07`);
}
