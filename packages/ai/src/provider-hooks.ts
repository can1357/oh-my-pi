/**
 * Provider hooks: request adapters an embedder installs in place of a
 * provider's built-in ones, keyed by provider id.
 *
 * A hooked provider's models keep their `api`, so option mapping, catalog
 * policy, credentials, and every api-keyed consumer behave as before; only
 * the wire call changes. The coding agent installs hooks from extension
 * `registerProvider` configs.
 *
 * @example
 * setProviderHooks("google-generative-ai", { stream: myGeminiStream });
 * setProviderHooks("google-generative-ai", undefined); // back to the built-in adapter
 */
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./images/types";
import type { Api, AssistantMessageEventStream, Context, Model, StreamOptions } from "./types";

/** Adapters replacing a provider's built-in ones; omitted members keep the built-in. */
export interface ProviderHooks {
	/**
	 * Streams every request to the provider's models. Receives what the
	 * built-in adapter for the model's `api` would: the prepared model, and
	 * options mapped for that api (`GoogleGeminiCliOptions` for
	 * `google-gemini-cli`) carrying the provider's key.
	 */
	stream?(model: Model<Api>, context: Context, options: StreamOptions): AssistantMessageEventStream;
	/** Generates images with the provider's image models, after the provider-enabled check. */
	generateImage?(
		model: Model<Api>,
		request: ImageGenerationRequest,
		options: ImageGenerationOptions,
	): Promise<ImageGenerationResult>;
}

const installed = new Map<string, ProviderHooks>();

/** Installs `provider`'s hooks, replacing earlier ones; `undefined` restores the built-in adapters. */
export function setProviderHooks(provider: string, hooks: ProviderHooks | undefined): void {
	if (hooks?.stream || hooks?.generateImage) installed.set(provider, hooks);
	else installed.delete(provider);
}

/** The hooks installed for `provider`, if any. */
export function getProviderHooks(provider: string): ProviderHooks | undefined {
	return installed.get(provider);
}
