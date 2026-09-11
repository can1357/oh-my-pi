/**
 * `login "api-key"` engine: open the provider's key page, prompt for a paste,
 * optionally validate the key against a declared probe, return the key.
 */
import type { CompiledApiKeyLogin, CompiledAuthValidation } from "@oh-my-pi/pi-catalog/compat/types";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import {
	validateAnthropicCompatibleApiKey,
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "../api-key-validation";
import type { OAuthController } from "../oauth/types";
import { loadHeadersHook } from "./common";

async function runValidation(
	validate: CompiledAuthValidation,
	label: string,
	apiKey: string,
	options: OAuthController,
): Promise<void> {
	const provider = validate.label ?? label;
	switch (validate.kind) {
		case "chat-completions":
			await validateOpenAICompatibleApiKey({
				provider,
				apiKey,
				baseUrl: validate.baseUrl,
				model: validate.model,
				maxTokensField: validate.maxTokensField,
				maxTokens: validate.maxTokens,
				tolerateModelDenied: validate.tolerateModelDenied,
				signal: options.signal,
				fetch: options.fetch,
			});
			return;
		case "anthropic-messages":
			await validateAnthropicCompatibleApiKey({
				provider,
				apiKey,
				baseUrl: validate.baseUrl,
				model: validate.model,
				signal: options.signal,
				fetch: options.fetch,
			});
			return;
		case "models-endpoint": {
			const envBase = validate.baseUrlEnv ? $env[validate.baseUrlEnv]?.trim() : undefined;
			const modelsUrl = envBase ? `${envBase.replace(/\/+$/, "")}/models` : validate.url;
			const headers = validate.headersHook ? (await loadHeadersHook(validate.headersHook))() : undefined;
			await validateApiKeyAgainstModelsEndpoint({
				provider,
				apiKey,
				modelsUrl,
				headers,
				signal: options.signal,
				fetch: options.fetch,
			});
		}
	}
}

/** Builds the login function for one `login "api-key"` rule; `label` is the provider display name. */
export function createApiKeyLogin(
	rule: CompiledApiKeyLogin,
	label: string,
): (options: OAuthController) => Promise<string> {
	return async function login(options: OAuthController): Promise<string> {
		if (!options.onPrompt) {
			throw new AIError.OnPromptRequiredError(label);
		}
		if (rule.authUrl && rule.instructions) {
			options.onAuth?.({ url: rule.authUrl, instructions: rule.instructions });
		}
		const answer = await options.onPrompt({
			message: rule.prompt,
			placeholder: rule.placeholder,
			...(rule.emptyFallback !== undefined ? { allowEmpty: true } : {}),
		});
		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}
		let trimmed = answer.trim();
		if (rule.normalize === "strip-bearer" && trimmed) {
			trimmed = trimmed.replace(/^bearer\b\s*/i, "");
			if (!trimmed) {
				throw new AIError.ApiKeyRequiredError(`${label} API key is empty after stripping Bearer prefix`);
			}
		}
		if (!trimmed) {
			if (rule.emptyFallback !== undefined) return rule.emptyFallback;
			throw new AIError.ApiKeyRequiredError();
		}
		if (rule.validate) {
			options.onProgress?.(rule.validate.optional ? "Validating API key (optional)..." : "Validating API key...");
			try {
				await runValidation(rule.validate, label, trimmed, options);
			} catch (error) {
				// An optional probe only rejects on a real auth failure (401/403);
				// any other validation-endpoint failure trusts the supplied key.
				if (!rule.validate.optional || AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
					throw error;
				}
				options.onProgress?.(`Skipping ${label} validation endpoint; continuing with provided API key.`);
			}
		}
		return trimmed;
	};
}
